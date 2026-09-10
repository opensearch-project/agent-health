/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Add Run" header-button state, derived from the RUN DOCUMENT rather than
 * from the lifetime of the SSE connection that launched it.
 *
 * Bug (owner report, 2026-09-09): after clicking Add Run on the benchmark
 * page, the header button stayed on "Running…" forever on long (30–60+ min)
 * runs even though the run itself completed server-side. The button was bound
 * to a client-local `isRunning` boolean that was only reset when the
 * `POST /api/storage/evaluation-runs` SSE stream ended — but an idle proxy /
 * tunnel / browser closes that stream after N minutes with no `completed`
 * event, so the flag never flipped. The per-row status on the same page was
 * already correct because it comes from the polled run docs; the header
 * button was the one thing still bound to the fragile connection.
 *
 * This helper makes the header truthful: it is "running" while the run this
 * page launched is not yet terminal ACCORDING TO THE POLLED DOCS, regardless
 * of whether the stream is alive.
 */

import type { BenchmarkRunStatus } from '@/types';

export type AddRunButtonState = 'idle' | 'launching' | 'running';

/** Statuses after which the run document can no longer change. */
const TERMINAL_RUN_STATUSES: ReadonlySet<BenchmarkRunStatus> = new Set<BenchmarkRunStatus>([
  'completed', 'failed', 'cancelled',
]);

export function isTerminalRunStatus(status: BenchmarkRunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * How long we keep showing "Running…" for a launched run whose document has
 * not shown up in the polled list yet. The doc is created server-side BEFORE
 * the `started` event is emitted, so a few poll cycles is plenty; after that
 * the run is considered gone (deleted, or the list is filtered) and the button
 * must not spin forever a second way.
 */
export const LAUNCHED_RUN_DOC_GRACE_MS = 30_000;

export interface DeriveAddRunButtonStateInput {
  /** POST sent, no `started` event (hence no runId) received yet. */
  launching: boolean;
  /** runId from the `started` event; null when nothing has been launched. */
  launchedRunId: string | null;
  /** Wall-clock ms when `launchedRunId` was set (for the missing-doc grace). */
  launchedAt?: number | null;
  /** The run documents this page currently knows about (polled). */
  runs: ReadonlyArray<{ id: string; status?: BenchmarkRunStatus }>;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * - no launch in progress → `idle`
 * - POST in flight, no runId yet → `launching`
 * - runId known, doc non-terminal → `running`
 * - runId known, doc missing → `running` for a bounded grace, then `idle`
 * - runId known, doc terminal (completed / failed / cancelled) → `idle`
 */
export function deriveAddRunButtonState(input: DeriveAddRunButtonStateInput): AddRunButtonState {
  const { launching, launchedRunId, runs } = input;
  if (launching && !launchedRunId) return 'launching';
  if (!launchedRunId) return 'idle';

  const doc = runs.find(r => r.id === launchedRunId);
  if (!doc) {
    const now = input.now ?? Date.now();
    const launchedAt = input.launchedAt ?? now;
    return now - launchedAt <= LAUNCHED_RUN_DOC_GRACE_MS ? 'running' : 'idle';
  }
  return isTerminalRunStatus(doc.status) ? 'idle' : 'running';
}
