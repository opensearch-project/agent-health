/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orphan BenchmarkRun recovery on server boot.
 *
 * Sister of `traceRecoveryOnBoot.ts`. Where that module fixes orphan
 * trace-polling state, this one fixes orphan *benchmark execution* state —
 * a separate failure mode hit by users when:
 *
 *   - A benchmark is mid-flight (executeRun has scheduled some test cases,
 *     completed a few, started others)
 *   - The server is killed (deploy / OOM / SIGKILL / uncaught rejection that
 *     bypasses the executeRun catch block)
 *   - On restart, `BenchmarkRun.status` is still `'running'`, and any test
 *     case that hadn't completed has `runResult.status: 'pending'` with no
 *     `reportId`. Nothing on the server moves these forward — the in-memory
 *     `activeRuns` cancellation registry was lost with the dead process, and
 *     the next `executeRun` won't re-pick the same run id.
 *
 * On boot, scan benchmarks for runs that are:
 *   - `status === 'running'` AND
 *   - older than `BENCHMARK_RUN_STALE_AFTER_MS` (default 1h) AND
 *   - not in the *current* process's `activeRuns` map (so we don't kill an
 *     in-flight resumption from another concurrent boot path)
 *
 * For each such run:
 *   - Mark every `runResult` whose `status` is still `'running'` or `'pending'`
 *     and which has **no** `reportId` as `'failed'` with a recovery note.
 *   - Mark the run itself as `'failed'`.
 *   - Refresh stats so the UI reflects reality.
 *
 * Behaviour can be disabled in tests with `BENCHMARK_RUN_RECOVERY_DISABLED=1`.
 */

import type { IStorageModule } from '../adapters/types.js';
import type { Benchmark, BenchmarkRun } from '../../types/index.js';
import { isRunActiveInThisProcess } from '../routes/storage/benchmarks.js';
import { refreshBenchmarkRunStatsByRunId } from './benchmarkRunStats.js';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BenchmarkRunRecoveryStat {
  scannedBenchmarks: number;
  scannedRuns: number;
  staleRuns: number;
  resultsMarkedFailed: number;
  runsMarkedFailed: number;
  errors: number;
  durationMs: number;
}

/**
 * Scan storage for stale `running` BenchmarkRuns and fail them out.
 * Idempotent and safe to run on every boot.
 */
export async function recoverOrphanBenchmarkRuns(storage: IStorageModule): Promise<BenchmarkRunRecoveryStat> {
  const startedAt = Date.now();
  const stat: BenchmarkRunRecoveryStat = {
    scannedBenchmarks: 0,
    scannedRuns: 0,
    staleRuns: 0,
    resultsMarkedFailed: 0,
    runsMarkedFailed: 0,
    errors: 0,
    durationMs: 0,
  };

  if (process.env.BENCHMARK_RUN_RECOVERY_DISABLED === '1') {
    stat.durationMs = Date.now() - startedAt;
    return stat;
  }

  const staleAfterMs = envInt('BENCHMARK_RUN_STALE_AFTER_MS', 60 * 60 * 1000); // 1h
  const pageSize = envInt('BENCHMARK_RUN_RECOVERY_PAGE_SIZE', 100);
  const maxPages = envInt('BENCHMARK_RUN_RECOVERY_MAX_PAGES', 50);
  const now = Date.now();

  let from = 0;
  for (let page = 0; page < maxPages; page++) {
    let benchmarks: Benchmark[];
    try {
      const result = await storage.benchmarks.getAll({ from, size: pageSize });
      benchmarks = result.items;
    } catch (err: any) {
      stat.errors++;
      console.warn(`[benchmarkRunRecovery] benchmarks.getAll failed at from=${from}: ${err?.message || err}`);
      break;
    }
    if (!benchmarks || benchmarks.length === 0) break;
    stat.scannedBenchmarks += benchmarks.length;

    for (const bm of benchmarks) {
      const runs: BenchmarkRun[] = bm.runs || [];
      if (runs.length === 0) continue;

      let benchmarkChanged = false;
      const updatedRuns: BenchmarkRun[] = [];
      const staleRunIds: string[] = [];

      for (const run of runs) {
        stat.scannedRuns++;
        if (run.status !== 'running') {
          updatedRuns.push(run);
          continue;
        }

        const runStart = new Date(run.createdAt || 0).getTime();
        const ageMs = Number.isFinite(runStart) && runStart > 0 ? now - runStart : Infinity;
        if (ageMs < staleAfterMs) {
          updatedRuns.push(run);
          continue;
        }

        if (isRunActiveInThisProcess(run.id)) {
          // Resumed in the current process — leave alone.
          updatedRuns.push(run);
          continue;
        }

        // Orphan: rewrite results + run status
        stat.staleRuns++;
        const reason = `Benchmark runner did not complete this test case ` +
          `(stale 'running' run resumed during boot recovery; original process likely died)`;

        const newResults: Record<string, any> = {};
        for (const [tcId, res] of Object.entries(run.results || {})) {
          const r: any = res;
          const isUnstarted =
            (r?.status === 'pending' || r?.status === 'running') && !r?.reportId;
          if (isUnstarted) {
            newResults[tcId] = {
              reportId: '',
              status: 'failed',
              error: reason,
            };
            stat.resultsMarkedFailed++;
          } else {
            newResults[tcId] = r;
          }
        }

        updatedRuns.push({ ...run, status: 'failed', results: newResults });
        staleRunIds.push(run.id);
        stat.runsMarkedFailed++;
        benchmarkChanged = true;
      }

      if (!benchmarkChanged) continue;

      try {
        await storage.benchmarks.update(bm.id, { ...bm, runs: updatedRuns } as Partial<Benchmark>);
        console.log(
          `[benchmarkRunRecovery] Benchmark ${bm.id}: marked ${staleRunIds.length} stale run(s) as failed: ${staleRunIds.join(', ')}`
        );
      } catch (err: any) {
        stat.errors++;
        console.warn(`[benchmarkRunRecovery] Failed to update benchmark ${bm.id}: ${err?.message || err}`);
        continue;
      }

      // Refresh stats per recovered run so the inspect/runs UI is consistent.
      for (const runId of staleRunIds) {
        try {
          await refreshBenchmarkRunStatsByRunId(storage, bm.id, runId);
        } catch (err: any) {
          stat.errors++;
          console.warn(`[benchmarkRunRecovery] refreshBenchmarkRunStatsByRunId failed for ${bm.id}/${runId}: ${err?.message || err}`);
        }
      }
    }

    if (benchmarks.length < pageSize) break;
    from += pageSize;
  }

  stat.durationMs = Date.now() - startedAt;
  return stat;
}

/**
 * Wrapper that logs a single summary line and never throws.
 * Suitable for fire-and-forget invocation from `startServer()`.
 */
export async function recoverOrphanBenchmarkRunsSafely(storage: IStorageModule): Promise<void> {
  try {
    const stat = await recoverOrphanBenchmarkRuns(storage);
    if (stat.staleRuns === 0 && stat.errors === 0) {
      console.log(
        `[benchmarkRunRecovery] benchmarks=${stat.scannedBenchmarks} runs=${stat.scannedRuns} no orphan running runs [${stat.durationMs}ms]`
      );
    } else {
      console.log(
        `[benchmarkRunRecovery] benchmarks=${stat.scannedBenchmarks} runs=${stat.scannedRuns} ` +
        `staleRuns=${stat.staleRuns} runsMarkedFailed=${stat.runsMarkedFailed} ` +
        `resultsMarkedFailed=${stat.resultsMarkedFailed} errors=${stat.errors} [${stat.durationMs}ms]`
      );
    }
  } catch (err: any) {
    console.warn(`[benchmarkRunRecovery] Unhandled failure: ${err?.message || err}`);
  }
}
