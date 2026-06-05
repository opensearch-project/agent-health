/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for representing *evaluator failures* on a run.
 *
 * Issue #242: a non-retryable judge / evaluator validation error used to be
 * recorded as a normal `completed` run with `metrics: { … all 0 }` and the
 * surface field `llmJudgeReasoning` left at its `'Waiting for traces to
 * become available...'` placeholder. From a user's perspective that was
 * indistinguishable from "the agent answered terribly" — the actual cause
 * (e.g. `Missing required field: expectedOutcomes`) was hidden in a
 * separate `traceError` field that nothing surfaced in the UI or in
 * benchmark summaries.
 *
 * Two things every error site must do consistently:
 *   1. Set `metricsStatus: 'error'` so stats aggregation can bucket the run
 *      into `errored` instead of `failed` (see {@link RunStats}).
 *   2. Replace `llmJudgeReasoning` with a clearly-labelled error message
 *      reflecting the *actual* terminal cause, so the run-report Judge tab
 *      stops showing the misleading "waiting for traces" placeholder.
 *
 * `buildEvaluatorErrorPatch()` returns the canonical patch payload covering
 * both. Use it everywhere you would otherwise hand-roll
 * `{ metricsStatus: 'error', traceError: ... }`.
 */

export type EvaluatorErrorKind =
  | 'judge_failed'         // Judge call itself threw (e.g. Bedrock validation, network)
  | 'trace_timeout'        // Trace polling exceeded max attempts with no spans
  | 'trace_incomplete'     // Spans arrived but never converged (no root span)
  | 'trace_callback_failed'// onTracesFound callback exploded
  | 'trace_fetch_failed'   // Underlying fetch to OpenSearch failed
  | 'boot_recovery'        // Pending run could not be resumed after a server restart
  | 'unknown';

export interface EvaluatorErrorPatch {
  metricsStatus: 'error';
  /** Machine-readable cause, persisted alongside the run. */
  traceError: string;
  /** Human-readable surface message shown in the Judge tab. */
  llmJudgeReasoning: string;
  /** Pass/fail is meaningless when the evaluator never ran — clear it. */
  passFailStatus: undefined;
  /** Reset metrics so charts don't graph the placeholder zeroes as a real run. */
  metrics: { accuracy: 0; faithfulness: 0; latency_score: 0; trajectory_alignment_score: 0 };
}

const KIND_LABEL: Record<EvaluatorErrorKind, string> = {
  judge_failed: 'Judge evaluation failed',
  trace_timeout: 'Traces never arrived',
  trace_incomplete: 'Trace did not converge',
  trace_callback_failed: 'Post-trace callback failed',
  trace_fetch_failed: 'Trace fetch failed',
  boot_recovery: 'Could not resume after restart',
  unknown: 'Evaluator error',
};

/**
 * Build the canonical "evaluator could not run" patch for `runs.update()`.
 *
 * @param kind   short tag used in logs and as the `traceError` prefix
 * @param error  the underlying error or message; we extract `.message`
 *               when given an Error so logs aren't `[object Object]`
 */
export function buildEvaluatorErrorPatch(
  kind: EvaluatorErrorKind,
  error: unknown,
): EvaluatorErrorPatch {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  const label = KIND_LABEL[kind];
  return {
    metricsStatus: 'error',
    traceError: `${label}: ${message}`,
    // The Judge tab renders this directly. Keep the prose concise and
    // explicit: the user must immediately see *why* there is no score.
    llmJudgeReasoning:
      `**Evaluator could not run.**\n\n` +
      `The agent may have completed normally, but the evaluator (judge or trace pipeline) ` +
      `failed before it could produce a verdict. This run is excluded from pass-rate aggregation.\n\n` +
      `**Reason (${kind}):** ${message}`,
    passFailStatus: undefined,
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
  };
}
