/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for checkpoint-resume eligibility (computeResumableTestCaseIds).
 *
 * Resume semantics (RedKite-inspired): a test case is resumable iff its
 * result has NO persisted report. Anything with a reportId is a checkpoint
 * and must be preserved.
 */

import {
  computeResumableTestCaseIds,
  runLivenessAgeMs,
  runStaleAfterMs,
  buildBenchmarkRunProjection,
  linkCompletedRunToBenchmark,
} from '@/server/routes/storage/evaluationRuns';

const snap = (id: string) => ({ id, version: 1, name: id });

describe('computeResumableTestCaseIds', () => {
  it('returns every snapshot id when there are no results yet', () => {
    const run = { testCaseSnapshots: [snap('a'), snap('b')], results: {} } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['a', 'b']);
  });

  it('skips test cases whose result has a persisted report', () => {
    const run = {
      testCaseSnapshots: [snap('a'), snap('b'), snap('c')],
      results: {
        a: { reportId: 'report-a', status: 'completed' },
        b: { reportId: '', status: 'pending' },
        // c has no entry at all (crashed before it was scheduled)
      },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['b', 'c']);
  });

  it('treats failed-WITH-report as done, failed-WITHOUT-report as resumable', () => {
    const run = {
      testCaseSnapshots: [snap('a'), snap('b')],
      results: {
        // Genuine agent failure — report persisted, verdict recorded. Keep it.
        a: { reportId: 'report-a', status: 'failed', error: 'agent errored' },
        // Interrupted by crash/recovery — no report. Re-run it.
        b: { reportId: '', status: 'failed', error: 'server died' },
      },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['b']);
  });

  it('treats interrupted running entries (no report) as resumable', () => {
    const run = {
      testCaseSnapshots: [snap('a')],
      results: { a: { reportId: '', status: 'running' } },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual(['a']);
  });

  it('returns empty when every test case has a report (nothing to resume)', () => {
    const run = {
      testCaseSnapshots: [snap('a'), snap('b')],
      results: {
        a: { reportId: 'r-a', status: 'completed' },
        b: { reportId: 'r-b', status: 'failed' },
      },
    } as any;
    expect(computeResumableTestCaseIds(run)).toEqual([]);
  });

  it('handles missing snapshots/results defensively', () => {
    expect(computeResumableTestCaseIds({} as any)).toEqual([]);
    expect(computeResumableTestCaseIds({ testCaseSnapshots: [], results: undefined } as any)).toEqual([]);
  });
});

describe('run liveness (shared-cluster safety)', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');

  it('uses the most recent of heartbeat/resumed/created', () => {
    const run = {
      createdAt: new Date(T0 - 3_600_000).toISOString(),
      resumedAt: new Date(T0 - 600_000).toISOString(),
      heartbeatAt: new Date(T0 - 30_000).toISOString(),
    };
    expect(runLivenessAgeMs(run, T0)).toBe(30_000);
    expect(runLivenessAgeMs({ ...run, heartbeatAt: undefined }, T0)).toBe(600_000);
    expect(runLivenessAgeMs({ createdAt: run.createdAt }, T0)).toBe(3_600_000);
  });

  it('a fresh resume claim counts as liveness even when the dead server\'s heartbeat is stale (codex #1)', () => {
    // After claiming an orphan, resumedAt is NEWER than the dead server's
    // last heartbeatAt. A priority order (heartbeat first) would leave the
    // just-resumed run looking stale — max() must win here.
    const run = {
      createdAt: new Date(T0 - 7_200_000).toISOString(),
      heartbeatAt: new Date(T0 - 3_600_000).toISOString(), // dead server, 1h ago
      resumedAt: new Date(T0 - 1_000).toISOString(),       // claimed 1s ago
    };
    expect(runLivenessAgeMs(run, T0)).toBe(1_000);
  });

  it('treats missing/invalid timestamps as infinitely stale', () => {
    expect(runLivenessAgeMs({} as any, T0)).toBe(Infinity);
    expect(runLivenessAgeMs({ createdAt: 'not-a-date' } as any, T0)).toBe(Infinity);
  });

  it('stale threshold defaults to 1h and honors EVALUATION_RUN_STALE_AFTER_MS', () => {
    const prev = process.env.EVALUATION_RUN_STALE_AFTER_MS;
    delete process.env.EVALUATION_RUN_STALE_AFTER_MS;
    expect(runStaleAfterMs()).toBe(3_600_000);
    process.env.EVALUATION_RUN_STALE_AFTER_MS = '5000';
    expect(runStaleAfterMs()).toBe(5000);
    process.env.EVALUATION_RUN_STALE_AFTER_MS = '-1';
    expect(runStaleAfterMs()).toBe(3_600_000);
    if (prev === undefined) delete process.env.EVALUATION_RUN_STALE_AFTER_MS;
    else process.env.EVALUATION_RUN_STALE_AFTER_MS = prev;
  });
});

/**
 * Unit tests for the benchmark.runs linking helpers (the "resumed run
 * missing from benchmark.runs" bug — hit twice in production).
 *
 * `buildBenchmarkRunProjection` is the pure projection also used by the
 * create route's success path; `linkCompletedRunToBenchmark` must upsert by
 * run id so a run that was already linked (e.g. by the create route, or by
 * an earlier resume) never ends up duplicated in `benchmark.runs`.
 */
describe('buildBenchmarkRunProjection', () => {
  const baseRun = {
    id: 'eval-run-1',
    name: 'My Run',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'demo-model',
    results: { tc1: { reportId: 'r1', status: 'completed' } },
    stats: { total: 1, passed: 1, failed: 0 },
    testCaseSnapshots: [{ id: 'tc1', version: 1, name: 'tc1' }],
  } as any;

  it('projects the required BenchmarkRun fields plus completedAt', () => {
    const projection = buildBenchmarkRunProjection(baseRun, '2026-01-01T00:05:00.000Z');
    expect(projection).toMatchObject({
      id: 'eval-run-1',
      name: 'My Run',
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      status: 'completed',
      agentKey: 'demo',
      modelId: 'demo-model',
      results: baseRun.results,
      stats: baseRun.stats,
      testCaseSnapshots: baseRun.testCaseSnapshots,
    });
  });

  it('omits optional fields the run does not have (no undefined keys leaking in)', () => {
    const projection = buildBenchmarkRunProjection(baseRun, '2026-01-01T00:05:00.000Z') as any;
    expect('description' in projection).toBe(false);
    expect('evaluatorId' in projection).toBe(false);
    expect('headers' in projection).toBe(false);
    expect('concurrency' in projection).toBe(false);
  });

  it('includes optional fields when present on the run', () => {
    const projection = buildBenchmarkRunProjection(
      { ...baseRun, description: 'desc', evaluatorId: 'ev-1', headers: { X: '1' }, concurrency: 3 },
      '2026-01-01T00:05:00.000Z'
    ) as any;
    expect(projection.description).toBe('desc');
    expect(projection.evaluatorId).toBe('ev-1');
    expect(projection.headers).toEqual({ X: '1' });
    expect(projection.concurrency).toBe(3);
  });
});

describe('linkCompletedRunToBenchmark', () => {
  const benchmarkRun = (id: string) => ({
    id,
    name: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    agentKey: 'demo',
    modelId: 'demo-model',
    results: {},
  } as any);

  it('adds a new run via addRun when the benchmark has no entry for this run id', async () => {
    const storage = {
      benchmarks: {
        getById: jest.fn().mockResolvedValue({ id: 'bm-1', runs: [] }),
        addRun: jest.fn().mockResolvedValue(true),
        updateRun: jest.fn(),
      },
    } as any;

    await linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1'));

    expect(storage.benchmarks.addRun).toHaveBeenCalledWith('bm-1', expect.objectContaining({ id: 'run-1' }));
    expect(storage.benchmarks.updateRun).not.toHaveBeenCalled();
  });

  it('upserts via updateRun (not addRun) when the run id is already linked — no duplicate entries', async () => {
    const storage = {
      benchmarks: {
        getById: jest.fn().mockResolvedValue({ id: 'bm-1', runs: [{ id: 'run-1', name: 'stale' }] }),
        addRun: jest.fn(),
        updateRun: jest.fn().mockResolvedValue(true),
      },
    } as any;

    await linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1'));

    expect(storage.benchmarks.updateRun).toHaveBeenCalledWith('bm-1', 'run-1', expect.objectContaining({ id: 'run-1' }));
    expect(storage.benchmarks.addRun).not.toHaveBeenCalled();
  });

  it('is a no-op regression guard: repeated calls with the same run id never grow the entry count (real array semantics)', async () => {
    // Mimic the real file/opensearch adapters' semantics against a plain array.
    const benchmark = { id: 'bm-1', runs: [] as any[] };
    const storage = {
      benchmarks: {
        getById: jest.fn().mockImplementation(async () => benchmark),
        addRun: jest.fn().mockImplementation(async (_id: string, run: any) => {
          benchmark.runs.push(run);
          return true;
        }),
        updateRun: jest.fn().mockImplementation(async (_id: string, runId: string, updates: any) => {
          const idx = benchmark.runs.findIndex((r) => r.id === runId);
          if (idx === -1) return false;
          benchmark.runs[idx] = { ...benchmark.runs[idx], ...updates };
          return true;
        }),
      },
    } as any;

    await linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1'));
    await linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1'));
    await linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1'));

    expect(benchmark.runs).toHaveLength(1);
    expect(benchmark.runs.filter((r) => r.id === 'run-1')).toHaveLength(1);
  });

  it('throws when the benchmark does not exist (surfaces as a 500 up the route, matching the create-route behavior)', async () => {
    const storage = {
      benchmarks: {
        getById: jest.fn().mockResolvedValue(null),
        addRun: jest.fn(),
        updateRun: jest.fn(),
      },
    } as any;

    await expect(linkCompletedRunToBenchmark(storage, 'missing-bm', benchmarkRun('run-1'))).rejects.toThrow(
      'Benchmark not found while linking completed run: missing-bm'
    );
  });

  it('throws when addRun reports failure (e.g. a race where the benchmark was deleted mid-request)', async () => {
    const storage = {
      benchmarks: {
        getById: jest.fn().mockResolvedValue({ id: 'bm-1', runs: [] }),
        addRun: jest.fn().mockResolvedValue(false),
        updateRun: jest.fn(),
      },
    } as any;

    await expect(linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1'))).rejects.toThrow(
      'Failed to link completed run to benchmark: bm-1'
    );
  });

  it(
    'KNOWN LIMITATION (codex_review): read-then-branch-then-write is not atomic — two ' +
      'truly concurrent links of the SAME run id can both observe "not yet linked" and both ' +
      'addRun, producing a duplicate this helper cannot repair on its own (a later updateRun ' +
      'only replaces ONE matching entry). Documented, not silently "fixed" by this PR — closing ' +
      'it needs an atomic upsert-by-id primitive in the storage adapters, tracked as a follow-up.',
    async () => {
      const benchmark = { id: 'bm-1', runs: [] as any[] };
      // Simulate two callers racing: both read the SAME pre-write snapshot
      // (an unresolved getById lets both branches decide "not linked yet")
      // before either write lands.
      let readCount = 0;
      const reads: Array<() => void> = [];
      const storage = {
        benchmarks: {
          getById: jest.fn().mockImplementation(
            () =>
              new Promise((resolve) => {
                readCount += 1;
                reads.push(() => resolve({ ...benchmark, runs: [...benchmark.runs] }));
                // Release both reads together once the second caller has
                // also reached this point.
                if (readCount === 2) reads.forEach((release) => release());
              })
          ),
          addRun: jest.fn().mockImplementation(async (_id: string, run: any) => {
            benchmark.runs.push(run);
            return true;
          }),
          updateRun: jest.fn(),
        },
      } as any;

      await Promise.all([
        linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1')),
        linkCompletedRunToBenchmark(storage, 'bm-1', benchmarkRun('run-1')),
      ]);

      // Both calls saw an empty `runs` array and both chose addRun — the
      // race this test documents. If storage ever gains an atomic
      // upsert-by-id primitive and this helper is switched to use it, this
      // assertion should be tightened to `toHaveLength(1)`.
      expect(benchmark.runs.filter((r) => r.id === 'run-1')).toHaveLength(2);
    }
  );
});
