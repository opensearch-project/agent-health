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
 */

import type { BenchmarkRun, EvaluationReport } from '@/types/index.js';

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
  /** Total number of test cases in the run */
  total: number;
  /** Pass rate as a percentage (0-100) */
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

  // Calculate pass rate (percentage of completed test cases that passed)
  const completed = passed + failed;
  const passRate = completed > 0 ? Math.round((passed / completed) * 100) : 0;

  return {
    passed,
    failed,
    pending,
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
