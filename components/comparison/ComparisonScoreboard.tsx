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
  formatMetricInScale,
  formatPassRateDetail,
  judgeCaption,
  passRateHeaderLabel,
  runPassPolicyLabel,
  type ScoringComparability,
} from '@/lib/comparison/scoringDisplay';
import { JudgeModelLabel, judgeModelText, type JudgeIdentityLike } from '@/components/JudgeModelLabel';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { JUDGE_PROVIDER_NONE, isJudgeProviderPseudoModelId } from '@/lib/judgeIdentity';
import { AgentFingerprintChip, AgentConfigChangedBadge } from '@/components/evals3/AgentFingerprintChip';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ComparisonScoreboardProps {
  runs: RunAggregateMetrics[];
  /** The raw selected runs — the judge line reads their run-level judge identity (`judgeModel` / `judgeModelId`). */
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
 * Nor is there an "Avg score" column: it read "—" for every run judged
 * before scoring snapshots existed (owner: noise), so the run-level
 * weighted aggregate stays in the payload (`RunAggregateMetrics.avgScore`)
 * but is not rendered here — the per-metric columns carry the score signal.
 */
export const SCOREBOARD_COLUMNS: ReadonlyArray<{ key: string; label: string; tooltip: string }> = [
  { key: 'run', label: 'Run', tooltip: 'Run name — click to open the run report' },
  { key: 'passRate', label: 'Pass rate', tooltip: 'Passed ÷ evaluated cases (errored cases excluded); the parenthesis names the verdict policy' },
  { key: 'cost', label: 'Cost', tooltip: 'Total LLM cost across all test cases in the run' },
  { key: 'avgDuration', label: 'Avg Duration', tooltip: 'Mean wall-clock duration per test case' },
  { key: 'tokens', label: 'Tokens', tooltip: 'Total tokens across all test cases' },
  { key: 'llmCalls', label: 'LLM Calls', tooltip: 'Total LLM calls across all test cases' },
  { key: 'toolCalls', label: 'Tool Calls', tooltip: 'Total tool invocations across all test cases' },
  { key: 'coverage', label: 'Coverage', tooltip: 'Test cases this run shares with the comparison set' },
];

export interface ScoreboardColumn { key: string; label: string; tooltip: string; primaryMetric?: string }

/** Static column the evaluator-declared primary-metric columns are inserted after. */
export const PRIMARY_METRICS_AFTER_COLUMN = 'passRate';

/**
 * Column list for a given run set: the static columns with the pass-rate
 * header labelled by policy, plus one column per primary metric any run's
 * snapshot declares (inserted after the pass-rate column, declaration order,
 * names passed through verbatim — nothing here knows what "Hit@1" means).
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
    if (col.key === PRIMARY_METRICS_AFTER_COLUMN) {
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

/** Δ-row text when the coverage gate blocks the aggregate comparison. */
export const NOT_COMPARABLE_LABEL = 'Not comparable — different scoring';

/** Tooltip on the delta footer's row label (two-run compare). */
export const DELTA_ROW_TOOLTIP = 'A minus B per column; blue/green when A is better on that metric, red when worse';

/**
 * Tooltip on a per-run delta row of a 3+-run compare: every row is baseline A
 * minus that run, so the sign/colour convention matches the two-run Δ row.
 */
export const deltaRowTooltipFor = (letter: string): string =>
  `A minus ${letter} per column; blue/green when A is better on that metric, red when worse`;

// ─── Run lettering / colours ─────────────────────────────────────────────────

/**
 * Rows are lettered in selection order: A, B, C, … The compare page puts no
 * cap on how many runs may be selected, so past Z the label falls back to a
 * number ("R27") rather than wrapping — the scoreboard must show EVERY
 * selected run (it used to hard-cap to A/B and silently drop the third run).
 */
export const runLetter = (idx: number): string =>
  idx < 26 ? String.fromCharCode(65 + idx) : `R${idx + 1}`;

/** Badge + pass-rate bar colour per row; cycles once the palette runs out. */
const RUN_COLORS: ReadonlyArray<{ badge: string; bar: string }> = [
  { badge: 'bg-blue-500/20 text-blue-300 border-blue-500/50', bar: 'rgb(59,130,246)' },
  { badge: 'bg-purple-500/18 text-purple-300 border-purple-400/50', bar: 'rgb(168,85,247)' },
  { badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50', bar: 'rgb(16,185,129)' },
  { badge: 'bg-amber-500/20 text-amber-300 border-amber-400/50', bar: 'rgb(245,158,11)' },
  { badge: 'bg-pink-500/20 text-pink-300 border-pink-400/50', bar: 'rgb(236,72,153)' },
  { badge: 'bg-cyan-500/20 text-cyan-300 border-cyan-400/50', bar: 'rgb(6,182,212)' },
];
const runColor = (idx: number) => RUN_COLORS[idx % RUN_COLORS.length];

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
 * plain statement of overlap, naming WHICH run carries the extra cases (the
 * common real-world shape: a small smoke run vs. a full benchmark run), e.g.
 * "6 in both · 56 only in A". With three or more runs a case can also sit in
 * SOME runs without being unique to one (in B and C but not A) — those are
 * neither "in all N" nor "only in X", so they get their own "K in some runs"
 * part (always 0 for two runs, where every non-shared case is unique to one
 * side). Letters are looked up by run id, not array position, so the label
 * cannot mis-attribute counts if `perRun` is ever ordered differently from
 * the rows.
 */
const formatCoverageLabel = (
  overlap: TestCaseOverlap,
  runs: ReadonlyArray<Pick<RunAggregateMetrics, 'runId'>>
): string => {
  const parts = [`${overlap.sharedTestCases} ${inAllLabel(runs.length)}`];
  let uniqueTotal = 0;
  overlap.perRun.forEach((r, i) => {
    if (r.uniqueCount <= 0) return;
    uniqueTotal += r.uniqueCount;
    const idx = runs.findIndex(run => run.runId === r.runId);
    parts.push(`${r.uniqueCount} only in ${runLetter(idx >= 0 ? idx : i)}`);
  });
  const inSome = overlap.partialTestCases - uniqueTotal;
  if (inSome > 0) parts.push(`${inSome} in some runs`);
  return parts.join(' · ');
};

/** "in both" for a two-run compare, "in all N" once a third run joins. */
export const inAllLabel = (runCount: number): string => (runCount > 2 ? `in all ${runCount}` : 'in both');

// ─── Badge sub-component ─────────────────────────────────────────────────────

const RunBadge: React.FC<{ idx: number }> = ({ idx }) => (
  <span
    className={cn(
      'inline-flex items-center justify-center w-[14px] h-[14px] rounded border text-[9.5px] font-extrabold leading-none',
      runColor(idx).badge
    )}
    data-testid={`run-badge-${runLetter(idx)}`}
  >
    {runLetter(idx)}
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
  const [a, ...others] = runs;

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs" data-testid="scoreboard-condensed">
      <span className="inline-flex items-center gap-1">
        <RunBadge idx={0} /> <span className="font-medium">{getAgentName(a.agentKey)}</span>
        <span className="tabular-nums">{formatPercent(a.passRatePercent)}</span>
      </span>
      {/* One "vs <run> <pass rate> <Δ vs A>" group per further run — the band
          used to show only B, so a third run vanished when condensed too. */}
      {others.map((b, i) => {
        const delta = a.passRatePercent - b.passRatePercent;
        const deltaStr = delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${Math.round(delta)}pp`;
        return (
          <React.Fragment key={b.runId}>
            <span className="text-muted-foreground">vs</span>
            <span className="inline-flex items-center gap-1">
              <RunBadge idx={i + 1} /> <span className="font-medium">{getAgentName(b.agentKey)}</span>
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
            {/* Same agent, different config between A and this run (agent-config provenance). */}
            <AgentConfigChangedBadge
              a={a}
              b={b}
              data-testid={i === 0 ? 'scoreboard-condensed-config-changed-badge' : `scoreboard-condensed-config-changed-badge-${runLetter(i + 1)}`}
            />
          </React.Fragment>
        );
      })}
      <span className="text-muted-foreground">
        {runs.map(r => formatCostSafe(r.totalCostUsd)).join(' vs ')}
      </span>
      <span className="text-muted-foreground">
        {runs.map(r => formatDurationSafe(r.avgDurationMs)).join(' vs ')}
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
 * judge across all runs collapses to one name; differing judges list every
 * run, labelled A/B/C/…. A run whose reports resolved to several judges reads
 * "mixed (a · b)"; runs with no judge information at all read "not recorded"
 * — an honest blank, never the agent model standing in.
 */
/**
 * One judge entry per run. Precedence:
 *   1. The run's reports resolved to SEVERAL judges → the plain "mixed (a · b)"
 *      caption (per-report resolution, lib/comparison/scoringDisplay.ts).
 *   2. The run recorded its judge identity (`judgeModel` = underlying LLM,
 *      `judgeModelId` = configured judge kind; lib/judgeIdentity) AND the
 *      reports agree with it (or carry no judge of their own) → the shared
 *      <JudgeModelLabel> ("agent-trace-judge · claude-sonnet-4-5", or a
 *      "model not recorded" hint for old agent-judge runs).
 *   3. The reports resolved to ONE judge that is NOT the run's — a
 *      judge-changing Retry judgement (#509) re-judged every case with another
 *      model / evaluator; the run's original `judgeModelId` is deliberately
 *      immutable, so the reports are the current truth → label that judge.
 *   4. Otherwise the single per-report judge, or "not recorded".
 */
type JudgeEntry =
  | { kind: 'label'; run: JudgeIdentityLike; text: string }
  | { kind: 'text'; text: string };

/**
 * Does the judge the reports resolved to (lib/comparison/scoringDisplay
 * `resolveJudgeModelId`) name the same judge the run recorded? Equal to the
 * run's resolved LLM or its configured id, or to the catalog `model_id`
 * behind that configured key (`claude-sonnet-4.6` → `us.anthropic.claude-
 * sonnet-4-6`) — the same alias rule `getJudgeModelDisplay` applies.
 */
function reportJudgeMatchesRun(reportJudge: string, run: { judgeModel?: string; judgeModelId?: string }): boolean {
  if (reportJudge === run.judgeModel || reportJudge === run.judgeModelId) return true;
  const configured = run.judgeModelId ? DEFAULT_CONFIG.models[run.judgeModelId]?.model_id : undefined;
  return !!configured && reportJudge === configured;
}

/**
 * Identity shape for a report-resolved judge id: the no-LLM marker, a provider
 * kind, or an LLM — paired with its catalog key when the id is a configured
 * model's `model_id`, so the label reads the display name ("Demo Model")
 * exactly as it would for a run that recorded that judge.
 */
function identityForReportJudge(reportJudge: string): JudgeIdentityLike {
  if (reportJudge === JUDGE_PROVIDER_NONE) return { judgeProvider: JUDGE_PROVIDER_NONE };
  if (isJudgeProviderPseudoModelId(reportJudge)) return { judgeModelId: reportJudge };
  const catalogKey = Object.keys(DEFAULT_CONFIG.models).find(k => k === reportJudge || DEFAULT_CONFIG.models[k]?.model_id === reportJudge);
  return catalogKey ? { judgeModelId: catalogKey, judgeModel: reportJudge } : { judgeModel: reportJudge };
}

function judgeEntryFor(run: RunAggregateMetrics, selected: BenchmarkRun | undefined): JudgeEntry {
  const ids = run.judgeModelIds && run.judgeModelIds.length > 0
    ? run.judgeModelIds
    : (run.judgeModelId ? [run.judgeModelId] : []);
  if (ids.length > 1) return { kind: 'text', text: judgeCaption(run, getModelName) };
  const reportJudge: string | undefined = ids[0];
  if (selected && (selected.judgeModel || selected.judgeModelId)) {
    const identity = { judgeModel: selected.judgeModel, judgeModelId: selected.judgeModelId };
    if (!reportJudge || reportJudgeMatchesRun(reportJudge, identity)) {
      return { kind: 'label', run: identity, text: judgeModelText(identity) };
    }
    const current = identityForReportJudge(reportJudge);
    return { kind: 'label', run: current, text: judgeModelText(current) };
  }
  return { kind: 'text', text: judgeCaption(run, getModelName) };
}

const JudgeEntryView: React.FC<{ entry: JudgeEntry }> = ({ entry }) =>
  entry.kind === 'label' ? <JudgeModelLabel run={entry.run} /> : <>{entry.text}</>;

const JudgeLine: React.FC<{ runs: RunAggregateMetrics[]; selectedRuns: BenchmarkRun[] }> = ({ runs, selectedRuns }) => {
  const selectedById = new Map(selectedRuns.map(r => [r.id, r]));
  const entries = runs.map(r => judgeEntryFor(r, selectedById.get(r.runId)));
  if (entries.length === 0) return null;
  const allSame = entries.every(e => e.text === entries[0].text);

  return (
    <div className="px-4 py-1.5 text-[11px] text-muted-foreground" data-testid="scoreboard-judge-line">
      {allSame ? (
        <span className="inline-flex items-baseline gap-1">Judge: <JudgeEntryView entry={entries[0]} /></span>
      ) : (
        <span className="inline-flex items-baseline gap-1 flex-wrap">
          Judge: {entries.map((entry, i) => (
            <React.Fragment key={runs[i].runId}>
              {i > 0 && ' · '}{runLetter(i)} <JudgeEntryView entry={entry} />
            </React.Fragment>
          ))}
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
  selectedRuns = [],
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

  const [runA, ...comparedRuns] = runs;
  const multiRun = comparedRuns.length > 0;
  const columns = buildScoreboardColumns(runs);
  // Every non-baseline run gets its own Δ row: baseline A minus that run, so
  // a 3+-run compare reads "Δ A−B", "Δ A−C", … with the same sign/colour
  // convention as the single "Delta" row of a two-run compare. A Δ is only
  // defined when BOTH sides carry the metric (a legacy run has no score to
  // diff against; the coverage gate below blocks the rows when the runs were
  // scored differently).
  const diff = (a: number | undefined, b: number | undefined): number | undefined =>
    a !== undefined && b !== undefined ? a - b : undefined;
  const deltaBlocked = multiRun && !comparability.comparable && !compareAnyway;
  // Tooltip caveat on the Δ cells: why an overridden comparison is shaky, or
  // that the legacy runs carry no scoring provenance at all.
  const allLegacy = multiRun && runs.every(r => scoringOf(r).source === 'legacy');
  const deltaCaveat = compareAnyway && !comparability.comparable
    ? `Compared anyway — ${comparability.reasons.join(' · ')}`
    : allLegacy
      ? `${runs.length > 2 ? 'All' : 'Both'} runs are legacy-scored: evaluator version and verdict policy were not recorded, so this Δ compares ${runs.length > 2 ? 'opaque' : 'two opaque'} judge-verdict streams.`
      : undefined;
  const primaryMean = (run: RunAggregateMetrics, name: string) => {
    const scoring = scoringOf(run);
    return scoring.source === 'snapshot' ? scoring.primaryMetrics.find(pm => pm.name === name) : undefined;
  };
  // Coverage wording: "same case IDs" is all that identical test-case sets
  // prove. Only when the scoring snapshots AND test-case versions also match
  // may the cell claim "same cases, same scoring".
  const sameScoring = overlap.fullyOverlapping && comparability.comparable
    && runs.every(r => scoringOf(r).source === 'snapshot');

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
                  {runs.map((run, idx) => {
                    const label = runLetter(idx);
                    const barColor = runColor(idx).bar;
                    const benchmarkId = runBenchmarkIdById?.get(run.runId);

                    return (
                      <tr
                        key={run.runId}
                        className="hover:bg-muted/30 transition-colors group"
                        data-testid={`scoreboard-row-${label}`}
                      >
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <RunBadge idx={idx} />
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
                              {/* Agent-config provenance: the chip names WHICH
                                  config version each row measured; the amber
                                  badge (row A only, once) fires when both rows
                                  are the SAME agent but DIFFERENT fingerprints
                                  — i.e. the pass-rate delta is confounded by a
                                  prompt/config change, not just the agent. */}
                              {(run.agentFingerprint || (idx === 0 && comparedRuns.length > 0) || idx > 1) && (
                                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap" data-testid={`scoreboard-provenance-${label}`}>
                                  <AgentFingerprintChip run={run} compact data-testid={`scoreboard-fingerprint-${run.runId}`} />
                                  {/* Row A carries the A-vs-B badge (the primary comparison); with
                                      3+ runs every further row carries its own A-vs-this badge. */}
                                  {idx === 0 && comparedRuns.length > 0 && (
                                    <AgentConfigChangedBadge a={runA} b={comparedRuns[0]} data-testid="scoreboard-config-changed-badge" />
                                  )}
                                  {idx > 1 && (
                                    <AgentConfigChangedBadge a={runA} b={run} data-testid={`scoreboard-config-changed-badge-${label}`} />
                                  )}
                                </div>
                              )}
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
                              {!multiRun ? (
                                <span>
                                  {overlap.totalTestCases} case{overlap.totalTestCases === 1 ? '' : 's'}
                                </span>
                              ) : overlap.fullyOverlapping ? (
                                <span className={sameScoring ? 'text-green-400' : 'text-muted-foreground'}>
                                  {overlap.sharedTestCases} {inAllLabel(runs.length)}, {sameScoring ? 'same cases, same scoring' : 'same case IDs'}
                                </span>
                              ) : (
                                <span className="text-amber-400">
                                  {formatCoverageLabel(overlap, runs)}
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
                {/* Delta footer — one row per compared run (A minus B, A minus C, …).
                    A two-run compare keeps its single "Delta" row verbatim. */}
                {multiRun && (
                <tfoot>
                  {comparedRuns.map((runB, i) => {
                    const letter = runLetter(i + 1);
                    const first = i === 0;
                    // The first Δ row keeps the historical un-suffixed test ids
                    // (two-run specs pin them); further rows are suffixed by letter.
                    const tid = (base: string) => (first ? base : `${base}-${letter}`);
                    const passRateDelta = runA.passRatePercent - runB.passRatePercent;
                    const costDelta = diff(runA.totalCostUsd, runB.totalCostUsd);
                    const durationDelta = diff(runA.avgDurationMs, runB.avgDurationMs);
                    const tokensDelta = diff(runA.totalTokens, runB.totalTokens);
                    return (
                  <tr
                    key={runB.runId}
                    className={first ? 'border-t border-border/50 bg-muted/20' : 'border-t border-border/30 bg-muted/20'}
                    data-testid={`scoreboard-delta-row-${letter}`}
                  >
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-help"
                          data-testid={tid('scoreboard-delta-label')}
                          title={runs.length > 2 ? deltaRowTooltipFor(letter) : DELTA_ROW_TOOLTIP}
                        >
                          {runs.length > 2 ? `Δ A−${letter}` : 'Delta'}
                        </span>
                        {first && (
                          <button
                            onClick={onSwapRuns}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title="Swap A/B"
                          >
                            <ArrowUpDown size={11} />
                          </button>
                        )}
                      </div>
                    </td>
                    {deltaBlocked ? (
                      <td className="px-3 py-1.5 text-left" colSpan={columns.length}>
                        <span className="inline-flex items-center gap-2 text-[11px]">
                          <span
                            data-testid={tid('scoreboard-delta-blocked')}
                            className="text-amber-400 cursor-help"
                            title={comparability.reasons.join(' · ')}
                          >
                            {NOT_COMPARABLE_LABEL}
                          </span>
                          {first && onCompareAnyway && (
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
                        data-testid={tid('scoreboard-delta-passrate')}
                        className={cn(
                          'font-semibold tabular-nums text-[11px]',
                          passRateDelta > 0 ? 'text-blue-400' : passRateDelta < 0 ? 'text-red-400' : 'text-muted-foreground'
                        )}
                        title={passRateDelta === 0 ? 'No change' : deltaCaveat}
                      >
                        {formatDelta(runA.passRatePercent, runB.passRatePercent, 'pp')}
                      </span>
                    </td>
                    {columns.filter(c => c.primaryMetric).map(col => {
                      const a = primaryMean(runA, col.primaryMetric as string);
                      const b = primaryMean(runB, col.primaryMetric as string);
                      const d = a?.mean !== undefined && b?.mean !== undefined ? a.mean - b.mean : undefined;
                      return (
                        <td key={col.key} className="px-3 py-1.5 text-right">
                          <DeltaCell
                            testId={tid(`scoreboard-delta-primary-${col.primaryMetric}`)}
                            delta={d}
                            text={d === undefined ? '' : d === 0 ? '—' : `${d > 0 ? '+' : ''}${formatMetricInScale(d, a!.scale).replace(/^—$/, '')}`}
                            title={deltaCaveat ?? `A minus ${letter}, mean ${col.primaryMetric} from both scoring snapshots`}
                          />
                        </td>
                      );
                    })}
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId={tid('scoreboard-delta-cost')}
                        delta={costDelta}
                        betterWhenLower
                        text={costDelta === undefined ? '' : costDelta === 0 ? '—' : (costDelta > 0 ? '+' : '') + formatCost(costDelta)}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId={tid('scoreboard-delta-duration')}
                        delta={durationDelta}
                        betterWhenLower
                        text={durationDelta === undefined ? '' : durationDelta === 0 ? '—' : (durationDelta > 0 ? '+' : '-') + formatDuration(Math.abs(durationDelta))}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <DeltaCell
                        testId={tid('scoreboard-delta-tokens')}
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
                    );
                  })}
                </tfoot>
                )}
              </table>
            </div>

            {/* Judge info — once, not per-row (replaces the old per-run drawer). */}
            <div className="border-t border-border/50">
              <JudgeLine runs={runs} selectedRuns={selectedRuns} />
            </div>
          </>
        )}
      </div>
    </>
  );
};
