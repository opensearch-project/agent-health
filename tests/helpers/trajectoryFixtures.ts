/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-shaped trajectory fixtures for the "step without a string `content`"
 * regression (TrajectoryView used to read `step.content.length` and blank the
 * whole Run inspector).
 *
 * Shared by the unit (jsdom/RTL) and Playwright suites so both exercise the
 * same 12-step mix of thinking / assistant / action / tool_result / response
 * steps, including a tool call whose arguments are a nested object, with the
 * malformed step placed in the MIDDLE so "every other step still renders" is
 * a meaningful assertion.
 *
 * Synthetic and generic on purpose (public fixture).
 */

/** The malformed `content` shapes a persisted report can carry. */
export type MalformedContent = 'undefined' | 'null' | 'object' | 'number';

export const MALFORMED_CONTENT_SHAPES: MalformedContent[] = ['undefined', 'null', 'object', 'number'];

/** Tool arguments used for the malformed action step (and echoed as `content` in the `object` shape). */
export const MALFORMED_STEP_TOOL_ARGS = {
  index: 'orders-2026.*',
  query: { bool: { filter: [{ term: { status: 'failed' } }, { range: { '@timestamp': { gte: 'now-1h' } } }] } },
  size: 50,
};

export const MALFORMED_STEP_TOOL_NAME = 'search_orders';

/** Visible text of the step right before and right after the malformed one. */
export const STEP_BEFORE_MALFORMED_TEXT = 'Next I will look up the failed orders from the last hour.';
export const STEP_AFTER_MALFORMED_TEXT = 'Found 50 failed orders; most failures are payment timeouts.';
export const FINAL_RESPONSE_TEXT = 'Root cause: the payment gateway timed out for 50 orders between 10:00 and 11:00 UTC.';

function malformedContentValue(shape: MalformedContent): unknown {
  switch (shape) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'object': return MALFORMED_STEP_TOOL_ARGS;
    case 'number': return 42;
  }
}

/**
 * A plain-object trajectory (not typed as `TrajectoryStep[]` on purpose — the
 * whole point is that `content` is NOT a string on one step). Cast at the
 * call site.
 */
export function buildRealShapedTrajectory(shape: MalformedContent, opts: { withToolArgs?: boolean } = {}): Array<Record<string, unknown>> {
  const withToolArgs = opts.withToolArgs ?? true;
  const t0 = 1_760_000_000_000;
  const step = (i: number, s: Record<string, unknown>) => ({ id: `step-${i}`, timestamp: t0 + i * 1_000, latencyMs: 120 + i * 10, ...s });

  const malformed: Record<string, unknown> = {
    type: 'action',
    toolName: MALFORMED_STEP_TOOL_NAME,
    ...(withToolArgs ? { toolArgs: MALFORMED_STEP_TOOL_ARGS } : {}),
  };
  // Mirror what producers actually persist: an `undefined` content is simply
  // absent from the JSON document, a `null` one is present as null.
  if (shape !== 'undefined') malformed.content = malformedContentValue(shape);

  return [
    step(0, { type: 'user', content: 'Why did orders fail in the last hour?' }),
    step(1, { type: 'thinking', content: 'The user wants a root cause for recent order failures. I should start by listing the available indices, then query the failed orders.' }),
    step(2, { type: 'action', toolName: 'list_indices', toolArgs: {}, content: '{}' }),
    step(3, { type: 'tool_result', toolName: 'list_indices', content: JSON.stringify(['orders-2026.10.26', 'orders-2026.10.27', 'payments-2026.10.27']), status: 'SUCCESS' }),
    step(4, { type: 'assistant', content: STEP_BEFORE_MALFORMED_TEXT }),
    step(5, malformed),
    step(6, { type: 'tool_result', toolName: MALFORMED_STEP_TOOL_NAME, content: JSON.stringify({ hits: { total: 50, hits: [{ _id: 'o-1', status: 'failed', reason: 'payment_timeout' }] } }), status: 'SUCCESS' }),
    step(7, { type: 'assistant', content: STEP_AFTER_MALFORMED_TEXT }),
    step(8, { type: 'action', toolName: 'get_payment_gateway_status', toolArgs: { window: '1h' }, content: '{"window":"1h"}' }),
    step(9, { type: 'tool_result', toolName: 'get_payment_gateway_status', content: 'gateway p99 latency 31s (threshold 30s) between 10:00 and 11:00 UTC', status: 'SUCCESS' }),
    step(10, { type: 'thinking', content: 'The gateway latency exceeded the timeout threshold during exactly the window where the orders failed. That is the root cause.' }),
    step(11, { type: 'response', content: FINAL_RESPONSE_TEXT }),
  ];
}

/** Count of steps {@link buildRealShapedTrajectory} produces. */
export const REAL_SHAPED_STEP_COUNT = 12;

/**
 * A minimal `EvaluationReport`-shaped document around the trajectory, suitable
 * for `POST /api/storage/runs`.
 */
export function buildReportWithMalformedStep(reportId: string, shape: MalformedContent, opts: { withToolArgs?: boolean } = {}) {
  return {
    id: reportId,
    timestamp: new Date().toISOString(),
    agentKey: 'plain-agent',
    agentName: 'plain-agent',
    modelId: 'generic-model',
    testCaseId: `${reportId}-tc`,
    trajectory: buildRealShapedTrajectory(shape, opts),
    status: 'completed',
    evaluationType: 'llm-judge',
    metricsStatus: 'completed',
    passFailStatus: 'passed',
    llmJudgeReasoning: 'The agent identified the payment gateway timeout as the root cause.',
    metrics: { accuracy: 90, faithfulness: 90, latency_score: 80, trajectory_alignment_score: 85 },
    performanceMetrics: { durationMs: 12_000, totalTokens: 1_234 },
  };
}
