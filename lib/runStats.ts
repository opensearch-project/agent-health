/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Run Statistics Calculation
 *
 * This module provides shared logic for calculating benchmark run statistics.
 * Both UI and CLI use these functions to ensure consistent pass/fail counting.
 *
 * The canonical approach is:
 * 1. Get report IDs from run.results[testCaseId].reportId
 * 2. Fetch each report by ID
 * 3. Count passFailStatus from the fetched reports
 *
 * For performance optimization, stats are denormalized onto BenchmarkRun.stats
 * and updated incrementally as test cases complete.
 */

import type { BenchmarkRun, EvaluationReport, RunStats as RunStatsType, BenchmarkRunStatus } from '@/types/index.js';

/**
 * Statistics for a benchmark run
 */
export interface RunStats {
  /** Number of test cases that passed (passFailStatus === 'passed') */
  passed: number;
  /** Number of test cases that failed (passFailStatus === 'failed' or execution failed) */
  failed: number;
  /** Number of test cases still pending (running, or report not yet available) */
  pending: number;
  /**
   * Number of test cases where the *evaluator* could not produce a verdict
   * (judge validation error, trace timeout, etc.). Excluded from passed and
   * failed counts so a misconfigured evaluator doesn't poison aggregate
   * pass rates. Issue #242.
   */
  errored: number;
  /**
   * Number of planned test cases that never executed (or never finished)
   * because the run reached a TERMINAL status first — cancelled mid-way, or
   * the executor crashed. Neither a pass, a fail, nor "pending": nothing is
   * ever going to happen to them. Excluded from the pass-rate denominator
   * and rendered as "n not run" (never with an in-progress spinner).
   */
  notRun: number;
  /** Total number of test cases in the run */
  total: number;
  /**
   * Pass rate as a percentage (0-100). Computed over `total - errored -
   * notRun` (the *evaluable* set), not over `total`, so a non-retryable
   * judge failure — or a cancellation — can't masquerade as the agent
   * scoring 0%.
   */
  passRate: number;
}

/** Run statuses after which no further per-case progress can happen. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<BenchmarkRunStatus> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalRunStatus(status: BenchmarkRunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Bucket a run's per-test-case results into passed/failed/errored/pending using
 * ONLY the persisted result fields (status + passFailStatus) — no reports
 * needed. This is the SINGLE source of truth for pass/fail/errored counts across
 * the app (the runs list AND the comparison page), so the numbers can't
 * diverge between views.
 *
 * The denormalized `run.stats` is NOT authoritative: its writer historically
 * counted every 'completed' result as passed without checking the verdict, so
 * an errored case (judge produced no verdict) was miscounted as a pass and
 * `errored` was never tracked. Recompute from results instead.
 *
 * Errored (#242): a 'completed' result with no 'passed'/'failed' verdict means
 * the evaluator couldn't produce one (judge validation error, trace timeout).
 * Excluded from passed/failed — exactly as calculateRunStats does via the
 * report's metricsStatus.
 *
 * `plannedTotal` (bug: runs list showed no in-flight indication, 2026-09-01):
 * for a genuinely in-progress run, `results` only gets an entry once a test
 * case has actually STARTED — a run 9 cases into a planned 62 has a
 * `results` map of length 9, so `total` here would report 9, not 62. Pass
 * the run's snapshotted test-case count (`testCaseSnapshots.length`) as
 * `plannedTotal` and the shortfall (planned - observed) is folded into
 * `pending` so the invariant `total === passed+failed+errored+pending+notRun`
 * still holds and callers see the true "53 more to go" total instead of a
 * misleadingly small, already-100%-accounted-for total that looks finished.
 *
 * `runStatus` (bug: cancelled/failed runs rendered a phantom "n pending ⟳"
 * forever, 2026-09-04): the shortfall above is only *pending* while the run
 * can still make progress. Once the run is TERMINAL (cancelled / failed /
 * completed) nothing will ever start those cases, so they are bucketed as
 * `notRun` instead — a cancelled 34/62 run reads "34 executed · 28 not run",
 * not "28 pending" with a spinner. The same applies to per-case entries a
 * terminal run left behind in `pending`/`running` (an executor that died
 * mid-case) and to entries explicitly marked `status: 'cancelled'` (written
 * for never-started cases when a run is cancelled — see
 * `EvaluationRun.results` in types/index.ts). Without `runStatus` the legacy
 * behaviour (shortfall = pending) is preserved.
 */
export function bucketRunResults(
  results: Record<string, { status?: string; passFailStatus?: string }> | undefined,
  plannedTotal?: number,
  runStatus?: BenchmarkRunStatus
): Pick<RunStats, 'passed' | 'failed' | 'errored' | 'pending' | 'notRun' | 'total'> {
  const terminal = isTerminalRunStatus(runStatus);
  let passed = 0, failed = 0, errored = 0, pending = 0, notRun = 0, total = 0;
  for (const r of Object.values(results || {})) {
    total++;
    if (r.status === 'cancelled') { notRun++; continue; }
    if (r.status === 'pending' || r.status === 'running') {
      if (terminal) notRun++; else pending++;
      continue;
    }
    if (r.status === 'failed') { failed++; continue; }
    if (r.status === 'completed') {
      if (r.passFailStatus === 'passed') passed++;
      else if (r.passFailStatus === 'failed') failed++;
      else errored++; // completed without a verdict = judge errored (#242)
      continue;
    }
    // Unknown / missing status: while the run is live this is "not settled
    // yet" (pending). On a TERMINAL run an entry with no recognised status is
    // schema drift or a bad writer — surface it as `errored` (amber ⚠) rather
    // than hide it in the neutral notRun bucket (codex review).
    if (terminal) errored++; else pending++;
  }
  if (plannedTotal !== undefined && plannedTotal > total) {
    if (terminal) notRun += plannedTotal - total;
    else pending += plannedTotal - total;
    total = plannedTotal;
  }
  return { passed, failed, errored, pending, notRun, total };
}

/**
 * Pass rate (0-100) over the JUDGED set only: `passed / (passed + failed)`.
 * Excluded: errored (executed, but the evaluator produced no verdict — the
 * repo-wide #242 convention, same as the benchmark runs table and the run
 * inspector), pending (not finished) and notRun (never started). So a run
 * cancelled at 34/62 reports the pass rate of the cases that were actually
 * judged, and an in-flight run doesn't read as "12%" because 50 cases
 * haven't happened yet. Named for what it is — callers that surface it
 * should footnote the excluded errored/notRun counts (the detail page does).
 * Returns `null` when nothing has been judged so callers can render "—"
 * rather than a fabricated 0%.
 */
export function passRateOverJudged(stats: { passed: number; failed: number }): number | null {
  const judged = stats.passed + stats.failed;
  return judged > 0 ? Math.round((stats.passed / judged) * 100) : null;
}

/**
 * Calculate statistics for a benchmark run.
 *
 * This function uses the same logic as the UI to count pass/fail status:
 * - Iterates over run.results to get reportIds
 * - Looks up each report in the provided reports map
 * - Counts passFailStatus from completed reports
 *
 * @param run - The benchmark run to calculate stats for
 * @param reports - Map of reportId -> EvaluationReport (pre-fetched)
 * @returns Calculated statistics including passed, failed, pending, total, and passRate
 */
export function calculateRunStats(
  run: BenchmarkRun,
  reports: Record<string, EvaluationReport | null>
): RunStats {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let errored = 0;
  let notRun = 0;
  let total = 0;

  Object.entries(run.results || {}).forEach(([testCaseId, result]) => {
    total++;

    // Check result status first
    if (result.status === 'pending' || result.status === 'running') {
      pending++;
      return;
    }

    // Never started (run cancelled before reaching it) — not a failure.
    if (result.status === 'cancelled') {
      notRun++;
      return;
    }

    if (result.status === 'failed') {
      failed++;
      return;
    }

    // For completed results, check the report's passFailStatus
    if (result.status === 'completed' && result.reportId) {
      const report = reports[result.reportId];

      if (!report) {
        // Report not loaded yet or doesn't exist
        pending++;
        return;
      }

      // Check if evaluation is still pending (trace mode)
      if (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') {
        pending++;
        return;
      }

      // Issue #242: evaluator could not produce a verdict (judge validation
      // error, trace timeout, etc.). Excluded from passed/failed so
      // misconfigured evaluators don't masquerade as agent failures.
      if (report.metricsStatus === 'error') {
        errored++;
        return;
      }

      // Count based on passFailStatus from LLM judge
      if (report.passFailStatus === 'passed') {
        passed++;
      } else {
        // passFailStatus === 'failed' or undefined (treat as failed)
        failed++;
      }
    } else {
      // No reportId but status is completed - treat as pending
      pending++;
    }
  });

  // Pass rate is computed over the evaluable set (total minus errored minus
  // never-run). If every run errored, expose 0% rather than dividing by zero.
  const evaluable = Math.max(0, total - errored - notRun);
  const passRate = evaluable > 0 ? Math.round((passed / evaluable) * 100) : 0;

  return {
    passed,
    failed,
    pending,
    errored,
    notRun,
    total,
    passRate,
  };
}

/**
 * Extract all report IDs from a run's results that need to be fetched.
 *
 * @param run - The benchmark run to extract report IDs from
 * @returns Array of unique report IDs
 */
export function getReportIdsFromRun(run: BenchmarkRun): string[] {
  const reportIds = new Set<string>();

  Object.values(run.results || {}).forEach((result) => {
    if (result.reportId) {
      reportIds.add(result.reportId);
    }
  });

  return Array.from(reportIds);
}

/**
 * Compute stats from a benchmark run and its reports.
 * This is the server-side version that returns the denormalized stats object.
 *
 * @param run - The benchmark run to compute stats for
 * @param reports - Array of reports for this run
 * @returns Denormalized stats object (passed, failed, pending, total)
 */
/**
 * Canonical "display" stats for a run detail/list view: prefer recomputing
 * from the persisted per-test-case verdicts (`run.results`) via
 * {@link bucketRunResults} — the single source of truth — and only fall
 * back to the denormalized `run.stats` when `results` is empty (e.g. a run
 * that hasn't started, or legacy data with no results map at all).
 *
 * This is THE single shared helper for pass/fail/errored/pending/total
 * across every surface that renders run stats (runs list, benchmark runs
 * list, run detail page, comparison page) — do not reimplement this logic
 * locally in a component or add a differently-named twin. Historically this
 * logic was duplicated per-page (each with its own subtly different bugs,
 * e.g. `errored` not tracked, or `run.stats` trusted directly even when
 * stale/inflated for trace-judged runs — a 66/84-real-passed run displaying
 * as 84/84). Callers that only need `{passed, failed, errored, total}` can
 * simply ignore the extra `pending` field.
 */
export function computeRunStats(
  run: {
    status?: BenchmarkRunStatus;
    results?: Record<string, { status?: string; passFailStatus?: string }>;
    stats?: Partial<RunStatsType> | null;
    testCaseSnapshots?: unknown[];
  }
): Pick<RunStatsType, 'passed' | 'failed' | 'errored' | 'pending' | 'total'> & { notRun: number } {
  const plannedTotal = run.testCaseSnapshots?.length;
  // Terminal-aware bucketing (see bucketRunResults): the planned-but-absent
  // remainder is `pending` only while the run is still running. Only the
  // EXPLICIT persisted status is trusted here — the results-derived legacy
  // fallback in getEffectiveRunStatus reports 'completed' for any status-less
  // run whose observed results happen to all be settled, which is exactly
  // what an in-flight legacy run looks like between two cases.
  const effectiveStatus = run.status;
  if (run.results && Object.keys(run.results).length > 0) {
    const bucketed = bucketRunResults(run.results, plannedTotal, effectiveStatus);

    // Legacy-shape fallback (goyamegh/pr-run-report-v2, run-list all-errored bug):
    // runs created before per-result passFailStatus denormalization landed
    // (evaluationRunner.ts writing `results[testCaseId].passFailStatus`) only
    // persisted `{ reportId, status: 'completed' }` on each result -- no
    // verdict field at all. bucketRunResults correctly treats a 'completed'
    // result with no passFailStatus as `errored` (#242), which is right for a
    // genuine judge failure, but wrong here: EVERY case in the run buckets as
    // errored (0 passed, 0 failed) even though the run actually has real
    // verdicts. Detect that specific signature and, only when the
    // denormalized `run.stats` independently shows real pass/fail evidence
    // (computed by the report-fetching `computeStatsForRun`, verified against
    // linked reports' actual passFailStatus -- see tests/unit/lib/runStats.test.ts
    // 'legacy run shape' cases), trust `run.stats` instead of asserting the
    // whole run errored. A run that is genuinely all-errored (no result ever
    // resolved a verdict) will have run.stats.passed === run.stats.failed === 0
    // too, so it still falls through to the errored bucketing below.
    const allBucketedAsErrored = bucketed.errored > 0 && bucketed.passed === 0 && bucketed.failed === 0;
    const statsHaveRealVerdicts = !!run.stats && ((run.stats.passed ?? 0) > 0 || (run.stats.failed ?? 0) > 0);
    if (allBucketedAsErrored && statsHaveRealVerdicts && run.stats) {
      return statsFallback(run.stats, run.stats.total ?? bucketed.total, effectiveStatus);
    }

    return bucketed;
  }
  if (run.stats && (run.stats.total ?? 0) > 0) {
    return statsFallback(run.stats, run.stats.total ?? 0, effectiveStatus);
  }
  // No results and no stats: a run that never started a case. Terminal →
  // every planned case is "not run"; otherwise they're all still pending.
  const planned = plannedTotal || 0;
  return isTerminalRunStatus(effectiveStatus)
    ? { passed: 0, failed: 0, errored: 0, pending: 0, notRun: planned, total: planned }
    : { passed: 0, failed: 0, errored: 0, pending: planned, notRun: 0, total: planned };
}

/**
 * Denormalized `run.stats` fallback, made terminal-aware: stats persisted
 * before `notRun` existed carry the never-started remainder in `pending`
 * even for a cancelled run. Re-home that remainder so a legacy cancelled
 * run can't render a phantom spinner either.
 */
function statsFallback(
  stats: Partial<RunStatsType>,
  total: number,
  effectiveStatus: BenchmarkRunStatus | undefined
): Pick<RunStatsType, 'passed' | 'failed' | 'errored' | 'pending' | 'total'> & { notRun: number } {
  const pending = stats.pending ?? 0;
  const notRun = stats.notRun ?? 0;
  const terminal = isTerminalRunStatus(effectiveStatus);
  return {
    passed: stats.passed ?? 0,
    failed: stats.failed ?? 0,
    errored: stats.errored ?? 0,
    pending: terminal ? 0 : pending,
    notRun: terminal ? notRun + pending : notRun,
    total,
  };
}

export function computeRunStatsFromReports(
  run: BenchmarkRun,
  reports: EvaluationReport[]
): RunStatsType {
  const reportsMap: Record<string, EvaluationReport | null> = {};
  reports.forEach(report => {
    reportsMap[report.id] = report;
  });

  const fullStats = calculateRunStats(run, reportsMap);

  return {
    passed: fullStats.passed,
    failed: fullStats.failed,
    pending: fullStats.pending,
    errored: fullStats.errored,
    notRun: fullStats.notRun,
    total: fullStats.total,
  };
}

/**
 * Single canonical "is this run actively in progress" check, shared by every
 * runs-list surface (bug: the Evaluation Runs page and the benchmark-scoped
 * Runs panel each grew their own copy of this, and only one of them actually
 * rendered a running indicator). `status` is authoritative when present
 * (always true for `EvaluationRun`; `BenchmarkRun.status` is only undefined
 * for legacy pre-status data). Falls back to inspecting `results` so legacy
 * runs without a top-level `status` still get a sensible effective status.
 */
export function getEffectiveRunStatus(
  run: { status?: BenchmarkRunStatus; results?: Record<string, { status?: string }> }
): BenchmarkRunStatus {
  if (run.status) return run.status;
  const results = Object.values(run.results || {});
  if (results.some(r => r.status === 'running')) return 'running';
  if (results.some(r => r.status === 'pending') &&
      !results.some(r => r.status === 'completed' || r.status === 'failed')) return 'running';
  if (results.some(r => r.status === 'completed') || results.some(r => r.status === 'failed')) return 'completed';
  return 'failed';
}

/**
 * True when a run has neither reached a terminal status nor accounted for
 * every planned test case yet. Used to decide whether a runs-list page
 * should keep polling for live updates.
 */
export function isRunInProgress(
  run: { status?: BenchmarkRunStatus; results?: Record<string, { status?: string }> }
): boolean {
  return getEffectiveRunStatus(run) === 'running';
}
