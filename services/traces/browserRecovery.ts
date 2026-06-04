/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-side trace polling recovery helper.
 *
 * Used by:
 *   - components/RunDetailsContent.tsx \u2014 when the user opens the *currently
 *     selected* pending report (existing inline recovery, retained there).
 *   - components/evals3/RunInspectorPage.tsx \u2014 to fan out recovery for every
 *     pending result on the inspect view, so users no longer have to click
 *     each pending row to unstick it.
 *
 * `tracePollingManager.startPolling` is idempotent (it skips if a poll is
 * already running for the report id), so calling this helper is safe even
 * when server-side recovery is also in flight.
 */

import type { EvaluationReport, TestCase } from '@/types';
import { tracePollingManager } from '@/services/traces/tracePoller';
import { asyncRunStorage } from '@/services/storage';
import { callBedrockJudge } from '@/services/evaluation';
import {
  buildJudgeMatcherEntry,
  formatExpectedOutcomesAsClaim,
} from '@/lib/matchers/judgeAccessor';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { DEFAULT_CONFIG } from '@/lib/constants';

/**
 * Ensure trace polling is running for a pending report. The provided
 * callbacks let the caller refresh local UI state when the judge finishes
 * (or fails). All callbacks are optional \u2014 omit them for fire-and-forget
 * background recovery.
 */
export function ensureTracePollingForReport(
  report: EvaluationReport,
  testCase: TestCase | null,
  options?: {
    onUpdated?: (updated: EvaluationReport) => void;
    onError?: (err: Error) => void;
  }
): void {
  // Only valid for trace-mode pending reports with a runId and a test case.
  if (report.metricsStatus !== 'pending' || !report.runId || !testCase) return;

  const existingState = tracePollingManager.getState(report.id);
  if (existingState?.running) return;

  tracePollingManager.startPolling(
    report.id,
    report.runId,
    {
      onTracesFound: async (_spans, updatedReport) => {
        try {
          const judgeModelId = report.modelId
            ? (DEFAULT_CONFIG.models[report.modelId]?.model_id || report.modelId)
            : undefined;

          const judgment = await callBedrockJudge(
            updatedReport.trajectory,
            {
              expectedOutcomes: testCase.expectedOutcomes,
              expectedTrajectory: testCase.expectedTrajectory,
            },
            [], // No logs in trace mode \u2014 traces are the source of truth
            () => {},
            judgeModelId
          );

          await asyncRunStorage.updateReport(report.id, {
            metricsStatus: 'ready',
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
            // Unified judge surface (issue #230 follow-up).
            matcherResults: [
              buildJudgeMatcherEntry(judgment, {
                claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
                model: judgeModelId,
              }),
            ],
            improvementStrategies: judgment.improvementStrategies,
          });

          if (options?.onUpdated) {
            const fresh = await asyncRunStorage.getReportById(report.id);
            if (fresh) options.onUpdated(fresh);
          }
        } catch (err) {
          await asyncRunStorage.updateReport(report.id, buildEvaluatorErrorPatch(
            'judge_failed',
            err,
          ) as any).catch(() => { /* swallow \u2014 nothing more to do */ });

          if (options?.onError) options.onError(err instanceof Error ? err : new Error(String(err)));
          if (options?.onUpdated) {
            const fresh = await asyncRunStorage.getReportById(report.id);
            if (fresh) options.onUpdated(fresh);
          }
        }
      },
      onAttempt: () => { /* no verbose logging in background recovery */ },
      onError: (error) => {
        if (options?.onError) options.onError(error);
      },
    }
  );
}
