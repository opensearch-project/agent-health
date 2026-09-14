/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Presentation-side helpers for the compare page's scoring honesty surface:
 * which judge to name, how to label the pass rate, and whether two runs'
 * aggregates may be compared at all. Pure functions over already-loaded
 * data so they can be unit-tested without React.
 */

import type { EvaluationReport, RunAggregateMetrics, RunScoringSummary, ScoringPassPolicy } from '@/types';

// ─── Judge identity ──────────────────────────────────────────────────────────

/**
 * The judge that actually produced a report's verdict, in precedence order:
 *   1. `report.judgeModel` — the resolved underlying LLM (PR #494; read via
 *      feature detection so this compiles with or without that field).
 *   2. `report.llmJudgeResponse.modelId` — what the judge response recorded.
 *   3. `report.judgeModelId` — the judge configured on the report.
 *   4. `run.judgeModelId` — the judge configured on the run.
 * NEVER `modelId` — that is the agent under test.
 */
export function resolveJudgeModelId(
  report: Pick<EvaluationReport, 'llmJudgeResponse' | 'judgeModelId'> | undefined | null,
  run?: { judgeModelId?: string } | null
): string | undefined {
  const judgeModel = (report as { judgeModel?: unknown } | undefined | null)?.judgeModel;
  if (typeof judgeModel === 'string' && judgeModel.trim()) return judgeModel;
  const responseModel = report?.llmJudgeResponse?.modelId;
  if (typeof responseModel === 'string' && responseModel.trim()) return responseModel;
  if (typeof report?.judgeModelId === 'string' && report.judgeModelId.trim()) return report.judgeModelId;
  if (typeof run?.judgeModelId === 'string' && run.judgeModelId.trim()) return run.judgeModelId;
  return undefined;
}

// ─── Pass-rate policy label ──────────────────────────────────────────────────

/** Short human label for the policy behind a pass/fail verdict. */
export function passPolicyLabel(policy: ScoringPassPolicy | undefined): string {
  if (!policy) return 'judge verdict';
  switch (policy.kind) {
    case 'threshold':
      return `score ≥ ${formatThreshold(policy.minScore)}`;
    case 'gates':
      return 'gates';
    case 'llm-verdict':
    default:
      return 'judge verdict';
  }
}

function formatThreshold(v: number): string {
  if (!Number.isFinite(v)) return '?';
  // Thresholds are on the normalized [0,1] score; show at most 2 decimals.
  return String(Math.round(v * 100) / 100);
}

/** The pass-rate policy label for a run aggregate ("judge verdict" for legacy). */
export function runPassPolicyLabel(scoring: RunScoringSummary | undefined): string {
  return scoring?.source === 'snapshot' ? passPolicyLabel(scoring.passPolicy) : 'judge verdict';
}

const scoringOf = (run: { scoring?: RunScoringSummary }): RunScoringSummary => run.scoring ?? { source: 'legacy' };

/**
 * Column header for the pass-rate column: one shared policy label when every
 * run agrees, otherwise "mixed policies" (each cell then carries its own).
 */
export function passRateHeaderLabel(runs: ReadonlyArray<Pick<RunAggregateMetrics, 'scoring'>>): string {
  const labels = Array.from(new Set(runs.map(r => runPassPolicyLabel(scoringOf(r)))));
  if (labels.length === 0) return 'Pass rate (judge verdict)';
  if (labels.length === 1) return `Pass rate (${labels[0]})`;
  return 'Pass rate (mixed policies)';
}

/**
 * "passed / evaluated (errored N, pending M)" — the denominators behind the
 * percentage. `evaluated` is the judged set (passed + failed); errored and
 * pending/not-run cases are excluded from it and called out separately.
 */
export function formatPassRateDetail(
  run: Pick<RunAggregateMetrics, 'passedCount' | 'failedCount' | 'erroredCount'> & Partial<Pick<RunAggregateMetrics, 'evaluatedCount' | 'pendingCount'>>
): string {
  const errored = run.erroredCount ?? 0;
  const pending = run.pendingCount ?? 0;
  // Fixtures built before `evaluatedCount` existed: the judged set is passed + failed.
  const evaluated = run.evaluatedCount ?? run.passedCount + run.failedCount;
  const notes: string[] = [];
  if (errored > 0) notes.push(`errored ${errored}`);
  if (pending > 0) notes.push(`pending ${pending}`);
  const base = `${run.passedCount} / ${evaluated}`;
  return notes.length > 0 ? `${base} (${notes.join(', ')})` : base;
}

/**
 * Judge caption text for one run: the single resolved judge, "mixed (a · b)"
 * when its reports resolved to several, or "not recorded".
 */
export function judgeCaption(
  run: Partial<Pick<RunAggregateMetrics, 'judgeModelId' | 'judgeModelIds'>>,
  displayName: (id: string) => string = id => id
): string {
  const ids = run.judgeModelIds && run.judgeModelIds.length > 0
    ? run.judgeModelIds
    : (run.judgeModelId ? [run.judgeModelId] : []);
  if (ids.length === 0) return 'not recorded';
  if (ids.length === 1) return displayName(ids[0]);
  return `mixed (${ids.map(displayName).join(' · ')})`;
}

// ─── Avg score hover ─────────────────────────────────────────────────────────

/** Tooltip body for the "Avg score" cell — evaluator, version, weights, coverage. */
export function avgScoreTooltip(scoring: RunScoringSummary | undefined): string {
  if (!scoring || scoring.source !== 'snapshot') {
    return 'This run was judged before scoring snapshots existed; its rubric values are shown by name below and are not aggregated into a score.';
  }
  const weights = Object.entries(scoring.weights)
    .filter(([, w]) => Number.isFinite(w) && w > 0)
    .map(([name, w]) => `${name} ${Math.round(w * 100) / 100}`)
    .join(', ');
  const evaluator = scoring.evaluatorName || scoring.evaluatorId;
  return `Evaluator ${evaluator} v${scoring.evaluatorVersion} · weights: ${weights} · scored ${scoring.scoredRubrics} / ${scoring.totalRubrics} rubrics over ${scoring.scoredReports} case${scoring.scoredReports === 1 ? '' : 's'}`;
}

// ─── Coverage gate ───────────────────────────────────────────────────────────

export interface ScoringComparability {
  comparable: boolean;
  /** Human-readable reasons the aggregates should not be compared (empty when comparable). */
  reasons: string[];
}

/**
 * May the Δ / aggregate row be shown for these runs? Not when
 *   - any two runs carry different snapshot `contentHash`es (different
 *     evaluator content ⇒ scores/verdicts measure different things);
 *   - a run mixes several snapshots internally;
 *   - one run is snapshot-scored and another is legacy;
 *   - any test case they share ran at different versions, or has no recorded
 *     version on one side (unknown provenance is not "matching" provenance).
 * Two fully legacy runs carry no scoring provenance and are treated as
 * comparable (the historical behaviour — blocking them would disable the Δ
 * row for every run persisted before snapshots existed); the coverage cell
 * still says only "same case IDs" for them and the Δ tooltip says why.
 */
export function assessScoringComparability(
  runs: ReadonlyArray<Pick<RunAggregateMetrics, 'runId' | 'runName'> & Partial<Pick<RunAggregateMetrics, 'scoring' | 'testCaseVersions'>>>
): ScoringComparability {
  const reasons: string[] = [];
  if (runs.length < 2) return { comparable: true, reasons };

  const label = (r: { runName: string; runId: string }, i: number) => r.runName || r.runId || (i === 0 ? 'A' : 'B');

  const scorings = runs.map(r => scoringOf(r));
  const sources = new Set(scorings.map(s => s.source));
  if (sources.size > 1) {
    const legacy = runs.filter((r, i) => scorings[i].source === 'legacy').map(label);
    reasons.push(`legacy scoring on ${legacy.join(', ')} — no scoring snapshot to compare against`);
  }

  const hashes = new Set<string>();
  runs.forEach((r, i) => {
    const scoring = scorings[i];
    if (scoring.source !== 'snapshot') return;
    if (scoring.contentHashes.length > 1) {
      reasons.push(`${label(r, i)} mixes ${scoring.contentHashes.length} scoring snapshots`);
    }
    scoring.contentHashes.forEach(h => hashes.add(h));
  });
  if (hashes.size > 1) {
    const described = runs
      .map((r, i) => {
        const scoring = scorings[i];
        return scoring.source === 'snapshot'
          ? `${label(r, i)}: ${scoring.evaluatorName || scoring.evaluatorId} v${scoring.evaluatorVersion}`
          : null;
      })
      .filter((s): s is string => !!s);
    reasons.push(`different scoring snapshots (${described.join(' vs ')})`);
  }

  const versionMismatches = countVersionMismatches(runs.map(r => r.testCaseVersions));
  if (versionMismatches > 0) {
    reasons.push(`${versionMismatches} shared test case${versionMismatches === 1 ? '' : 's'} ran at different versions`);
  }
  // Only snapshot-scored runs are held to full version provenance: a legacy
  // run's missing versions are part of what "legacy" already means.
  if (scorings.every(s => s.source === 'snapshot')) {
    const unknown = countVersionUnknown(runs.map(r => r.testCaseVersions));
    if (unknown > 0) {
      reasons.push(`${unknown} shared test case${unknown === 1 ? '' : 's'} ${unknown === 1 ? 'has' : 'have'} no recorded version on one side`);
    }
  }

  return { comparable: reasons.length === 0, reasons };
}

/**
 * Shared test cases (present in every run's results) whose version is not
 * recorded on at least one side. Uses the union of ids across the maps as
 * the case set, so a run that recorded nothing still counts as unknown.
 */
export function countVersionUnknown(versionMaps: ReadonlyArray<Record<string, number> | undefined>): number {
  if (versionMaps.length < 2) return 0;
  const maps = versionMaps.map(m => m ?? {});
  const ids = new Set<string>();
  maps.forEach(m => Object.keys(m).forEach(id => ids.add(id)));
  let unknown = 0;
  for (const id of ids) {
    if (maps.some(m => typeof m[id] !== 'number')) unknown++;
  }
  return unknown;
}

/** Shared test cases whose recorded version differs between any two runs. */
export function countVersionMismatches(versionMaps: ReadonlyArray<Record<string, number> | undefined>): number {
  const maps = versionMaps.map(m => m ?? {});
  if (maps.length < 2) return 0;
  let mismatches = 0;
  const shared = Object.keys(maps[0]).filter(id => maps.every(m => id in m));
  for (const id of shared) {
    const versions = new Set(maps.map(m => m[id]));
    if (versions.size > 1) mismatches++;
  }
  return mismatches;
}

/** Session-scoped "Compare anyway" override, keyed by the compared run set. */
const OVERRIDE_PREFIX = 'ah.compare.compareAnyway:';

export function compareAnywayKey(runIds: ReadonlyArray<string>): string {
  return OVERRIDE_PREFIX + [...runIds].sort().join(',');
}

export function readCompareAnyway(runIds: ReadonlyArray<string>): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(compareAnywayKey(runIds)) === '1';
  } catch {
    return false;
  }
}

export function writeCompareAnyway(runIds: ReadonlyArray<string>, value: boolean): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (value) sessionStorage.setItem(compareAnywayKey(runIds), '1');
    else sessionStorage.removeItem(compareAnywayKey(runIds));
  } catch {
    /* sandboxed / storage disabled — the override simply does not persist */
  }
}

// ─── Metric formatting ───────────────────────────────────────────────────────

/**
 * Format a metric mean in its own scale: fractions (max ≤ 1) with two
 * decimals, percentages for 0–100, otherwise one decimal.
 */
export function formatMetricInScale(value: number | undefined, scale: { min: number; max: number }): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (scale.max <= 1) return (Math.round(value * 100) / 100).toFixed(2);
  if (scale.min === 0 && scale.max === 100) return `${Math.round(value)}%`;
  return String(Math.round(value * 10) / 10);
}
