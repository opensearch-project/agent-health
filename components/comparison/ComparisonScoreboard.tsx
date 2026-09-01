/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChevronUp, ExternalLink, X, ArrowUpDown } from 'lucide-react';
import { cn, formatRelativeTime, getModelName } from '@/lib/utils';
import { formatCost, formatDuration, formatTokens } from '@/services/metrics';
import type { RunAggregateMetrics, BenchmarkRun } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ComparisonScoreboardProps {
  runs: RunAggregateMetrics[];
  selectedRuns: BenchmarkRun[];
  overlap: TestCaseOverlap;
  /**
   * runId -> benchmarkId lookup (undefined for ad-hoc/eval-runs). Benchmark
   * runs deep-link to /evaluations/benchmarks/:benchmarkId/runs/:runId — the
   * bare /evaluations/runs/:runId route resolves only the SDK eval-run store
   * and 404s for benchmark run ids.
   */
  runBenchmarkIdById?: Map<string, string | undefined>;
  onRemoveRun: (id: string) => void;
  onSwapRuns: () => void;
  getAgentName: (key: string) => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const formatPercent = (v: number | undefined): string =>
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

const formatTokensSafe = (v: number | undefined): string => {
  if (v === undefined) return '--';
  return formatTokens(v);
};

const formatCountSafe = (v: number | undefined): string => {
  if (v === undefined) return '--';
  return v.toLocaleString();
};

const formatDelta = (a: number | undefined, b: number | undefined, suffix = ''): string => {
  if (a === undefined || b === undefined) return '';
  const diff = a - b;
  if (diff === 0) return '—';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${Math.round(diff)}${suffix}`;
};

/**
 * Coverage cell label — owner feedback: "how many tests are tested in both
 * — Coverage column is confusing". Reworded from "N shared / M total" to a
 * plain statement of overlap, naming WHICH side carries the extra cases (the
 * common real-world shape: a small smoke run vs. a full benchmark run), e.g.
 * "6 in both · 56 only in A". Falls back to just "N in both" if, unusually,
 * neither side has any test cases the other lacks (shouldn't happen once
 * `fullyOverlapping` is false, but stay defensive).
 */
const formatCoverageLabel = (overlap: TestCaseOverlap): string => {
  const parts = [`${overlap.sharedTestCases} in both`];
  overlap.perRun.slice(0, 2).forEach((r, i) => {
    if (r.uniqueCount > 0) parts.push(`${r.uniqueCount} only in ${i === 0 ? 'A' : 'B'}`);
  });
  return parts.join(' · ');
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
  const deltaStr = delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${Math.round(delta)}pp`;

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs" data-testid="scoreboard-condensed">
      <span className="inline-flex items-center gap-1">
        <RunBadgeA /> <span className="font-medium">{getAgentName(a.agentKey)}</span>
        <span className="tabular-nums">{formatPercent(a.passRatePercent)}</span>
      </span>
      {b && (
        <>
          <span className="text-muted-foreground">vs</span>
          <span className="inline-flex items-center gap-1">
            <RunBadgeB /> <span className="font-medium">{getAgentName(b.agentKey)}</span>
            <span className="tabular-nums">{formatPercent(b.passRatePercent)}</span>
          </span>
          <span
            className={cn(
              'font-medium tabular-nums',
              delta > 0 ? 'text-blue-400' : delta < 0 ? 'text-red-400' : 'text-muted-foreground'
            )}
            title={delta === 0 ? 'No change' : undefined}
          >
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

// ─── Judge line ──────────────────────────────────────────────────────────────

/**
 * Judge info used to live per-row in an expandable drawer, duplicated once
 * per run. Owner feedback: show it exactly ONCE — a single muted line, not a
 * per-run dropdown. Same judge model across all selected runs collapses to
 * one name; differing judges show both, labeled A/B.
 */
const JudgeLine: React.FC<{ selectedRuns: BenchmarkRun[] }> = ({ selectedRuns }) => {
  const modelIds = selectedRuns.map(r => r.modelId).filter((m): m is string => !!m);
  if (modelIds.length === 0) return null;
  const allSame = modelIds.every(m => m === modelIds[0]);

  return (
    <div className="px-4 py-1.5 text-[11px] text-muted-foreground" data-testid="scoreboard-judge-line">
      {allSame ? (
        <span>Judge: {getModelName(modelIds[0])}</span>
      ) : (
        <span>
          Judge: A {getModelName(modelIds[0])}
          {modelIds[1] !== undefined && <> · B {getModelName(modelIds[1])}</>}
        </span>
      )}
    </div>
  );
};

// ─── Main ComparisonScoreboard ───────────────────────────────────────────────

export const ComparisonScoreboard: React.FC<ComparisonScoreboardProps> = ({
  runs,
  selectedRuns,
  overlap,
  runBenchmarkIdById,
  onRemoveRun,
  onSwapRuns,
  getAgentName,
}) => {
  const [isCondensed, setIsCondensed] = useState(false);
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

  // Single-run selections still get the scoreboard (just one row, no delta
  // footer / swap / judge-vs-judge line).
  if (runs.length === 0) return null;

  const [runA, runB] = runs;
  const passRateDelta = runB ? runA.passRatePercent - runB.passRatePercent : 0;
  const accuracyDelta = (runB && runA.avgAccuracy !== undefined && runB.avgAccuracy !== undefined)
    ? runA.avgAccuracy - runB.avgAccuracy
    : undefined;
  const costDelta = (runB && runA.totalCostUsd !== undefined && runB.totalCostUsd !== undefined)
    ? runA.totalCostUsd - runB.totalCostUsd
    : undefined;
  const durationDelta = (runB && runA.avgDurationMs !== undefined && runB.avgDurationMs !== undefined)
    ? runA.avgDurationMs - runB.avgDurationMs
    : undefined;
  const tokensDelta = (runB && runA.totalTokens !== undefined && runB.totalTokens !== undefined)
    ? runA.totalTokens - runB.totalTokens
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
            {/* Full scoreboard table — every RunAggregateMetrics metric lives
                on the run row itself now (no separate "All metrics" panel). */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 text-left w-[240px]">Run</th>
                    <th className="px-3 py-2 text-right">Pass Rate</th>
                    <th className="px-3 py-2 text-right">Avg Accuracy</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Avg Duration</th>
                    <th className="px-3 py-2 text-right">Tokens</th>
                    <th className="px-3 py-2 text-right">LLM Calls</th>
                    <th className="px-3 py-2 text-right">Tool Calls</th>
                    <th className="px-3 py-2 text-right">Coverage</th>
                    <th className="px-2 py-2 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 2).map((run, idx) => {
                    const label = idx === 0 ? 'A' : 'B';
                    const Badge = idx === 0 ? RunBadgeA : RunBadgeB;
                    const barColor = idx === 0 ? 'rgb(59,130,246)' : 'rgb(168,85,247)';
                    const benchmarkId = runBenchmarkIdById?.get(run.runId);

                    return (
                      <tr
                        key={run.runId}
                        className="hover:bg-muted/30 transition-colors group"
                        data-testid={`scoreboard-row-${label}`}
                      >
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Badge />
                            <div className="min-w-0">
                              {/* Run name leads (owner: "runs info should be
                                  communicated — what are we comparing here?") —
                                  agent/model/time move to a secondary line. */}
                              <div className="font-medium text-[12px] truncate max-w-[220px]" title={run.runName || getAgentName(run.agentKey)}>
                                {run.runName || getAgentName(run.agentKey)}
                              </div>
                              <div className="text-muted-foreground text-[10px] truncate max-w-[220px]">
                                {getAgentName(run.agentKey)} — {getModelName(run.modelId)} · {formatRelativeTime(run.createdAt)}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right relative">
                          <MicroBar percent={run.passRatePercent} color={barColor} />
                          <span
                            data-testid={`run-passrate-${run.runId}`}
                            className="relative font-semibold tabular-nums"
                          >
                            {formatPercent(run.passRatePercent)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span data-testid={`run-accuracy-${run.runId}`}>
                            {formatPercent(run.avgAccuracy)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCostSafe(run.totalCostUsd)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatDurationSafe(run.avgDurationMs)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatTokensSafe(run.totalTokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCountSafe(run.totalLlmCalls)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCountSafe(run.totalToolCalls)}
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
                                  {overlap.sharedTestCases} in both, fully comparable
                                </span>
                              ) : (
                                <span className="text-amber-400">
                                  {formatCoverageLabel(overlap)}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link
                              to={benchmarkId
                                ? `/evaluations/benchmarks/${benchmarkId}/runs/${run.runId}`
                                : `/evaluations/runs/${run.runId}`}
                              data-testid={`open-run-${run.runId}`}
                              title="Open run"
                              className="inline-flex items-center text-muted-foreground hover:text-blue-400 transition-colors"
                            >
                              <ExternalLink size={12} />
                            </Link>
                            <button
                              onClick={() => onRemoveRun(run.runId)}
                              title="Remove"
                              className="inline-flex items-center text-muted-foreground hover:text-red-400 transition-colors"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
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
                      <span
                        data-testid="scoreboard-delta-passrate"
                        className={cn(
                          'font-semibold tabular-nums text-[11px]',
                          passRateDelta > 0 ? 'text-blue-400' : passRateDelta < 0 ? 'text-red-400' : 'text-muted-foreground'
                        )}
                        title={passRateDelta === 0 ? 'No change' : undefined}
                      >
                        {formatDelta(runA.passRatePercent, runB.passRatePercent, 'pp')}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {accuracyDelta !== undefined && (
                        <span
                          data-testid="scoreboard-delta-accuracy"
                          className={cn(
                            'tabular-nums text-[11px]',
                            accuracyDelta > 0 ? 'text-blue-400' : accuracyDelta < 0 ? 'text-red-400' : 'text-muted-foreground'
                          )}
                          title={accuracyDelta === 0 ? 'No change' : undefined}
                        >
                          {formatDelta(runA.avgAccuracy, runB.avgAccuracy, 'pp')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {costDelta !== undefined && (
                        <span
                          data-testid="scoreboard-delta-cost"
                          className={cn(
                            'tabular-nums text-[11px]',
                            costDelta < 0 ? 'text-green-400' : costDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
                          )}
                          title={costDelta === 0 ? 'No change' : undefined}
                        >
                          {costDelta === 0 ? '—' : (costDelta > 0 ? '+' : '') + formatCost(costDelta)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {durationDelta !== undefined && (
                        <span
                          data-testid="scoreboard-delta-duration"
                          className={cn(
                            'tabular-nums text-[11px]',
                            durationDelta < 0 ? 'text-green-400' : durationDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
                          )}
                          title={durationDelta === 0 ? 'No change' : undefined}
                        >
                          {durationDelta === 0 ? '—' : (durationDelta > 0 ? '+' : '-') + formatDuration(Math.abs(durationDelta))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {tokensDelta !== undefined && (
                        <span
                          data-testid="scoreboard-delta-tokens"
                          className={cn(
                            'tabular-nums text-[11px]',
                            tokensDelta < 0 ? 'text-green-400' : tokensDelta > 0 ? 'text-red-400' : 'text-muted-foreground'
                          )}
                          title={tokensDelta === 0 ? 'No change' : undefined}
                        >
                          {tokensDelta === 0 ? '—' : (tokensDelta > 0 ? '+' : '-') + formatTokens(Math.abs(tokensDelta))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-2 py-1.5"></td>
                  </tr>
                </tfoot>
                )}
              </table>
            </div>

            {/* Judge info — once, not per-row (replaces the old per-run drawer). */}
            <div className="border-t border-border/50">
              <JudgeLine selectedRuns={selectedRuns} />
            </div>
          </>
        )}
      </div>
    </>
  );
};
