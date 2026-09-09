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
 *   - `prompt`     — fingerprint differs AND prompt hash differs → at least
 *                    the prompt changed (other fields may have too).
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
    case 'prompt': return 'system prompt changed';
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
