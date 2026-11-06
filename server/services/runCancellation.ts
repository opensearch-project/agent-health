/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide fan-out over the in-flight run registries.
 *
 * In-flight executors are tracked in two per-route in-memory registries
 * (`server/routes/storage/benchmarks.ts` for legacy `POST .../execute` runs,
 * `server/routes/storage/evaluationRuns.ts` for evaluation runs and
 * retry-judgement jobs). A delete issued through EITHER route must be able
 * to stop an executor registered by the OTHER (a dual-written run deleted via
 * the benchmark's nested-run URL is executing under the evaluation-runs
 * registry), and the two route modules must not import each other. Each
 * registers a canceller here at load time; the delete paths call
 * `cancelActiveRun`.
 *
 * The same registries are the only truthful answer to "is this server
 * executing anything right now?" — storage `status: 'running'` can be a
 * stale doc left by a crashed process. Each registry also registers a
 * lister; `/health` reports `listActiveRuns()` so the CLI's version-mismatch
 * restart (`cli/utils/serverLifecycle.ts`) can refuse to kill a server that
 * is mid-run (#612).
 *
 * Same single-process caveat as the cancel endpoints themselves: a run
 * executing in a different server process is not reachable from here.
 */

type RunCanceller = (runId: string) => boolean;

const cancellers = new Set<RunCanceller>();

/** Register a `(runId) => cancelled?` hook for one executor registry. */
export function registerRunCanceller(canceller: RunCanceller): () => void {
  cancellers.add(canceller);
  return () => { cancellers.delete(canceller); };
}

/**
 * Ask every registry to cancel `runId`; true when one of them held a live
 * executor. A canceller that throws is logged and does not block the others
 * (the delete this precedes must not fail because a stop signal did).
 */
export function cancelActiveRun(runId: string): boolean {
  let cancelled = false;
  for (const canceller of cancellers) {
    try {
      if (canceller(runId)) cancelled = true;
    } catch (error: any) {
      console.warn(`[runCancellation] canceller threw for ${runId}: ${error?.message ?? error}`);
    }
  }
  return cancelled;
}

/** One run this process is executing right now. */
export interface ActiveRunRef {
  id: string;
  kind: 'benchmark' | 'evaluation' | 'retry-judgement';
}

type ActiveRunLister = () => ActiveRunRef[];

const listers = new Set<ActiveRunLister>();

/** Register a `() => runs in flight` hook for one executor registry. */
export function registerActiveRunLister(lister: ActiveRunLister): () => void {
  listers.add(lister);
  return () => { listers.delete(lister); };
}

/** `listActiveRuns()` result: `complete` is false when a registry could not answer. */
export interface ActiveRunsSnapshot {
  runs: ActiveRunRef[];
  complete: boolean;
}

/**
 * Every run currently executing in THIS process, across all registries.
 * A lister that throws is logged and the snapshot is marked incomplete —
 * never silently reported as "idle", because a caller deciding whether a
 * restart is safe must fail closed (the CLI treats an absent/incomplete
 * answer as "unknown" and refuses).
 */
export function listActiveRuns(): ActiveRunsSnapshot {
  const runs: ActiveRunRef[] = [];
  let complete = true;
  for (const lister of listers) {
    try {
      runs.push(...lister());
    } catch (error: any) {
      complete = false;
      console.warn(`[runCancellation] active-run lister threw: ${error?.message ?? error}`);
    }
  }
  return { runs, complete };
}
