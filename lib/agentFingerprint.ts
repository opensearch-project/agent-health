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
 *   - `headers` (agent-level and run-level overrides) — carry credentials.
 *   - `auth` — username/password/token/AWS keys.
 *   - `connectorConfig.env` VALUES — env maps routinely hold API keys and
 *     tokens; only the sorted KEY NAMES participate (plus the values of
 *     non-secret `*MODEL*` selectors such as `ANTHROPIC_MODEL`), so adding/
 *     removing an env var or swapping the model changes the fingerprint but
 *     rotating a secret does not.
 *   - MCP server `env` values, same rule as above.
 *   - Any key whose name looks secret-ish (`token`, `apiKey`, `password`,
 *     `secret`, `authorization`, `credential`) anywhere in connectorConfig.
 *
 * Hooks ARE hashed via their source text (`Function.prototype.toString`),
 * because a `beforeRequest` that rewrites the payload is as much "the agent's
 * configuration" as the prompt is. `name`/`description`/`enabled` are not
 * hashed — they don't change agent behavior.
 *
 * This module runs server-side (node `crypto`). It is imported by the run
 * creation routes and the runners, never by browser code (the browser only
 * reads the persisted values).
 */

import { createHash } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import type { AgentConfig } from '@/types';
import { resolveAgentModel } from '@/lib/resolveAgentModel';
import type { AgentFingerprint, AgentConfigSource } from './agentFingerprintDiff';

export type { AgentFingerprint, AgentConfigSource, FingerprintDiffKind } from './agentFingerprintDiff';
export { classifyFingerprintDiff } from './agentFingerprintDiff';

/** Bump when the payload shape changes (invalidates cross-version equality). */
export const AGENT_FINGERPRINT_VERSION = 1;

/** Length of {@link AgentFingerprint.agentFingerprintShort}. */
export const AGENT_FINGERPRINT_SHORT_LENGTH = 12;

/**
 * Key names (case-insensitive substring match) that are redacted wherever
 * they appear inside `connectorConfig`. Redaction replaces the VALUE with
 * a fixed marker so presence still participates in the hash — a config that
 * gained a `token` key differs from one without it, but rotating the token
 * does not change the fingerprint.
 */
const SECRET_KEY_PATTERN = /(token|apikey|api_key|password|passwd|secret|authorization|credential|sessiontoken|access_key|accesskey|private)/i;

const REDACTED = '[redacted]';

/**
 * Env keys whose VALUE is behavior, not a credential: model selectors. The
 * Claude Code connector takes its model from `env.ANTHROPIC_MODEL` (see
 * lib/resolveAgentModel.ts), so a model swap there must change the
 * fingerprint. Anything matching {@link SECRET_KEY_PATTERN} still loses.
 */
const ENV_VALUE_ALLOWLIST = /model/i;

/**
 * Deterministic JSON: objects serialized with sorted keys, recursively.
 * Arrays keep their order. `undefined` values are dropped (so `{a: 1}` and
 * `{a: 1, b: undefined}` hash identically — the persisted forms are equal).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === 'function') return functionSource(value as (...args: unknown[]) => unknown);
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hook/function source text. Whitespace-normalized so a reformat isn't a "change". */
function functionSource(fn: (...args: unknown[]) => unknown): string {
  return Function.prototype.toString.call(fn).replace(/\s+/g, ' ').trim();
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
export function redactConnectorConfig(value: unknown, keyName?: string): unknown {
  if (keyName !== undefined && SECRET_KEY_PATTERN.test(keyName)) return REDACTED;
  if (Array.isArray(value)) return value.map(v => redactConnectorConfig(v));
  if (typeof value === 'function') return functionSource(value as (...args: unknown[]) => unknown);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (keyName === 'env') {
      // Keep key names; redact every value except non-secret model selectors.
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        const keepValue = ENV_VALUE_ALLOWLIST.test(k) && !SECRET_KEY_PATTERN.test(k);
        out[k] = keepValue ? obj[k] : REDACTED;
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      if (obj[k] === undefined) continue;
      out[k] = redactConnectorConfig(obj[k], k);
    }
    return out;
  }
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
 * talks to. Only `endpoint` participates — `headers` are credentials and are
 * redacted by design (see module doc).
 */
export interface FingerprintRunOverrides {
  agentEndpoint?: string;
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

/**
 * Best-effort: resolve the authored config file's real path and the git
 * commit of the repository containing it. The config file is commonly a
 * symlink into another repo (the canonical config lives elsewhere), so the
 * path is `realpath`-resolved BEFORE asking git. Never throws; returns
 * `undefined` when there is no config file or git is unavailable.
 *
 * `execFileSync` (not `exec`) with an argv array — no shell, no
 * interpolation of the path.
 */
export function resolveAgentConfigSource(configPath: string | null | undefined): AgentConfigSource | undefined {
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
    const sha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) source.gitSha = sha;
    const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--', realPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    source.dirty = status.length > 0;
  } catch {
    // Not a git checkout / git missing — path alone is still useful.
  }
  return source;
}
