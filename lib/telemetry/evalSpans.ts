/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel span helpers for evaluation telemetry.
 *
 * Creates and manages spans for benchmark execution following
 * OpenTelemetry semantic conventions for test suites and GenAI evaluation.
 *
 * Span structure:
 *   test_suite_run {benchmarkName}     ← root span (1 per benchmark run)
 *     └── test_case                    ← child span (1 per test case)
 *           └── Event: gen_ai.evaluation.result
 */

import {
  context,
  trace,
  TraceFlags,
  type Context,
  type Span,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  type Link,
} from '@opentelemetry/api';
import { getEvalTracer, isEvalTelemetryEnabled, flushEvalTracer } from './provider.js';
import {
  // In-spec attributes
  ATTR_TEST_SUITE_NAME,
  ATTR_TEST_SUITE_RUN_STATUS,
  ATTR_TEST_CASE_NAME,
  ATTR_TEST_CASE_RESULT_STATUS,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_EVALUATION_NAME,
  ATTR_GEN_AI_EVALUATION_SCORE_VALUE,
  ATTR_GEN_AI_EVALUATION_SCORE_LABEL,
  ATTR_GEN_AI_EVALUATION_EXPLANATION,
  EVENT_GEN_AI_EVALUATION_RESULT,
  TEST_SUITE_RUN_STATUS_VALUE_SUCCESS,
  TEST_SUITE_RUN_STATUS_VALUE_FAILURE,
  TEST_CASE_RESULT_STATUS_VALUE_PASS,
  TEST_CASE_RESULT_STATUS_VALUE_FAIL,

  // Proposed attributes (#3398)
  ATTR_TEST_SUITE_RUN_ID,
  ATTR_TEST_CASE_ID,

  // IO attributes
  ATTR_TEST_CASE_INPUT,
  ATTR_TEST_CASE_OUTPUT,
  ATTR_TEST_CASE_EXPECTED,

  // Agent Health extensions
  ATTR_AGENT_HEALTH_JUDGE_MODEL_ID,
  ATTR_AGENT_HEALTH_JUDGE_DURATION_MS,
  ATTR_AGENT_HEALTH_JUDGE_ATTEMPTS,
  ATTR_AGENT_HEALTH_AGENT_DURATION_MS,
  ATTR_AGENT_HEALTH_CONNECTOR_PROTOCOL,
  ATTR_AGENT_HEALTH_AGENT_RUN_ID,

  // Constants
  GEN_AI_OPERATION_NAME_VALUE_EVALUATION,
  MAX_ATTRIBUTE_LENGTH,
  MAX_EXPLANATION_LENGTH,
} from './constants.js';
import type { Benchmark, BenchmarkRun, TestCase, TestCaseRun } from '@/types';

/**
 * Truncate a string to the given max length
 */
function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

/**
 * Extract the agent's final response from a trajectory
 */
function extractAgentResponse(report: TestCaseRun): string | undefined {
  const responseStep = [...report.trajectory].reverse().find(
    s => s.type === 'response' || s.type === 'assistant'
  );
  return responseStep?.content;
}

/**
 * Start a test_suite_run root span for a benchmark run.
 *
 * Returns the span and a context carrying it for child span creation.
 * The caller MUST call finalizeTestSuiteRunSpan() when the run completes.
 */
export function startTestSuiteRunSpan(
  benchmark: Benchmark,
  run: BenchmarkRun
): { span: Span; context: Context } | null {
  if (!isEvalTelemetryEnabled()) return null;

  const tracer = getEvalTracer();
  const span = tracer.startSpan(`test_suite_run ${benchmark.name}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      [ATTR_TEST_SUITE_NAME]: benchmark.name,
      [ATTR_TEST_SUITE_RUN_ID]: run.id,
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EVALUATION,
    },
  });

  const ctx = context.active();
  const spanContext = trace.setSpan(ctx, span);

  console.log(`[Telemetry] Started test_suite_run span for "${benchmark.name}" (runId=${run.id})`);
  return { span, context: spanContext };
}

/**
 * Start a test_case child span for a single test case evaluation.
 *
 * @param parentCtx - Context from the parent test_suite_run span
 * @param testCase - The test case being evaluated
 * @param benchmark - Parent benchmark (for name duplication)
 * @param run - Parent benchmark run (for run ID duplication)
 * @param agentRunId - Optional agent execution run ID (links eval span to agent traces)
 * @param links - Optional span links (e.g., to agent execution trace)
 */
export function startTestCaseSpan(
  parentCtx: Context,
  testCase: TestCase,
  benchmark: Benchmark,
  run: BenchmarkRun,
  agentRunId?: string,
  links?: Link[]
): { span: Span; context: Context } | null {
  if (!isEvalTelemetryEnabled()) return null;

  const tracer = getEvalTracer();
  const attributes: Record<string, string> = {
    [ATTR_TEST_SUITE_NAME]: benchmark.name,
    [ATTR_TEST_SUITE_RUN_ID]: run.id,
    [ATTR_TEST_CASE_ID]: testCase.id,
    [ATTR_TEST_CASE_NAME]: testCase.name,
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EVALUATION,
  };
  if (agentRunId) {
    attributes[ATTR_AGENT_HEALTH_AGENT_RUN_ID] = agentRunId;
  }
  attributes[ATTR_TEST_CASE_INPUT] = truncate(testCase.initialPrompt || '', MAX_ATTRIBUTE_LENGTH)!;
  const expected = truncate(
    testCase.expectedOutcomes ? JSON.stringify(testCase.expectedOutcomes) : undefined,
    MAX_ATTRIBUTE_LENGTH
  );
  if (expected) attributes[ATTR_TEST_CASE_EXPECTED] = expected;

  const span = tracer.startSpan(
    'test_case',
    {
      kind: SpanKind.INTERNAL,
      attributes,
      links,
    },
    parentCtx
  );

  const ctx = trace.setSpan(parentCtx, span);
  console.log(`[Telemetry] Started test_case span for "${testCase.name}" (agentRunId=${agentRunId || 'none'})`);
  return { span, context: ctx };
}

/**
 * Add gen_ai.evaluation.result events to a test case span.
 *
 * Emits one event per metric (currently: accuracy with pass/fail label).
 */
export function addEvaluationResultEvents(span: Span, report: TestCaseRun): void {
  if (!isEvalTelemetryEnabled()) return;

  // Primary metric: accuracy
  if (report.metrics?.accuracy !== undefined) {
    span.addEvent(EVENT_GEN_AI_EVALUATION_RESULT, {
      [ATTR_GEN_AI_EVALUATION_NAME]: 'accuracy',
      [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: report.metrics.accuracy,
      [ATTR_GEN_AI_EVALUATION_SCORE_LABEL]: report.passFailStatus === 'passed' ? 'pass' : 'fail',
      [ATTR_GEN_AI_EVALUATION_EXPLANATION]: truncate(report.llmJudgeReasoning, MAX_EXPLANATION_LENGTH),
    });
  }

  // Additional metrics (faithfulness, latency_score, trajectory_alignment_score)
  if (report.metrics?.faithfulness !== undefined) {
    span.addEvent(EVENT_GEN_AI_EVALUATION_RESULT, {
      [ATTR_GEN_AI_EVALUATION_NAME]: 'faithfulness',
      [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: report.metrics.faithfulness,
    });
  }

  if (report.metrics?.latency_score !== undefined) {
    span.addEvent(EVENT_GEN_AI_EVALUATION_RESULT, {
      [ATTR_GEN_AI_EVALUATION_NAME]: 'latency_score',
      [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: report.metrics.latency_score,
    });
  }

  if (report.metrics?.trajectory_alignment_score !== undefined) {
    span.addEvent(EVENT_GEN_AI_EVALUATION_RESULT, {
      [ATTR_GEN_AI_EVALUATION_NAME]: 'trajectory_alignment_score',
      [ATTR_GEN_AI_EVALUATION_SCORE_VALUE]: report.metrics.trajectory_alignment_score,
    });
  }
}

/**
 * Finalize a test case span with evaluation results and end it.
 */
export function finalizeTestCaseSpan(span: Span, report: TestCaseRun, endTime?: Date): void {
  if (!isEvalTelemetryEnabled()) return;

  // Set result status
  const status = report.passFailStatus === 'passed'
    ? TEST_CASE_RESULT_STATUS_VALUE_PASS
    : TEST_CASE_RESULT_STATUS_VALUE_FAIL;
  span.setAttribute(ATTR_TEST_CASE_RESULT_STATUS, status);

  // Set output (agent's final response) — always set so UI can distinguish missing vs empty
  const output = extractAgentResponse(report) || '';
  span.setAttribute(ATTR_TEST_CASE_OUTPUT, truncate(output, MAX_ATTRIBUTE_LENGTH)!);

  // Set Agent Health extension attributes
  if (report.connectorProtocol) {
    span.setAttribute(ATTR_AGENT_HEALTH_CONNECTOR_PROTOCOL, report.connectorProtocol);
  }
  if (report.performanceMetrics?.agentDurationMs !== undefined) {
    span.setAttribute(ATTR_AGENT_HEALTH_AGENT_DURATION_MS, report.performanceMetrics.agentDurationMs);
  }
  if (report.performanceMetrics?.judgeDurationMs !== undefined) {
    span.setAttribute(ATTR_AGENT_HEALTH_JUDGE_DURATION_MS, report.performanceMetrics.judgeDurationMs);
  }
  if (report.performanceMetrics?.judgeAttempts !== undefined) {
    span.setAttribute(ATTR_AGENT_HEALTH_JUDGE_ATTEMPTS, report.performanceMetrics.judgeAttempts);
  }
  if (report.llmJudgeResponse?.modelId) {
    span.setAttribute(ATTR_AGENT_HEALTH_JUDGE_MODEL_ID, report.llmJudgeResponse.modelId);
  }

  // Set span status based on evaluation outcome
  if (report.status === 'failed') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Evaluation failed' });
  }

  span.end(endTime);
  console.log(`[Telemetry] Finalized test_case span (status=${status}, passFailStatus=${report.passFailStatus})`);
}

/**
 * Finalize a test_suite_run span and end it.
 */
export function finalizeTestSuiteRunSpan(span: Span, run: BenchmarkRun): void {
  if (!isEvalTelemetryEnabled()) return;

  // Compute overall status from results
  const results = Object.values(run.results);
  const hasFailures = results.some(r => r.status === 'failed');
  const status = hasFailures
    ? TEST_SUITE_RUN_STATUS_VALUE_FAILURE
    : TEST_SUITE_RUN_STATUS_VALUE_SUCCESS;

  span.setAttribute(ATTR_TEST_SUITE_RUN_STATUS, status);

  if (hasFailures) {
    const failCount = results.filter(r => r.status === 'failed').length;
    span.setStatus({ code: SpanStatusCode.ERROR, message: `${failCount} case(s) failed` });
  }

  span.end();
  console.log(`[Telemetry] Finalized test_suite_run span (status=${status}), flushing...`);
  flushEvalTracer().catch(() => {});
}

/**
 * Emit a complete test case span for a deferred (trace-mode) evaluation.
 *
 * Used when the judge runs asynchronously after trace polling completes.
 * Creates a standalone span with explicit timestamps reflecting the original execution.
 */
export function emitDeferredTestCaseSpan(
  testCase: TestCase,
  report: TestCaseRun,
  benchmark: { name: string },
  runId: string,
  agentRunId?: string,
  startTime?: Date,
  endTime?: Date,
  agentTraceId?: string
): void {
  if (!isEvalTelemetryEnabled()) return;

  const tracer = getEvalTracer();
  const attributes: Record<string, string> = {
    [ATTR_TEST_SUITE_NAME]: benchmark.name,
    [ATTR_TEST_SUITE_RUN_ID]: runId,
    [ATTR_TEST_CASE_ID]: testCase.id,
    [ATTR_TEST_CASE_NAME]: testCase.name,
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EVALUATION,
  };
  if (agentRunId) {
    attributes[ATTR_AGENT_HEALTH_AGENT_RUN_ID] = agentRunId;
  }
  attributes[ATTR_TEST_CASE_INPUT] = truncate(testCase.initialPrompt || '', MAX_ATTRIBUTE_LENGTH)!;
  const expected = truncate(
    testCase.expectedOutcomes ? JSON.stringify(testCase.expectedOutcomes) : undefined,
    MAX_ATTRIBUTE_LENGTH
  );
  if (expected) attributes[ATTR_TEST_CASE_EXPECTED] = expected;

  // If an agent traceId is provided, create the span within the same trace
  // so it appears as a sibling of the agent's root span in the trace tree.
  let parentCtx: Context | undefined;
  if (agentTraceId && /^[0-9a-f]{32}$/i.test(agentTraceId)) {
    const remoteSpanContext: SpanContext = {
      traceId: agentTraceId,
      // Use a valid synthetic spanId — an all-zero spanId is considered invalid
      // by the OTel SDK and would cause it to ignore this context entirely.
      // This "remote" context carries the traceId forward so the eval span
      // shares the same trace as the agent spans.
      spanId: 'eeee000000000001',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    parentCtx = trace.setSpanContext(context.active(), remoteSpanContext);
  }

  const span = tracer.startSpan('test_case', {
    kind: SpanKind.INTERNAL,
    startTime,
    attributes,
  }, parentCtx);

  addEvaluationResultEvents(span, report);
  finalizeTestCaseSpan(span, report, endTime);
  console.log(`[Telemetry] Emitted deferred test_case span for "${testCase.name}" (agentRunId=${agentRunId || 'none'}, traceId=${agentTraceId || 'new'}), flushing...`);
  flushEvalTracer().catch(() => {});
}
