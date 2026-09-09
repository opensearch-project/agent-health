/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run-level judge-failure surfacing.
 *
 * Background: an individual case whose evaluator (judge) could not produce
 * a verdict is already visible per-case as the amber "errored" badge (see
 * `lib/runStats.ts` / `components/evals3/ResultStatus.tsx`) -- but nothing
 * aggregates WHY across a run. A run whose judge call fails on every case
 * (e.g. the original incident: the agent-trace-judge provider hard-failing
 * with "needs a runId or trace correlation hint" for every case of a
 * non-instrumented REST agent's 62-case run, before it was fixed to degrade
 * to trajectory-only judging instead) looks IDENTICAL in the runs list to
 * "the agent did badly" -- the errored/failed count is a bare number with no
 * text explaining the cause.
 *
 * `computeJudgeFailureSummary` aggregates the dominant per-case reason into
 * one line, persisted on `run.judgeFailureSummary` (BenchmarkRun /
 * EvaluationRun) and rendered in the runs list + inspector.
 *
 * Two report shapes are recognized (see {@link extractJudgeFailureReason}):
 *   - The canonical shape written by `buildEvaluatorErrorPatch('judge_failed',
 *     ...)` (services/evaluation/evaluatorError.ts): `metricsStatus: 'error'`
 *     with a `traceError` tagged `kind=judge_failed`.
 *   - The legacy/back-compat shape some pre-fix and outer-catch code paths
 *     still produce: `status: 'failed'` with `llmJudgeReasoning` explicitly
 *     naming the judge as the failure point (e.g. "Evaluation failed:
 *     Bedrock Judge validation error ..."). Scoped to messages that mention
 *     "judge" so a plain agent/network failure sharing the same generic
 *     `status: 'failed'` shape isn't mislabeled as a judge problem.
 */

export interface CaseFailureLike {
  /** EvaluationReport.status */
  status?: string;
  /** EvaluationReport.metricsStatus */
  metricsStatus?: string;
  /** Set by buildEvaluatorErrorPatch(). */
  traceError?: string;
  /** Option-B BC field; also the legacy shape's error carrier. */
  llmJudgeReasoning?: string;
  /** Explicit stage marker (post agent-error-surfacing). */
  failureStage?: string;
}

const PATCH_JUDGE_FAILURE_RE = /kind=judge_failed/;
const LEGACY_JUDGE_FAILURE_RE = /^Evaluation failed:.*\bjudge\b/i;

/**
 * Extract the human-readable reason a single case's report represents a
 * JUDGE (not agent) failure, or `undefined` if it doesn't represent one at
 * all (case passed/failed normally, or failed for a non-judge reason such as
 * the agent itself crashing).
 */
export function extractJudgeFailureReason(report: CaseFailureLike | null | undefined): string | undefined {
  if (!report) return undefined;
  // Explicit stage marker wins: an agent-request failure is never a judge failure.
  if (report.failureStage && report.failureStage !== 'judge') return undefined;

  if (report.metricsStatus === 'error' && PATCH_JUDGE_FAILURE_RE.test(report.traceError || '')) {
    // traceError format: "<Label> (kind=judge_failed): <message>" -- the
    // part after the tag is already the human-readable message.
    const traceError = report.traceError!;
    const idx = traceError.indexOf('): ');
    return idx >= 0 ? traceError.slice(idx + 3) : traceError;
  }

  if (report.status === 'failed' && LEGACY_JUDGE_FAILURE_RE.test(report.llmJudgeReasoning || '')) {
    return (report.llmJudgeReasoning || '').replace(/^Evaluation failed:\s*/, '');
  }

  return undefined;
}

/**
 * Aggregate per-case judge-failure reasons (as returned by
 * {@link extractJudgeFailureReason}, one entry per case in the run,
 * `undefined` for cases that weren't a judge failure) into one run-level
 * summary line.
 *
 * Only fires when judge failures are the DOMINANT outcome (a strict majority,
 * > 50% of total
 * cases) -- a couple of incidental judge failures amid an otherwise-healthy
 * run don't need a run-level banner; the per-case badge already covers
 * that. Ties on the most-frequent distinct message break in first-seen
 * order.
 *
 * @param reasons per-case reasons (or undefined), one entry per case that
 *   actually ran (NOT necessarily equal to `total` -- a run in progress may
 *   have fewer entries than its planned total).
 * @param total the run's total planned case count (denominator).
 */
export function computeJudgeFailureSummary(
  reasons: Array<string | undefined>,
  total: number
): string | undefined {
  if (total <= 0) return undefined;
  const judgeFailed = reasons.filter((r): r is string => !!r);
  if (judgeFailed.length === 0) return undefined;
  if (judgeFailed.length * 2 <= total) return undefined;

  const counts = new Map<string, number>();
  for (const r of judgeFailed) counts.set(r, (counts.get(r) ?? 0) + 1);
  let dominant = judgeFailed[0];
  let dominantCount = 0;
  for (const [reason, count] of counts) {
    if (count > dominantCount) {
      dominant = reason;
      dominantCount = count;
    }
  }

  const n = judgeFailed.length;
  return `${n}/${total} case${n === 1 ? '' : 's'} failed at the judge step: ${dominant}`;
}
