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
  TraceMetrics,
} from '@/types';
import { TEST_CASES } from '@/data/testCases';
import { bucketRunResults } from '@/lib/runStats';
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

  // Pass/fail/errored counts: the SINGLE source of truth shared with the runs
  // list (lib/runStats.bucketRunResults), computed from the persisted per-case
  // verdicts — NOT the naive denormalized run.stats (which counts errored cases
  // as passed and never tracks `errored`, #242). This keeps the comparison
  // panel, the per-cell Errored badges, and the runs list all in agreement.
  //
  // Some writers (e.g. the CLI benchmark path) persist results entries with
  // only { reportId, status } and leave the verdict on the report doc. Overlay
  // the report's passFailStatus before bucketing — otherwise every completed
  // case buckets as "errored" and the scoreboard renders a fabricated 0% pass
  // rate while the per-case table below shows real Passed/Failed verdicts.
  const resultsWithVerdicts = Object.fromEntries(
    Object.entries(run.results).map(([id, r]) => {
      const entry = r as { reportId?: string; status?: string; passFailStatus?: string };
      return [id, {
        status: entry.status,
        passFailStatus: entry.passFailStatus
          ?? (entry.reportId ? (reports[entry.reportId] as { passFailStatus?: string } | undefined)?.passFailStatus : undefined),
      }];
    })
  );
  const buckets = bucketRunResults(resultsWithVerdicts);
  const passedCount = buckets.passed;
  const failedCount = buckets.failed;
  const erroredCount = buckets.errored;

  // Accuracy is averaged over the *evaluated* reports only (exclude errored and
  // not-yet-evaluated / trace-pending), so placeholder zeros never drag it down.
  let totalAccuracy = 0;
  let completedCount = 0;
  for (const testCaseId of testCaseIds) {
    const result = run.results[testCaseId];
    const report = reports[result.reportId];
    if (!report) continue;
    if (report.metricsStatus === 'error' || report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') continue;
    completedCount++;
    totalAccuracy += report.metrics?.accuracy ?? 0;
  }

  const count = completedCount || 1; // Avoid division by zero (accuracy: over evaluable)
  const evaluable = Math.max(0, testCaseIds.length - erroredCount);

  return {
    runId: run.id,
    runName: run.name,
    createdAt: run.createdAt,
    modelId: run.modelId,
    agentKey: run.agentKey,
    totalTestCases: testCaseIds.length,
    passedCount,
    failedCount,
    erroredCount,
    avgAccuracy: Math.round(totalAccuracy / count),
    passRatePercent: evaluable > 0 ? Math.round((passedCount / evaluable) * 100) : 0,
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
 * Overlay trace-derived metrics (tokens/cost/duration/calls) onto a run's
 * base aggregate (from {@link calculateRunAggregates}), which deliberately
 * leaves these fields undefined since they come from a separate trace
 * metrics fetch. Two honesty fixes live here, both found comparing
 * EnterpriseRAG-Bench runs:
 *
 * 1. The batch metrics API returns a zero-filled `status: 'pending'`
 *    placeholder when a runId has no spans at all (no tracing configured, or
 *    traces not yet ingested) — summing those as real data rendered
 *    "$0.00 / 0ms" for an untraced agent, which reads as "this run cost
 *    nothing and took no time" instead of "not captured". Pending
 *    placeholders are skipped entirely.
 * 2. When no trace metrics are available at all (mc === 0), fall back to
 *    the per-result `performanceMetrics.durationMs` the benchmark runner
 *    already persists (averaged across cases with a real value) before the
 *    coarser run-level `performanceMetrics` fields — real data we already
 *    have beats another "0ms".
 */
export function mergeTraceMetrics(
  base: RunAggregateMetrics,
  run: ExperimentRun,
  reports: Record<string, EvaluationReport>,
  traceMetricsMap: Map<string, TraceMetrics>
): RunAggregateMetrics {
  let totalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCostUsd = 0, totalDurationMs = 0, totalLlmCalls = 0, totalToolCalls = 0, mc = 0;
  for (const result of Object.values(run.results)) {
    const report = reports[result.reportId];
    if (report?.runId) {
      const tm = traceMetricsMap.get(report.runId);
      if (tm && tm.status !== 'pending') {
        totalTokens += tm.totalTokens || 0;
        totalInputTokens += tm.inputTokens || 0;
        totalOutputTokens += tm.outputTokens || 0;
        totalCostUsd += tm.costUsd || 0;
        totalDurationMs += tm.durationMs || 0;
        totalLlmCalls += tm.llmCalls || 0;
        totalToolCalls += tm.toolCalls || 0;
        mc++;
      }
    }
  }

  // Duration fallback: prefer the per-result performanceMetrics the
  // benchmark runner already persists on run.results[testCaseId], but a
  // second source of truth exists too — the REPORT document itself can carry
  // its own performanceMetrics.durationMs (e.g. ad-hoc eval-run reports,
  // where duration lives on the report rather than a benchmark's embedded
  // result). Try the result first, then the report, per case.
  const perResultDurations = Object.values(run.results)
    .map(r => {
      const resultDuration = (r as { performanceMetrics?: { durationMs?: number } }).performanceMetrics?.durationMs;
      if (typeof resultDuration === 'number' && resultDuration > 0) return resultDuration;
      const report = reports[(r as TestCaseRunResult).reportId ?? ''];
      return report?.performanceMetrics?.durationMs;
    })
    .filter((d): d is number => typeof d === 'number' && d > 0);
  const perf = (run as ExperimentRun & { performanceMetrics?: { avgTestCaseDurationMs?: number; durationMs?: number } }).performanceMetrics;
  const fallbackAvgDurationMs = perResultDurations.length > 0
    ? Math.round(perResultDurations.reduce((a, b) => a + b, 0) / perResultDurations.length)
    : perf?.avgTestCaseDurationMs ?? (perf?.durationMs && base.totalTestCases ? Math.round(perf.durationMs / base.totalTestCases) : undefined);

  // Tool-calls fallback: when there is no trace data at all (mc === 0), fall
  // back to counting real 'action' trajectory steps across the run's reports
  // — the SAME counting DeepDiveHeaderMetrics' (now-removed) formatToolsCell
  // used. Only claim a fallback count when at least one report actually has
  // a trajectory array to count (0 is a real, meaningful count; "we never
  // saw a trajectory at all" is not — that stays a dash, not a fabricated 0).
  let toolCallFallbackKnown = false;
  let fallbackToolCalls = 0;
  for (const result of Object.values(run.results)) {
    const report = reports[result.reportId];
    if (report && Array.isArray(report.trajectory)) {
      toolCallFallbackKnown = true;
      fallbackToolCalls += report.trajectory.filter(s => s?.type === 'action').length;
    }
  }

  return {
    ...base,
    totalTokens: mc > 0 ? totalTokens : undefined,
    totalInputTokens: mc > 0 ? totalInputTokens : undefined,
    totalOutputTokens: mc > 0 ? totalOutputTokens : undefined,
    totalCostUsd: mc > 0 ? totalCostUsd : undefined,
    avgDurationMs: mc > 0 ? Math.round(totalDurationMs / mc) : fallbackAvgDurationMs,
    // LLM calls: no honest non-trace source exists on the report/result docs
    // (checked against real EnterpriseRAG-Bench data — no llmCallCount-shaped
    // field). Do NOT invent a proxy (e.g. counting 'assistant'/'thinking'
    // steps miscounts — a single visible turn can issue multiple LLM calls
    // in a tool-calling loop). Stays a dash without real trace data.
    totalLlmCalls: mc > 0 ? totalLlmCalls : undefined,
    totalToolCalls: mc > 0 ? totalToolCalls : (toolCallFallbackKnown ? fallbackToolCalls : undefined),
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
 * Build a `report.runId -> report.sessionId` map for every report reachable
 * from the given runs. Threaded through to `fetchBatchMetrics` so the batch
 * metrics endpoint can correlate via Strategy D (`session.id` — the precise,
 * real-world-adopted correlator for closed-source connectors like Claude
 * Code, which never stamp our own `agent_health.run.id` / `gen_ai.conversation.id`
 * attributes) in addition to Strategy B. Entries with no sessionId are omitted.
 */
export function collectSessionIdsFromReports(
  runs: ExperimentRun[],
  reports: Record<string, EvaluationReport>
): Record<string, string> {
  const sessionIdByRunId: Record<string, string> = {};
  for (const run of runs) {
    for (const result of Object.values(run.results)) {
      const report = reports[result.reportId];
      const sessionId = report?.sessionId;
      if (report?.runId && sessionId && !sessionIdByRunId[report.runId]) {
        sessionIdByRunId[report.runId] = sessionId;
      }
    }
  }
  return sessionIdByRunId;
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
 * - 'compare':  ≥2 distinct agentKeys OR ≥2 distinct modelIds (different
 *               agents, or the same agent on different models — e.g. Sonnet
 *               vs Opus).
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
  // 'compare' the moment the runs differ by agent OR by model: comparing
  // Sonnet vs Opus on the SAME agent (claude-code) is still a comparison, not
  // an iteration of one config. Only truly-identical setups (same agent AND
  // same model — e.g. re-runs of one config) default to 'iterate'.
  const agentKeys = new Set<string>();
  const modelIds = new Set<string>();
  for (const run of runs) {
    if (run.agentKey) agentKeys.add(run.agentKey);
    if (run.modelId) modelIds.add(run.modelId);
  }
  return (agentKeys.size >= 2 || modelIds.size >= 2) ? 'compare' : 'iterate';
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

/**
 * Test-level overlap between the selected runs.
 *
 * Comparison is a test-case-level primitive — it does NOT require the runs to
 * belong to the same benchmark. Two ad-hoc runs (no benchmarkId) can be
 * compared as long as we are honest about WHICH test cases they have in
 * common. This computes that honesty surface:
 *
 *  - `totalTestCases`  — union of every test case any selected run executed.
 *  - `sharedTestCases` — intersection: cases run by ALL selected runs (the
 *                        only cases where an apples-to-apples verdict holds).
 *  - `partialTestCases`— cases run by some-but-not-all runs (surfaced as
 *                        "Not run" cells per run).
 *  - `perRun`          — per-run executed count + how many were unique to it.
 *  - `fullyOverlapping` — true when every run ran the exact same set.
 */
export interface TestCaseOverlap {
  runCount: number;
  totalTestCases: number;
  sharedTestCases: number;
  partialTestCases: number;
  perRun: Array<{ runId: string; runName: string; count: number; uniqueCount: number }>;
  fullyOverlapping: boolean;
}

export function computeTestCaseOverlap(runs: ExperimentRun[]): TestCaseOverlap {
  const idsPerRun = runs.map(r => new Set(Object.keys(r.results || {})));
  const union = new Set<string>();
  idsPerRun.forEach(s => s.forEach(id => union.add(id)));

  let shared = 0;
  let partial = 0;
  for (const id of union) {
    const inCount = idsPerRun.reduce((n, s) => n + (s.has(id) ? 1 : 0), 0);
    if (runs.length > 0 && inCount === runs.length) shared++;
    else partial++;
  }

  const perRun = runs.map((run, i) => {
    const s = idsPerRun[i];
    let uniqueCount = 0;
    for (const id of s) {
      const inCount = idsPerRun.reduce((n, ss) => n + (ss.has(id) ? 1 : 0), 0);
      if (inCount === 1) uniqueCount++;
    }
    return { runId: run.id, runName: run.name, count: s.size, uniqueCount };
  });

  return {
    runCount: runs.length,
    totalTestCases: union.size,
    sharedTestCases: shared,
    partialTestCases: partial,
    perRun,
    fullyOverlapping: union.size > 0 && shared === union.size,
  };
}
