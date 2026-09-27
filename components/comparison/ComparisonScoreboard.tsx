/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChevronUp, ExternalLink, X, ArrowUpDown } from 'lucide-react';
import { cn, formatRelativeTime, getModelName } from '@/lib/utils';
import { formatCost, formatDuration, formatTokens } from '@/services/metrics';
import type { RunAggregateMetrics, BenchmarkRun, RunScoringSummary } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';
import { runReportPath } from '@/lib/runReportPath';
import {
  avgScoreTooltip,
  formatMetricInScale,
  formatPassRateDetail,
  judgeCaption,
  passRateHeaderLabel,
  runPassPolicyLabel,
  type ScoringComparability,
} from '@/lib/comparison/scoringDisplay';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ComparisonScoreboardProps {
  runs: RunAggregateMetrics[];
  /** The raw selected runs (kept for callers; the judge caption now reads the resolved judge off `runs`). */
  selectedRuns?: BenchmarkRun[];
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
  /**
   * Coverage gate (see lib/comparison/scoringDisplay.ts
   * assessScoringComparability): when the runs were scored differently the
   * Δ row is replaced by "Not comparable — different scoring" until the user
   * clicks "Compare anyway". Defaults to comparable so single-purpose callers
   * / older tests need not thread it.
   */
  comparability?: ScoringComparability;
  compareAnyway?: boolean;
  onCompareAnyway?: () => void;
}

// ─── Column definitions ──────────────────────────────────────────────────────

/**
 * Every scoreboard column header carries a one-line hover explanation
 * (owner: "each column should be explainable by a hover with a one line
 * description"). Kept as data so tests can assert the exact wording.
 *
 * The pass-rate header is dynamic (it carries the verdict policy) and the
 * primary-metric columns come from the runs' scoring snapshots — see
 * {@link buildScoreboardColumns}. There is deliberately NO accuracy-only
 * column any more: "accuracy" is one evaluator's rubric name, not the score.
 */
export const SCOREBOARD_COLUMNS: ReadonlyArray<{ key: string; label: string; tooltip: string }> = [
  { key: 'run', label: 'Run', tooltip: 'Run name — click to open the run report' },
  { key: 'passRate', label: 'Pass rate', tooltip: 'Passed ÷ evaluated cases (errored cases excluded); the parenthesis names the verdict policy' },
  { key: 'avgScore', label: 'Avg score', tooltip: 'Mean of each case\'s weighted rubric score per its scoring snapshot (0–100); "—" for runs judged before scoring snapshots existed' },
  { key: 'cost', label: 'Cost', tooltip: 'Total LLM cost across all test cases in the run' },
  { key: 'avgDuration', label: 'Avg Duration', tooltip: 'Mean wall-clock duration per test case' },
  { key: 'tokens', label: 'Tokens', tooltip: 'Total tokens across all test cases' },
  { key: 'llmCalls', label: 'LLM Calls', tooltip: 'Total LLM calls across all test cases' },
  { key: 'toolCalls', label: 'Tool Calls', tooltip: 'Total tool invocations across all test cases' },
  { key: 'coverage', label: 'Coverage', tooltip: 'Test cases this run shares with the comparison set' },
];

export interface ScoreboardColumn { key: string; label: string; tooltip: string; primaryMetric?: string }

/**
 * Column list for a given run set: the static columns with the pass-rate
 * header labelled by policy, plus one column per primary metric any run's
 * snapshot declares (inserted after "Avg score", declaration order, names
 * passed through verbatim — nothing here knows what "Hit@1" means).
 */
export function buildScoreboardColumns(runs: ReadonlyArray<RunAggregateMetrics>): ScoreboardColumn[] {
  const primaryNames: string[] = [];
  for (const run of runs) {
    const scoring = scoringOf(run);
    if (scoring.source !== 'snapshot') continue;
    for (const pm of scoring.primaryMetrics) if (!primaryNames.includes(pm.name)) primaryNames.push(pm.name);
  }
  const out: ScoreboardColumn[] = [];
  for (const col of SCOREBOARD_COLUMNS) {
    if (col.key === 'passRate') out.push({ ...col, label: passRateHeaderLabel(runs) });
    else out.push({ ...col });
    if (col.key === 'avgScore') {
      for (const name of primaryNames) {
        out.push({
          key: `primary:${name}`,
          label: name,
          tooltip: `Run-level mean of the evaluator-declared primary metric "${name}" (raw scale)`,
          primaryMetric: name,
        });
      }
    }
  }
  return out;
}

/** Runs built before `scoring` existed (or partial fixtures) read as legacy. */
const scoringOf = (run: Pick<RunAggregateMetrics, 'scoring'>): RunScoringSummary => run.scoring ?? { source: 'legacy' };

/** Label under the "—" of a legacy-scored run. */
export const LEGACY_SCORING_LABEL = 'legacy scoring';
/** Δ-row text when the coverage gate blocks the aggregate comparison. */
export const NOT_COMPARABLE_LABEL = 'Not comparable — different scoring';

/** Tooltip on the delta footer's row label. */
export const DELTA_ROW_TOOLTIP = 'A minus B per column; blue/green when A is better on that metric, red when worse';

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

/**
 * Honesty markers for the trace-derived cells (Cost / Tokens / LLM Calls /
 * Tool Calls). A run whose trace query hit its size cap is a LOWER bound, so
 * it renders with a `≥` prefix; a run correlated (at least partly) by the
 * service.name + time-window fallback rather than precise ids says so in the
 * tooltip — both are real data, neither should read as exact truth.
 */
const traceCellPrefix = (
  run: Pick<RunAggregateMetrics, 'traceMetricsPartial'>,
  value: number | undefined
): string => (value !== undefined && run.traceMetricsPartial ? '≥' : '');

const traceCellTitle = (
  run: Pick<RunAggregateMetrics, 'traceMetricsPartial' | 'traceMetricsWindowCorrelated'>
): string | undefined => {
  const notes: string[] = [];
  if (run.traceMetricsPartial) notes.push('Lower bound: the trace query hit its size cap, so some spans may be missing.');
  if (run.traceMetricsWindowCorrelated) notes.push('Correlated by the agent\'s service name + run time window (no precise run id on some reports); may include unrelated traffic of the same service.');
  return notes.length > 0 ? notes.join(' ') : undefined;
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
 * Judge info is shown exactly ONCE — a single muted line. It names the JUDGE
 * that produced the verdicts (resolved per report: `report.judgeModel` →
 * `llmJudgeResponse.modelId` → `judgeModelId` → run.judgeModelId; see
 * lib/comparison/scoringDisplay.ts), never the agent model under test — the
 * old caption read `run.modelId` and labelled the agent as the judge. Same
 * judge across all runs collapses to one name; differing judges show both,
 * labelled A/B. A run whose reports resolved to several judges reads
 * "mixed (a · b)"; runs with no judge information at all read "not recorded"
 * — an honest blank, never the agent model standing in.
 */
const JudgeLine: React.FC<{ runs: RunAggregateMetrics[] }> = ({ runs }) => {
  const captions = runs.slice(0, 2).map(r => judgeCaption(r, getModelName));
  if (captions.length === 0) return null;
  const allSame = captions.every(c => c === captions[0]);

  return (
    <div className="px-4 py-1.5 text-[11px] text-muted-foreground" data-testid="scoreboard-judge-line">
      {allSame ? (
        <span>Judge: {captions[0]}</span>
      ) : (
        <span>
          Judge: A {captions[0]}
          {captions.length > 1 && <> · B {captions[1]}</>}
        </span>
      )}
    </div>
  );
};

/** Δ cell shared by the numeric footer columns. */
const DeltaCell: React.FC<{
  testId: string;
  delta: number | undefined;
  text: string;
  betterWhenLower?: boolean;
  title?: string;
}> = ({ testId, delta, text, betterWhenLower = false, title }) => {
  if (delta === undefined) return null;
  const good = betterWhenLower ? delta < 0 : delta > 0;
  const bad = betterWhenLower ? delta > 0 : delta < 0;
  return (
    <span
      data-testid={testId}
      className={cn(
        'tabular-nums text-[11px]',
        good ? (betterWhenLower ? 'text-green-400' : 'text-blue-400') : bad ? 'text-red-400' : 'text-muted-foreground'
      )}
      title={delta === 0 ? 'No change' : title}
    >
      {text}
    </span>
  );
};

// ─── Main ComparisonScoreboard ───────────────────────────────────────────────

export const ComparisonScoreboard: React.FC<ComparisonScoreboardProps> = ({
  runs,
  overlap,
  runBenchmarkIdById,
  onRemoveRun,
  onSwapRuns,
  getAgentName,
  comparability = { comparable: true, reasons: [] },
  compareAnyway = false,
  onCompareAnyway,
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
  const columns = buildScoreboardColumns(runs);
  const passRateDelta = runB ? runA.passRatePercent - runB.passRatePercent : 0;
  // Only defined when BOTH runs are snapshot-scored; a legacy run has no
  // score to diff against (and the coverage gate below blocks the row when
  // the two snapshots differ).
  const avgScoreDelta = (runB && runA.avgScore !== undefined && runB.avgScore !== undefined)
    ? runA.avgScore - runB.avgScore
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
  const deltaBlocked = !!runB && !comparability.comparable && !compareAnyway;
  // Tooltip caveat on the Δ cells: why an overridden comparison is shaky, or
  // that two legacy runs carry no scoring provenance at all.
  const bothLegacy = !!runB && runs.slice(0, 2).every(r => scoringOf(r).source === 'legacy');
  const deltaCaveat = compareAnyway && !comparability.comparable
    ? `Compared anyway — ${comparability.reasons.join(' · ')}`
    : bothLegacy
      ? 'Both runs are legacy-scored: evaluator version and verdict policy were not recorded, so this Δ compares two opaque judge-verdict streams.'
      : undefined;
  const primaryMean = (run: RunAggregateMetrics, name: string) => {
    const scoring = scoringOf(run);
    return scoring.source === 'snapshot' ? scoring.primaryMetrics.find(pm => pm.name === name) : undefined;
  };
  // Coverage wording: "same case IDs" is all that identical test-case sets
  // prove. Only when the scoring snapshots AND test-case versions also match
  // may the cell claim "same cases, same scoring".
  const sameScoring = overlap.fullyOverlapping && comparability.comparable
    && runs.slice(0, 2).every(r => scoringOf(r).source === 'snapshot');

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
                    {columns.map(col => (
                      <th
                        key={col.key}
                        data-testid={`scoreboard-col-${col.key}`}
                        title={col.tooltip}
                        className={cn(
                          'py-2 cursor-help',
                          col.key === 'run' ? 'px-4 text-left w-[240px]' : 'px-3 text-right'
                        )}
                      >
                        {col.label}
                      </th>
                    ))}
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
                              <Link
                                to={runReportPath(run.runId, benchmarkId)}
                                data-testid={`run-name-link-${run.runId}`}
                                title={run.runName || getAgentName(run.agentKey)}
                                className="block font-medium text-[12px] truncate max-w-[220px] hover:text-blue-400 hover:underline transition-colors"
                              >
                                {run.runName || getAgentName(run.agentKey)}
                              </Link>
                              <div className="text-muted-foreground text-[10px] truncate max-w-[220px]">
                                {getAgentName(run.agentKey)} — {getModelName(run.modelId)} · {formatRelativeTime(run.createdAt)}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right relative">
                          <MicroBar percent={run.passRatePercent} color={barColor} />
                          <div className="relative" title={`Pass rate (${runPassPolicyLabel(scoringOf(run))}): passed ÷ evaluated cases; errored cases are excluded from the denominator`}>
                            <span
                              data-testid={`run-passrate-${run.runId}`}
                              className="font-semibold tabular-nums"
                            >
                              {formatPercent(run.passRatePercent)}
                            </span>
                            <div
                              data-testid={`run-passrate-detail-${run.runId}`}
                              className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap"
                            >
                              {formatPassRateDetail(run)}
                            </div>
                          </div>
                        </td>
                        <td
                          className="px-3 py-2 text-right tabular-nums cursor-help"
                          data-testid={`run-avgscore-${run.runId}`}
                          title={avgScoreTooltip(scoringOf(run))}
                        >
                          {scoringOf(run).source === 'snapshot' && run.avgScore !== undefined ? (
                            formatPercent(run.avgScore)
                          ) : (
                            <span className="inline-flex flex-col items-end leading-tight">
                              <span>—</span>
                              <span
                                className="text-[9px] text-muted-foreground/80 normal-case tracking-normal"
                                data-testid={`run-avgscore-legacy-${run.runId}`}
                              >
                                {LEGACY_SCORING_LABEL}
                              </span>
                            </span>
                          )}
                        </td>
                        {columns.filter(c => c.primaryMetric).map(col => {
                          const pm = primaryMean(run, col.primaryMetric as string);
                          return (
                            <td
                              key={col.key}
                              className="px-3 py-2 text-right tabular-nums"
                              data-testid={`run-primary-${col.primaryMetric}-${run.runId}`}
                              title={pm ? `Mean ${col.primaryMetric} over evaluated cases (raw scale ${pm.scale.min}–${pm.scale.max})` : `${col.primaryMetric} not declared by this run's scoring snapshot`}
                            >
                              {pm ? formatMetricInScale(pm.mean, pm.scale) : '—'}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`run-cost-${run.runId}`} title={traceCellTitle(run)}>
                          {traceCellPrefix(run, run.totalCostUsd)}{formatCostSafe(run.totalCostUsd)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`run-duration-${run.runId}`}>
                          {formatDurationSafe(run.avgDurationMs)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`run-tokens-${run.runId}`} title={traceCellTitle(run)}>
                          {traceCellPrefix(run, run.totalTokens)}{formatTokensSafe(run.totalTokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`run-llmcalls-${run.runId}`} title={traceCellTitle(run)}>
                          {traceCellPrefix(run, run.totalLlmCalls)}{formatCountSafe(run.totalLlmCalls)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`run-toolcalls-${run.runId}`} title={traceCellTitle(run)}>
                          {traceCellPrefix(run, run.totalToolCalls)}{formatCountSafe(run.totalToolCalls)}
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
                                  ? `All ${overlap.runCount} runs ran the same ${overlap.totalTestCases} test case${overlap.totalTestCases === 1 ? '' : 's'} — ${sameScoring ? 'same cases, same scoring.' : 'same case IDs (scoring provenance not verified to match).'}`
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
                                <span className={sameScoring ? 'text-green-400' : 'text-muted-foreground'}>
                                  {overlap.sharedTestCases} in both, {sameScoring ? 'same cases, same scoring' : 'same case IDs'}
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
                              to={runReportPath(run.runId, benchmarkId)}
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
                        <span
                          className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-help"
                          data-testid="scoreboard-delta-label"
                          title={DELTA_ROW_TOOLTIP}
                        >
                          Delta
                        </span>
                        <button
                          onClick={onSwapRuns}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Swap A/B"
                        >
                          <ArrowUpDown size={11} />
                        </button>
                      </div>
                    </td>
                    {deltaBlocked ? (
                      <td className="px-3 py-1.5 text-left" colSpan={columns.length}>
                        <span className="inline-flex items-center gap-2 text-[11px]">
                          <span
                            data-testid="scoreboard-delta-blocked"
                            className="text-amber-400 cursor-help"
                            title={comparability.reasons.join(' · ')}
                          >
                            {NOT_COMPARABLE_LABEL}
                          </span>
                          {onCompareAnyway && (
                            <button
                              type="button"
                              data-testid="scoreboard-compare-anyway"
                              onClick={onCompareAnyway}
                              className="text-[10px] underline text-muted-foreground hover:text-foreground"
                              title="Show the Δ row even though the runs were scored differently (remembered for this browser session)"
                            >
                              Compare anyway
                            </button>
                          )}
                        </span>
                      </td>
                    ) : (
                      <>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        data-testid="scoreboard-delta-passrate"
                        className={cn(
                          'font-semibold tabular-nums text-[11px]',
                          passRateDelta > 0 ? 'text-blue-400' : passRateDelta < 0 ? 'text-red-400' : 'text-muted-foreground'
                        )}
                        title={passRateDelta === 0 ? 'No change' : deltaCaveat}
                      >
                        {formatDelta(runA.passRatePercent, runB.passRatePercent, 'pp')}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId="scoreboard-delta-avgscore"
                        delta={avgScoreDelta}
                        text={formatDelta(runA.avgScore, runB.avgScore)}
                        title={deltaCaveat ?? 'A minus B, both from scoring snapshots'}
                      />
                    </td>
                    {columns.filter(c => c.primaryMetric).map(col => {
                      const a = primaryMean(runA, col.primaryMetric as string);
                      const b = primaryMean(runB, col.primaryMetric as string);
                      const d = a?.mean !== undefined && b?.mean !== undefined ? a.mean - b.mean : undefined;
                      return (
                        <td key={col.key} className="px-3 py-1.5 text-right">
                          <DeltaCell
                            testId={`scoreboard-delta-primary-${col.primaryMetric}`}
                            delta={d}
                            text={d === undefined ? '' : d === 0 ? '—' : `${d > 0 ? '+' : ''}${formatMetricInScale(d, a!.scale).replace(/^—$/, '')}`}
                          />
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId="scoreboard-delta-cost"
                        delta={costDelta}
                        betterWhenLower
                        text={costDelta === undefined ? '' : costDelta === 0 ? '—' : (costDelta > 0 ? '+' : '') + formatCost(costDelta)}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId="scoreboard-delta-duration"
                        delta={durationDelta}
                        betterWhenLower
                        text={durationDelta === undefined ? '' : durationDelta === 0 ? '—' : (durationDelta > 0 ? '+' : '-') + formatDuration(Math.abs(durationDelta))}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId="scoreboard-delta-tokens"
                        delta={tokensDelta}
                        betterWhenLower
                        text={tokensDelta === undefined ? '' : tokensDelta === 0 ? '—' : (tokensDelta > 0 ? '+' : '-') + formatTokens(Math.abs(tokensDelta))}
                      />
                    </td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-2 py-1.5"></td>
                      </>
                    )}
                  </tr>
                </tfoot>
                )}
              </table>
            </div>

            {/* Judge info — once, not per-row (replaces the old per-run drawer). */}
            <div className="border-t border-border/50">
              <JudgeLine runs={runs} />
            </div>
          </>
        )}
      </div>
    </>
  );
};
