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

import type { EvaluationReport, Span, TestCase } from '@/types';
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
    /** Fired as soon as spans land, before the judge runs — lets the caller
     *  update trace-visualization state (issue #320 consolidation). */
    onSpans?: (spans: Span[]) => void;
    /**
     * Only start recovery when the report has been pending at least this
     * long. Eager-path reports are *transiently* pending while their agent
     * executes — fan-out callers (RunInspectorPage) should pass a grace
     * period so freshly-created reports aren't dragged into trace polling
     * that races their eager judge. 0 (default) = start immediately.
     */
    minPendingAgeMs?: number;
  }
): void {
  // Only valid for trace-mode pending reports with a test case. A missing
  // runId is no longer disqualifying because the poller can correlate via
  // sessionId/service-window hints; the neutral marker still prevents stale
  // no-trace placeholders from entering the timeout path (#407).
  if (report.traceStatus === 'not_configured' || report.metricsStatus !== 'pending' || !testCase) return;

  const minAge = options?.minPendingAgeMs ?? 0;
  if (minAge > 0) {
    const ts = Date.parse(report.timestamp || '') || 0;
    if (ts > 0 && Date.now() - ts < minAge) return;
  }

  const existingState = tracePollingManager.getState(report.id);
  if (existingState?.running) return;

  tracePollingManager.startPolling(
    report.id,
    report.runId,
    {
      onTracesFound: async (spans, updatedReport) => {
        try {
          options?.onSpans?.(spans);

          // TRUE-FALLBACK GUARD (issue #320): the server-side poller runs the
          // same judge in a different runtime, so the "already polling" check
          // above cannot see it. Re-read the persisted report and bail unless
          // it is still awaiting a judge ('pending'); 'calculating' means a
          // judge is mid-flight elsewhere, and 'ready'/'error' mean a verdict
          // already landed — the browser recovery must never race or
          // overwrite the server's judge result.
          const persisted = await asyncRunStorage.getReportById(report.id);
          if (persisted && persisted.metricsStatus !== 'pending') {
            if (persisted.metricsStatus !== 'calculating' && options?.onUpdated) {
              options.onUpdated(persisted);
            }
            return;
          }

          // Same priority as the server-side runner: report.judgeModelId
          // (persisted at run-create time) > agent's modelId BC fallback.
          // (BEDROCK_MODEL_ID env is server-only — not readable here.)
          const judgeModelKey = report.judgeModelId || report.modelId;
          const judgeModelId = judgeModelKey
            ? (DEFAULT_CONFIG.models[judgeModelKey]?.model_id || judgeModelKey)
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
          ) as any).catch((updateErr) => {
            // Last-resort log. If marking-as-error itself fails, the report
            // is stuck in `pending` forever with no diagnostic trail \u2014 the
            // recovery path quietly broke and operators have no way to
            // notice. We can't do anything to recover from here (the
            // storage backend is the failing dependency), but at least
            // surface it in the server log with the report id.
            console.warn(
              `[browserRecovery] Failed to mark report ${report.id} as error after judge failure:`,
              updateErr instanceof Error ? updateErr.message : updateErr,
            );
          });

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
