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
 *   - Re-run: any run. A top-level EvaluationRun doc (docType ===
 *     'evaluation-run') goes through the provenance-tracked rerun endpoint;
 *     a legacy benchmark-embedded BenchmarkRun has no such endpoint, so its
 *     surfaces open the same run-config dialog in create mode, prefilled
 *     from the run, and start a NEW run on the benchmark (see
 *     RunInspectorPage). Either way the dialog is where "the agent is no
 *     longer configured" is said honestly — Re-run legitimately needs a
 *     configured agent, and the picker offers the alternatives.
 *   - Retry judgement: any run (EvaluationRun doc OR legacy
 *     benchmark-embedded run — the endpoint takes a `benchmarkId` hint for
 *     the latter), only when the run is terminal (not running) AND it has at
 *     least one test case whose agent execution completed
 *     (`results[*].status === 'completed'`) — i.e. there is stored agent
 *     output to re-judge. Retry judgement never needs the agent: only the
 *     stored trajectory plus an evaluator / judge model. Owner requirement
 *     (follow-up to #468): "Retry judgement should be a retryable step all
 *     the time" — so it is NOT limited to judge-failed cases anymore; the
 *     dialog lets the user pick the scope (only judge-failed cases vs. all
 *     cases) plus the evaluator + judge model. `judgeFailedCount` (the
 *     "errored" bucket — trace timeout, judge 400, "evaluator could not
 *     run", exactly what `scope=errored` re-judges) is still computed to
 *     pick the default scope and label the item. The pipeline itself
 *     (services/evaluation/retryJudgement.ts) additionally requires a
 *     stored trajectory per report; the run doc can't see that, so the
 *     server-side count may be lower than `rejudgeableCount`.
 */

import type { BenchmarkRun, EvaluationRun } from '@/types';
import { isEvaluationRun as isEvaluationRunDoc } from '@/types';

/** Minimal shape both BenchmarkRun and EvaluationRun satisfy for these checks. */
export type RunLike = Pick<BenchmarkRun | EvaluationRun, 'status' | 'results'> & {
  docType?: string;
  stats?: BenchmarkRun['stats'] | null;
};

/**
 * True when `run` is a top-level EvaluationRun document (created via
 * `POST /api/storage/evaluation-runs`), as opposed to a legacy
 * benchmark-embedded BenchmarkRun (`benchmark.runs[]`). The two share a lot
 * of shape but only EvaluationRun docs carry `docType: 'evaluation-run'` and
 * support the rerun / rename endpoints (retry judgement works for both).
 *
 * Null-tolerant wrapper over the typed predicate in `types/index.ts` (the
 * single source of truth for the docType discriminator) — kept so callers
 * holding a possibly-null run don't need their own guard.
 */
export function isEvaluationRun(run: RunLike | null | undefined): run is EvaluationRun {
  return !!run && isEvaluationRunDoc(run as BenchmarkRun | EvaluationRun);
}

/** True while the run has an in-progress executor that a Cancel action could stop. */
export function isRunRunning(run: RunLike | null | undefined): boolean {
  return run?.status === 'running';
}

/**
 * True once a run has reached any terminal state (not running/pending). A
 * run with NO status is legacy data persisted before the field existed
 * (`BenchmarkRun.status` doc: "undefined = legacy data, treat as completed")
 * — terminal unless one of its own results is still running/pending (the
 * same reading `lib/runStats` `getEffectiveRunStatus` gives such a run).
 */
export function isRunTerminal(run: RunLike | null | undefined): boolean {
  if (!run) return false;
  if (run.status === undefined) {
    return !Object.values(run.results || {}).some(r => r?.status === 'running' || r?.status === 'pending');
  }
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

/**
 * Count test cases where the AGENT finished (`status === 'completed'`) but
 * the JUDGE produced no verdict (`passFailStatus` neither 'passed' nor
 * 'failed') — the "errored" bucket of `lib/runStats` `bucketRunResults`
 * (issue #242) and exactly the set `POST .../retry-judgement` (default
 * `scope=errored`) will re-judge. Deliberately excludes:
 *   - `status !== 'completed'` (agent-failed/cancelled/pending cases — no
 *     trajectory to re-judge, or nothing ran).
 *   - a real 'failed' verdict — the judge DID run and graded the case; that
 *     is a legitimate result, not a judge failure (re-grading it is
 *     `scope=all`, opt-in from the inspector's dedicated button).
 *
 * `passFailStatus` isn't declared on `EvaluationRun['results']`'s static
 * type (a pre-existing gap — evaluationRunner.ts writes it via an `as any`
 * spread) so this reads it defensively.
 */
export function countJudgeFailed(run: RunLike | null | undefined): number {
  if (!run?.results) return 0;
  let count = 0;
  for (const r of Object.values(run.results)) {
    const result = r as { status?: string; passFailStatus?: string | null };
    if (result.status !== 'completed') continue;
    if (result.passFailStatus === 'passed' || result.passFailStatus === 'failed') continue;
    count++;
  }
  return count;
}

/**
 * Minimal shape of one `run.results[tc]` entry these predicates read. Wider
 * than the declared `EvaluationRun['results'][string]` type: the runner
 * persists `passFailStatus` on this map at runtime.
 */
export interface RunResultEntryLike {
  reportId?: string;
  status?: string;
  passFailStatus?: string | null;
}

/** The report-summary fields {@link isRejudgeableResult} reads (all present on the inspector's lightweight summaries). */
export type RejudgeableReportLike = { failureStage?: string | null; passFailStatus?: string | null };

/**
 * Does this case have stored agent output the judge can be re-run against
 * (`scope=all`)? ONE predicate shared by the server-side selection
 * (services/evaluation/retryJudgement.ts `selectRetryableCases`) and the run
 * inspector's Retry-judgement enablement + count, so the item is never
 * enabled for a set the backend then rejects in full.
 *
 *   - no report loaded → false (nothing to judge against);
 *   - `report.failureStage === 'agent'` → false: the agent request failed
 *     (timeout / connection / non-2xx), nothing was ever judged — the runner
 *     still writes these as `results[tc].status: 'completed'`, which is why
 *     the run doc alone over-counts; Re-run is the remedy;
 *   - `results[tc].status === 'completed'` → true: the agent finished
 *     (passed, judge-failed, trace-failed — all re-judgeable);
 *   - `results[tc].status === 'failed'` → true only for a judged FAILURE
 *     (`report.passFailStatus === 'failed'`): the runner mirrors a failed
 *     verdict as `status: 'failed'`, so these cases DO have output and are
 *     exactly the ones a second opinion is wanted on; a `status: 'failed'`
 *     entry with no verdict is an executor crash / legacy agent failure
 *     (placeholder report, nothing stored) and is not counted.
 *
 * The backend additionally requires a non-empty stored trajectory
 * (`hasRejudgeableOutput`), which the inspector's summaries cannot see.
 */
export function isRejudgeableResult(
  result: RunResultEntryLike | null | undefined,
  report: RejudgeableReportLike | null | undefined
): boolean {
  if (!result || !report) return false;
  if (report.failureStage === 'agent') return false;
  if (result.status === 'completed') return true;
  return result.status === 'failed' && report.passFailStatus === 'failed';
}

/**
 * Count test cases with stored output the judge can be re-run against,
 * regardless of the current verdict, from the RUN DOC alone (no reports
 * loaded — the runs list / detail page). Mirrors {@link isRejudgeableResult}
 * as far as the run doc allows: completed cases plus judged failures
 * (`status: 'failed'` carrying the runner's `passFailStatus: 'failed'`
 * mirror). Agent-request failures look like plain completed cases here, so
 * this may over-count; surfaces that have the reports loaded (the inspector)
 * use `isRejudgeableResult` instead.
 */
export function countRejudgeable(run: RunLike | null | undefined): number {
  if (!run?.results) return 0;
  let count = 0;
  for (const r of Object.values(run.results)) {
    const result = r as RunResultEntryLike;
    if (result.status === 'completed' || (result.status === 'failed' && result.passFailStatus === 'failed')) count++;
  }
  return count;
}

export interface RunActionVisibility {
  /** Delete is always available for any run in any status. */
  canDelete: boolean;
  /** Cancel is available only while the run is actively running. */
  canCancel: boolean;
  /** Re-run is available for any run (see the module comment for how legacy runs re-run). */
  canRerun: boolean;
  /** Reason to show (e.g. as a disabled-item tooltip) when canRerun is false. */
  rerunDisabledReason?: string;
  /** Retry judgement: terminal run with >0 completed (re-judgeable) cases — any run shape. */
  canRetryJudgement: boolean;
  /** Reason to show when canRetryJudgement is false. */
  retryJudgementDisabledReason?: string;
  /** Number of judge-failed test cases (0 when not applicable/unknown). */
  judgeFailedCount: number;
  /** Number of completed cases with agent output to re-judge (`scope=all`). */
  rejudgeableCount: number;
  /**
   * Cases the Retry-judgement dialog's DEFAULT scope will re-judge — the
   * judge-failed count when there are any, otherwise every re-judgeable
   * case. Shown as "Retry judgement (N)" on the kebab item.
   */
  retryJudgementCount: number;
}

const RETRY_JUDGEMENT_STILL_RUNNING_REASON = 'Retry judgement is only available once the run finishes';
const RETRY_JUDGEMENT_NOTHING_TO_REJUDGE_REASON = 'No completed test cases to re-judge';

/**
 * Minimum time a run must have been persisted before a Cancel request with
 * no in-memory executor token is allowed to take the "zombie" fallback path
 * (mark cancelled directly — see getRunActionVisibility callers in the
 * cancel routes). Guards the narrow window right after a run is created:
 * the doc is persisted (and therefore visible to a concurrent Cancel
 * request) strictly before its executor registers its cancellation token,
 * so a Cancel that lands in that gap would otherwise mark a run "cancelled"
 * moments before its own executor starts making progress on it. A brand-new
 * run is also the case the fallback is LEAST useful for — "zombie" (no
 * executor anywhere) is far more plausible once a run has been running for
 * a while than in its first couple of seconds.
 */
export const ZOMBIE_CANCEL_MIN_AGE_MS = 5000;

/**
 * True once a run is old enough that a tokenless Cancel request can safely
 * assume its executor (if any) would already have registered a
 * cancellation token — i.e. it's safe to treat "no token" as "no executor"
 * rather than "executor hasn't started yet".
 *
 * NOTE — known limitation, not fixed by this check: cancellation tokens are
 * tracked in an in-memory `Map` scoped to ONE server process. In a
 * multi-process/clustered deployment, a Cancel request routed to a
 * DIFFERENT process than the one executing the run will always find no
 * token there, regardless of run age, and this zombie fallback will mark
 * the run cancelled in storage even though it's alive and progressing on
 * another process. This mirrors a pre-existing, documented constraint of
 * this codebase's run-execution model (see AGENTS.md's "orphan-run
 * recovery" notes: "active is tracked per-process"); fixing it for real
 * needs the same heartbeat-based ownership (`run.heartbeatAt`) that doc
 * already calls out as the eventual replacement. Out of scope here.
 */
export function isOldEnoughForZombieCancel(createdAt: string | undefined, now: number = Date.now()): boolean {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(created)) return true; // no timestamp to compare against — don't block on it
  return now - created >= ZOMBIE_CANCEL_MIN_AGE_MS;
}

/**
 * Compute the full action-visibility matrix for one run. Pure function —
 * safe to call from both React components and server-side route validation
 * so the two never drift.
 */
export function getRunActionVisibility(run: RunLike | null | undefined): RunActionVisibility {
  const running = isRunRunning(run);
  const terminal = isRunTerminal(run);
  // Both shapes carry `results[tc].status` (+ the runner's `passFailStatus`
  // mirror on newer docs), so the counts apply to legacy embedded runs too.
  const rejudgeableCount = countRejudgeable(run);
  let judgeFailedCount = countJudgeFailed(run);
  // Classic-shape docs (every legacy benchmark-embedded run, older eval-run
  // docs) carry NO `passFailStatus` mirror on any result, so every completed
  // case reads as judge-failed above — the kebab would say "Retry judgement
  // (5)" for a run whose dialog pre-flight then finds 1. When no result has a
  // mirror but the denormalized `stats` show real verdicts, those stats are
  // the honest judge-failed count (same signature `lib/runStats`
  // `computeRunStats` trusts for the same reason).
  if (run?.results && judgeFailedCount > 0) {
    const anyMirror = Object.values(run.results).some(r => (r as RunResultEntryLike)?.passFailStatus === 'passed' || (r as RunResultEntryLike)?.passFailStatus === 'failed');
    const stats = run.stats;
    if (!anyMirror && stats && ((stats.passed ?? 0) > 0 || (stats.failed ?? 0) > 0)) {
      judgeFailedCount = Math.min(judgeFailedCount, stats.errored ?? 0);
    }
  }

  const canRetryJudgement = terminal && rejudgeableCount > 0;
  let retryJudgementDisabledReason: string | undefined;
  if (!canRetryJudgement) {
    if (!terminal) retryJudgementDisabledReason = RETRY_JUDGEMENT_STILL_RUNNING_REASON;
    else retryJudgementDisabledReason = RETRY_JUDGEMENT_NOTHING_TO_REJUDGE_REASON;
  }

  return {
    canDelete: true,
    canCancel: running,
    canRerun: !!run,
    rerunDisabledReason: undefined,
    canRetryJudgement,
    retryJudgementDisabledReason,
    judgeFailedCount,
    rejudgeableCount,
    retryJudgementCount: judgeFailedCount > 0 ? judgeFailedCount : rejudgeableCount,
  };
}
