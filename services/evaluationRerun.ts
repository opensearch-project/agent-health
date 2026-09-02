/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-only half of "re-run an evaluation run": the storage-aware check
 * that a source run's referenced benchmark(s)/version(s) still exist. Pure
 * naming/config-duplication logic lives in lib/evaluationRerun.ts (shared
 * with the UI's confirm-dialog preview); this file adds the one thing that
 * needs the storage module.
 */

import type { EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

export { computeRerunName, buildRerunConfig, applyRerunOverrides } from '@/lib/evaluationRerun';
export type {
  RerunConfig,
  BuildRerunConfigResult,
  BuildRerunConfigError,
  RerunOverrides,
  ApplyRerunOverridesResult,
} from '@/lib/evaluationRerun';

/**
 * Collect every (benchmarkId, benchmarkVersion) pair a source run references
 * — from `sources` entries of type `'benchmark'`, plus the run's own
 * top-level `benchmarkId`/`benchmarkVersion` association if not already
 * covered by an identical (same id AND same version) source entry.
 *
 * Dedup key is the (id, version) PAIR, not just benchmarkId: a run whose
 * `sources[]` pins one version but whose top-level association records a
 * *different* version of the same benchmark (a real possibility on
 * inconsistent/legacy documents — the two fields are written independently)
 * must have BOTH versions checked. Deduping on benchmarkId alone (an earlier
 * version of this function did) silently dropped the top-level check
 * whenever any source referenced the same benchmark, regardless of which
 * version it pinned — caught by codex_review.
 */
function collectBenchmarkRefs(
  sourceRun: EvaluationRun
): Array<{ benchmarkId: string; benchmarkVersion?: number }> {
  const refs: Array<{ benchmarkId: string; benchmarkVersion?: number }> = [];
  const seenKeys = new Set<string>();
  const pushUnique = (benchmarkId: string, benchmarkVersion?: number) => {
    const key = `${benchmarkId}\u0000${benchmarkVersion ?? ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    refs.push({ benchmarkId, benchmarkVersion });
  };

  for (const src of sourceRun.sources || []) {
    if (src.type === 'benchmark') {
      pushUnique(src.benchmarkId, src.benchmarkVersion);
    }
  }
  if (sourceRun.benchmarkId) {
    pushUnique(sourceRun.benchmarkId, sourceRun.benchmarkVersion);
  }
  return refs;
}

/**
 * Verify every benchmark (and, if pinned, benchmark version) a source run
 * references still exists. Returns a clear, user-facing error message when
 * it doesn't (caller maps this to HTTP 409 — the run's config is no longer
 * satisfiable, not a client input error), or `null` when everything checks
 * out (including the common case: no benchmark source at all).
 *
 * Only fetches each distinct benchmarkId once even if referenced from
 * multiple places (a `sources` entry AND the top-level association, or
 * multiple `sources` entries pointing at the same benchmark).
 *
 * IMPORTANT CAVEAT (pre-existing, not introduced by rerun): this only
 * checks that a pinned `benchmarkVersion` still EXISTS. It does not — cannot
 * — make the actual re-run execute against that historical version's
 * test-case list: `resolveTestCaseSources()` (services/sourceResolver.ts)
 * always resolves a `{type:'benchmark'}` source against the benchmark's
 * *current* `testCaseIds`, ignoring `benchmarkVersion` entirely. That's true
 * for every run creation path today (`POST /api/storage/evaluation-runs`
 * has the identical behavior), not something this endpoint changed — but it
 * means passing this check does not guarantee the rerun will cover the same
 * test cases the pinned version did if the benchmark's current version has
 * since diverged. Fixing that would mean threading `benchmarkVersion`
 * through source resolution for every caller, which is out of scope here;
 * flagging so it isn't mistaken for "safe" once this check passes.
 */
export async function checkBenchmarkSourcesStillExist(
  sourceRun: EvaluationRun,
  storage: Pick<IStorageModule, 'benchmarks'>
): Promise<string | null> {
  const refs = collectBenchmarkRefs(sourceRun);
  if (refs.length === 0) return null;

  const benchmarkCache = new Map<string, Awaited<ReturnType<IStorageModule['benchmarks']['getById']>>>();

  for (const { benchmarkId, benchmarkVersion } of refs) {
    if (!benchmarkCache.has(benchmarkId)) {
      benchmarkCache.set(benchmarkId, await storage.benchmarks.getById(benchmarkId));
    }
    const benchmark = benchmarkCache.get(benchmarkId);

    if (!benchmark) {
      return `Source benchmark "${benchmarkId}" no longer exists; cannot re-run.`;
    }

    if (benchmarkVersion != null && !(benchmark.versions || []).some(v => v.version === benchmarkVersion)) {
      return `Benchmark version ${benchmarkVersion} of "${benchmark.name}" no longer exists ` +
        `(current version: ${benchmark.currentVersion}); cannot re-run.`;
    }
  }

  return null;
}
