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

import type { AgentErrorInfo, FailureStage } from '@/types';

export type EvaluatorErrorKind =
  | 'judge_failed'         // Judge call itself threw (e.g. Bedrock validation, network)
  | 'agent_failed'         // Agent never produced a result (HTTP timeout / connection refused / subprocess crash)
  | 'trace_timeout'        // Trace polling exceeded max attempts with no spans
  | 'trace_incomplete'     // Spans arrived but never converged (no root span)
  | 'trace_callback_failed'// onTracesFound callback exploded
  | 'trace_fetch_failed'   // Underlying fetch to OpenSearch failed
  | 'unknown';

export interface EvaluatorErrorPatch {
  metricsStatus: 'error';
  /** Machine-readable cause, persisted alongside the run. */
  traceError: string;
  /** Human-readable surface message shown in the Judge tab. */
  llmJudgeReasoning: string;
  /**
   * Pass/fail is meaningless when the evaluator never ran — set to `null`
   * so the storage layer (`asyncRunStorage.updateReport`) actually CLEARS
   * the field on the persisted document. Using `undefined` here would be
   * filtered out by the typical `!== undefined` allow-list, leaving a
   * stale `'passed'` / `'failed'` on disk inconsistent with
   * `metricsStatus: 'error'`.
   */
  passFailStatus: null;
  /** Reset metrics so charts don't graph the placeholder zeroes as a real run. */
  metrics: { accuracy: 0; faithfulness: 0; latency_score: 0; trajectory_alignment_score: 0 };
  /**
   * Which stage failed — the explicit signal consumers should key on instead
   * of regexing `traceError` for `kind=…`. Derived from `kind`.
   */
  failureStage: FailureStage;
  /** The underlying cause as one line (same text as after `): ` in traceError). */
  error: string;
  /** Structured agent-request failure detail (agent_failed only). */
  agentError?: AgentErrorInfo;
  /** Judge-step failure detail (judge_failed only). */
  judgeError?: { message: string; rawResponse?: string; attempts?: number };
}

const KIND_LABEL: Record<EvaluatorErrorKind, string> = {
  judge_failed: 'Judge evaluation failed',
  agent_failed: 'Agent request failed',
  trace_timeout: 'Traces never arrived',
  trace_incomplete: 'Trace did not converge',
  trace_callback_failed: 'Post-trace callback failed',
  trace_fetch_failed: 'Trace fetch failed',
  unknown: 'Evaluator error',
};

const KIND_STAGE: Record<EvaluatorErrorKind, FailureStage> = {
  judge_failed: 'judge',
  agent_failed: 'agent',
  trace_timeout: 'trace',
  trace_incomplete: 'trace',
  trace_callback_failed: 'trace',
  trace_fetch_failed: 'trace',
  unknown: 'judge',
};

/** Map an evaluator-error kind to its {@link FailureStage}. */
export function failureStageForKind(kind: EvaluatorErrorKind): FailureStage {
  return KIND_STAGE[kind];
}

export interface EvaluatorErrorPatchOptions {
  /** Structured detail persisted as `report.agentError` (agent_failed). */
  agentError?: AgentErrorInfo;
  /** Judge-step detail persisted as `report.judgeError` (judge_failed). */
  judgeError?: { message: string; rawResponse?: string; attempts?: number };
}

/**
 * Build the canonical "evaluator could not run" patch for `runs.update()`.
 *
 * @param kind   short tag used in logs and as the `traceError` prefix
 * @param error  the underlying error or message; we extract `.message`
 *               when given an Error so logs aren't `[object Object]`
 * @param options structured detail (agentError / judgeError) to persist
 */
export function buildEvaluatorErrorPatch(
  kind: EvaluatorErrorKind,
  error: unknown,
  options: EvaluatorErrorPatchOptions = {},
): EvaluatorErrorPatch {
  const message =
    options.agentError?.message ??
    (error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error');
  const label = KIND_LABEL[kind];
  // `agent_failed` is not an *evaluator* failure — the agent itself never
  // produced a trajectory (timeout/crash). Use prose that says so, instead of
  // the misleading "the evaluator failed" wording, so the Judge tab is honest.
  const isAgent = kind === 'agent_failed';
  const patch: EvaluatorErrorPatch = {
    metricsStatus: 'error',
    // Both the human label AND the machine-readable kind token are
    // included — logs / dashboards can grep by `kind=judge_failed`
    // without having to parse the human label, while users skimming
    // a trace view still see the friendly prose form. Format:
    // `<Human Label> (kind=<kind>): <underlying message>`.
    traceError: `${label} (kind=${kind}): ${message}`,
    // The Judge tab renders this directly. Keep the prose concise and
    // explicit: the user must immediately see *why* there is no score.
    llmJudgeReasoning: isAgent
      ? `**Agent request failed — not judged.**\n\n` +
        `The agent produced no output (request timed out, connection failed, or the agent returned an error) ` +
        `so there is no trajectory to judge. The judge was skipped. This run is excluded ` +
        `from pass-rate aggregation; re-run the case to retry the agent.\n\n` +
        `**Cause:** ${message}`
      : `**Evaluator could not run.**\n\n` +
        `The agent may have completed normally, but the evaluator (judge or trace pipeline) ` +
        `failed before it could produce a verdict. This run is excluded from pass-rate aggregation.\n\n` +
        `**Reason (${kind}):** ${message}`,
    passFailStatus: null,
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    failureStage: KIND_STAGE[kind],
    error: message,
  };
  if (options.agentError) patch.agentError = options.agentError;
  if (options.judgeError) patch.judgeError = options.judgeError;
  return patch;
}
