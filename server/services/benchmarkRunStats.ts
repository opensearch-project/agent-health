/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for recomputing benchmark-run stats from the underlying
 * report state.
 *
 * Two entry points:
 *   - `refreshBenchmarkRunStatsByReportId` — original behaviour from
 *     `routes/storage/runs.ts`. Locates the run by the `reportId` of one of
 *     its results, then recomputes stats. Used by the runs PATCH route after
 *     a single judge completion.
 *   - `refreshBenchmarkRunStatsByRunId` — locates the run by `runId` and
 *     recomputes the same way. Used by orphan-recovery code paths where we
 *     don't have a single owning report id (e.g. recovering a run whose
 *     pending tests never produced any reports at all).
 */

import type { IStorageModule } from '../adapters/types.js';

interface RunResultLike {
  reportId?: string;
  status?: string;
}

interface BenchmarkRunLike {
  id: string;
  results?: Record<string, RunResultLike>;
}

interface BenchmarkLike {
  id: string;
  runs?: BenchmarkRunLike[];
}

async function computeAndPersistStats(
  storage: IStorageModule,
  benchmarkId: string,
  targetRun: BenchmarkRunLike,
): Promise<void> {
  const reportIds = Object.values(targetRun.results || {})
    .map((r) => r.reportId)
    .filter((rid): rid is string => !!rid);

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let errored = 0;
  const total = Object.keys(targetRun.results || {}).length;

  for (const rid of reportIds) {
    try {
      const report = await storage.runs.getById(rid);
      if (!report) {
        pending++;
        continue;
      }
      const ms = (report as any).metricsStatus;
      if (ms === 'pending' || ms === 'calculating') {
        pending++;
      } else if (ms === 'error') {
        // Evaluator could not produce a verdict (issue #242). Excluded from
        // passed/failed so misconfigured judge runs don't poison pass rates.
        errored++;
      } else if (report.passFailStatus === 'passed') {
        passed++;
      } else {
        failed++;
      }
    } catch {
      pending++;
    }
  }

  // Count results without reports. Anything still flagged as 'pending' or
  // 'running' counts as pending; anything explicitly failed (e.g. by
  // boot-recovery) counts as failed.
  for (const [, res] of Object.entries(targetRun.results || {})) {
    if (res.reportId) continue;
    if (res.status === 'failed' || res.status === 'cancelled') {
      failed++;
    } else {
      pending++;
    }
  }

  await storage.benchmarks.updateRun(benchmarkId, targetRun.id, {
    stats: { passed, failed, pending, errored, total },
  } as any);
}

/**
 * Recompute and persist stats for the benchmark run that owns the given
 * report id. No-op if benchmark or run can't be found.
 */
export async function refreshBenchmarkRunStatsByReportId(
  storage: IStorageModule,
  benchmarkId: string,
  reportId: string,
): Promise<void> {
  const benchmark = (await storage.benchmarks.getById(benchmarkId)) as BenchmarkLike | null;
  if (!benchmark) return;

  const targetRun = benchmark.runs?.find((run) =>
    Object.values(run.results || {}).some((result) => result.reportId === reportId),
  );
  if (!targetRun) return;

  await computeAndPersistStats(storage, benchmarkId, targetRun);
}

/**
 * Recompute and persist stats for the benchmark run with the given run id.
 * No-op if benchmark or run can't be found.
 */
export async function refreshBenchmarkRunStatsByRunId(
  storage: IStorageModule,
  benchmarkId: string,
  runId: string,
): Promise<void> {
  const benchmark = (await storage.benchmarks.getById(benchmarkId)) as BenchmarkLike | null;
  if (!benchmark) return;

  const targetRun = benchmark.runs?.find((run) => run.id === runId);
  if (!targetRun) return;

  await computeAndPersistStats(storage, benchmarkId, targetRun);
}
