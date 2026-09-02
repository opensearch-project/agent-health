/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Retry judgement" — re-run ONLY the LLM judge against a test case's
 * already-captured trajectory, without re-invoking the agent. Scoped to
 * top-level EvaluationRun docs (see lib/runActions.ts for the applicability
 * predicate) whose terminal results include at least one case where the
 * agent completed but the judge verdict was 'failed'.
 *
 * This reuses the exact same judge call (`callBedrockJudge`) and report-patch
 * shape the runner itself uses for the trace-mode deferred judge path (see
 * `waitForTracesAndJudge` in services/evaluationRunner.ts) — deliberately not
 * a new judging code path, just re-invoked against a stored report instead
 * of a freshly-finished one.
 */

import { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { callBedrockJudge } from '@/services/evaluation';
import { buildJudgeMatcherEntry, formatExpectedOutcomesAsClaim } from '@/lib/matchers/index';
import { buildJudgeAgentsHints } from '@/services/traces/judgeAgentsHints';
import { bucketRunResults } from '@/lib/runStats';
import { countJudgeFailed } from '@/lib/runActions';
import { loadConfigSync } from '@/lib/config/index';

export interface RetryJudgementOutcome {
  /** Test cases the judge was actually re-invoked for. */
  retried: number;
  /** Of those, how many now pass. */
  nowPassed: number;
  /** Of those, how many are still failing. */
  stillFailed: number;
  /**
   * Judge-failed cases that were skipped (missing report or test case doc,
   * or the judge call itself errored) — not counted in retried/nowPassed/
   * stillFailed. Zero in the common case.
   */
  skipped: number;
  /** Per-testCaseId skip reasons, for surfacing in the API response. */
  skipReasons: Record<string, string>;
}

/**
 * Re-judge every judge-failed test case in `run` (see
 * {@link countJudgeFailed}) and persist:
 *   - the updated report doc (passFailStatus/metrics/matcherResults/etc.)
 *   - the run's `results[testCaseId]` (fresh `passFailStatus`)
 *   - the run's denormalized `stats`, recomputed from the updated results
 *
 * Does NOT change `run.status` — a completed run stays completed even if a
 * previously-failed case now passes; only its stats move.
 */
export async function retryJudgementForRun(
  run: EvaluationRun,
  storage: Pick<IStorageModule, 'runs' | 'testCases' | 'evaluationRuns'>
): Promise<RetryJudgementOutcome> {
  const results = { ...(run.results || {}) };
  const targets = Object.entries(results).filter(([, r]) => {
    const result = r as { status?: string; passFailStatus?: string };
    return result.status === 'completed' && result.passFailStatus === 'failed';
  });

  const outcome: RetryJudgementOutcome = { retried: 0, nowPassed: 0, stillFailed: 0, skipped: 0, skipReasons: {} };
  if (targets.length === 0) return outcome;

  let agentTraceServiceName: string | undefined;
  try {
    const cfg = loadConfigSync();
    agentTraceServiceName = cfg.agents.find(a => a.key === run.agentKey)?.traceServiceName;
  } catch { /* best-effort only — Strategy C hints degrade gracefully without it */ }

  for (const [testCaseId, rawResult] of targets) {
    const result = rawResult as { reportId?: string; status?: string; passFailStatus?: string };
    const reportId = result.reportId;
    if (!reportId) {
      outcome.skipped++;
      outcome.skipReasons[testCaseId] = 'Result has no reportId to re-judge';
      continue;
    }

    try {
      const report = await storage.runs.getById(reportId);
      if (!report) {
        outcome.skipped++;
        outcome.skipReasons[testCaseId] = `Report ${reportId} no longer exists`;
        continue;
      }
      const testCase: TestCase | null = await storage.testCases.getById(testCaseId);
      if (!testCase) {
        outcome.skipped++;
        outcome.skipReasons[testCaseId] = `Test case ${testCaseId} no longer exists`;
        continue;
      }

      const judgeModelId = run.judgeModelId || (report as any).judgeModelId;
      const judgment = await callBedrockJudge(
        report.trajectory || [],
        { expectedOutcomes: testCase.expectedOutcomes, expectedTrajectory: testCase.expectedTrajectory },
        (report as any).openSearchLogs || (report as any).logs,
        undefined,
        judgeModelId,
        run.evaluatorId,
        (report as any).runId,
        buildJudgeAgentsHints(report as any, agentTraceServiceName)
      );

      await storage.runs.update(report.id, {
        passFailStatus: judgment.passFailStatus,
        metrics: judgment.metrics,
        metricsStatus: 'ready',
        llmJudgeReasoning: judgment.llmJudgeReasoning,
        matcherResults: [
          buildJudgeMatcherEntry(judgment, {
            claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
            model: judgeModelId,
          }),
        ],
        improvementStrategies: judgment.improvementStrategies,
        llmJudgeResponse: {
          modelId: judgeModelId || '',
          timestamp: new Date().toISOString(),
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: judgment.judgeDurationMs ?? 0,
          rawResponse: judgment.rawResponse ?? judgment.llmJudgeReasoning,
          parsedMetrics: judgment.metrics as any,
          improvementStrategies: judgment.improvementStrategies,
        },
      } as any);

      results[testCaseId] = { ...(rawResult as any), passFailStatus: judgment.passFailStatus };
      outcome.retried++;
      if (judgment.passFailStatus === 'passed') outcome.nowPassed++;
      else outcome.stillFailed++;
    } catch (error: any) {
      outcome.skipped++;
      outcome.skipReasons[testCaseId] = error?.message || 'Judge call failed';
    }
  }

  if (outcome.retried > 0) {
    const bucketed = bucketRunResults(results as any);
    const evaluable = Math.max(0, bucketed.total - bucketed.errored);
    await storage.evaluationRuns.update(run.id, {
      results,
      stats: {
        ...bucketed,
        passRate: evaluable > 0 ? Math.round((bucketed.passed / evaluable) * 100) : 0,
      },
    } as any);
  }

  return outcome;
}

/** Re-export for callers that only need the applicability count (route validation). */
export { countJudgeFailed };
