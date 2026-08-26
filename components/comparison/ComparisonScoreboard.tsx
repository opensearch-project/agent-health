/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ChevronUp, Copy, ExternalLink, X, ArrowUpDown, Grid2x2 } from 'lucide-react';
import { cn, formatRelativeTime, getModelName } from '@/lib/utils';
import { formatCost, formatDuration } from '@/services/metrics';
import { Button } from '@/components/ui/button';
import { MetricComparisonPanel } from './MetricComparisonPanel';
import type { RunAggregateMetrics, BenchmarkRun } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ComparisonScoreboardProps {
  runs: RunAggregateMetrics[];
  selectedRuns: BenchmarkRun[];
  overlap: TestCaseOverlap;
  onRemoveRun: (id: string) => void;
  onSwapRuns: () => void;
  getAgentName: (key: string) => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const formatPassRate = (v: number | undefined): string =>
  v !== undefined ? `${Math.round(v)}%` : '--';

const formatCostSafe = (v: number | undefined): string => {
  if (v === undefined) return '--';
  if (v === 0) return '$0.00';
  return formatCost(v);
};

const formatDurationSafe = (v: number | undefined): string => {
  if (v === undefined) return '--';
  return formatDuration(v);
};

const formatDelta = (a: number | undefined, b: number | undefined, suffix = ''): string => {
  if (a === undefined || b === undefined) return '';
  const diff = a - b;
  if (diff === 0) return '=';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${Math.round(diff)}${suffix}`;
};

// ─── Badge sub-components ────────────────────────────────────────────────────

const RunBadgeA: React.FC = () => (
  <span className="inline-flex items-center justify-center w-[14px] h-[14px] rounded bg-blue-500/20 text-blue-300 border border-blue-500/50 text-[9.5px] font-extrabold leading-none">
    A
  </span>
);

const RunBadgeB: React.FC = () => (
  <span className="inline-flex items-center justify-center w-[14px] h-[14px] rounded bg-purple-500/18 text-purple-300 border border-purple-400/50 text-[9.5px] font-extrabold leading-none">
    B
  </span>
);

// ─── Run detail drawer ───────────────────────────────────────────────────────

interface RunDetailDrawerProps {
  run: RunAggregateMetrics;
  selectedRun: BenchmarkRun;
  label: 'A' | 'B';
  getAgentName: (key: string) => string;
  onRemove: () => void;
}

const RunDetailDrawer: React.FC<RunDetailDrawerProps> = ({ run, selectedRun, label, getAgentName, onRemove }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // Best-effort: writeText() can reject (insecure context, missing
    // permission, unsupported browser). The "Copied" affordance is a nice-to-
    // have hint, not a critical action, so we swallow the rejection rather
    // than surface it — but it must be caught, or a failed copy becomes an
    // unhandled promise rejection.
    navigator.clipboard.writeText(run.runId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="px-4 py-2 bg-muted/30 border-t border-border/50 text-xs space-y-1">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="font-medium text-foreground">{run.runName || getAgentName(run.agentKey)}</span>
        <span>started {formatRelativeTime(run.createdAt)}</span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>Judge: {getModelName(selectedRun.modelId)}</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          {run.runId}
        </code>
        <button onClick={handleCopy} className="text-muted-foreground hover:text-foreground transition-colors" title="Copy run ID">
          <Copy size={11} />
        </button>
        {copied && <span className="text-[10px] text-green-400">Copied</span>}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Link
          to={`/evaluations/runs/${run.runId}`}
          className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"
        >
          <ExternalLink size={10} /> Open run
        </Link>
        <button
          onClick={onRemove}
          className="inline-flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 ml-auto"
        >
          <X size={10} /> Remove
        </button>
      </div>
    </div>
  );
};

// ─── Micro pass-rate bar ─────────────────────────────────────────────────────

const MicroBar: React.FC<{ percent: number; color: string }> = ({ percent, color }) => (
  <div className="absolute inset-0 pointer-events-none opacity-15">
    <div
      className="h-full rounded-sm transition-all duration-700"
      style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: color }}
    />
  </div>
);

// ─── Condensed one-liner ─────────────────────────────────────────────────────

interface CondensedBandProps {
  runs: RunAggregateMetrics[];
  overlap: TestCaseOverlap;
  getAgentName: (key: string) => string;
  onScrollTop: () => void;
}

const CondensedBand: React.FC<CondensedBandProps> = ({ runs, overlap, getAgentName, onScrollTop }) => {
  if (runs.length === 0) return null;
  const [a, b] = runs;
  const delta = b ? a.passRatePercent - b.passRatePercent : 0;
  const deltaStr = delta === 0 ? '=' : `${delta > 0 ? '+' : ''}${Math.round(delta)}pp`;

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs" data-testid="scoreboard-condensed">
      <span className="inline-flex items-center gap-1">
        <RunBadgeA /> <span className="font-medium">{getAgentName(a.agentKey)}</span>
        <span className="tabular-nums">{formatPassRate(a.passRatePercent)}</span>
      </span>
      {b && (
        <>
          <span className="text-muted-foreground">vs</span>
          <span className="inline-flex items-center gap-1">
            <RunBadgeB /> <span className="font-medium">{getAgentName(b.agentKey)}</span>
            <span className="tabular-nums">{formatPassRate(b.passRatePercent)}</span>
          </span>
          <span className={cn(
            'font-medium tabular-nums',
            delta > 0 ? 'text-blue-400' : delta < 0 ? 'text-red-400' : 'text-muted-foreground'
          )}>
            {deltaStr}
          </span>
        </>
      )}
      <span className="text-muted-foreground">
        {formatCostSafe(a.totalCostUsd)}{b ? ` vs ${formatCostSafe(b.totalCostUsd)}` : ''}
      </span>
      <span className="text-muted-foreground">
        {formatDurationSafe(a.avgDurationMs)}{b ? ` vs ${formatDurationSafe(b.avgDurationMs)}` : ''}
      </span>
      <span className="text-muted-foreground">
        {overlap.sharedTestCases} shared
      </span>
      <button
        onClick={onScrollTop}
        className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ChevronUp size={12} /> top
      </button>
    </div>
  );
};

// ─── Main ComparisonScoreboard ───────────────────────────────────────────────

export const ComparisonScoreboard: React.FC<ComparisonScoreboardProps> = ({
  runs,
  selectedRuns,
  overlap,
  onRemoveRun,
  onSwapRuns,
  getAgentName,
}) => {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [isCondensed, setIsCondensed] = useState(false);
  const [metricsExpanded, setMetricsExpanded] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver to detect scroll past the band
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    // No rootMargin: the sentinel sits at the band's anchor position, so it
    // leaves the (clipped) viewport exactly when the sticky band pins to the
    // top — condensing any earlier (e.g. a negative top margin) misfires as
    // "condensed on load" when the band starts within that distance of the
    // viewport top.
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsCondensed(!entry.isIntersecting);
      },
      { threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const handleScrollTop = useCallback(() => {
    // Scroll the SENTINEL (which sits just above the sticky band), not the
    // band itself — the band is already pinned in view while condensed, so
    // scrollIntoView on it is a no-op. Scrolling the sentinel back into view
    // moves the page past the sticky breakpoint, which is what actually
    // un-condenses the band (the IntersectionObserver picks up the sentinel
    // re-entering the viewport).
    sentinelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Single-run selections still get the scoreboard (run row + "All metrics"
  // expander) — the delta footer and swap only make sense for two runs.
  if (runs.length === 0) return null;

  const [runA, runB] = runs;
  const passRateDelta = runB ? runA.passRatePercent - runB.passRatePercent : 0;
  const costDelta = (runB && runA.totalCostUsd !== undefined && runB.totalCostUsd !== undefined)
    ? runA.totalCostUsd - runB.totalCostUsd
    : undefined;
  const durationDelta = (runB && runA.avgDurationMs !== undefined && runB.avgDurationMs !== undefined)
    ? runA.avgDurationMs - runB.avgDurationMs
    : undefined;

  return (
    <>
      {/* Sentinel for the IntersectionObserver — 1px tall (zero-area elements
          have flaky isIntersecting semantics), margin-cancelled so it doesn't
          shift layout. */}
      <div ref={sentinelRef} className="h-px w-full -mb-px pointer-events-none" aria-hidden="true" />

      <div
        ref={bandRef}
        className="sticky top-0 z-40 bg-card border border-border rounded-lg overflow-hidden"
        data-testid="comparison-scoreboard"
      >
        {isCondensed ? (
          <CondensedBand
            runs={runs}
            overlap={overlap}
            getAgentName={getAgentName}
            onScrollTop={handleScrollTop}
          />
        ) : (
          <>
            {/* Full scoreboard table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 text-left w-[200px]">Run</th>
                    <th className="px-3 py-2 text-right">Pass Rate</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Avg Duration</th>
                    <th className="px-3 py-2 text-right">Coverage</th>
                    <th className="px-2 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 2).map((run, idx) => {
                    const label = idx === 0 ? 'A' : 'B';
                    const isExpanded = expandedRow === run.runId;
                    const Badge = idx === 0 ? RunBadgeA : RunBadgeB;
                    const barColor = idx === 0 ? 'rgb(59,130,246)' : 'rgb(168,85,247)';

                    return (
                      <React.Fragment key={run.runId}>
                        <tr
                          className="cursor-pointer hover:bg-muted/30 transition-colors group"
                          onClick={() => setExpandedRow(isExpanded ? null : run.runId)}
                          data-testid={`scoreboard-row-${label}`}
                        >
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <Badge />
                              <span className="font-medium truncate max-w-[120px]">
                                {getAgentName(run.agentKey)}
                              </span>
                              <span className="text-muted-foreground text-[10px] truncate">
                                {getModelName(run.modelId)} · {formatRelativeTime(run.createdAt)}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right relative">
                            <MicroBar percent={run.passRatePercent} color={barColor} />
                            <span className="relative font-semibold tabular-nums">
                              {formatPassRate(run.passRatePercent)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatCostSafe(run.totalCostUsd)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatDurationSafe(run.avgDurationMs)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {idx === 0 && (
                              /* Carries the old ComparisonOverlapBanner contract
                                 (data-testid + data-overlap) — deep links and e2e
                                 gate on it. Per-run breakdown moves to the tooltip. */
                              <span
                                data-testid="comparison-overlap-banner"
                                data-overlap={overlap.fullyOverlapping ? 'full' : 'partial'}
                                className="text-muted-foreground cursor-help"
                                title={
                                  overlap.fullyOverlapping
                                    ? `All ${overlap.runCount} runs ran the same ${overlap.totalTestCases} test case${overlap.totalTestCases === 1 ? '' : 's'} — fully comparable.`
                                    : `${overlap.partialTestCases} case${overlap.partialTestCases === 1 ? '' : 's'} only in some runs (shown as "Not run" where skipped). ` +
                                      overlap.perRun
                                        .map(r => `${r.runName}: ${r.count} ran${r.uniqueCount > 0 ? `, ${r.uniqueCount} only here` : ''}`)
                                        .join(' · ')
                                }
                              >
                                {!runB ? (
                                  <span>
                                    {overlap.totalTestCases} case{overlap.totalTestCases === 1 ? '' : 's'}
                                  </span>
                                ) : overlap.fullyOverlapping ? (
                                  <span className="text-green-400">
                                    {overlap.sharedTestCases} shared, fully comparable
                                  </span>
                                ) : (
                                  <span className="text-amber-400">
                                    {overlap.sharedTestCases} shared / {overlap.totalTestCases} total
                                  </span>
                                )}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground">
                            <ChevronRight
                              size={12}
                              className={cn('transition-transform', isExpanded && 'rotate-90')}
                            />
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={6}>
                              <RunDetailDrawer
                                run={run}
                                selectedRun={selectedRuns[idx]}
                                label={label as 'A' | 'B'}
                                getAgentName={getAgentName}
                                onRemove={() => onRemoveRun(run.runId)}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                {/* Delta footer row — only meaningful for a two-run compare */}
                {runB && (
                <tfoot>
                  <tr className="border-t border-border/50 bg-muted/20">
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Delta</span>
                        <button
                          onClick={onSwapRuns}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Swap A/B"
                        >
                          <ArrowUpDown size={11} />
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={cn(
                        'font-semibold tabular-nums text-[11px]',
                        passRateDelta > 0 ? 'text-blue-400' : passRateDelta < 0 ? 'text-red-400' : 'text-muted-foreground'
                      )}>
                        {formatDelta(runA.passRatePercent, runB.passRatePercent, 'pp')}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {costDelta !== undefined && (
                        <span className={cn(
                          'tabular-nums text-[11px]',
                          costDelta < 0 ? 'text-green-400' : costDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
                        )}>
                          {costDelta === 0 ? '=' : (costDelta > 0 ? '+' : '') + formatCost(costDelta)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {durationDelta !== undefined && (
                        <span className={cn(
                          'tabular-nums text-[11px]',
                          durationDelta < 0 ? 'text-green-400' : durationDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
                        )}>
                          {durationDelta === 0 ? '=' : (durationDelta > 0 ? '+' : '-') + formatDuration(Math.abs(durationDelta))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-2 py-1.5"></td>
                  </tr>
                </tfoot>
                )}
              </table>
            </div>

            {/* "All metrics" expander */}
            <div className="border-t border-border/50">
              <button
                onClick={() => setMetricsExpanded(!metricsExpanded)}
                className="flex items-center gap-2 w-full text-left px-4 py-2 hover:bg-muted/30 transition-colors"
                data-testid="scoreboard-all-metrics-toggle"
              >
                <Grid2x2 size={12} className="text-muted-foreground" />
                <span className="text-[10px] font-medium">All metrics</span>
                <ChevronRight
                  size={12}
                  className={cn('text-muted-foreground transition-transform ml-auto', metricsExpanded && 'rotate-90')}
                />
              </button>
              {metricsExpanded && (
                <div className="px-4 pb-3">
                  <MetricComparisonPanel runs={runs} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
};
