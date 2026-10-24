/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-safe half of the agent-fingerprint feature: the persisted shape
 * and the pure diff classifier the UI uses. No node imports — the hashing
 * side (node `crypto` / `fs` / `child_process`) lives in
 * `lib/agentFingerprint.ts` and is server-only. See that module for the full
 * design note (what is hashed, what is redacted, why).
 */

/**
 * Persisted provenance fields. Optional everywhere they are stored — runs and
 * reports created before this existed carry none of them.
 */
export interface AgentFingerprint {
  /** sha256 hex over the redacted connector-relevant config. */
  agentFingerprint: string;
  /** First 12 hex chars of `agentFingerprint`. */
  agentFingerprintShort: string;
  /** sha256 hex over the system/append prompt alone; undefined when no prompt is derivable. */
  agentPromptHash?: string;
  /** Where the agent's config came from, when resolvable. Informational only. */
  agentConfigSource?: AgentConfigSource;
}

export interface AgentConfigSource {
  /** Real (symlink-resolved) path of the authored config file. */
  path: string;
  /** `git rev-parse HEAD` of the repo containing that file, when resolvable. */
  gitSha?: string;
  /** True when `git status --porcelain -- <file>` reports local modifications. */
  dirty?: boolean;
}

/**
 * Classify how two fingerprints differ. Used by the comparison scoreboard
 * ("config changed between runs") and the re-run provenance chip ("config
 * changed since source run").
 *
 *   - `same`       — identical fingerprint.
 *   - `prompt`     — fingerprint differs AND prompt hash differs → the
 *                    prompt changed. Other fields MAY have changed too; the
 *                    hashes cannot tell, and the wording says so.
 *   - `other`      — fingerprint differs, prompt hash equal (or both absent)
 *                    → something other than the prompt changed.
 *   - `unknown`    — one side has no fingerprint (legacy run).
 */
export type FingerprintDiffKind = 'same' | 'prompt' | 'other' | 'unknown';

export interface FingerprintCarrier {
  agentFingerprint?: string;
  agentPromptHash?: string;
}

export function classifyFingerprintDiff(
  a: FingerprintCarrier | null | undefined,
  b: FingerprintCarrier | null | undefined,
): FingerprintDiffKind {
  if (!a?.agentFingerprint || !b?.agentFingerprint) return 'unknown';
  if (a.agentFingerprint === b.agentFingerprint) return 'same';
  if (a.agentPromptHash !== b.agentPromptHash) return 'prompt';
  return 'other';
}

/** Human wording for a non-`same` diff, shared by the scoreboard badge and the re-run chip. */
export function describeFingerprintDiff(kind: FingerprintDiffKind): string {
  switch (kind) {
    case 'prompt': return 'system prompt changed (other connector fields may have changed too)';
    case 'other': return 'connector config changed (prompt unchanged)';
    case 'same': return 'identical agent configuration';
    default: return 'agent configuration not recorded on one of the runs';
  }
}

/**
 * One-line tooltip body for a fingerprint chip. Multi-line via `\n` (the
 * native `title` attribute renders newlines).
 */
export function formatFingerprintTooltip(fp: FingerprintCarrier & {
  agentFingerprintShort?: string;
  agentConfigSource?: AgentConfigSource;
}): string {
  const lines: string[] = [];
  lines.push(`Agent config fingerprint: ${fp.agentFingerprint ?? '—'}`);
  lines.push(`Prompt hash: ${fp.agentPromptHash ?? 'no system prompt recorded'}`);
  if (fp.agentConfigSource?.path) {
    const sha = fp.agentConfigSource.gitSha ? fp.agentConfigSource.gitSha.slice(0, 12) : 'no git sha';
    const dirty = fp.agentConfigSource.dirty ? ' (uncommitted edits)' : '';
    lines.push(`Config: ${fp.agentConfigSource.path} @ ${sha}${dirty}`);
  }
  return lines.join('\n');
}

/**
 * What goes INTO the fingerprint, one entry per top-level key of the hashed
 * payload (`buildFingerprintPayload` in lib/agentFingerprint.ts — that module
 * is server-only because of node `crypto`, so the browser-facing catalogue
 * lives here and a unit test pins the two together: every payload key must
 * be documented, and nothing documented may be missing from the payload).
 *
 * Shown in the chip's details popover so a reader can tell what a changed
 * fingerprint can mean. The inputs themselves are NOT stored on the run —
 * only the hashes are — so the popover points at the CLI / API that
 * recompute them from the current config instead of pretending to list
 * per-run values it does not have.
 */
export interface FingerprintInputField {
  /** Top-level key in the hashed payload. */
  key: string;
  /** Human label. */
  label: string;
  /** What exactly participates (and what is redacted). */
  detail: string;
}

export const FINGERPRINT_INPUT_FIELDS: readonly FingerprintInputField[] = [
  { key: 'v', label: 'Fingerprint version', detail: 'payload-shape version (bumped when the hashed shape changes)' },
  { key: 'key', label: 'Agent key', detail: 'the `key` in agent-health.config.ts' },
  { key: 'connectorType', label: 'Connector type', detail: 'e.g. claude-code, rest, agui-streaming' },
  { key: 'endpoint', label: 'Endpoint', detail: 'the agent endpoint, including a run-level endpoint override' },
  { key: 'useTraces', label: 'Trace mode', detail: 'whether the run judges from traces' },
  { key: 'model', label: 'Resolved model', detail: 'connectorConfig.model › env.ANTHROPIC_MODEL › --model arg' },
  { key: 'headerKeys', label: 'Header names', detail: 'sorted header KEY names only — values are credentials and never hashed' },
  { key: 'auth', label: 'Auth shape', detail: 'type, AWS region/service, header names, has-username/has-token — never the secrets' },
  { key: 'traceServiceName', label: 'Trace service name', detail: 'OTel service.name used for trace correlation' },
  { key: 'tracePolling', label: 'Trace polling', detail: 'trace-mode polling settings' },
  { key: 'connectorConfig', label: 'Connector config', detail: 'system/append prompt, allowed tools, args, MCP servers, trace context, … — secret-looking keys redacted, env maps reduced to key names (model selectors kept)' },
  { key: 'hooks', label: 'Hooks', detail: 'exact source text of each hook function (a reformat IS a change)' },
];
