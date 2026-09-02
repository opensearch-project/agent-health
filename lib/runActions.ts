/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, isomorphic predicates for the run-lifecycle action matrix (delete /
 * cancel / re-run / retry-judgement) shared by every run surface (runs list,
 * benchmark runs list, run detail/report page, inspector header) AND by the
 * server routes that enforce the same rules server-side. No storage/IO here
 * — callers pass in the run document they already have.
 *
 * Action matrix (see AGENTS.md / PR description for the full writeup):
 *   - Delete: any run, any status. Always available (existing endpoint).
 *   - Cancel: only while `status === 'running'`.
 *   - Re-run: only top-level EvaluationRun docs (docType === 'evaluation-run').
 *     Legacy benchmark-embedded BenchmarkRun rows don't support the
 *     provenance-tracked rerun endpoint (pre-existing constraint — see
 *     RerunConfirmDialog / EvalRunsPage).
 *   - Retry judgement: only EvaluationRun docs, only when the run is
 *     terminal (not running) AND it has at least one test case whose agent
 *     execution completed but whose judge verdict was 'failed' (a
 *     judge-failed case, as opposed to an agent-failed one — retrying the
 *     judge on a case the agent itself never finished has nothing to
 *     re-grade).
 */

import type { BenchmarkRun, EvaluationRun } from '@/types';

/** Minimal shape both BenchmarkRun and EvaluationRun satisfy for these checks. */
export type RunLike = Pick<BenchmarkRun | EvaluationRun, 'status' | 'results'> & {
  docType?: string;
};

/**
 * True when `run` is a top-level EvaluationRun document (created via
 * `POST /api/storage/evaluation-runs`), as opposed to a legacy
 * benchmark-embedded BenchmarkRun (`benchmark.runs[]`). The two share a lot
 * of shape but only EvaluationRun docs carry `docType: 'evaluation-run'` and
 * support the rerun/retry-judgement endpoints.
 */
export function isEvaluationRun(run: RunLike | null | undefined): run is EvaluationRun {
  return !!run && (run as any).docType === 'evaluation-run';
}

/** True while the run has an in-progress executor that a Cancel action could stop. */
export function isRunRunning(run: RunLike | null | undefined): boolean {
  return run?.status === 'running';
}

/** True once a run has reached any terminal state (not running/pending). */
export function isRunTerminal(run: RunLike | null | undefined): boolean {
  return !!run && (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
}

/**
 * Count test cases where the AGENT finished (`status === 'completed'`) but
 * the JUDGE's verdict was 'failed' — i.e. cases retrying judgement could
 * plausibly flip. Deliberately excludes:
 *   - `status !== 'completed'` (agent-failed/cancelled/pending cases — no
 *     trajectory to re-judge, or nothing ran).
 *   - `passFailStatus` absent/undefined (evaluator errored, not "failed" —
 *     see issue #242; re-judging those is legitimate too but is out of
 *     scope for THIS predicate, which only counts unambiguous judge fails).
 *
 * `passFailStatus` isn't declared on `EvaluationRun['results']`'s static
 * type (a pre-existing gap — evaluationRunner.ts writes it via an `as any`
 * spread) so this reads it defensively.
 */
export function countJudgeFailed(run: RunLike | null | undefined): number {
  if (!run?.results) return 0;
  let count = 0;
  for (const r of Object.values(run.results)) {
    const result = r as { status?: string; passFailStatus?: string };
    if (result.status === 'completed' && result.passFailStatus === 'failed') count++;
  }
  return count;
}

export interface RunActionVisibility {
  /** Delete is always available for any run in any status. */
  canDelete: boolean;
  /** Cancel is available only while the run is actively running. */
  canCancel: boolean;
  /** Re-run is available only for top-level EvaluationRun docs. */
  canRerun: boolean;
  /** Reason to show (e.g. as a disabled-item tooltip) when canRerun is false. */
  rerunDisabledReason?: string;
  /** Retry judgement: EvaluationRun, terminal, with >0 judge-failed cases. */
  canRetryJudgement: boolean;
  /** Reason to show when canRetryJudgement is false. */
  retryJudgementDisabledReason?: string;
  /** Number of judge-failed test cases (0 when not applicable/unknown). */
  judgeFailedCount: number;
}

const RERUN_NOT_SUPPORTED_REASON = "Re-run isn't available for legacy benchmark-embedded runs";
const RETRY_JUDGEMENT_NOT_SUPPORTED_REASON = "Retry judgement isn't available for legacy benchmark-embedded runs";
const RETRY_JUDGEMENT_STILL_RUNNING_REASON = 'Retry judgement is only available once the run finishes';
const RETRY_JUDGEMENT_NONE_FAILED_REASON = 'No judge-failed test cases to retry';

/**
 * Compute the full action-visibility matrix for one run. Pure function —
 * safe to call from both React components and server-side route validation
 * so the two never drift.
 */
export function getRunActionVisibility(run: RunLike | null | undefined): RunActionVisibility {
  const evalRun = isEvaluationRun(run);
  const running = isRunRunning(run);
  const terminal = isRunTerminal(run);
  const judgeFailedCount = evalRun ? countJudgeFailed(run) : 0;

  const canRetryJudgement = evalRun && terminal && judgeFailedCount > 0;
  let retryJudgementDisabledReason: string | undefined;
  if (!canRetryJudgement) {
    if (!evalRun) retryJudgementDisabledReason = RETRY_JUDGEMENT_NOT_SUPPORTED_REASON;
    else if (!terminal) retryJudgementDisabledReason = RETRY_JUDGEMENT_STILL_RUNNING_REASON;
    else retryJudgementDisabledReason = RETRY_JUDGEMENT_NONE_FAILED_REASON;
  }

  return {
    canDelete: true,
    canCancel: running,
    canRerun: evalRun,
    rerunDisabledReason: evalRun ? undefined : RERUN_NOT_SUPPORTED_REASON,
    canRetryJudgement,
    retryJudgementDisabledReason,
    judgeFailedCount,
  };
}
