/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent configuration fingerprint — provenance for "which configuration of
 * this agent produced these numbers?"
 *
 * A run document records `agentKey`, but the agent's configuration behind
 * that key (system prompt, allowed tools, model, MCP servers, hooks, ...)
 * lives in `agent-health.config.ts` and changes over time. When a prompt
 * edit lands between two runs of the same agent, "which prompt produced this
 * pass rate" becomes a git-archaeology question. The fingerprint freezes the
 * connector-relevant configuration into a stable SHA-256 at run-creation
 * time so two runs of the same `agentKey` can be told apart (or proven
 * identical) without leaving the run doc.
 *
 * Three hashes, one purpose each:
 *
 *   - `agentFingerprint`      — full sha256 over the connector-relevant
 *                               config (see {@link buildFingerprintPayload}).
 *   - `agentFingerprintShort` — first 12 hex chars, for chips/labels.
 *   - `agentPromptHash`       — sha256 over the system/append prompt ALONE,
 *                               when one is derivable. A prompt-only change
 *                               shows as a different promptHash while the
 *                               comparison UI can say "prompt changed" vs
 *                               "other config changed".
 *
 * What is deliberately NOT hashed (redaction, not omission by accident):
 *
 *   - `headers` VALUES (agent-level; run-level header overrides never
 *     participate at all) — they carry credentials. The sorted header KEY
 *     NAMES do participate, so adding an `X-Api-Version` header changes the
 *     fingerprint but rotating its `Authorization` value does not.
 *   - `auth` secrets — username/password/token/AWS keys. The auth SHAPE
 *     (`type`, `awsRegion`, `awsService`, header key names) participates.
 *   - `connectorConfig.env` VALUES — env maps routinely hold API keys and
 *     tokens; only the sorted KEY NAMES participate (plus the values of
 *     non-secret `*MODEL*` selectors such as `ANTHROPIC_MODEL`), so adding/
 *     removing an env var or swapping the model changes the fingerprint but
 *     rotating a secret does not.
 *   - MCP server `env` values, same rule as above.
 *   - Any key whose name is a credential carrier (see {@link isSecretKey}:
 *     `token`, `apiKey`, `password`, `secret`, `authorization`, `credential`,
 *     `cookie`, `jwt`, `*Token`, `*Secret`, `*Key`-style suffixes) anywhere
 *     in connectorConfig. Behavior fields that merely CONTAIN such a word
 *     (`maxTokens`, `tokenBudget`, `authorizationMode`, `privateMode`) are
 *     NOT redacted — hiding those would hide real config drift.
 *
 * Hooks ARE hashed via their exact source text (`Function.prototype.toString`,
 * no normalization — a reformat IS a change, because collapsing whitespace
 * would also collapse whitespace inside string literals), because a
 * `beforeRequest` that rewrites the payload is as much "the agent's
 * configuration" as the prompt is. Known limit, stated plainly: source text
 * cannot see closed-over variables, imported constants or env-driven
 * branches inside a hook — the fingerprint proves "the hook's code changed",
 * never "the hook's behavior is identical". `name`/`description`/`enabled`
 * are not hashed — they don't change agent behavior.
 *
 * Serialization is deterministic for plain data AND the non-plain values a
 * config file realistically contains (Map/Set → sorted entries, Date → ISO,
 * URL/RegExp → string, BigInt → decimal string). Cycles throw; the caller
 * (`server/services/agentProvenance.ts`) catches, logs a warning and stamps
 * nothing — provenance is metadata, never a reason to refuse a run.
 *
 * This module runs server-side (node `crypto`). It is imported by the run
 * creation routes and the runners, never by browser code (the browser only
 * reads the persisted values).
 */

import { createHash } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentConfig } from '@/types';
import { resolveAgentModel } from '@/lib/resolveAgentModel';
import type { AgentFingerprint, AgentConfigSource } from './agentFingerprintDiff';

export type { AgentFingerprint, AgentConfigSource, FingerprintDiffKind } from './agentFingerprintDiff';
export { classifyFingerprintDiff } from './agentFingerprintDiff';

/** Bump when the payload shape changes (invalidates cross-version equality). */
export const AGENT_FINGERPRINT_VERSION = 1;

/** Length of {@link AgentFingerprint.agentFingerprintShort}. */
export const AGENT_FINGERPRINT_SHORT_LENGTH = 12;

const REDACTED = '[redacted]';

/**
 * Exact credential-carrier key names (compared after lower-casing and
 * stripping `_`/`-`, so `api_key`, `api-key`, `apiKey` all match).
 */
const SECRET_KEY_EXACT = new Set([
  'token', 'apikey', 'accesskey', 'secretkey', 'secret', 'password', 'passwd', 'pass',
  'authorization', 'credential', 'credentials', 'cookie', 'jwt', 'privatekey',
  'awsaccesskeyid', 'awssecretaccesskey', 'awssessiontoken',
]);
/** Suffixes that mark a key as a credential carrier (`refreshToken`, `clientSecret`, `signingKey`). */
const SECRET_KEY_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'apikey', 'accesskey', 'privatekey', 'credential', 'credentials', 'authorization', 'cookie', 'jwt'];

/**
 * Is `keyName` a credential carrier? Redaction replaces the VALUE with a
 * fixed marker so presence still participates in the hash — a config that
 * gained a `token` key differs from one without it, but rotating the token
 * does not change the fingerprint.
 *
 * Deliberately NOT a substring match: `maxTokens`, `tokenBudget`,
 * `authorizationMode`, `privateMode`, `credentialSource` are behavior fields
 * whose drift must stay visible. Exact names and credential-style SUFFIXES
 * only (`maxTokens` ends in `tokens`, not `token`).
 */
export function isSecretKey(keyName: string): boolean {
  const norm = keyName.toLowerCase().replace(/[_-]/g, '');
  if (SECRET_KEY_EXACT.has(norm)) return true;
  return SECRET_KEY_SUFFIXES.some(suffix => norm.length > suffix.length && norm.endsWith(suffix));
}

/**
 * Env keys whose VALUE is behavior, not a credential: model selectors. The
 * Claude Code connector takes its model from `env.ANTHROPIC_MODEL` (see
 * lib/resolveAgentModel.ts), so a model swap there must change the
 * fingerprint. Anything {@link isSecretKey} flags still loses.
 */
const ENV_VALUE_ALLOWLIST = /model/i;

/**
 * Deterministic JSON: objects serialized with sorted keys, recursively.
 * Arrays keep their order. `undefined` values are dropped (so `{a: 1}` and
 * `{a: 1, b: undefined}` hash identically — the persisted forms are equal).
 * Non-plain values are made explicit and deterministic instead of being
 * silently lost by `JSON.stringify` (which turns a Map into `{}`):
 * Map → sorted `[k, v]` entries, Set → sorted members, Date → ISO string,
 * URL/RegExp → their string form, BigInt → decimal string, NaN/±Infinity →
 * their names, class instances → own enumerable props (sorted) tagged with
 * the constructor name. Cycles throw (the caller treats that as "no
 * provenance", with a logged warning).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value, new WeakSet()));
}

function normalizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'function') return { $fn: functionSource(value as (...args: unknown[]) => unknown) };
  if (t === 'bigint') return { $bigint: (value as bigint).toString() };
  if (t === 'number') {
    const n = value as number;
    return Number.isFinite(n) ? n : { $number: String(n) };
  }
  if (t !== 'object') return value;
  const obj = value as object;
  if (seen.has(obj)) throw new Error('agentFingerprint: circular reference in agent config');
  if (obj instanceof Date) return { $date: Number.isNaN(obj.getTime()) ? 'invalid' : obj.toISOString() };
  if (obj instanceof RegExp) return { $regexp: obj.toString() };
  if (typeof URL !== 'undefined' && obj instanceof URL) return { $url: obj.toString() };
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map(v => normalizeValue(v, seen));
    if (obj instanceof Map) {
      const entries = Array.from(obj.entries()).map(([k, v]) => [normalizeValue(k, seen), normalizeValue(v, seen)] as const);
      entries.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
      return { $map: entries };
    }
    if (obj instanceof Set) {
      const members = Array.from(obj.values()).map(v => normalizeValue(v, seen));
      members.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { $set: members };
    }
    const out: Record<string, unknown> = {};
    const rec = obj as Record<string, unknown>;
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      if (v !== undefined) out[key] = normalizeValue(v, seen);
    }
    const ctor = Object.getPrototypeOf(obj)?.constructor?.name;
    if (ctor && ctor !== 'Object') out.$class = ctor;
    return out;
  } finally {
    seen.delete(obj);
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hook/function source text, verbatim. NOT whitespace-normalized: collapsing
 * whitespace would also collapse whitespace inside string/template literals
 * and regexes, making distinct behavior hash identically. A reformat of a
 * hook therefore changes the fingerprint — that is the honest answer.
 */
function functionSource(fn: (...args: unknown[]) => unknown): string {
  return Function.prototype.toString.call(fn);
}

/**
 * Redact secret-looking values inside an arbitrary connectorConfig subtree.
 *
 *   - Keys named `env` (at any depth) keep their KEY NAMES only: values are
 *     replaced by the redaction marker. Env maps are where API keys live.
 *   - Any key matching {@link SECRET_KEY_PATTERN} has its value replaced.
 *   - Everything else is recursed into (arrays and nested objects preserved).
 *
 * Functions (e.g. a connectorConfig callback) are hashed via their source
 * text like hooks are.
 */
export function redactConnectorConfig(value: unknown, keyName?: string, seen: WeakSet<object> = new WeakSet()): unknown {
  if (keyName !== undefined && isSecretKey(keyName)) return REDACTED;
  if (typeof value === 'function') return functionSource(value as (...args: unknown[]) => unknown);
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp) && !(value instanceof Map) && !(value instanceof Set)) {
    if (seen.has(value)) throw new Error('agentFingerprint: circular reference in agent config');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(v => redactConnectorConfig(v, undefined, seen));
      const obj = value as Record<string, unknown>;
      if (keyName === 'env') {
        // Keep key names; redact every value except non-secret model selectors.
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) {
          const keepValue = ENV_VALUE_ALLOWLIST.test(k) && !isSecretKey(k);
          out[k] = keepValue ? obj[k] : REDACTED;
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        if (obj[k] === undefined) continue;
        out[k] = redactConnectorConfig(obj[k], k, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  // Primitives and non-plain objects (Date/RegExp/Map/Set) fall through to
  // canonicalStringify's deterministic normalization.
  return value;
}

/**
 * Derive the agent's system prompt text, when the connector exposes one.
 * Concatenates `systemPrompt` and `appendSystemPrompt` (both Claude Code
 * connector fields) with a separator so either changing changes the hash.
 * Other connectors that carry a prompt under a conventional name
 * (`system_prompt`, `instructions`) are picked up too. Returns `undefined`
 * when nothing prompt-like is configured — the run then has no
 * `agentPromptHash`, which the UI renders as "no prompt recorded".
 */
export function deriveAgentPromptText(agent: Pick<AgentConfig, 'connectorConfig'>): string | undefined {
  const cc = (agent.connectorConfig || {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['systemPrompt', 'system_prompt', 'instructions', 'appendSystemPrompt', 'append_system_prompt']) {
    const v = cc[key];
    if (typeof v === 'string' && v.length > 0) parts.push(`${key}:${v}`);
  }
  return parts.length > 0 ? parts.join('\n---\n') : undefined;
}

/**
 * Overrides applied at run creation that change what the connector actually
 * talks to. Only `endpoint` participates — run-level `headers` are
 * credentials supplied per run and never participate (see module doc).
 */
export interface FingerprintRunOverrides {
  agentEndpoint?: string;
}

/** Sorted header KEY NAMES (values are credentials — never hashed). */
function headerKeyNames(headers: Record<string, string> | undefined): string[] | undefined {
  if (!headers) return undefined;
  const keys = Object.keys(headers).sort();
  return keys.length > 0 ? keys : undefined;
}

/** The non-secret SHAPE of an auth config: how the agent authenticates, not with what. */
function authShape(auth: AgentConfig['auth']): Record<string, unknown> | undefined {
  if (!auth) return undefined;
  return {
    type: auth.type,
    awsRegion: auth.awsRegion,
    awsService: auth.awsService,
    headerKeys: headerKeyNames(auth.headers),
    hasUsername: auth.username ? true : undefined,
    hasToken: auth.token ? true : undefined,
  };
}

/**
 * The canonical (pre-hash) payload. Exported so tests can assert exactly
 * which fields participate and what redaction produces.
 */
export function buildFingerprintPayload(
  agent: AgentConfig,
  overrides: FingerprintRunOverrides = {},
): Record<string, unknown> {
  const hooks = agent.hooks
    ? Object.fromEntries(
        Object.entries(agent.hooks)
          .filter(([, fn]) => typeof fn === 'function')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, fn]) => [name, functionSource(fn as (...args: unknown[]) => unknown)]),
      )
    : undefined;

  return {
    v: AGENT_FINGERPRINT_VERSION,
    key: agent.key,
    connectorType: agent.connectorType ?? 'agui-streaming',
    endpoint: overrides.agentEndpoint || agent.endpoint,
    useTraces: agent.useTraces ?? false,
    // The LLM the agent runs on, resolved the same way the runner does
    // (connectorConfig.model > env.ANTHROPIC_MODEL > args --model). Listed
    // explicitly so a model swap is visible even when the connector reads
    // it from a place the redaction below would otherwise hide.
    model: resolveAgentModel(agent) || undefined,
    // Header KEY NAMES and auth SHAPE (never values): an added
    // `X-Api-Version` header or a switch from bearer to sigv4 is behavior.
    headerKeys: headerKeyNames(agent.headers),
    auth: authShape(agent.auth),
    traceServiceName: agent.traceServiceName,
    tracePolling: agent.tracePolling,
    // Everything connector-specific (systemPrompt, appendSystemPrompt,
    // additionalArgs, allowedTools, model, mcpServers, traceContext, ...)
    // lives here — with secrets redacted, env values dropped to key names.
    connectorConfig: agent.connectorConfig ? redactConnectorConfig(agent.connectorConfig) : undefined,
    hooks,
  };
}

/**
 * Compute the fingerprint for a resolved agent config (+ optional run-level
 * endpoint override). Pure: same input → same output, no I/O.
 */
export function computeAgentFingerprint(
  agent: AgentConfig,
  overrides: FingerprintRunOverrides = {},
): Omit<AgentFingerprint, 'agentConfigSource'> {
  const payload = buildFingerprintPayload(agent, overrides);
  const agentFingerprint = sha256Hex(canonicalStringify(payload));
  const promptText = deriveAgentPromptText(agent);
  return {
    agentFingerprint,
    agentFingerprintShort: agentFingerprint.slice(0, AGENT_FINGERPRINT_SHORT_LENGTH),
    agentPromptHash: promptText !== undefined ? sha256Hex(promptText) : undefined,
  };
}

const execFileAsync = promisify(execFile);

/**
 * Best-effort: resolve the authored config file's real path and the git
 * commit of the repository containing it. The config file is commonly a
 * symlink into another repo (the canonical config lives elsewhere), so the
 * path is `realpath`-resolved BEFORE asking git. Never throws; returns
 * `undefined` when there is no config file, and the path alone when git is
 * unavailable / the file isn't in a checkout.
 *
 * Async `execFile` (argv array — no shell, no interpolation of the path) so
 * a slow repo or lock contention never blocks the event loop; each call is
 * bounded by a 2s timeout.
 */
export async function resolveAgentConfigSource(configPath: string | null | undefined): Promise<AgentConfigSource | undefined> {
  if (!configPath) return undefined;
  let realPath: string;
  try {
    if (!existsSync(configPath)) return undefined;
    realPath = realpathSync(configPath);
  } catch {
    return undefined;
  }
  const source: AgentConfigSource = { path: realPath };
  try {
    const cwd = dirname(realPath);
    const git = async (...args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000 });
      return stdout.trim();
    };
    const sha = await git('rev-parse', 'HEAD');
    if (/^[0-9a-f]{40}$/.test(sha)) source.gitSha = sha;
    const status = await git('status', '--porcelain', '--', realPath);
    source.dirty = status.length > 0;
  } catch {
    // Not a git checkout / git missing — path alone is still useful.
  }
  return source;
}
