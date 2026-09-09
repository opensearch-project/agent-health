/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-configuration provenance chips.
 *
 *   - {@link AgentFingerprintChip}: a mono 12-hex chip showing WHICH version
 *     of the agent's configuration a run was measured against, with the
 *     full fingerprint / prompt hash / config sha in the tooltip. Renders
 *     nothing for legacy runs that carry no fingerprint (no empty chips).
 *
 *   - {@link AgentConfigChangedBadge}: an amber warning shown when two runs
 *     of the SAME agent carry DIFFERENT fingerprints — the tooltip says
 *     whether the system prompt changed or something else in the connector
 *     config did. Renders nothing when the fingerprints match or either side
 *     is a legacy run (an "unknown" is not a warning).
 *
 * Both are pure presentational components — the classification lives in
 * lib/agentFingerprintDiff.ts so tests can pin it without a DOM.
 */

import React from 'react';
import { Fingerprint, AlertTriangle } from 'lucide-react';
import {
  classifyFingerprintDiff,
  describeFingerprintDiff,
  formatFingerprintTooltip,
  type FingerprintCarrier,
  type AgentConfigSource,
} from '@/lib/agentFingerprintDiff';

export interface AgentFingerprintChipProps {
  run: FingerprintCarrier & { agentFingerprintShort?: string; agentConfigSource?: AgentConfigSource };
  /** Compact = icon + 12 hex only; default adds a "config" label prefix. */
  compact?: boolean;
  className?: string;
  'data-testid'?: string;
}

export const AgentFingerprintChip: React.FC<AgentFingerprintChipProps> = ({
  run,
  compact = false,
  className = '',
  'data-testid': testId = 'agent-fingerprint-chip',
}) => {
  if (!run?.agentFingerprint) return null;
  const short = run.agentFingerprintShort || run.agentFingerprint.slice(0, 12);
  return (
    <span
      data-testid={testId}
      data-fingerprint={run.agentFingerprint}
      data-prompt-hash={run.agentPromptHash ?? ''}
      title={formatFingerprintTooltip(run)}
      className={`inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0 font-mono text-[10px] leading-4 text-muted-foreground cursor-help ${className}`}
    >
      <Fingerprint size={10} className="shrink-0 opacity-70" aria-hidden="true" />
      {!compact && <span className="font-sans not-italic">config</span>}
      <span>{short}</span>
    </span>
  );
};

export interface AgentConfigChangedBadgeProps {
  a: (FingerprintCarrier & { agentKey?: string }) | null | undefined;
  b: (FingerprintCarrier & { agentKey?: string }) | null | undefined;
  /** Wording variant: the scoreboard says "between runs", the re-run chip "since source run". */
  wording?: 'between-runs' | 'since-source';
  className?: string;
  'data-testid'?: string;
}

export const AgentConfigChangedBadge: React.FC<AgentConfigChangedBadgeProps> = ({
  a,
  b,
  wording = 'between-runs',
  className = '',
  'data-testid': testId = 'agent-config-changed-badge',
}) => {
  if (!a || !b) return null;
  // Only meaningful for the SAME agent — two different agents are expected
  // to have different configs; that's the comparison, not a warning.
  if (a.agentKey && b.agentKey && a.agentKey !== b.agentKey) return null;
  const kind = classifyFingerprintDiff(a, b);
  if (kind === 'same' || kind === 'unknown') return null;
  const label = wording === 'since-source' ? 'config changed since source run' : 'config changed between runs';
  const tooltip = [
    `Same agent, different configuration: ${describeFingerprintDiff(kind)}.`,
    `A: ${a.agentFingerprint} (prompt ${a.agentPromptHash?.slice(0, 12) ?? 'n/a'})`,
    `B: ${b.agentFingerprint} (prompt ${b.agentPromptHash?.slice(0, 12) ?? 'n/a'})`,
  ].join('\n');
  return (
    <span
      data-testid={testId}
      data-diff-kind={kind}
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] leading-4 text-amber-600 dark:text-amber-400 cursor-help whitespace-nowrap ${className}`}
    >
      <AlertTriangle size={10} className="shrink-0" aria-hidden="true" />
      <span>{label}</span>
      <span className="opacity-80">· {kind === 'prompt' ? 'incl. prompt' : 'other fields'}</span>
    </span>
  );
};
