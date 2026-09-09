/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide "stop this run if you are executing it" fan-out.
 *
 * In-flight executors are tracked in two per-route in-memory registries
 * (`server/routes/storage/benchmarks.ts` for legacy `POST .../execute` runs,
 * `server/routes/storage/evaluationRuns.ts` for evaluation runs). A delete
 * issued through EITHER route must be able to stop an executor registered by
 * the OTHER (a dual-written run deleted via the benchmark's nested-run URL is
 * executing under the evaluation-runs registry), and the two route modules
 * must not import each other. Each registers a canceller here at load time;
 * the delete paths call `cancelActiveRun`.
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
