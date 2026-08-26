/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deciding how to report on a CLI `benchmark -f` unified evaluation run once
 * the SSE progress stream is done. Kept in its own module (no ESM-only deps
 * like `ora`/`chalk`) so it can be unit-tested by importing the real
 * function directly, rather than mirroring its logic in the test file.
 */

import type { EvaluationRun } from '@/types/index.js';

export type UnifiedRunOutcome =
  | { kind: 'success'; doneCount: number }
  | { kind: 'failed'; message: string }
  | { kind: 'timeout' };

/**
 * Decide how `runUnifiedMode` should report on the run it ended up with once
 * the SSE stream is done (whether it completed normally, was recovered via
 * `ApiClient.pollEvaluationRunStatus`, or that poll timed out).
 *
 * - `run` is `null` when no `runId` was ever captured (connection dropped
 *   before the started event) — nothing to report on, treat as a plain
 *   success using whatever SSE progress was seen.
 * - `run.status === 'completed'` is the only true success case.
 * - `'failed'` / `'cancelled'` are terminal-but-unsuccessful — report as a
 *   command failure, not a success. Without this check, a run that failed
 *   server-side (or was cancelled) after a mid-stream disconnect would be
 *   reported as a completed success once the fallback poll picked it up —
 *   the same class of "lying about the outcome" bug this whole fix (CLI
 *   `benchmark -f` polling storage on long runs) exists to close, just one
 *   layer up the call stack.
 * - `'pending'` / `'running'` means `pollEvaluationRunStatus` timed out
 *   before the run finished server-side (a very long run, past the poll
 *   budget) — report the ambiguity honestly rather than claiming completion.
 */
export function resolveUnifiedRunOutcome(
  run: EvaluationRun | null,
  completedCount: number
): UnifiedRunOutcome {
  if (!run) {
    return { kind: 'success', doneCount: completedCount };
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return { kind: 'failed', message: `Evaluation run ${run.status}${run.error ? `: ${run.error}` : ''}` };
  }
  if (run.status === 'pending' || run.status === 'running') {
    return { kind: 'timeout' };
  }
  // 'completed' — prefer the fresh per-case count from storage over the
  // SSE-derived completedCount, which is stale whenever we polled (it stops
  // updating the moment the stream dropped).
  const doneCount = Object.values(run.results || {}).filter(
    (r) => r.status !== 'pending' && r.status !== 'running'
  ).length;
  return { kind: 'success', doneCount };
}
