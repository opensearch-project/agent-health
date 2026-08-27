/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Finalize top-level EvaluationRun documents orphaned by a server restart.
 *
 * The execution registry is process-local. Therefore, after a cold start, a
 * persisted `status: running` document with no matching registry entry cannot
 * make further progress. Marking it failed is terminal, preserves every
 * persisted per-case result, and makes this sweep naturally idempotent.
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationRun } from '../../types/index.js';
import { isEvaluationRunActiveInThisProcess } from '../routes/storage/evaluationRuns.js';

const INTERRUPTION_ERROR = 'interrupted: server restarted mid-run';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface EvaluationRunRecoveryStat {
  scannedRuns: number;
  orphanedRuns: number;
  runsMarkedFailed: number;
  activeRunsSkipped: number;
  errors: number;
  durationMs: number;
}

/** Scan and finalize orphaned EvaluationRuns. Safe to run repeatedly. */
export async function recoverOrphanEvaluationRuns(storage: IStorageModule): Promise<EvaluationRunRecoveryStat> {
  const startedAt = Date.now();
  const stat: EvaluationRunRecoveryStat = {
    scannedRuns: 0,
    orphanedRuns: 0,
    runsMarkedFailed: 0,
    activeRunsSkipped: 0,
    errors: 0,
    durationMs: 0,
  };

  if (process.env.EVALUATION_RUN_RECOVERY_DISABLED === '1') {
    stat.durationMs = Date.now() - startedAt;
    return stat;
  }

  const pageSize = envInt('EVALUATION_RUN_RECOVERY_PAGE_SIZE', 100);
  const maxPages = envInt('EVALUATION_RUN_RECOVERY_MAX_PAGES', 50);
  const runningRuns: EvaluationRun[] = [];

  // Snapshot candidates before changing their status. Updating a page while
  // paginating a `status=running` result set would shrink the set and skip the
  // next page.
  for (let page = 0; page < maxPages; page++) {
    try {
      const result = await storage.evaluationRuns.list({
        status: 'running',
        from: page * pageSize,
        size: pageSize,
        sort: 'createdAt',
        order: 'asc',
      });
      runningRuns.push(...result.items);
      if (result.items.length < pageSize) break;
    } catch (err: any) {
      stat.errors++;
      console.warn(`[evaluationRunRecovery] evaluationRuns.list failed at page=${page}: ${err?.message || err}`);
      break;
    }
  }

  for (const run of runningRuns) {
    stat.scannedRuns++;
    // Defensive: adapters should enforce the status filter, but never finalize
    // a terminal document if a custom adapter returns an over-broad page.
    if (run.status !== 'running') continue;
    if (isEvaluationRunActiveInThisProcess(run.id)) {
      stat.activeRunsSkipped++;
      continue;
    }

    stat.orphanedRuns++;
    try {
      await storage.evaluationRuns.update(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: INTERRUPTION_ERROR,
      });
      stat.runsMarkedFailed++;
    } catch (err: any) {
      stat.errors++;
      console.warn(`[evaluationRunRecovery] Failed to finalize ${run.id}: ${err?.message || err}`);
    }
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/** Log one boot summary and keep recovery failures non-fatal. */
export async function recoverOrphanEvaluationRunsSafely(storage: IStorageModule): Promise<void> {
  try {
    const stat = await recoverOrphanEvaluationRuns(storage);
    console.log(
      `[evaluationRunRecovery] runs=${stat.scannedRuns} orphaned=${stat.orphanedRuns} ` +
      `markedFailed=${stat.runsMarkedFailed} activeSkipped=${stat.activeRunsSkipped} ` +
      `errors=${stat.errors} [${stat.durationMs}ms]`
    );
  } catch (err: any) {
    console.warn(`[evaluationRunRecovery] Unhandled failure: ${err?.message || err}`);
  }
}
