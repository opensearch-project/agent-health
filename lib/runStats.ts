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

import type { BenchmarkRun, EvaluationReport, RunStats as RunStatsType } from '@/types/index.js';

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
