/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry judgement — salvage a TERMINAL evaluation run whose AGENT
 * executions completed fine but whose JUDGE phase failed per test case
 * (trace_timeout, judge 400s, "evaluator could not run", etc.).
 *
 * Re-runs ONLY the judge pipeline (a bounded trace re-fetch for trace-mode
 * agents, then the judge call) against the STORED trajectory/output — it
 * never re-invokes the agent. Owner ask: "retry judgement on failed kinda
 * functionality at a run level ... so that we retry once the tests are
 * run" (a run can have 40+ completed cases with errored judgements, e.g.
 * trace timeouts or judge 400s, and re-running the whole agent side is
 * wasteful).
 *
 * Selection predicate mirrors what the run-report UI already labels
 * "ERRORED" (`getResultStatus()` in components/evals3/ResultStatus.tsx):
 * `report.metricsStatus === 'error'` on an agent execution that completed.
 * That status is written exclusively by
 * `buildEvaluatorErrorPatch()` (services/evaluation/evaluatorError.ts) for
 * both `judge_failed`/`trace_*` kinds AND `agent_failed` (a genuine agent
 * crash) — the two are told apart here by whether the report actually has
 * a trajectory to re-judge: an `agent_failed` report has none, so it is
 * excluded (nothing stored to salvage).
 */

import type {
  EvaluationRun,
  EvaluationReport,
  TestCase,
  AgentConfig,
  PassFailStatus,
} from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { callBedrockJudge } from '@/services/evaluation';
import { buildJudgeAgentsHints } from '@/services/traces/judgeAgentsHints';
import { buildJudgeMatcherEntry, formatExpectedOutcomesAsClaim } from '@/lib/matchers/index';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { spansToTrajectory } from '@/services/traces/spansToTrajectory';
import { fetchSpansForRun } from '@/services/traces/fetchSpansForRun';
import { computeRunStats } from '@/lib/runStats';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import { readEnv } from '@/lib/envCompat';

export type RetryJudgementScope = 'errored' | 'all';

export interface RetryJudgementCaseResult {
  testCaseId: string;
  reportId: string;
  outcome: 'succeeded' | 'failed';
  passFailStatus?: PassFailStatus | null;
  error?: string;
}

export interface RetryJudgementSummary {
  retried: number;
  succeeded: number;
  failed: number;
  results: RetryJudgementCaseResult[];
}

/**
 * Minimal shape retry-judgement needs from a run result. Wider than the
 * strict `EvaluationRun['results'][string]` type declares — the runner
 * persists `passFailStatus` on this map at runtime (see
 * services/evaluationRunner.ts) even though the type predates that field.
 */
export interface RunResultLike {
  reportId?: string;
  status?: string;
  passFailStatus?: PassFailStatus | null;
  error?: string;
}

/** Bounded — a salvage attempt, not a full poll cycle (never blocks the HTTP request for minutes). */
const RETRY_TRACE_FETCH_MAX_ATTEMPTS = 3;
const RETRY_TRACE_FETCH_INTERVAL_MS = 1500;
/** Cap on retry concurrency regardless of what the caller requests. */
const MAX_RETRY_CONCURRENCY = 3;

/**
 * True when `report` represents a judge failure that retry-judgement can
 * salvage: the agent execution completed (produced a report) but the
 * evaluator could not produce a verdict (`metricsStatus: 'error'`) — the
 * same condition the run-report UI already renders as "ERRORED" (amber) —
 * AND the report actually has a trajectory stored to re-judge (excludes
 * `agent_failed`: a genuine agent crash with nothing to salvage).
 */
export function isJudgeFailedCase(
  report: EvaluationReport | null | undefined,
  result: RunResultLike | undefined
): boolean {
  if (!report || !result) return false;
  if (result.status !== 'completed') return false;
  if (report.metricsStatus !== 'error') return false;
  return Array.isArray(report.trajectory) && report.trajectory.length > 0;
}

/**
 * True when `report` has agent output worth re-judging at all, regardless
 * of its current verdict. Used for `scope=all` (force a full re-judge pass).
 */
export function hasRejudgeableOutput(report: EvaluationReport | null | undefined): boolean {
  if (!report) return false;
  return Array.isArray(report.trajectory) && report.trajectory.length > 0;
}

/**
 * Select the test-case ids eligible for retry-judgement.
 *
 * @param scope 'errored' (default) — only judge-failed cases (see
 *              {@link isJudgeFailedCase}).
 *              'all' — every case with rejudgeable agent output, regardless
 *              of its current verdict.
 */
export function selectRetryableCases(
  run: Pick<EvaluationRun, 'results'>,
  reportsById: Record<string, EvaluationReport | null | undefined>,
  scope: RetryJudgementScope = 'errored'
): string[] {
  const ids: string[] = [];
  for (const [testCaseId, resultRaw] of Object.entries(run.results || {})) {
    const result = resultRaw as RunResultLike;
    if (!result?.reportId) continue;
    const report = reportsById[result.reportId];
    const eligible = scope === 'all'
      ? result.status === 'completed' && hasRejudgeableOutput(report)
      : isJudgeFailedCase(report, result);
    if (eligible) ids.push(testCaseId);
  }
  return ids;
}

function resolveAgentConfig(agentKey: string | undefined): AgentConfig | undefined {
  if (!agentKey) return undefined;
  try {
    const cfg = loadConfigSync();
    const allAgents = [...cfg.agents, ...getCustomAgents()];
    return allAgents.find(a => a.key === agentKey);
  } catch {
    return undefined;
  }
}

/**
 * Re-run ONLY the judge pipeline for one already-completed test case,
 * against the report's stored trajectory. Never re-invokes the agent.
 *
 * For trace-mode agents (`agentConfig.useTraces`), attempts a bounded
 * fresh trace fetch first — a `trace_timeout` retry can succeed if spans
 * have since landed in the backing OpenSearch cluster — and rebuilds the
 * trajectory from spans on success (falling back to the stored trajectory
 * when the re-fetch comes up empty, same as the original run would have
 * left on the report). Persists the verdict (or the canonical
 * evaluator-error patch on failure) onto the report doc.
 */
export async function retryJudgementForCase(
  report: EvaluationReport,
  testCase: TestCase,
  run: Pick<EvaluationRun, 'judgeModelId' | 'evaluatorId' | 'agentKey'>,
  storage: IStorageModule,
  agentConfig: AgentConfig | undefined
): Promise<{ passFailStatus: PassFailStatus | null; error?: string }> {
  let trajectory = report.trajectory || [];

  if (agentConfig?.useTraces) {
    try {
      const windowAgents = buildJudgeAgentsHints(report, agentConfig.traceServiceName);
      const fetchResult = await fetchSpansForRun(report.runId, {
        maxAttempts: RETRY_TRACE_FETCH_MAX_ATTEMPTS,
        intervalMs: RETRY_TRACE_FETCH_INTERVAL_MS,
        windowAgents,
      });
      if (fetchResult.spans.length > 0) {
        const converted = spansToTrajectory(fetchResult.spans, agentConfig.traceServiceName);
        if (converted.length > 0) trajectory = converted;
      } else {
        debug('RetryJudgement', `[${report.id}] Trace re-fetch found no spans — re-judging stored trajectory`);
      }
    } catch (err) {
      debug('RetryJudgement', `[${report.id}] Trace re-fetch failed, falling back to stored trajectory: ${err}`);
    }
  }

  const judgeModelId =
    run.judgeModelId ||
    report.judgeModelId ||
    readEnv('BEDROCK_MODEL_ID', 'AGENT_HEALTH_BEDROCK_MODEL_ID') ||
    report.modelId;
  try {
    const judgment = await callBedrockJudge(
      trajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      undefined,
      () => {},
      judgeModelId,
      run.evaluatorId,
      report.runId,
      buildJudgeAgentsHints(report, agentConfig?.traceServiceName)
    );

    await storage.runs.update(report.id, {
      trajectory,
      passFailStatus: judgment.passFailStatus,
      metrics: judgment.metrics,
      llmJudgeReasoning: judgment.llmJudgeReasoning,
      matcherResults: [
        buildJudgeMatcherEntry(judgment, {
          claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
          model: judgeModelId,
        }),
      ],
      improvementStrategies: judgment.improvementStrategies,
      metricsStatus: 'completed',
      // Explicit clear now that a verdict exists. `undefined` (rather than
      // omitting the key) is dropped by both storage backends' full
      // read-modify-write serialization — same idiom noted on
      // EvaluatorErrorPatch.passFailStatus's `null` (that field uses `null`
      // because it must survive an object-spread merge; `traceError` here
      // is a plain top-level key on the SAME update call, so `undefined`
      // is enough to drop it from the JSON body).
      traceError: undefined,
    } as any);

    return { passFailStatus: judgment.passFailStatus };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    // codex_review: a repeat failure previously left the report's PRIOR
    // `matcherResults` (a passing verdict, if this case was ever judged
    // successfully before — e.g. under `scope=all`) stale and inconsistent
    // with the new `metricsStatus: 'error'` — the Judge tab would show a
    // green matcher entry on a report the UI otherwise renders as errored.
    // Clear both alongside the canonical error patch.
    await storage.runs.update(report.id, {
      ...buildEvaluatorErrorPatch('judge_failed', `Retry judgement: ${message}`),
      matcherResults: [],
      improvementStrategies: [],
    } as any).catch(() => {});
    return { passFailStatus: null, error: message };
  }
}

/** Small bounded-concurrency runner (mirrors evaluationRunner's own helper). */
async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Fetch every report doc referenced by `run.results` once, keyed by report
 * id. Shared by {@link countRetryableCases} (a cheap pre-flight count so
 * the HTTP route can respond with a total before kicking off the — often
 * long-running — judge pipeline below) and {@link retryJudgementForRun}
 * itself, so both agree on exactly the same selection.
 */
async function fetchReportsById(
  run: Pick<EvaluationRun, 'results'>,
  storage: IStorageModule
): Promise<Record<string, EvaluationReport | null>> {
  const reportIds = Array.from(
    new Set(
      Object.values(run.results || {})
        .map((r: any) => r?.reportId)
        .filter((id: unknown): id is string => Boolean(id))
    )
  );
  const fetchedReports = await Promise.all(
    reportIds.map(id => storage.runs.getById(id).catch(() => null))
  );
  const reportsById: Record<string, EvaluationReport | null> = {};
  reportIds.forEach((id, i) => { reportsById[id] = fetchedReports[i]; });
  return reportsById;
}

/**
 * How many cases `retryJudgementForRun(run, storage, { scope })` would
 * retry, without doing any of the (potentially minutes-long) judge work.
 * Used by the route to report a `total` in its immediate 202 response —
 * see the module comment on `retryJudgementForRun` for why the route
 * doesn't await the full pipeline inline anymore.
 */
export async function countRetryableCases(
  run: Pick<EvaluationRun, 'results'>,
  storage: IStorageModule,
  scope: RetryJudgementScope = 'errored'
): Promise<number> {
  const reportsById = await fetchReportsById(run, storage);
  return selectRetryableCases(run, reportsById, scope).length;
}

/**
 * Retry judgement for a run: salvage judge-failed cases (or, with
 * `scope: 'all'`, every rejudgeable case) at JUDGE COST ONLY — the agent is
 * never re-invoked. Updates each report doc, the run's `results` map, and
 * recomputes `run.stats` (`lib/runStats` `computeRunStats`) before
 * persisting the run doc.
 *
 * Caller is responsible for the running/terminal-status gate (this
 * function does not re-check `run.status`).
 *
 * This can run for a long time on a large run (real incident: 62 cases at
 * ~40-90s per Bedrock judge call / concurrency 3 ≈ 20-30+ minutes) — the
 * caller (the HTTP route) MUST NOT hold the response open for the whole
 * duration; see server/routes/storage/evaluationRuns.ts's POST handler,
 * which fires this and returns immediately, polling status separately.
 * `options.onProgress(completed, total)` lets the caller track progress
 * for that polling without waiting on the returned promise.
 */
export async function retryJudgementForRun(
  run: EvaluationRun,
  storage: IStorageModule,
  options?: { scope?: RetryJudgementScope; concurrency?: number; onProgress?: (completed: number, total: number) => void }
): Promise<RetryJudgementSummary> {
  const scope = options?.scope ?? 'errored';
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? MAX_RETRY_CONCURRENCY, MAX_RETRY_CONCURRENCY));

  const reportsById = await fetchReportsById(run, storage);

  const testCaseIds = selectRetryableCases(run, reportsById, scope);
  const agentConfig = resolveAgentConfig(run.agentKey);

  const results: RetryJudgementCaseResult[] = [];
  const updatedResults: Record<string, any> = { ...run.results };
  const total = testCaseIds.length;
  let completedCount = 0;
  // Reports progress AFTER each case finishes (success or failure) rather
  // than as cases start, so `completed` never exceeds what's actually been
  // persisted — a poller reading `onProgress`'s last value always sees a
  // consistent lower bound. See the module comment above for why callers
  // need this at all (long-running pipeline, HTTP route can't await it).
  const reportProgress = () => options?.onProgress?.(completedCount, total);
  reportProgress();

  await runWithConcurrencyLimit(testCaseIds, concurrency, async (testCaseId) => {
    try {
      const result = updatedResults[testCaseId] as RunResultLike;
      const report = result?.reportId ? reportsById[result.reportId] : null;
      if (!report) {
        results.push({ testCaseId, reportId: result?.reportId || '', outcome: 'failed', error: 'report not found' });
        return;
      }
      // Judge against the test-case version the run actually SNAPSHOTTED
      // (testCaseSnapshots[].version), not today's possibly-edited
      // definition — otherwise "retry" silently becomes "re-grade against
      // different criteria" and the run's verdicts stop being comparable
      // with each other. Falls back to the current doc only for legacy runs
      // that recorded no snapshot version.
      const snapshotVersion = run.testCaseSnapshots?.find(s => s.id === testCaseId)?.version;
      let testCase: TestCase | null = null;
      try {
        testCase = snapshotVersion != null
          ? await storage.testCases.getVersion(testCaseId, snapshotVersion)
          : await storage.testCases.getById(testCaseId);
      } catch { /* handled below via null check */ }
      if (!testCase) {
        results.push({
          testCaseId, reportId: report.id, outcome: 'failed',
          error: snapshotVersion != null ? `test case version ${snapshotVersion} not found` : 'test case not found',
        });
        return;
      }

      const { passFailStatus, error } = await retryJudgementForCase(report, testCase, run, storage, agentConfig);

      const nextResult: any = { ...result, status: 'completed' };
      if (passFailStatus) {
        nextResult.passFailStatus = passFailStatus;
      } else {
        // Drop the key entirely rather than persist `passFailStatus: undefined`
        // — bucketRunResults() treats a missing verdict as errored, same as
        // the very first run.
        delete nextResult.passFailStatus;
      }
      updatedResults[testCaseId] = nextResult;

      results.push({
        testCaseId,
        reportId: report.id,
        outcome: passFailStatus ? 'succeeded' : 'failed',
        passFailStatus,
        ...(error ? { error } : {}),
      });
    } finally {
      completedCount += 1;
      reportProgress();
    }
  });

  const updatedRun = { ...run, results: updatedResults };
  const stats = computeRunStats(updatedRun);
  await storage.evaluationRuns.update(run.id, {
    results: updatedResults,
    stats: { ...(run.stats || {}), ...stats } as any,
  });

  // Deterministic order (not insertion/completion order, which varies with
  // the concurrency fan-out) so callers/tests can rely on a stable summary.
  results.sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));

  return {
    retried: testCaseIds.length,
    succeeded: results.filter(r => r.outcome === 'succeeded').length,
    failed: results.filter(r => r.outcome === 'failed').length,
    results,
  };
}
