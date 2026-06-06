/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExperimentRun,
  EvaluationReport,
  RunAggregateMetrics,
  TestCaseComparisonRow,
  TestCaseRunResult,
  Category,
} from '@/types';
import { TEST_CASES } from '@/data/testCases';
import {
  MockTestCaseMeta,
  getMockTestCaseMeta,
  getMockTestCaseVersion,
} from '@/data/mockComparisonData';

/**
 * Get test case metadata from real TEST_CASES data
 */
export function getRealTestCaseMeta(testCaseId: string): MockTestCaseMeta | undefined {
  const tc = TEST_CASES.find(t => t.id === testCaseId);
  if (!tc) return undefined;
  return {
    id: tc.id,
    name: tc.name,
    category: tc.category,
    difficulty: tc.difficulty,
    version: `v${tc.currentVersion}`,
  };
}

/**
 * Calculate aggregate metrics for a single run
 *
 * Uses run.stats (denormalized) for pass/fail counts when available,
 * falling back to computing from reports for accuracy and older data.
 */
export function calculateRunAggregates(
  run: ExperimentRun,
  reports: Record<string, EvaluationReport>
): RunAggregateMetrics {
  const testCaseIds = Object.keys(run.results);
  let totalAccuracy = 0;
  let passedCount = 0;
  let failedCount = 0;
  let completedCount = 0;

  // Fast path: use denormalized stats if available
  const hasStats = run.stats && typeof run.stats.passed === 'number';
  if (hasStats) {
    passedCount = run.stats!.passed;
    failedCount = run.stats!.failed;
  }

  // Always calculate accuracy from reports (not stored in run.stats)
  for (const testCaseId of testCaseIds) {
    const result = run.results[testCaseId];
    if (result.status === 'completed' || result.status === 'failed') {
      const report = reports[result.reportId];
      if (report) {
        completedCount++;
        totalAccuracy += report.metrics?.accuracy ?? 0;

        // Fallback: count pass/fail from reports if stats not available
        if (!hasStats) {
          if (report.passFailStatus === 'passed') {
            passedCount++;
          } else {
            failedCount++;
          }
        }
      }
    }
  }

  const count = completedCount || 1; // Avoid division by zero

  return {
    runId: run.id,
    runName: run.name,
    createdAt: run.createdAt,
    modelId: run.modelId,
    agentKey: run.agentKey,
    totalTestCases: testCaseIds.length,
    passedCount,
    failedCount,
    avgAccuracy: Math.round(totalAccuracy / count),
    passRatePercent: testCaseIds.length > 0 ? Math.round((passedCount / testCaseIds.length) * 100) : 0,
    // Trace metrics will be populated separately via fetchBatchMetrics
    totalTokens: undefined,
    totalInputTokens: undefined,
    totalOutputTokens: undefined,
    totalCostUsd: undefined,
    avgDurationMs: undefined,
    totalLlmCalls: undefined,
    totalToolCalls: undefined,
  };
}

/**
 * Collect all runIds from reports for trace metrics fetching
 */
export function collectRunIdsFromReports(
  runs: ExperimentRun[],
  reports: Record<string, EvaluationReport>
): string[] {
  const runIds: string[] = [];
  for (const run of runs) {
    for (const result of Object.values(run.results)) {
      const report = reports[result.reportId];
      if (report?.runId && !runIds.includes(report.runId)) {
        runIds.push(report.runId);
      }
    }
  }
  return runIds;
}

/**
 * Build comparison rows for all test cases across selected runs
 */
export function buildTestCaseComparisonRows(
  runs: ExperimentRun[],
  reports: Record<string, EvaluationReport>,
  getTestCaseMeta: (id: string) => MockTestCaseMeta | undefined = getMockTestCaseMeta,
  getTestCaseVersion: (testCaseId: string, runId: string) => string | undefined = getMockTestCaseVersion
): TestCaseComparisonRow[] {
  // Collect all unique test case IDs across all runs
  const allTestCaseIds = new Set<string>();
  for (const run of runs) {
    Object.keys(run.results).forEach(id => allTestCaseIds.add(id));
  }

  const rows: TestCaseComparisonRow[] = [];

  for (const testCaseId of allTestCaseIds) {
    const meta = getTestCaseMeta(testCaseId);
    const results: Record<string, TestCaseRunResult> = {};
    const versions: string[] = [];

    for (const run of runs) {
      const runResult = run.results[testCaseId];
      const version = getTestCaseVersion(testCaseId, run.id);

      if (version && !versions.includes(version)) {
        versions.push(version);
      }

      if (!runResult) {
        // Test case not in this run
        results[run.id] = { status: 'missing' };
        continue;
      }

      const report = reports[runResult.reportId];
      if (!report) {
        results[run.id] = { status: 'missing' };
        continue;
      }

      results[run.id] = {
        reportId: report.id,
        status: runResult.status === 'completed' ? 'completed' : 'failed',
        passFailStatus: report.passFailStatus,
        // Issue #242: surface evaluator-error reports so the comparison
        // surface (MetricCell) can light up the amber `Errored` chip
        // instead of conflating with `Failed`.
        errored: report.metricsStatus === 'error',
        accuracy: report.metrics.accuracy,
        faithfulness: report.metrics.faithfulness,
        trajectoryAlignment: report.metrics.trajectory_alignment_score,
        latencyScore: report.metrics.latency_score,
        testCaseVersion: version,
      };
    }

    rows.push({
      testCaseId,
      testCaseName: meta?.name || testCaseId,
      labels: meta?.labels || [],
      category: meta?.category || ('Unknown' as Category),
      difficulty: meta?.difficulty || 'Medium',
      results,
      hasVersionDifference: versions.length > 1,
      versions,
    });
  }

  // Sort by category then name
  return rows.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    return a.testCaseName.localeCompare(b.testCaseName);
  });
}

/**
 * Find the run ID with the best value for a given metric across all runs
 */
export function findBestRunForMetric(
  row: TestCaseComparisonRow,
  metric: 'accuracy' | 'faithfulness'
): string | undefined {
  let bestRunId: string | undefined;
  let bestValue = -1;

  for (const [runId, result] of Object.entries(row.results)) {
    const value = result[metric];
    if (value !== undefined && value > bestValue) {
      bestValue = value;
      bestRunId = runId;
    }
  }

  return bestRunId;
}

/**
 * Calculate delta between a value and the reference run
 */
export function calculateDelta(value: number, baseline: number): number {
  return value - baseline;
}

/**
 * Format delta for display
 */
export function formatDelta(delta: number): string {
  if (delta === 0) return '';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}%`;
}

/**
 * Get color class for delta value
 */
export function getDeltaColorClass(delta: number): string {
  if (delta > 0) return 'text-opensearch-blue';
  if (delta < 0) return 'text-red-400';
  return 'text-muted-foreground';
}

/**
 * Filter comparison rows by category
 */
export function filterRowsByCategory(
  rows: TestCaseComparisonRow[],
  category: Category | 'all'
): TestCaseComparisonRow[] {
  if (category === 'all') return rows;
  return rows.filter(row => row.category === category);
}

/**
 * Filter comparison rows by status
 */
export function filterRowsByStatus(
  rows: TestCaseComparisonRow[],
  status: 'all' | 'passed' | 'failed' | 'mixed',
  runIds: string[]
): TestCaseComparisonRow[] {
  if (status === 'all') return rows;

  return rows.filter(row => {
    const statuses = runIds
      .map(runId => row.results[runId]?.passFailStatus)
      .filter(Boolean);

    if (status === 'passed') {
      return statuses.every(s => s === 'passed');
    }
    if (status === 'failed') {
      return statuses.some(s => s === 'failed');
    }
    if (status === 'mixed') {
      const uniqueStatuses = new Set(statuses);
      return uniqueStatuses.size > 1;
    }
    return true;
  });
}

/**
 * Row status type for regression/improvement detection
 */
export type RowStatus = 'regression' | 'improvement' | 'mixed' | 'neutral';

/**
 * Calculate a weighted combined score from metrics
 * Weights: accuracy (40%), faithfulness (30%), trajectory alignment (20%), latency (10%)
 */
export function calculateCombinedScore(result: TestCaseRunResult): number {
  const weights = {
    accuracy: 0.4,
    faithfulness: 0.3,
    trajectoryAlignment: 0.2,
    latencyScore: 0.1,
  };
  return (
    (result.accuracy ?? 0) * weights.accuracy +
    (result.faithfulness ?? 0) * weights.faithfulness +
    (result.trajectoryAlignment ?? 0) * weights.trajectoryAlignment +
    (result.latencyScore ?? 0) * weights.latencyScore
  );
}

/**
 * Determine if a row represents a regression, improvement, or mixed result
 * compared to the reference run (oldest run).
 *
 * The primary signal is pass/fail — if the baseline passed and any other
 * run failed, that's a regression, regardless of how close the scores are.
 * Score-delta is a secondary tiebreaker for cases where pass/fail is the
 * same but accuracy moved meaningfully (e.g., both passed but one is much
 * weaker).
 */
export function calculateRowStatus(
  row: TestCaseComparisonRow,
  baselineRunId: string
): RowStatus {
  const baselineResult = row.results[baselineRunId];
  if (!baselineResult || baselineResult.status !== 'completed') {
    return 'neutral';
  }

  const SCORE_THRESHOLD = 5; // Only flag pure score moves above this delta.
  const baselineScore = calculateCombinedScore(baselineResult);
  const baselinePassed = baselineResult.passFailStatus === 'passed';

  let hasRegression = false;
  let hasImprovement = false;

  for (const [runId, result] of Object.entries(row.results)) {
    if (runId === baselineRunId || result.status !== 'completed') continue;

    // Primary signal: pass/fail crossover.
    if (result.passFailStatus) {
      const otherPassed = result.passFailStatus === 'passed';
      if (baselinePassed && !otherPassed) { hasRegression = true; continue; }
      if (!baselinePassed && otherPassed) { hasImprovement = true; continue; }
    }

    // Secondary signal: meaningful score move when pass/fail agrees.
    const score = calculateCombinedScore(result);
    if (score < baselineScore - SCORE_THRESHOLD) hasRegression = true;
    if (score > baselineScore + SCORE_THRESHOLD) hasImprovement = true;
  }

  if (hasRegression && hasImprovement) return 'mixed';
  if (hasRegression) return 'regression';
  if (hasImprovement) return 'improvement';
  return 'neutral';
}

/**
 * Comparison mode — drives whether the page asks
 * "why is one agent better?" (compare) or
 * "is my agent improving?" (iterate).
 *
 * - 'compare':  ≥2 distinct agentKeys across the selected runs.
 * - 'iterate':  all runs share one agentKey (a sequence of attempts).
 */
export type ComparisonMode = 'compare' | 'iterate';

/**
 * Detect the comparison mode from the selected runs.
 * Empty / single-run selections fall back to 'iterate' so that downstream
 * components have a deterministic mode to render against.
 */
export function detectComparisonMode(runs: ExperimentRun[]): ComparisonMode {
  if (runs.length < 2) return 'iterate';
  const agentKeys = new Set<string>();
  for (const run of runs) {
    if (run.agentKey) agentKeys.add(run.agentKey);
  }
  return agentKeys.size >= 2 ? 'compare' : 'iterate';
}

/**
 * Count rows by status for summary display
 */
export function countRowsByStatus(
  rows: TestCaseComparisonRow[],
  baselineRunId: string
): Record<RowStatus, number> {
  const counts: Record<RowStatus, number> = {
    regression: 0,
    improvement: 0,
    mixed: 0,
    neutral: 0,
  };

  for (const row of rows) {
    const status = calculateRowStatus(row, baselineRunId);
    counts[status]++;
  }

  return counts;
}
