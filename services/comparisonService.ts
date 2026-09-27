/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExperimentRun,
  EvaluationReport,
  RunAggregateMetrics,
  RunScoringSummary,
  TestCaseComparisonRow,
  TestCaseRunResult,
  Category,
  TraceMetrics,
} from '@/types';
import { TEST_CASES } from '@/data/testCases';
import { bucketRunResults } from '@/lib/runStats';
import {
  primaryMetricMeans,
  rubricScale,
  rubricValuesByName,
  runAggregate,
  scoreFromSnapshot,
  scoredRubricNames,
} from '@/lib/scoring/snapshotScore';
import { resolveJudgeModelId } from '@/lib/comparison/scoringDisplay';
import { rowVerdictAgreement, verdictOf } from '@/lib/comparison/verdictAgreement';
import {
  MockTestCaseMeta,
  getMockTestCaseMeta,
  getMockTestCaseVersion,
} from '@/data/mockComparisonData';
import { buildJudgeAgentsHints, type JudgeAgentsHint } from '@/services/traces/judgeAgentsHints';

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
 * Collapse a run's snapshot aggregate into the display summary the scoreboard
 * needs (evaluator identity, weights, pass policy, primary-metric means).
 * The representative snapshot is the first one seen; `contentHashes` lists
 * every distinct hash so the coverage gate can flag mixed runs.
 */
export function summarizeRunScoring(
  aggregate: ReturnType<typeof runAggregate>,
  reports: ReadonlyArray<EvaluationReport | undefined>
): RunScoringSummary {
  if (aggregate.source !== 'snapshot' || aggregate.snapshots.length === 0) return { source: 'legacy' };
  const snapshot = aggregate.snapshots[0];
  const primaryNames = Array.from(new Set(
    aggregate.snapshots.flatMap(s => Array.isArray(s.primaryMetrics) ? s.primaryMetrics : [])
  ));
  const means = primaryMetricMeans(reports, primaryNames);
  return {
    source: 'snapshot',
    evaluatorId: snapshot.evaluatorId,
    evaluatorName: snapshot.evaluatorName,
    evaluatorVersion: snapshot.evaluatorVersion,
    contentHashes: aggregate.snapshots.map(s => String(s.contentHash ?? '')),
    weights: Object.fromEntries(scoredRubricNames(snapshot).map(n => [n, snapshot.weights[n]])),
    passPolicy: snapshot.passPolicy ?? { kind: 'llm-verdict' },
    scoredReports: aggregate.scoredReports,
    scoredRubrics: aggregate.scoredRubrics,
    totalRubrics: aggregate.totalRubrics,
    // Scale from the first snapshot that declares one for the metric (a
    // mixed-snapshot run is already flagged by the coverage gate).
    primaryMetrics: primaryNames.map(name => {
      const declaring = aggregate.snapshots.find(s => s.scale?.[name]) ?? snapshot;
      return { name, mean: means[name], scale: rubricScale(declaring, name) };
    }),
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
  // Only reports that actually CARRY a numeric `metrics.accuracy` participate:
  // custom-evaluator reports score entirely different metric keys and have no
  // accuracy field at all. `avgAccuracy` is a metric named by its key — it is
  // NOT the run's score (see `avgScore` below) and is no longer a scoreboard
  // column; it feeds the legacy summary table / HTML export only.
  let totalAccuracy = 0;
  let accuracyCount = 0;
  const runReports: Array<EvaluationReport | undefined> = [];
  const testCaseVersions: Record<string, number> = {};
  // Every DISTINCT judge the run's reports resolve to (never the agent
  // model). Exactly one → the caption names it; several → "mixed" (a run
  // re-judged half-way through, or a fallback judge kicking in) is surfaced
  // rather than hidden behind whichever report came first (codex review).
  const judgeModelIds: string[] = [];
  for (const testCaseId of testCaseIds) {
    const result = run.results[testCaseId];
    const report = reports[result.reportId];
    if (!report) continue;
    runReports.push(report);
    if (typeof report.testCaseVersion === 'number') testCaseVersions[testCaseId] = report.testCaseVersion;
    const judge = resolveJudgeModelId(report, run as { judgeModelId?: string });
    if (judge && !judgeModelIds.includes(judge)) judgeModelIds.push(judge);
    if (report.metricsStatus === 'error' || report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') continue;
    if (typeof report.metrics?.accuracy === 'number') {
      accuracyCount++;
      totalAccuracy += report.metrics.accuracy;
    }
  }
  if (judgeModelIds.length === 0) {
    const runJudge = resolveJudgeModelId(undefined, run as { judgeModelId?: string });
    if (runJudge) judgeModelIds.push(runJudge);
  }

  // "Avg score": the ONLY run-level score. Derived from each report's frozen
  // ScoringSnapshot (weighted mean of its rubrics, normalized to [0,1]); a
  // run with any legacy (snapshot-less) evaluated report has NO score — it
  // renders "—" + "legacy scoring" rather than a number reconstructed from an
  // arbitrary rubric (the old alphabetical primary-rubric pick showed an
  // unrelated rubric at ~90% next to a 45% pass rate).
  const aggregate = runAggregate(runReports);
  const scoring = summarizeRunScoring(aggregate, runReports);
  const avgScore = aggregate.source === 'snapshot' && aggregate.score !== null
    ? Math.round(aggregate.score * 100)
    : undefined;
  // "Evaluated" = the JUDGED set (passed + failed) — the same denominator as
  // the runs list (lib/runStats). Errored (judge produced no verdict), pending
  // (not finished) and not-run cases are all excluded, and each is called out
  // separately in the pass-rate detail so "1 / 2" can never mean "1 passed of
  // 2 evaluated" while the second case is still running.
  const evaluable = passedCount + failedCount;
  const pendingCount = buckets.pending + buckets.notRun;

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
    avgAccuracy: accuracyCount > 0 ? Math.round(totalAccuracy / accuracyCount) : undefined,
    avgScore,
    scoring,
    evaluatedCount: evaluable,
    pendingCount,
    passRatePercent: evaluable > 0 ? Math.round((passedCount / evaluable) * 100) : 0,
    judgeModelId: judgeModelIds.length === 1 ? judgeModelIds[0] : undefined,
    judgeModelIds,
    testCaseVersions,
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
  let anyPartial = false, anyWindow = false;
  for (const result of Object.values(run.results)) {
    const report = reports[result.reportId];
    const key = report ? metricsKeyForReport(report) : undefined;
    if (key) {
      const tm = traceMetricsMap.get(key);
      if (tm && tm.status !== 'pending') {
        if (tm.partial) anyPartial = true;
        if (tm.correlatedBy === 'window' || tm.correlatedBy === 'mixed') anyWindow = true;
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
    ...(mc > 0 && anyPartial ? { traceMetricsPartial: true } : {}),
    ...(mc > 0 && anyWindow ? { traceMetricsWindowCorrelated: true } : {}),
  };
}

/**
 * The key a report's trace metrics are requested and returned under.
 *
 * `report.runId` when the connector produced (or the `afterResponse` hook
 * extracted) a correlation id; otherwise the report's own storage id. The
 * batch metrics API returns results under whatever key was sent, so a report
 * with NO runId can still be correlated purely by its Strategy-C hint
 * (service.name + window, see {@link collectMetricsCorrelationFromReports})
 * and its metrics land back on the right report. Pre-fix such reports were
 * silently skipped by every collector below, which is exactly why the
 * comparison scoreboard's Cost / Tokens / LLM Calls stayed blank for whole
 * REST-connector runs even though the Traces tab showed their spans.
 */
export function metricsKeyForReport(
  report: Pick<EvaluationReport, 'id' | 'runId'>
): string | undefined {
  return report.runId || report.id || undefined;
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
      const key = report ? metricsKeyForReport(report) : undefined;
      if (key && !runIds.includes(key)) {
        runIds.push(key);
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
      const key = report ? metricsKeyForReport(report) : undefined;
      if (key && sessionId && !sessionIdByRunId[key]) {
        sessionIdByRunId[key] = sessionId;
      }
    }
  }
  return sessionIdByRunId;
}

/**
 * Build a `report.runId -> report.traceId` map for every report reachable
 * from `runs` (Strategy-A correlator, see server/services/metricsService.ts).
 *
 * REST-connector reports never get a native runId (`RESTConnector.execute()`
 * returns none), so `report.runId` already falls back to `report.traceId` in
 * that case — harmless here (mapping a key to itself). The map matters for
 * connectors that DO have a distinct native runId (subprocess agents like
 * Claude Code) whose vendor OTel SDK never stamps `agent_health.run.id`; only
 * the shared `traceId` (propagated via W3C TRACEPARENT) reaches their spans.
 */
export function collectTraceIdsFromReports(
  runs: ExperimentRun[],
  reports: Record<string, EvaluationReport>
): Record<string, string> {
  const traceIdByRunId: Record<string, string> = {};
  for (const run of runs) {
    for (const result of Object.values(run.results)) {
      const report = reports[result.reportId];
      const key = report ? metricsKeyForReport(report) : undefined;
      if (key && report?.traceId && !traceIdByRunId[key]) {
        traceIdByRunId[key] = report.traceId;
      }
    }
  }
  return traceIdByRunId;
}

/** Per-case snapshot score on the 0–100 display scale, or undefined for legacy / unscored reports. */
export function perCaseScore(report: Pick<EvaluationReport, 'metrics' | 'scoringSnapshot'>): number | undefined {
  const rs = scoreFromSnapshot(report);
  return rs.source === 'snapshot' && rs.score !== null ? Math.round(rs.score * 1000) / 10 : undefined;
}

/**
 * Build a `metrics key -> Strategy-C/D hints` map for every report reachable
 * from `runs`, so `fetchBatchMetrics` can correlate a report's spans by the
 * agent's OTel `service.name` + the run's wall-clock window even when the
 * report carries NO runId / sessionId / traceId at all.
 *
 * The hint is derived by {@link buildJudgeAgentsHints} — the SAME function
 * the agent (trace) judge and the run-report Traces tab use — from the
 * report's `connectorProtocol` / `agentKey` / `timestamp` /
 * `performanceMetrics.durationMs` / `sessionId`, plus the agent's configured
 * `traceServiceName` looked up through `resolveTraceServiceName(agentKey)`.
 * Nothing here is specific to any agent: a protocol whose service.name
 * isn't knowable (generic `rest` / `openai-compatible` / ... transports with
 * no `traceServiceName` configured) yields no hint, and that report simply
 * relies on A/B/D as before.
 */
export function collectAgentHintsFromReports(
  runs: ExperimentRun[],
  reports: Record<string, EvaluationReport>,
  resolveTraceServiceName: (agentKey: string | undefined) => string | undefined = () => undefined
): Record<string, JudgeAgentsHint[]> {
  const hintsByKey: Record<string, JudgeAgentsHint[]> = {};
  for (const run of runs) {
    for (const result of Object.values(run.results)) {
      const report = reports[result.reportId];
      const key = report ? metricsKeyForReport(report) : undefined;
      if (!key || hintsByKey[key]) continue;
      const hints = buildJudgeAgentsHints(report, resolveTraceServiceName(report.agentKey));
      if (hints.length > 0) hintsByKey[key] = hints;
    }
  }
  return hintsByKey;
}

/**
 * Everything `fetchBatchMetrics` needs for the runs on screen, derived in one
 * pass: the metrics keys (see {@link metricsKeyForReport}) plus the per-key
 * Strategy A (traceId), D (sessionId) and C (service.name + window) hints.
 */
export interface MetricsCorrelation {
  keys: string[];
  sessionIdByKey: Record<string, string>;
  traceIdByKey: Record<string, string>;
  agentsByKey: Record<string, JudgeAgentsHint[]>;
}

export function collectMetricsCorrelationFromReports(
  runs: ExperimentRun[],
  reports: Record<string, EvaluationReport>,
  resolveTraceServiceName?: (agentKey: string | undefined) => string | undefined
): MetricsCorrelation {
  return {
    keys: collectRunIdsFromReports(runs, reports),
    sessionIdByKey: collectSessionIdsFromReports(runs, reports),
    traceIdByKey: collectTraceIdsFromReports(runs, reports),
    agentsByKey: collectAgentHintsFromReports(runs, reports, resolveTraceServiceName),
  };
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
        // Only a run-level `failed` (agent crashed on the case) is a fail; an
        // in-flight (`pending`/`running`) or `cancelled` case has NO verdict
        // and must never be counted as one — it renders "Not run" and stays
        // out of Split / verdict-change counts (codex review).
        status: runResult.status === 'completed'
          ? 'completed'
          : (runResult.status === 'pending' || runResult.status === 'running' || runResult.status === 'cancelled')
            ? 'missing'
            : 'failed',
        passFailStatus: report.passFailStatus,
        // Issue #242: surface evaluator-error reports so the comparison
        // surface (MetricCell) can light up the amber `Errored` chip
        // instead of conflating with `Failed`.
        errored: report.metricsStatus === 'error',
        accuracy: report.metrics.accuracy,
        faithfulness: report.metrics.faithfulness,
        trajectoryAlignment: report.metrics.trajectory_alignment_score,
        latencyScore: report.metrics.latency_score,
        // Per-case score from the report's own scoring snapshot (0–100);
        // legacy reports get none and the cell shows rubric values by name.
        score: perCaseScore(report),
        rubricValues: rubricValuesByName(report.metrics),
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
 * What kind of difference a row shows between the runs:
 *   - `verdict`    — the runs reached different pass/fail verdicts. Uses the
 *                    SAME predicate as the insights band's "Split" bucket
 *                    (`lib/comparison/verdictAgreement.ts`), so the "N verdict
 *                    changes" badge and "Split" always agree.
 *   - `score-only` — every run agrees on the verdict but the per-case score
 *                    moved by more than {@link SCORE_ONLY_THRESHOLD} points.
 *                    A distinct, weaker signal; labelled separately in the UI.
 *   - `null`       — no difference (or the row is not covered by every run).
 */
export type RowDifferenceKind = 'verdict' | 'score-only' | null;

export interface RowClassification {
  status: RowStatus;
  kind: RowDifferenceKind;
}

/** Only flag pure score moves (verdicts agree) above this many points (0–100 scale). */
export const SCORE_ONLY_THRESHOLD = 5;

/**
 * The per-case number used for the secondary "score moved" signal. Snapshot
 * scores are only compared with snapshot scores. For legacy reports the only
 * quantity honest enough to diff is a metric both sides actually carry under
 * the same name — `accuracy` — never the invented 40/30/20/10 zero-filled
 * combination (`calculateCombinedScore`), which would flag "moves" on
 * rubrics a report never emitted (codex review). No shared quantity → no
 * score-only signal.
 */
function comparableScores(a: TestCaseRunResult, b: TestCaseRunResult): [number, number] | null {
  if (typeof a.score === 'number' && typeof b.score === 'number') return [a.score, b.score];
  if (typeof a.score === 'number' || typeof b.score === 'number') return null;
  if (typeof a.accuracy === 'number' && typeof b.accuracy === 'number') return [a.accuracy, b.accuracy];
  return null;
}

/**
 * Classify a row relative to the reference run (oldest run).
 *
 * The primary signal is the verdict: if the runs disagree on pass/fail the
 * row is a regression (baseline passed, another failed), an improvement
 * (the reverse) or mixed (both, ≥3 runs). Only when every run has a verdict
 * AND they all agree is the secondary score-move signal consulted. Rows not
 * covered by every run (missing / evaluator-errored, #242) are neutral —
 * "the judge broke" is not a regression of the agent.
 */
export function classifyRow(
  row: TestCaseComparisonRow,
  baselineRunId: string
): RowClassification {
  const runIds = Object.keys(row.results);
  const baselineResult = row.results[baselineRunId];
  if (!baselineResult) return { status: 'neutral', kind: null };

  const agreement = rowVerdictAgreement(row, runIds);
  if (agreement === 'uncovered') return { status: 'neutral', kind: null };

  let hasRegression = false;
  let hasImprovement = false;

  if (agreement === 'split') {
    const baselineVerdict = verdictOf(baselineResult);
    for (const [runId, result] of Object.entries(row.results)) {
      if (runId === baselineRunId) continue;
      const v = verdictOf(result);
      if (v === baselineVerdict) continue;
      if (baselineVerdict === 'passed') hasRegression = true;
      else hasImprovement = true;
    }
    return { status: resolveStatus(hasRegression, hasImprovement), kind: 'verdict' };
  }

  // Verdicts agree everywhere — look for a meaningful score move.
  for (const [runId, result] of Object.entries(row.results)) {
    if (runId === baselineRunId) continue;
    const pair = comparableScores(result, baselineResult);
    if (!pair) continue;
    const [score, baselineScore] = pair;
    if (score < baselineScore - SCORE_ONLY_THRESHOLD) hasRegression = true;
    if (score > baselineScore + SCORE_ONLY_THRESHOLD) hasImprovement = true;
  }
  const status = resolveStatus(hasRegression, hasImprovement);
  return { status, kind: status === 'neutral' ? null : 'score-only' };
}

function resolveStatus(hasRegression: boolean, hasImprovement: boolean): RowStatus {
  if (hasRegression && hasImprovement) return 'mixed';
  if (hasRegression) return 'regression';
  if (hasImprovement) return 'improvement';
  return 'neutral';
}

/**
 * Determine if a row represents a regression, improvement, or mixed result
 * compared to the reference run (oldest run). See {@link classifyRow}.
 */
export function calculateRowStatus(
  row: TestCaseComparisonRow,
  baselineRunId: string
): RowStatus {
  return classifyRow(row, baselineRunId).status;
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

/** Row-status tallies plus the two difference kinds (see {@link RowDifferenceKind}). */
export interface RowStatusCounts extends Record<RowStatus, number> {
  /** Rows where the runs reached different verdicts — equals the insights band's "Split" count. */
  verdictDifferences: number;
  /** Rows where verdicts agree but the score moved more than {@link SCORE_ONLY_THRESHOLD} points. */
  scoreOnlyDifferences: number;
}

/**
 * Count rows by status for summary display
 */
export function countRowsByStatus(
  rows: TestCaseComparisonRow[],
  baselineRunId: string
): RowStatusCounts {
  const counts: RowStatusCounts = {
    regression: 0,
    improvement: 0,
    mixed: 0,
    neutral: 0,
    verdictDifferences: 0,
    scoreOnlyDifferences: 0,
  };

  for (const row of rows) {
    const { status, kind } = classifyRow(row, baselineRunId);
    counts[status]++;
    if (kind === 'verdict') counts.verdictDifferences++;
    else if (kind === 'score-only') counts.scoreOnlyDifferences++;
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
