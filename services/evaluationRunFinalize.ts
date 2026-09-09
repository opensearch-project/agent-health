/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal write for an evaluation run — the ONE place a run transitions to
 * `completed` / `cancelled` in storage.
 *
 * Why this exists (data-integrity bug, 2026-09-04): the two execution routes
 * (`POST /evaluation-runs` SSE path and `POST /:id/rerun`) each ended with
 * `evaluationRuns.update(runId, { status, stats, completedAt, results })`,
 * i.e. they re-sent the runner's in-memory `results` map wholesale and the
 * stats computed from it. Per-case verdicts had ALREADY been persisted one
 * by one via the atomic `updateResult()`, so the terminal write was at best
 * redundant and at worst — after a lost/late per-case write, or a concurrent
 * cancel/rename that itself was a stale full overwrite — a clobber that
 * resurrected or dropped entries. This helper instead:
 *
 *  1. Marks never-started planned cases explicitly (`status: 'cancelled'`)
 *     when the run was cancelled, so the UI needs no inference (R3).
 *  2. Merges those markers + the in-memory results into the persisted doc
 *     ONLY for keys that are absent (`mergeMissingResults`) — heals a lost
 *     per-case write, never overwrites a persisted verdict (R2b).
 *  3. Reads the doc back and recomputes `stats` from what is actually
 *     PERSISTED, terminal-aware (`notRun` instead of phantom `pending`), not
 *     from the in-memory copy (R2c).
 *  4. Writes `status` / `stats` / `completedAt` as a scripted partial update
 *     — no `results` in the payload (R2a).
 */

import type { IStorageModule, EvaluationRunResultEntry } from '../server/adapters/types';
import type { BenchmarkRunStatus, EvaluationRun, RunStats } from '@/types';
import { bucketRunResults } from '@/lib/runStats';

export type FinalRunStatus = Extract<BenchmarkRunStatus, 'completed' | 'cancelled'>;

/** Result entry stamped on every planned case a cancelled run never reached. */
export const CANCELLED_NOT_STARTED_ENTRY: Readonly<EvaluationRunResultEntry> = Object.freeze({
  reportId: '',
  status: 'cancelled' as const,
});

/**
 * Planned cases with no in-memory result (never started) → explicit
 * `cancelled` markers. Only meaningful for a cancelled run: a completed run
 * has an entry for every planned case by construction.
 */
export function buildCancelledMarkers(
  plannedTestCaseIds: readonly string[],
  results: Record<string, unknown> | undefined,
): Record<string, EvaluationRunResultEntry> {
  const markers: Record<string, EvaluationRunResultEntry> = {};
  for (const id of plannedTestCaseIds) {
    if (!results || results[id] === undefined) markers[id] = { ...CANCELLED_NOT_STARTED_ENTRY };
  }
  return markers;
}

/** Terminal-aware stats over the PERSISTED results of a run. */
export function computeTerminalStats(
  persisted: Pick<EvaluationRun, 'results' | 'testCaseSnapshots'>,
  finalStatus: BenchmarkRunStatus,
): RunStats {
  const planned = persisted.testCaseSnapshots?.length;
  const b = bucketRunResults(persisted.results, planned, finalStatus);
  return { passed: b.passed, failed: b.failed, errored: b.errored, pending: b.pending, notRun: b.notRun, total: b.total };
}

export interface FinalizeEvaluationRunInput {
  runId: string;
  finalStatus: FinalRunStatus;
  /**
   * The runner's in-memory run at completion. `results`/`testCaseSnapshots`
   * drive the merge + stats; `judgeFailureSummary` (run-level judge-failure
   * reason, see lib/judgeFailureSummary.ts) is a plain top-level field the
   * runner computes and is carried through onto the doc when present.
   */
  completedRun: Pick<EvaluationRun, 'results' | 'testCaseSnapshots'> & Partial<Pick<EvaluationRun, 'judgeFailureSummary'>>;
  completedAt?: string;
}

export interface FinalizeEvaluationRunOutput {
  run: EvaluationRun;
  stats: RunStats;
  /** Never-started cases stamped `cancelled` by this call (empty unless cancelled). */
  cancelledMarkers: Record<string, EvaluationRunResultEntry>;
}

export async function finalizeEvaluationRun(
  storage: Pick<IStorageModule, 'evaluationRuns'>,
  input: FinalizeEvaluationRunInput,
): Promise<FinalizeEvaluationRunOutput> {
  const { runId, finalStatus, completedRun } = input;
  const completedAt = input.completedAt ?? new Date().toISOString();
  const plannedIds = (completedRun.testCaseSnapshots || []).map(s => s.id);

  const cancelledMarkers = finalStatus === 'cancelled'
    ? buildCancelledMarkers(plannedIds, completedRun.results)
    : {};

  // Add-if-absent merge: in-memory verdicts heal a per-case write that the
  // runner's `persistResult` reported as failed; cancelled markers fill the
  // never-started gaps. Nothing persisted is overwritten. Only SETTLED
  // in-memory entries are eligible — a `running`/`pending` entry is never
  // written to the doc by design and must not be introduced here. (Nothing
  // deletes `results` keys while a run is executing — retry-judgement refuses
  // non-terminal runs — so "absent from the doc" can only mean "never
  // written", not "intentionally removed".)
  const healable: Record<string, EvaluationRunResultEntry> = {};
  for (const [id, entry] of Object.entries(completedRun.results || {})) {
    if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled') healable[id] = entry;
  }
  await storage.evaluationRuns.mergeMissingResults(runId, { ...healable, ...cancelledMarkers });

  const persisted = await storage.evaluationRuns.getById(runId);
  if (!persisted) throw new Error(`Evaluation run ${runId} not found during finalization`);

  const stats = computeTerminalStats(
    { results: persisted.results, testCaseSnapshots: persisted.testCaseSnapshots ?? completedRun.testCaseSnapshots },
    finalStatus,
  );

  const run = await storage.evaluationRuns.update(runId, {
    status: finalStatus,
    stats,
    completedAt,
    ...(completedRun.judgeFailureSummary ? { judgeFailureSummary: completedRun.judgeFailureSummary } : {}),
  });
  return { run, stats, cancelledMarkers };
}
