/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One delete for a run, whatever shape it was persisted in.
 *
 * A run started against a benchmark exists in up to TWO places (#399
 * dual-write): a first-class `evaluation-run` document AND, once it
 * finishes, a legacy-shaped projection embedded in `benchmark.runs[]`.
 * Older runs may be embedded only; runs still in flight (or CLI/SDK runs
 * that never linked) are standalone documents only. Both public DELETE
 * routes used to remove exactly one of the two:
 *
 *   - `DELETE /api/storage/evaluation-runs/:id` dropped the doc but left the
 *     projection, so the benchmark page kept showing a ghost row.
 *   - `DELETE /api/storage/benchmarks/:id/runs/:runId` dropped the projection
 *     (404ing when there was none — the common case for every run since the
 *     dual-write era) and left the doc, which the benchmark page merges back
 *     in as a "standalone" row. Owner report: "the run doesn't get deleted
 *     when I go inside the run page and try it myself."
 *
 * Both routes now delegate here so either entry point removes BOTH forms.
 *
 * Order matters (codex_review): the projection is removed FIRST, then the
 * document. The two writes are not atomic; if the second fails the caller
 * gets a 500 and what remains is a doc-only run — still listed everywhere,
 * still deletable by retrying either endpoint. The reverse order would leave
 * an embedded-only ghost that only the nested-run URL can reach, i.e. the
 * exact bug this module exists to fix.
 *
 * Deleting a run does NOT cascade to its per-test-case report documents —
 * they stay reachable from the test-case pages (AGENTS.md: "Deleting a
 * benchmark or evaluation run does NOT delete its reports").
 *
 * A run that is still `running` is cancelled first when this process holds
 * its executor's cancellation token (`cancelActive`) so the executor stops
 * spending agent/judge calls on a run nobody can see any more. This is
 * best-effort and process-local (same limitation as the cancel endpoints —
 * an executor in another server process is not reachable); the delete
 * proceeds either way and the result reports whether anything was stopped.
 * In-flight cases of a stopped executor drain; their late persists land on a
 * document that no longer exists and are dropped by the adapters
 * (updateResult → false, finalize → "not found", logged; addRun is never
 * reached because finalize throws first).
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationRun } from '../../types/index.js';

/** Sample/demo data is read-only everywhere (mirrors the routes' `isSampleId`). */
export function isSampleRunOrBenchmarkId(id: string | undefined): boolean {
  return !!id && id.startsWith('demo-');
}

export interface DeleteRunOptions {
  /**
   * Benchmark the caller is acting on behalf of (the nested-run route). When
   * given, the projection is removed from THIS benchmark, and the run
   * document is only deleted if it is actually associated with this
   * benchmark — a colliding or unlinked doc must not be deletable through
   * another benchmark's URL (codex_review). When omitted, the benchmark is
   * derived from the document itself.
   */
  benchmarkId?: string;
  /** Already-fetched document, to avoid a second read (and a read race). */
  doc?: EvaluationRun | null;
  /**
   * Cancel a still-running executor before deleting. Returns true when a
   * live token was found and cancelled. Caller-provided so this module stays
   * free of the per-route in-memory token registries.
   */
  cancelActive?: (runId: string) => boolean;
}

export interface DeleteRunResult {
  /** True when at least one persisted form of the run was removed. */
  deleted: boolean;
  /** The standalone `evaluation-run` document was removed. */
  docDeleted: boolean;
  /**
   * A document exists but was left alone because it belongs to a different
   * benchmark than the one the caller acted on (or to none).
   */
  docSkippedNotOwned: boolean;
  /** An embedded `benchmark.runs[]` projection was removed. */
  projectionDeleted: boolean;
  /** Benchmark the projection was looked up in (if any). */
  benchmarkId?: string;
  /** The run was still running and a live executor in this process was told to stop. */
  cancelled: boolean;
}

/** Benchmark a run document is associated with, if any. */
export function resolveRunBenchmarkId(run: Pick<EvaluationRun, 'benchmarkId' | 'sources'> | null | undefined): string | undefined {
  if (!run) return undefined;
  if (run.benchmarkId) return run.benchmarkId;
  for (const src of run.sources || []) {
    if (src.type === 'benchmark' && src.benchmarkId) return src.benchmarkId;
  }
  return undefined;
}

export async function deleteRunEverywhere(
  storage: IStorageModule,
  runId: string,
  options: DeleteRunOptions = {},
): Promise<DeleteRunResult> {
  const doc = options.doc !== undefined ? options.doc : await storage.evaluationRuns.getById(runId);
  const docBenchmarkId = resolveRunBenchmarkId(doc);
  const benchmarkId = options.benchmarkId ?? docBenchmarkId;
  const docOwned = !!doc && (options.benchmarkId === undefined || docBenchmarkId === options.benchmarkId);

  // 1. Projection (see the ordering note above). Never touch sample data.
  let projectionDeleted = false;
  if (benchmarkId && !isSampleRunOrBenchmarkId(benchmarkId)) {
    try {
      projectionDeleted = await storage.benchmarks.deleteRun(benchmarkId, runId);
    } catch (error: any) {
      // A missing benchmark is not a failure of THIS delete — there is
      // simply no projection left to remove. Anything else is a real
      // storage error and must surface before the document is touched.
      if (error?.meta?.statusCode !== 404) throw error;
    }
  }

  // 2. Document — cancel a live executor first.
  let cancelled = false;
  let docDeleted = false;
  if (doc && docOwned) {
    if (doc.status === 'running' && options.cancelActive) {
      cancelled = options.cancelActive(runId);
    }
    docDeleted = (await storage.evaluationRuns.delete(runId)).deleted;
  }

  return {
    deleted: docDeleted || projectionDeleted,
    docDeleted,
    docSkippedNotOwned: !!doc && !docOwned,
    projectionDeleted,
    benchmarkId,
    cancelled,
  };
}
