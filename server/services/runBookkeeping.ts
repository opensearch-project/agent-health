/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage-side bookkeeping performed when an evaluation run is created —
 * the same for a run the server executes (`POST /api/storage/evaluation-runs`)
 * and a run an out-of-process executor ingests (`POST /api/runs/ingest`,
 * #612): the parent benchmark is kept linked to the run's test cases and the
 * run's evaluation conditions are stamped as a benchmark image.
 *
 * Both callers resolve their test cases FIRST (the UI route from the request
 * sources, the CLI locally in its own cwd) and only then record the run; this
 * module is the one place that turns "these cases, this benchmark, these
 * judge conditions" into the persisted links, so the two paths cannot drift.
 */

import type { Benchmark, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { linkTestCaseIdsToBenchmark } from '@/services/benchmarkPromotion';
import { computeImageDigest, buildImageDoc, type ImageEvalConditions } from '@/lib/benchmarkImage';

export interface RunBookkeepingInput {
  /** The benchmark the run is grouped under, if any. Must exist. */
  benchmarkId?: string;
  /** The run's resolved test cases (latest stored versions). */
  testCases: TestCase[];
  /** Judge conditions that, with the cases, identify the benchmark image. */
  evalConditions: ImageEvalConditions;
  /** `createdAt` of the run — stamped as the image's `lastRunAt`. */
  now: string;
}

export class BenchmarkNotFoundError extends Error {
  constructor(public readonly benchmarkId: string) {
    super(`Benchmark not found: ${benchmarkId}`);
    this.name = 'BenchmarkNotFoundError';
  }
}

/**
 * Keep an explicitly associated benchmark linked to the canonical test case
 * documents the run resolved: repeated CLI imports therefore reuse one
 * benchmark and one stable set of ids instead of leaving a shell whose
 * definitions live only in run documents. The link covers the top level AND
 * the current version (see `linkTestCaseIdsToBenchmark`) and is best-effort
 * — a link failure must not abort the run.
 *
 * @throws BenchmarkNotFoundError when `benchmarkId` names no benchmark.
 */
export async function linkRunTestCasesToBenchmark(
  storage: IStorageModule,
  benchmarkId: string,
  testCaseIds: string[],
): Promise<Benchmark> {
  const benchmark = await storage.benchmarks.getById(benchmarkId);
  if (!benchmark) throw new BenchmarkNotFoundError(benchmarkId);
  const idsChanged = JSON.stringify(benchmark.testCaseIds || []) !== JSON.stringify(testCaseIds);
  if (idsChanged) {
    await storage.benchmarks.update(benchmarkId, { testCaseIds });
  }
  if (testCaseIds.length > 0) {
    try {
      await linkTestCaseIdsToBenchmark(benchmarkId, testCaseIds, storage);
    } catch (linkError: any) {
      console.error(`[runBookkeeping] Failed to link test cases into benchmark ${benchmarkId}:`, linkError?.message);
    }
  }
  return benchmark;
}

/**
 * Stamp the content digest of the run's evaluation conditions and
 * find-or-create the corresponding benchmark image. Content-addressed
 * identity is the inherent dedup: re-running the same command yields the
 * same digest → the same image doc, never a duplicate. Failure-safe: image
 * bookkeeping must never block run execution, so any error logs a warning
 * and yields `undefined`.
 */
export async function stampRunImage(
  storage: IStorageModule,
  testCases: TestCase[],
  evalConditions: ImageEvalConditions,
  now: string,
): Promise<string | undefined> {
  if (testCases.length === 0) return undefined;
  try {
    const digest = computeImageDigest({ testCases, evalConditions });
    await storage.images.create(buildImageDoc({ testCases, evalConditions }));
    await storage.images.update(digest, { lastRunAt: now }).catch(() => {});
    return digest;
  } catch (imageErr: any) {
    console.warn('[runBookkeeping] Image digest stamping failed (run continues):', imageErr?.message);
    return undefined;
  }
}

/**
 * Everything a run's creation records besides the run document itself.
 * Returns the image digest to stamp on the run (`run.imageDigest`), if any.
 *
 * @throws BenchmarkNotFoundError — the only refusal; everything else is best-effort.
 */
export async function performRunBookkeeping(storage: IStorageModule, input: RunBookkeepingInput): Promise<{ imageDigest?: string }> {
  const testCaseIds = input.testCases.map((tc) => tc.id);
  if (input.benchmarkId) {
    await linkRunTestCasesToBenchmark(storage, input.benchmarkId, testCaseIds);
  }
  const imageDigest = await stampRunImage(storage, input.testCases, input.evalConditions, input.now);
  return imageDigest ? { imageDigest } : {};
}

/**
 * Bookkeeping for a run document ingested from another process: its test
 * cases are the ones named by `testCaseSnapshots` (already upserted by the
 * executor through the storage API). Snapshots whose document cannot be
 * read are skipped for the image (a digest over a partial set would alias a
 * different run), while the benchmark link still receives every id.
 */
export async function performIngestedRunBookkeeping(
  storage: IStorageModule,
  run: { benchmarkId?: string; testCaseSnapshots?: Array<{ id: string }>; evaluatorId?: string; judgeModelId?: string; createdAt?: string },
): Promise<{ imageDigest?: string }> {
  const ids = (run.testCaseSnapshots ?? []).map((s) => s.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const now = run.createdAt ?? new Date().toISOString();
  if (run.benchmarkId) {
    await linkRunTestCasesToBenchmark(storage, run.benchmarkId, ids);
  }
  const testCases: TestCase[] = [];
  let missing = 0;
  for (const id of ids) {
    const tc = await storage.testCases.getById(id).catch(() => null);
    if (tc) testCases.push(tc);
    else missing++;
  }
  if (missing > 0 || testCases.length === 0) {
    if (ids.length > 0) console.warn(`[runBookkeeping] ${missing} of ${ids.length} test cases of the ingested run are not stored; no image stamped`);
    return {};
  }
  const imageDigest = await stampRunImage(storage, testCases, { evaluatorId: run.evaluatorId || undefined, judgeModelId: run.judgeModelId || undefined }, now);
  return imageDigest ? { imageDigest } : {};
}
