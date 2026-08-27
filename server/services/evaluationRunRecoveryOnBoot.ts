/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orphan EvaluationRun recovery on server boot.
 *
 * Sister of `benchmarkRunRecoveryOnBoot.ts`, for the run-first
 * `EvaluationRun` documents. When the server dies mid-run (deploy / OOM /
 * SIGKILL), the run doc stays `status: 'running'` forever — the in-memory
 * cancellation registry died with the process and nothing else moves the
 * run forward. That both misleads the UI and blocks the checkpoint-resume
 * endpoint (`POST /api/storage/evaluation-runs/:id/resume`), which only
 * offers resume for non-active runs.
 *
 * On boot, scan evaluation runs that are:
 *   - `status === 'running'` AND
 *   - older than `EVALUATION_RUN_STALE_AFTER_MS` (default 1h; the most
 *     recent of createdAt/resumedAt counts) AND
 *   - not actively executing in the current process.
 *
 * For each: mark unfinished results (`pending`/`running` without a
 * reportId) as failed with a recovery note, and the run itself as
 * `'failed'`. Completed results keep their reports — the run is then
 * resumable from exactly where it stopped.
 *
 * Disable in tests with `EVALUATION_RUN_RECOVERY_DISABLED=1`.
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationRun } from '../../types/index.js';
import {
  isEvaluationRunActiveInThisProcess,
  runLivenessAgeMs,
  runStaleAfterMs,
} from '../routes/storage/evaluationRuns.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface EvaluationRunRecoveryStat {
  scannedRuns: number;
  staleRuns: number;
  resultsMarkedFailed: number;
  runsMarkedFailed: number;
  errors: number;
  durationMs: number;
}

/**
 * Scan storage for stale `running` EvaluationRuns and fail them out.
 * Idempotent and safe to run on every boot.
 */
export async function recoverOrphanEvaluationRuns(storage: IStorageModule): Promise<EvaluationRunRecoveryStat> {
  const startedAt = Date.now();
  const stat: EvaluationRunRecoveryStat = {
    scannedRuns: 0,
    staleRuns: 0,
    resultsMarkedFailed: 0,
    runsMarkedFailed: 0,
    errors: 0,
    durationMs: 0,
  };

  if (process.env.EVALUATION_RUN_RECOVERY_DISABLED === '1') {
    stat.durationMs = Date.now() - startedAt;
    return stat;
  }

  const staleAfterMs = runStaleAfterMs();
  const pageSize = envInt('EVALUATION_RUN_RECOVERY_PAGE_SIZE', 100);
  const maxPages = envInt('EVALUATION_RUN_RECOVERY_MAX_PAGES', 50);
  const now = Date.now();

  // Two-phase: SCAN everything first, MUTATE afterwards. The list query
  // filters on status:'running' — mutating docs to 'failed' while paging
  // with from/size shrinks the result set under the cursor and skips runs.
  const candidates: EvaluationRun[] = [];
  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    let runs: EvaluationRun[];
    try {
      const result = await storage.evaluationRuns.list({ from, size: pageSize, status: 'running' });
      runs = result.items;
    } catch (err: any) {
      stat.errors++;
      console.warn(`[evaluationRunRecovery] evaluationRuns.list failed at from=${from}: ${err?.message || err}`);
      break;
    }
    if (!runs || runs.length === 0) break;
    candidates.push(...runs);
    if (runs.length < pageSize) break;
    from += pageSize;
  }

  for (const run of candidates) {
    stat.scannedRuns++;
    if (run.status !== 'running') continue;

    // Age from the most recent liveness signal (heartbeat / resumed / created).
    // Executing servers stamp `heartbeatAt` every minute, so a run on a
    // sibling server sharing this storage cluster never looks stale.
    const ageMs = runLivenessAgeMs(run, now);
    if (ageMs < staleAfterMs) continue;

    if (isEvaluationRunActiveInThisProcess(run.id)) continue;

    stat.staleRuns++;
    const reason =
      `Evaluation runner did not complete this test case ` +
      `(stale 'running' run found during boot recovery; original process likely died). ` +
      `Use Resume to re-execute the unfinished test cases.`;

    const newResults: Record<string, any> = {};
    for (const [tcId, res] of Object.entries(run.results || {})) {
      const r: any = res;
      const isUnfinished = (r?.status === 'pending' || r?.status === 'running') && !r?.reportId;
      if (isUnfinished) {
        newResults[tcId] = { reportId: '', status: 'failed', error: reason };
        stat.resultsMarkedFailed++;
      } else {
        newResults[tcId] = r;
      }
    }

    try {
      await storage.evaluationRuns.update(run.id, {
        status: 'failed',
        error: 'Run interrupted (server restarted mid-run). Completed test cases are preserved — use Resume to finish the rest.',
        results: newResults,
        completedAt: new Date().toISOString(),
      });
      stat.runsMarkedFailed++;
      console.log(`[evaluationRunRecovery] Marked stale run ${run.id} as failed (resumable)`);
    } catch (err: any) {
      stat.errors++;
      console.warn(`[evaluationRunRecovery] Failed to update run ${run.id}: ${err?.message || err}`);
    }
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/**
 * Wrapper that logs a single summary line and never throws.
 * Suitable for fire-and-forget invocation from `startServer()`.
 */
export function recoverOrphanEvaluationRunsSafely(storage: IStorageModule): void {
  recoverOrphanEvaluationRuns(storage)
    .then((stat) => {
      const summary = stat.staleRuns > 0
        ? `marked ${stat.runsMarkedFailed} stale run(s) failed (${stat.resultsMarkedFailed} unfinished result(s))`
        : 'no orphan running runs';
      console.log(`[evaluationRunRecovery] runs=${stat.scannedRuns} ${summary} [${stat.durationMs}ms]`);
    })
    .catch((err: any) => {
      console.warn(`[evaluationRunRecovery] Recovery failed (non-fatal): ${err?.message || err}`);
    });
}
