/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Find-or-create the single stable benchmark that CLI quick mode
 * (`agent-health benchmark` with no `-n`/`-f`) attaches every run to.
 *
 * Quick mode used to create a `quick-<timestamp>` Benchmark doc per
 * invocation (unbounded junk). Runs must still belong to a benchmark, though
 * — the Evaluation Runs page links its Benchmark column to the benchmark page
 * and history accumulates there — so instead of going ad-hoc, quick mode
 * resolves ONE benchmark named {@link QUICK_MODE_BENCHMARK_NAME}:
 *
 *  1. exact id → exact name → unique trimmed/case-insensitive match
 *     ({@link ApiClient.findBenchmarkDetailed}); an ambiguous match is a hard
 *     error listing the collisions (we never guess and never create a third
 *     near-duplicate under the colliding name);
 *  2. when found and its test-case set differs from the full stored set, the
 *     benchmark is updated to the current set BEFORE the run starts (the
 *     server's PUT records the change as a new benchmark version);
 *  3. created only when nothing matches.
 *
 * Kept free of ESM-only deps (`ora`/`chalk`) so it is unit-testable directly.
 */

import type { Benchmark } from '@/types/index.js';

/**
 * The ONE benchmark every CLI quick-mode run attaches to. Looked up by this
 * exact name (then unique trimmed/case-insensitive match) on every run.
 */
export const QUICK_MODE_BENCHMARK_NAME = 'Quick run — all test cases';

export const QUICK_MODE_BENCHMARK_DESCRIPTION =
  'Reused by every CLI quick-mode run; its test cases are refreshed to the full stored set on each run.';

/** The subset of {@link ApiClient} this helper needs (mock-friendly). */
export interface QuickModeBenchmarkApi {
  findBenchmarkDetailed(
    identifier: string
  ): Promise<{ benchmark: Benchmark | null; ambiguousMatches: Benchmark[] }>;
  createBenchmark(input: { name: string; description?: string; testCaseIds: string[] }): Promise<Benchmark>;
  updateBenchmark(id: string, input: { testCaseIds?: string[] }): Promise<Benchmark>;
}

export type QuickModeBenchmarkResolution =
  | { outcome: 'created'; benchmark: Benchmark }
  | { outcome: 'reused'; benchmark: Benchmark; refreshed: boolean }
  | { outcome: 'ambiguous'; matches: Benchmark[] };

/** Order-insensitive, duplicate-insensitive set equality on test-case ids. */
export function sameTestCaseSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/**
 * @param identity Production callers use the default (the stable quick-mode
 *   name). Integration tests running against a SHARED storage backend point
 *   this at a run-unique name so they never create or mutate the real
 *   quick-mode benchmark of whoever else uses that server.
 */
export async function resolveQuickModeBenchmark(
  api: QuickModeBenchmarkApi,
  testCaseIds: string[],
  identity: { name: string; description: string } = {
    name: QUICK_MODE_BENCHMARK_NAME,
    description: QUICK_MODE_BENCHMARK_DESCRIPTION,
  }
): Promise<QuickModeBenchmarkResolution> {
  // Stable ordering so repeated runs over an unchanged set never look like a
  // change (the test-case list endpoint sorts by last activity, which moves
  // every run).
  const ids = [...new Set(testCaseIds)].sort();

  const found = await api.findBenchmarkDetailed(identity.name);
  if (found.ambiguousMatches.length > 0) {
    return { outcome: 'ambiguous', matches: found.ambiguousMatches };
  }

  if (found.benchmark) {
    if (sameTestCaseSet(found.benchmark.testCaseIds, ids)) {
      return { outcome: 'reused', benchmark: found.benchmark, refreshed: false };
    }
    const updated = await api.updateBenchmark(found.benchmark.id, { testCaseIds: ids });
    return { outcome: 'reused', benchmark: updated, refreshed: true };
  }

  const created = await api.createBenchmark({
    name: identity.name,
    description: identity.description,
    testCaseIds: ids,
  });
  return { outcome: 'created', benchmark: created };
}
