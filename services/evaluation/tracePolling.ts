/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace-mode polled judge.
 *
 * A `useTraces: true` report is persisted with `metricsStatus: 'pending'`;
 * this module attaches the shared `tracePollingManager` to it, judges the
 * span-built trajectory once spans arrive, persists the verdict and refreshes
 * the parent benchmark run's stats. Uses the storage adapter — works with both
 * file and OpenSearch backends.
 */

import type { EvaluationReport, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { callBedrockJudge } from './index';
import { buildEvaluatorErrorPatch } from './evaluatorError';
import { findConfiguredAgent, getBedrockModelId } from './runAgentConfig';
import { readEnv } from '@/lib/envCompat';
import { buildJudgeAgentsHints, resolveJudgeRunId } from '@/services/traces/judgeAgentsHints';
import { extractJudgeFailureReason, computeJudgeFailureSummary } from '@/lib/judgeFailureSummary';
import { buildJudgeIdentityPatch, buildLlmJudgeResponseIdentity } from '@/lib/judgeIdentity';
import { buildJudgeMatcherEntry, formatExpectedOutcomesAsClaim } from '@/lib/matchers/index';
import { tracePollingManager } from '@/services/traces/tracePoller';
import { debug } from '@/lib/debug';
import { emitDeferredTestCaseSpan } from '@/lib/telemetry';

/**
 * Start trace polling for a report that has metricsStatus: 'pending'.
 * Uses the storage adapter — works with both file and OpenSearch backends.
 *
 * Exported so server-side boot recovery (`server/services/traceRecoveryOnBoot.ts`)
 * can re-attach polling for reports that were orphaned by a server restart.
 */
export function startTracePollingForReportWithModule(report: EvaluationReport, testCase: TestCase, storage: IStorageModule): Promise<void> {
  // No runId (e.g. REST-connector agents) is fine now: the poller derives
  // sessionId / service-window correlation hints from the report itself
  // (Strategies C/D), so polling can proceed without Strategy B.
  if (!report.runId) {
    debug('TracePolling', `No runId for report ${report.id} — polling via sessionId/service-window hints`);
  }

  // Pass agent config to trace poller for hooks
  const agentConfig = findConfiguredAgent(report.agentKey);

  return tracePollingManager.startPollingAsync(
    report.id,
    report.runId,
    {
      onTracesFound: async (spans, updatedReport) => {
        try {
          // updatedReport.trajectory is the span-built trajectory (from the
          // agent's buildTrajectory hook, or the default span→trajectory
          // conversion — issue #320); the poller leaves the original SSE
          // trajectory in place when no steps could be built from spans.
          const finalTrajectory = updatedReport.trajectory;
          // Trace-mode polled judge — same priority chain as the standard
          // path: report.judgeModelId (persisted at run-create time) >
          // BEDROCK_MODEL_ID env > agent's modelId (last-resort BC
          // fallback for runs that didn't carry the new field).
          const judgeModelId =
            report.judgeModelId ||
            readEnv('BEDROCK_MODEL_ID', 'AGENT_HEALTH_BEDROCK_MODEL_ID') ||
            (report.modelId ? getBedrockModelId(report.modelId) : undefined);

          const judgment = await callBedrockJudge(
            finalTrajectory,
            {
              expectedOutcomes: testCase.expectedOutcomes,
              expectedTrajectory: testCase.expectedTrajectory,
            },
            [], // No logs for trace-mode - traces are the source of truth
            () => {}, // No progress callback needed
            judgeModelId,
            report.evaluatorId,
            // Forward report.runId so the agent (trace) judge can scope;
            // fall back to the eval's own traceId, then the report's own id,
            // when the connector never returns a native runId (REST agents
            // — see resolveJudgeRunId doc comment / #trace-poll-fix).
            resolveJudgeRunId(report),
            // Strategy C correlation hints (#264).
            buildJudgeAgentsHints(report, agentConfig?.traceServiceName)
          );

          // Update report with judge results
          await storage.runs.update(report.id, {
            trajectory: finalTrajectory,
            metricsStatus: 'ready',
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
            // Set only by the agent (trace) judge provider -- see
            // JudgeResponse.judgeMode / TestCaseRun.judgeMode.
            ...(judgment.judgeMode ? { judgeMode: judgment.judgeMode } : {}),
            // Underlying LLM that judged (TestCaseRun.judgeModel) -- see lib/judgeIdentity.
            ...buildJudgeIdentityPatch(judgment, judgeModelId),
            // Unified judge surface (issue #230 follow-up).
            matcherResults: [
              buildJudgeMatcherEntry(judgment, {
                claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
                model: judgeModelId,
              }),
            ],
            improvementStrategies: judgment.improvementStrategies,
            // Persist the full judge sidecar (rawResponse, parsedMetrics,
            // extraFields, judgeDebug, ...) so the run-detail Judge
            // Output card has all the breadcrumbs even on the trace-mode
            // polled-judge code path. Pre-fix this update silently
            // dropped llmJudgeResponse, mirroring the placeholder-update
            // bug fixed earlier for the standard path.
            llmJudgeResponse: {
              ...buildLlmJudgeResponseIdentity(judgment, judgeModelId),
              timestamp: new Date().toISOString(),
              promptTokens: 0,
              completionTokens: 0,
              latencyMs: judgment.judgeDurationMs ?? 0,
              rawResponse: judgment.rawResponse ?? judgment.llmJudgeReasoning,
              parsedMetrics: judgment.metrics as any,
              improvementStrategies: judgment.improvementStrategies,
              ...(judgment.extraFields ? { extraFields: judgment.extraFields } : {}),
              ...(judgment.judgeDebug ? { judgeDebug: judgment.judgeDebug } : {}),
            },
          } as any);

          // Emit deferred OTel eval span now that judge is complete
          const completedReport = {
            ...report,
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
          } as EvaluationReport;
          emitDeferredTestCaseSpan(
            testCase,
            completedReport,
            { name: report.experimentId ? `benchmark:${report.experimentId}` : `standalone:${report.agentKey}` },
            report.experimentRunId || report.id,
            report.runId,
            undefined, // startTime
            undefined, // endTime
            spans[0]?.traceId
          );

          // Update parent benchmark run stats now that this report is complete
          if (report.experimentId) {
            await refreshBenchmarkRunStats(storage, report.experimentId, report.id);
          }
        } catch (error) {
          console.error(`[TracePolling] Failed to judge report ${report.id}:`, error instanceof Error ? error.message : error);
          // Still mark as error
          await storage.runs.update(report.id, buildEvaluatorErrorPatch(
            'judge_failed',
            error,
          ) as any);

          // Update parent benchmark run stats (error counts as failed)
          if (report.experimentId) {
            await refreshBenchmarkRunStats(storage, report.experimentId, report.id);
          }
        }
      },
      onAttempt: () => {}, // No verbose logging
      onError: (error) => {
        console.error(`[TracePolling] Trace polling failed for report ${report.id}:`, error instanceof Error ? error.message : error);
      },
    },
    {
      agentConfig, // Pass agent config for hooks
      intervalMs: agentConfig?.tracePolling?.intervalMs,
      maxAttempts: agentConfig?.tracePolling?.maxAttempts,
    }
  );
}

/**
 * Recompute pass/fail stats for a benchmark run after one of its reports changes.
 * Adapter-agnostic — works with both file and OpenSearch storage.
 */
export async function refreshBenchmarkRunStats(
  storage: IStorageModule,
  benchmarkId: string,
  reportId: string,
): Promise<void> {
  try {
    const benchmark = await storage.benchmarks.getById(benchmarkId);
    if (!benchmark) return;

    const targetRun = benchmark.runs?.find((run: any) =>
      Object.values(run.results || {}).some((result: any) => result.reportId === reportId)
    );
    if (!targetRun) return;

    const reportIds = Object.values(targetRun.results || {})
      .map((r: any) => r.reportId)
      .filter(Boolean) as string[];

    let passed = 0, failed = 0, pending = 0, errored = 0;
    const total = Object.keys(targetRun.results || {}).length;
    const judgeFailureReasons: Array<string | undefined> = [];

    for (const rid of reportIds) {
      try {
        const report = await storage.runs.getById(rid);
        if (!report) { pending++; continue; }
        const ms = (report as any).metricsStatus;
        if (ms === 'pending' || ms === 'calculating') {
          pending++;
        } else if (ms === 'error') {
          // Evaluator failed to produce a verdict (issue #242).
          errored++;
          judgeFailureReasons.push(extractJudgeFailureReason(report as any));
        } else if (report.passFailStatus === 'passed') {
          passed++;
        } else {
          failed++;
          judgeFailureReasons.push(extractJudgeFailureReason(report as any));
        }
      } catch {
        pending++;
      }
    }
    pending += total - reportIds.length;

    const judgeFailureSummary = computeJudgeFailureSummary(judgeFailureReasons, total);
    await storage.benchmarks.updateRun(benchmarkId, targetRun.id, {
      stats: { passed, failed, pending, errored, total },
      // `null` (not omitted) so a stale summary is CLEARED once retry-judgement
      // or a trace-poll verdict resolves the cases (codex_review finding).
      judgeFailureSummary: judgeFailureSummary ?? null,
    } as any);
  } catch (err) {
    console.warn(`[TracePolling] Failed to refresh stats for benchmark ${benchmarkId}:`, err instanceof Error ? err.message : err);
  }
}
