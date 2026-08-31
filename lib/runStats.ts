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
  /** Total number of test cases in the run */
  total: number;
  /**
   * Pass rate as a percentage (0-100). Computed over `total - errored`
   * (the *evaluable* set), not over `total`, so a non-retryable judge
   * failure can't masquerade as the agent scoring 0%.
   */
  passRate: number;
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
 * `pending` so the invariant `total === passed+failed+errored+pending` still
 * holds and callers see the true "53 more to go" total instead of a
 * misleadingly small, already-100%-accounted-for total that looks finished.
 */
export function bucketRunResults(
  results: Record<string, { status?: string; passFailStatus?: string }> | undefined,
  plannedTotal?: number
): Pick<RunStats, 'passed' | 'failed' | 'errored' | 'pending' | 'total'> {
  let passed = 0, failed = 0, errored = 0, pending = 0, total = 0;
  for (const r of Object.values(results || {})) {
    total++;
    if (r.status === 'pending' || r.status === 'running') { pending++; continue; }
    if (r.status === 'failed' || r.status === 'cancelled') { failed++; continue; }
    if (r.status === 'completed') {
      if (r.passFailStatus === 'passed') passed++;
      else if (r.passFailStatus === 'failed') failed++;
      else errored++; // completed without a verdict = judge errored (#242)
      continue;
    }
    pending++; // unknown / no status
  }
  if (plannedTotal !== undefined && plannedTotal > total) {
    pending += plannedTotal - total;
    total = plannedTotal;
  }
  return { passed, failed, errored, pending, total };
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
  let total = 0;

  Object.entries(run.results || {}).forEach(([testCaseId, result]) => {
    total++;

    // Check result status first
    if (result.status === 'pending' || result.status === 'running') {
      pending++;
      return;
    }

    if (result.status === 'failed' || result.status === 'cancelled') {
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

  // Pass rate is computed over the evaluable set (total minus errored).
  // If every run errored, expose 0% rather than dividing by zero.
  const evaluable = Math.max(0, total - errored);
  const passRate = evaluable > 0 ? Math.round((passed / evaluable) * 100) : 0;

  return {
    passed,
    failed,
    pending,
    errored,
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
    results?: Record<string, { status?: string; passFailStatus?: string }>;
    stats?: Partial<RunStatsType> | null;
    testCaseSnapshots?: unknown[];
  }
): Pick<RunStatsType, 'passed' | 'failed' | 'errored' | 'pending' | 'total'> {
  const plannedTotal = run.testCaseSnapshots?.length;
  if (run.results && Object.keys(run.results).length > 0) {
    return bucketRunResults(run.results, plannedTotal);
  }
  if (run.stats && (run.stats.total ?? 0) > 0) {
    return {
      passed: run.stats.passed ?? 0,
      failed: run.stats.failed ?? 0,
      errored: run.stats.errored ?? 0,
      pending: run.stats.pending ?? 0,
      total: run.stats.total ?? 0,
    };
  }
  return { passed: 0, failed: 0, errored: 0, pending: 0, total: plannedTotal || 0 };
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
