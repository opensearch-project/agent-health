/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run a single test case with a single run configuration.
 *
 * This is the engine behind `POST /api/evaluate` (UI "Run Test" / Quick Run,
 * CLI `agent-health run`, SDK `agent.run()`): invoke the agent through its
 * connector, judge, persist the report (create or placeholder-update) and,
 * for trace-mode agents, hand the report to the trace-polled judge.
 * Uses the storage adapter — works with both file and OpenSearch backends.
 */

import type { Benchmark, BenchmarkRun, TestCase, TestCaseRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { runEvaluationWithConnector } from './index';
import { buildAgentConfigForRun, getBedrockModelId } from './runAgentConfig';
import { startTracePollingForReportWithModule } from './tracePolling';
import { connectorRegistry } from '@/services/connectors/server';
import {
  startIsolatedTestCaseSpan,
  addEvaluationResultEvents,
  finalizeTestCaseSpan,
} from '@/lib/telemetry';
import { context } from '@opentelemetry/api';
import { ATTR_AGENT_HEALTH_AGENT_RUN_ID } from '@/lib/telemetry/constants';
import { resolveReportTraceId } from '@/lib/traceIdentity';
import { assertJudgeIdentityConsistent } from '@/lib/judgeIdentity';

/**
 * Save an evaluation report using the storage adapter (works with both file and OpenSearch backends).
 */
async function saveReportWithModule(storage: IStorageModule, report: any): Promise<any> {
  const saved = await storage.runs.create({
    experimentId: report.experimentId || '',
    experimentRunId: report.experimentRunId || '',
    testCaseId: report.testCaseId,
    agentId: report.agentKey || report.agentName,
    modelId: report.modelId || report.modelName,
    // Persist the agent's runId (Strategy B trace correlation key). Without
    // it the run-detail Traces tab can't scope to the run's eval span and
    // a null runId even rejected the whole trace query. See #264.
    runId: report.runId,
    // Agent-emitted session id (Strategy D trace correlation, e.g. Claude Code).
    sessionId: report.sessionId,
    // Persist judgeModelId on the report so the run-detail UI can show
    // "agent: <m1> judge: <m2>" and the audit trail is intact. Inherits
    // from the run-level cx input (BenchmarkRun.judgeModelId).
    judgeModelId: report.judgeModelId,
    // Underlying LLM that judged (see lib/judgeIdentity) -- distinct from
    // judgeModelId, which for the agent trace judge is a provider name.
    judgeModel: report.judgeModel,
    // Judge kind, or 'none' when a code-SDK body made no LLM judge call.
    judgeProvider: report.judgeProvider,
    evaluatorId: report.evaluatorId,
    status: report.status,
    passFailStatus: report.passFailStatus,
    // Real W3C OTel trace id when we have it (extracted from polled spans),
    // else undefined. Pre-fix this was set to `report.runId` — i.e. the
    // connector's subprocess id (`subprocess-<timestamp>`) was being
    // mis-stamped as a 32-hex W3C traceId, which broke trace-tab
    // correlation that prefers `traceId` over `runId`. The runner's
    // `runId` field is preserved separately as `traceId: report.traceId`
    // here only when a real OTel traceId is available. See #190 / #264.
    traceId: report.traceId || (report.spans?.[0] as any)?.traceId,
    llmJudgeReasoning: report.llmJudgeReasoning,
    metrics: report.metrics,
    trajectory: report.trajectory,
    rawEvents: report.rawEvents || [],
    logs: report.logs || report.openSearchLogs,
    improvementStrategies: report.improvementStrategies,
    // Unified judge surface (issue #230 follow-up): the SDK judge()
    // matcher verdict / buildJudgeMatcherEntry() output built by
    // runEvaluationWithConnector. Pre-fix this helper (and the
    // placeholder-update path below) silently dropped `matcherResults` —
    // the trace-mode polled paths already forward it, but standard-mode
    // single-test-case runs (/api/evaluate) never did, so a run's
    // MatcherResultsPanel (and its improvementStrategies /
    // judgeExtraFields) was empty for every judge provider on this path.
    matcherResults: report.matcherResults,
    // Same fix as the placeholder-update path: pass through the full
    // judge sidecar (rawResponse, extraFields, judgeDebug, parsedMetrics).
    llmJudgeResponse: report.llmJudgeResponse,
    metricsStatus: report.metricsStatus,
    traceFetchAttempts: report.traceFetchAttempts,
    lastTraceFetchAt: report.lastTraceFetchAt,
    traceError: report.traceError,
    spans: report.spans,
    connectorProtocol: report.connectorProtocol,
    // Set only by the agent (trace) judge provider -- see
    // JudgeResponse.judgeMode / TestCaseRun.judgeMode.
    judgeMode: report.judgeMode,
  } as any);
  return { ...report, id: saved.id, timestamp: saved.timestamp };
}

/**
 * Options for {@link runSingleUseCase}.
 */
export interface RunSingleUseCaseOptions {
  /** Whether to await trace polling completion before returning (default: true for CLI, false for UI) */
  awaitTraces?: boolean;
}

/**
 * Run a single use case with a single configuration (for quick testing).
 * Uses the storage adapter — works with both file and OpenSearch backends.
 */
export async function runSingleUseCase(
  run: BenchmarkRun,
  testCase: TestCase,
  storage: IStorageModule,
  onStep?: (step: any) => void,
  evaluatorId?: string,
  existingReportId?: string,
  options?: RunSingleUseCaseOptions
): Promise<string> {
  const agentConfig = buildAgentConfigForRun(run);
  const bedrockModelId = getBedrockModelId(run.modelId);

  // Start the OTel `test_case` span BEFORE running the agent so the eval span
  // is the active OTel context when the connector spawns/calls the agent.
  // Connectors with `traceContext.propagateEnv/Header` inject TRACEPARENT,
  // making the agent's root span a child of this eval span (single trace tree).
  const standaloneBenchmark = { name: `standalone:${agentConfig.name || agentConfig.key}` } as Benchmark;
  const caseSpanResult = startIsolatedTestCaseSpan(testCase, standaloneBenchmark, run);
  const caseSpan = caseSpanResult?.span;
  const caseSpanContext = caseSpanResult?.context;

  // Run the evaluation using connector, with the eval span as active context.
  const runEval = () => runEvaluationWithConnector(
    agentConfig,
    bedrockModelId,
    testCase,
    onStep || (() => {}),
    {
      registry: connectorRegistry,
      evaluatorId,
      // Forward the run-level judge model so the judge call uses what the
      // customer picked in the run config dialog / CLI / API — not the
      // agent's own model. See {@link RunEvaluationWithConnectorOptions.judgeModelId}.
      judgeModelId: run.judgeModelId,
    }
  );
  const report = caseSpanContext
    ? await context.with(caseSpanContext, runEval)
    : await runEval();

  // Stamp `judgeModelId` onto the report BEFORE saving so both code
  // paths (placeholder-update and create) persist the run-level cx
  // input. The connector return path doesn't carry it, but `run` does.
  (report as any).judgeModelId = (report as any).judgeModelId ?? run.judgeModelId;
  // Same fix for `evaluatorId`. The connector return path doesn't carry
  // it either, so without this stamp the trace-mode polled judge (which
  // reads `report.evaluatorId` to forward to /api/judge) silently falls
  // back to the default RCA evaluator — the bug that surfaced when
  // running an ops test case with `useTraces: true` + the agent (trace) judge.
  (report as any).evaluatorId = (report as any).evaluatorId ?? run.evaluatorId;
  // Eval test_case span traceId — Strategy A correlator for the trace poller
  // (eval span wins; non-W3C candidates are dropped — lib/traceIdentity.ts).
  (report as any).traceId = resolveReportTraceId(caseSpan?.spanContext().traceId, (report as any).traceId);

  // If a placeholder run was pre-created, update it instead of creating a new one.
  // We use the storage-layer field names (traceId, etc.) to match `saveReportWithModule`
  // for consistency — the IStorageModule operations accept Partial<TestCaseRun> nominally
  // but the codebase convention is to pass the storage-shaped doc directly.
  let savedReport: any;
  if (existingReportId) {
    const updates = {
      status: report.status,
      passFailStatus: report.passFailStatus,
      // Persist the agent's runId on the placeholder-update path. The
      // placeholder was created at run-start before the agent ran, so it
      // had no runId; without re-stamping it here the doc keeps runId
      // undefined. That broke the run-detail Traces tab: with no runId,
      // its trace query degraded (and a `[null]` runIds clause even
      // rejected the whole query). Strategy B correlation + the eval-span
      // match both depend on this being present. See #264.
      runId: report.runId,
      // Agent-emitted session id (Strategy D trace correlation, e.g. Claude Code).
      sessionId: report.sessionId,
      // Same fix as saveReportWithModule above — only stamp a real W3C
      // trace id, not the subprocess connector's run id.
      traceId: report.traceId || (report.spans?.[0] as any)?.traceId,
      // Same reason as the report-level stamp above — the placeholder
      // doc was created with judgeModelId set, but on update we re-stamp
      // it from the run config in case the placeholder pre-creation skipped
      // the field (storage transient failures during /api/evaluate).
      judgeModelId: run.judgeModelId,
      // Underlying LLM that judged this report (lib/judgeIdentity).
      judgeModel: (report as any).judgeModel,
      judgeProvider: (report as any).judgeProvider,
      // Re-stamp evaluatorId for the same reason. /api/evaluate sets it
      // on the placeholder, but if that step failed silently the doc has
      // no evaluatorId — and the trace-mode polled judge then reads it
      // off the report and falls back to the default. Belt-and-braces.
      evaluatorId: run.evaluatorId,
      llmJudgeReasoning: report.llmJudgeReasoning,
      metrics: report.metrics,
      trajectory: report.trajectory,
      rawEvents: report.rawEvents || [],
      logs: report.logs || report.openSearchLogs,
      improvementStrategies: report.improvementStrategies,
      // Unified judge surface (issue #230 follow-up) — see the matching fix
      // in saveReportWithModule above for why this was missing.
      matcherResults: report.matcherResults,
      // The full judge response (rawResponse, parsedMetrics, extraFields,
      // judgeDebug, ...) lives on `llmJudgeResponse` and was previously
      // dropped by the placeholder-update path — callers using
      // /api/evaluate (UI "Run Test", CLI `agent-health run`) lost the
      // detailed judge breadcrumbs even though the connector returned
      // them. Forwarding both top-level pieces (`improvementStrategies`,
      // `llmJudgeReasoning`) plus the full sidecar so the run-detail
      // "Judge Debug" surface and `extraFields` rendering work end-to-end.
      llmJudgeResponse: report.llmJudgeResponse,
      metricsStatus: report.metricsStatus,
      traceFetchAttempts: report.traceFetchAttempts,
      lastTraceFetchAt: report.lastTraceFetchAt,
      traceError: report.traceError,
      spans: report.spans,
      connectorProtocol: report.connectorProtocol,
      // Set only by the agent (trace) judge provider -- see
      // JudgeResponse.judgeMode / TestCaseRun.judgeMode.
      judgeMode: (report as any).judgeMode,
    } as Partial<TestCaseRun>;
    const updated = await storage.runs.update(existingReportId, updates);
    savedReport = { ...report, id: updated.id, timestamp: updated.timestamp };
  } else {
    savedReport = await saveReportWithModule(storage, report);
  }
  // Runtime guard (lib/judgeIdentity): when the synchronous judge ran (a
  // non-trace agent judged inline), a resolved `judgeModel` must have been
  // recorded on the saved report. Trace-mode reports are still `pending`
  // here and are checked when their polled judge completes. Warns only.
  if (savedReport.metricsStatus !== 'pending') {
    assertJudgeIdentityConsistent(savedReport);
  }

  // Denormalize lastRunAt onto the test case (only for persisted test cases)
  storage.testCases.getById(testCase.id)
    .then(existing => {
      if (existing) {
        return storage.testCases.update(testCase.id, { lastRunAt: new Date().toISOString() } as any);
      }
    })
    .catch(err => console.warn(`[RunSingleUseCase] Failed to update lastRunAt for ${testCase.id}:`, err.message));

  // Start trace polling for trace-mode runs. No runId requirement — see
  // startTracePollingForReportWithModule.
  if (savedReport.metricsStatus === 'pending') {
    if (options?.awaitTraces !== false) {
      // CLI/batch mode: block until traces arrive and judge evaluates
      try {
        await startTracePollingForReportWithModule(savedReport, testCase, storage);
      } catch (err) {
        // Trace polling failed (timeout, auth, etc.) — don't crash.
        // The report is already saved with metricsStatus: 'error' by the poller.
        console.warn(`[RunSingleUseCase] Trace polling failed for ${savedReport.id}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // UI mode: fire-and-forget, let the UI poll for status updates
      startTracePollingForReportWithModule(savedReport, testCase, storage)
        .catch(err => console.warn(`[RunSingleUseCase] Background trace polling failed for ${savedReport.id}:`, err.message));
    }
  }

  // Finalize the eval test_case span. agentRunId is now known.
  // For trace-mode runs (metricsStatus='pending'), judge runs later when
  // polled spans arrive — we end the span as-is here so its trace tree is
  // closed; the late-completion path emits a separate span with final metrics.
  if (caseSpan) {
    caseSpan.setAttribute(ATTR_AGENT_HEALTH_AGENT_RUN_ID, savedReport.runId || '');
    if (savedReport.metricsStatus !== 'pending') {
      addEvaluationResultEvents(caseSpan, savedReport);
      finalizeTestCaseSpan(caseSpan, savedReport);
    } else {
      caseSpan.end();
    }
  }

  return savedReport.id;
}
