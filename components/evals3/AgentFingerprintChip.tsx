/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-configuration provenance chips.
 *
 *   - {@link AgentFingerprintChip}: a labelled mono chip ("config ·
 *     b8692d59c93a") showing WHICH version of the agent's configuration a
 *     run was measured against. Hover: a short tooltip. Click: a details
 *     popover that says what the hash is (a SHA-256 of the agent's resolved
 *     configuration — NOT a git commit), what it was computed from, what
 *     the run actually recorded (agent key, model, config file + the git
 *     commit of the repository containing it), how to recompute it from the
 *     local config (CLI / API), and a live "compare with current config"
 *     check. Renders nothing for legacy runs by default (no empty chips in
 *     a 50-row list); `showMissing` renders an explicit "not recorded" chip
 *     for the places where silence would be ambiguous (run headers).
 *
 *     Why the always-on label (2026-10-22): the owner read the bare 12-hex
 *     chip as a commit SHA. A fingerprint with no word next to it IS
 *     indistinguishable from one.
 *
 *   - {@link AgentConfigChangedBadge}: an amber warning shown when two runs
 *     of the SAME agent carry DIFFERENT fingerprints — the tooltip says
 *     whether the system prompt changed or something else in the connector
 *     config did. Renders nothing when the fingerprints match or either side
 *     is a legacy run (an "unknown" is not a warning).
 *
 * Both are presentational — the classification lives in
 * lib/agentFingerprintDiff.ts so tests can pin it without a DOM.
 */

import React, { useCallback, useState } from 'react';
import { Fingerprint, AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CopyButton } from '@/components/ui/copy-button';
import { ENV_CONFIG } from '@/lib/config';
import {
  classifyFingerprintDiff,
  describeFingerprintDiff,
  formatFingerprintTooltip,
  FINGERPRINT_INPUT_FIELDS,
  type FingerprintCarrier,
  type FingerprintDiffKind,
  type AgentConfigSource,
} from '@/lib/agentFingerprintDiff';

/** The run fields the chip reads. Every one optional: legacy docs carry none. */
export type FingerprintChipRun = FingerprintCarrier & {
  agentFingerprintShort?: string;
  agentConfigSource?: AgentConfigSource;
  agentKey?: string;
  modelId?: string;
  agentEndpoint?: string;
};

export interface AgentFingerprintChipProps {
  run: FingerprintChipRun | null | undefined;
  /**
   * Render an explicit muted "config · not recorded" chip when the run has
   * no fingerprint (runs created before provenance was recorded). Default
   * off: lists stay quiet, headers opt in.
   */
  showMissing?: boolean;
  className?: string;
  'data-testid'?: string;
}

const CHIP_CLASS = 'inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0 font-mono text-[10px] leading-4 text-muted-foreground';

export const AgentFingerprintChip: React.FC<AgentFingerprintChipProps> = ({
  run,
  showMissing = false,
  className = '',
  'data-testid': testId = 'agent-fingerprint-chip',
}) => {
  if (!run?.agentFingerprint) {
    if (!showMissing) return null;
    return (
      <span
        data-testid={`${testId}-missing`}
        title="Agent configuration fingerprint not recorded — this run was created before agent-health stamped runs with a config fingerprint, so there is nothing to compare against."
        className={`${CHIP_CLASS} italic cursor-help ${className}`}
      >
        <Fingerprint size={10} className="shrink-0 opacity-50" aria-hidden="true" />
        <span className="font-sans not-italic">config</span>
        <span className="font-sans">not recorded</span>
      </span>
    );
  }
  const short = run.agentFingerprintShort || run.agentFingerprint.slice(0, 12);
  return (
    <Popover>
      <PopoverTrigger>
        <button
          type="button"
          data-testid={testId}
          data-fingerprint={run.agentFingerprint}
          data-prompt-hash={run.agentPromptHash ?? ''}
          title={`${formatFingerprintTooltip(run)}\nClick for what this hash covers and how to find it in your config.`}
          onClick={e => e.stopPropagation()}
          className={`${CHIP_CLASS} cursor-pointer hover:border-border hover:text-foreground ${className}`}
        >
          <Fingerprint size={10} className="shrink-0 opacity-70" aria-hidden="true" />
          <span className="font-sans">config</span>
          <span>{short}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[440px] max-h-[min(80vh,640px)] overflow-y-auto p-0 text-xs" onClick={e => e.stopPropagation()}>
        <AgentFingerprintDetails run={run} data-testid={`${testId}-details`} />
      </PopoverContent>
    </Popover>
  );
};

// ─── Details popover ─────────────────────────────────────────────────────────

type LiveCheck =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; kind: FingerprintDiffKind; current: FingerprintCarrier & { agentFingerprintShort?: string } }
  | { state: 'unknown-agent' }
  | { state: 'error'; message: string };

export const AgentFingerprintDetails: React.FC<{ run: FingerprintChipRun; 'data-testid'?: string }> = ({
  run,
  'data-testid': testId = 'agent-fingerprint-details',
}) => {
  const [live, setLive] = useState<LiveCheck>({ state: 'idle' });
  const agentKey = run.agentKey;
  const source = run.agentConfigSource;
  const cliCommand = `npx @opensearch-project/agent-health fingerprint ${agentKey ?? '<agent-key>'}`;

  const compareWithCurrent = useCallback(async () => {
    if (!agentKey) return;
    setLive({ state: 'loading' });
    try {
      const res = await fetch(`${ENV_CONFIG.backendUrl}/api/agents/${encodeURIComponent(agentKey)}/fingerprint`);
      if (res.status === 404) { setLive({ state: 'unknown-agent' }); return; }
      if (!res.ok) { setLive({ state: 'error', message: `HTTP ${res.status}` }); return; }
      const current = await res.json() as FingerprintCarrier & { agentFingerprintShort?: string };
      setLive({ state: 'done', kind: classifyFingerprintDiff(run, current), current });
    } catch (err: any) {
      setLive({ state: 'error', message: err?.message || 'request failed' });
    }
  }, [agentKey, run]);

  return (
    <div data-testid={testId} className="flex flex-col divide-y divide-border/60">
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Fingerprint size={12} aria-hidden="true" />
          Agent configuration fingerprint
        </div>
        <p className="mt-1 text-muted-foreground leading-snug">
          A SHA-256 of this agent&apos;s configuration as resolved when the run started —
          <strong className="text-foreground font-medium"> not a git commit</strong>. Two runs of the same agent
          with the same fingerprint were measured against an identical (secret-redacted) config;
          a different fingerprint means the prompt, model, tools or another connector field changed.
        </p>
      </div>

      <dl className="px-3 py-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">Fingerprint</dt>
        <dd className="font-mono break-all flex items-start gap-1" data-testid={`${testId}-fingerprint`}>
          <span>{run.agentFingerprint}</span>
          <CopyButton value={run.agentFingerprint!} title="Copy fingerprint" />
        </dd>
        <dt className="text-muted-foreground">Prompt hash</dt>
        <dd className="font-mono break-all" data-testid={`${testId}-prompt-hash`}>
          {run.agentPromptHash ?? <span className="font-sans text-muted-foreground">no system prompt recorded</span>}
        </dd>
        {agentKey && (<>
          <dt className="text-muted-foreground">Agent key</dt>
          <dd className="font-mono" data-testid={`${testId}-agent-key`}>{agentKey}</dd>
        </>)}
        {run.modelId && (<>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono">{run.modelId}</dd>
        </>)}
        {run.agentEndpoint && (<>
          <dt className="text-muted-foreground">Endpoint override</dt>
          <dd className="font-mono break-all">{run.agentEndpoint}</dd>
        </>)}
        {source?.path && (<>
          <dt className="text-muted-foreground">Config file</dt>
          <dd className="font-mono break-all" data-testid={`${testId}-config-path`}>{source.path}</dd>
          <dt className="text-muted-foreground">Config repo commit</dt>
          <dd className="font-mono break-all" data-testid={`${testId}-config-sha`}>
            {source.gitSha ?? <span className="font-sans text-muted-foreground">not a git checkout</span>}
            {source.dirty && <span className="font-sans text-amber-600 dark:text-amber-400"> · config file had uncommitted edits</span>}
          </dd>
        </>)}
      </dl>
      {source?.path && (
        <p className="px-3 pb-2 -mt-1 text-[10px] text-muted-foreground leading-snug">
          &ldquo;Config repo commit&rdquo; is <code>git rev-parse HEAD</code> of the repository containing the config file
          when the run started — the commit you can check out to see this configuration (unless it had uncommitted edits).
        </p>
      )}

      <div className="px-3 py-2">
        <div className="font-medium text-foreground">What was hashed</div>
        <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground leading-snug" data-testid={`${testId}-inputs`}>
          {FINGERPRINT_INPUT_FIELDS.filter(f => f.key !== 'v').map(f => (
            <li key={f.key} data-input-key={f.key}>
              <span className="text-foreground">{f.label}</span> — {f.detail}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[10px] text-muted-foreground leading-snug">
          Header values, auth secrets and env values are redacted before hashing; rotating a credential does not change the fingerprint.
          The inputs themselves are not stored on the run — only the hashes above. Recompute them from your config:
        </p>
      </div>

      <div className="px-3 py-2">
        <div className="font-medium text-foreground">Find it in your code</div>
        <div className="mt-1 flex items-center gap-1 font-mono text-[11px] bg-muted/40 rounded px-1.5 py-1 break-all" data-testid={`${testId}-cli`}>
          <span className="flex-1">{cliCommand}</span>
          <CopyButton value={cliCommand} title="Copy command" />
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
          Prints the fingerprint of <code>{agentKey ?? 'the agent'}</code> as configured in your local <code>agent-health.config.ts</code>
          (add <code>--payload</code> to see the exact redacted inputs). Same data via <code>GET /api/agents/{agentKey ?? '<key>'}/fingerprint</code>.
          Edit the config, re-run the command, and watch which hash moves.
        </p>
        {agentKey && (
          <div className="mt-2 flex flex-col items-start gap-1">
            <button
              type="button"
              onClick={compareWithCurrent}
              disabled={live.state === 'loading'}
              data-testid={`${testId}-compare`}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted/60 disabled:opacity-60"
            >
              {live.state === 'loading' ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={10} aria-hidden="true" />}
              Compare with this server&apos;s current config
            </button>
            <span className="text-[11px] leading-snug" data-testid={`${testId}-compare-result`} data-state={live.state} data-kind={live.state === 'done' ? live.kind : undefined}>
              {live.state === 'done' && live.kind === 'same' && (
                <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400"><Check size={10} aria-hidden="true" /> matches the current config</span>
              )}
              {live.state === 'done' && live.kind !== 'same' && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" title={`Current: ${live.current.agentFingerprint}`}>
                  <AlertTriangle size={10} aria-hidden="true" /> current config differs ({live.current.agentFingerprintShort ?? live.current.agentFingerprint?.slice(0, 12)}): {describeFingerprintDiff(live.kind)}
                </span>
              )}
              {live.state === 'unknown-agent' && <span className="text-muted-foreground">agent &ldquo;{agentKey}&rdquo; is not in this server&apos;s config</span>}
              {live.state === 'error' && <span className="text-red-500">could not compare: {live.message}</span>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Mismatch badge ──────────────────────────────────────────────────────────

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
