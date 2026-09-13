/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracking for the runs a benchmark page LAUNCHED via "Add Run", derived from
 * the polled RUN DOCUMENTS rather than from the lifetime of the SSE
 * connections that launched them.
 *
 * Two owner reports shaped this module:
 *
 * - 2026-09-09: after Add Run the header button stayed on "Running…" forever
 *   on long (30–60+ min) runs even though the run completed server-side. The
 *   page bound its state to a client-local boolean that was only reset when
 *   the launching `POST /api/storage/evaluation-runs` SSE stream ended — but an
 *   idle proxy/tunnel/browser closes that stream long before `completed`. The
 *   polled run docs (which already drive the per-row status) are the truth.
 *
 * - 2026-09-13: the fix above still turned "Add Run" into a disabled
 *   "Running…" button for the whole run. The owner routinely launches 2–4 arms
 *   (agent/model variants) on the same benchmark back-to-back, so blocking the
 *   button meant a page refresh between launches. **Add Run is never disabled
 *   by running runs**: multiple concurrent runs on one benchmark are the normal
 *   flow. The page keeps a LIST of launched runs, shows one progress block per
 *   non-terminal launched run, and a non-blocking `● N running` pill counts
 *   every in-flight run for the benchmark (launched here or anywhere else).
 */

import type { BenchmarkRunStatus } from '@/types';
import { isRunInProgress, isTerminalRunStatus } from '@/lib/runStats';

/** A run this page launched; `launchedAt` anchors the missing-doc grace. */
export interface LaunchedRun {
  runId: string;
  name: string;
  launchedAt: number;
}

/** The subset of a polled run document these helpers look at. */
export interface PolledRunDoc {
  id: string;
  status?: BenchmarkRunStatus;
  results?: Record<string, { status?: string }>;
}

/**
 * How long a launched run stays tracked while its document has not shown up
 * in the polled list yet. The doc is created server-side BEFORE the `started`
 * event is emitted, so a few poll cycles is plenty; after that the run is
 * considered gone (deleted, or the list is filtered) and its progress block
 * must not linger forever a second way.
 */
export const LAUNCHED_RUN_DOC_GRACE_MS = 30_000;

/**
 * Drop launched runs whose polled document is terminal (completed / failed /
 * cancelled), or which never appeared within the grace window. Order is
 * preserved (launch order). Returns the SAME array instance when nothing
 * changed so callers can skip a state update.
 */
export function pruneLaunchedRuns<T extends LaunchedRun>(
  launched: readonly T[],
  runs: ReadonlyArray<PolledRunDoc>,
  now: number = Date.now(),
): T[] {
  const kept = launched.filter(l => {
    const doc = runs.find(r => r.id === l.runId);
    if (!doc) return now - l.launchedAt <= LAUNCHED_RUN_DOC_GRACE_MS;
    return !isTerminalRunStatus(doc.status);
  });
  return kept.length === launched.length ? (launched as T[]) : kept;
}

/**
 * Number of in-flight runs for the `● N running` header pill — every run in
 * the polled list whose EFFECTIVE status is `running`, whether or not this
 * page launched it. Deliberately the same predicate the runs table's
 * `status: running` filter applies (`getEffectiveRunStatus`), so clicking the
 * pill always lands on exactly N rows; legacy status-less docs resolve
 * through their per-case results the same way there.
 */
export function countRunsInFlight(runs: ReadonlyArray<PolledRunDoc>): number {
  return runs.filter(r => isRunInProgress(r)).length;
}

export interface LaunchedCaseStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

/**
 * Per-case rows for a launched run's progress block once the launching SSE
 * stream is gone: rebuilt from the polled doc's `results`. A case with no
 * result yet hasn't started (a stale `running` from the dropped stream goes
 * back to pending until the doc says otherwise). With no doc at all (grace
 * window) the stream's last-known rows are kept as-is.
 */
export function progressFromPolledDoc(
  cases: ReadonlyArray<LaunchedCaseStatus>,
  doc: PolledRunDoc | null | undefined,
): LaunchedCaseStatus[] {
  if (!doc) return [...cases];
  const results = doc.results || {};
  return cases.map(uc => {
    const status = results[uc.id]?.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'running') {
      return { ...uc, status };
    }
    return uc.status === 'running' ? { ...uc, status: 'pending' as const } : uc;
  });
}
