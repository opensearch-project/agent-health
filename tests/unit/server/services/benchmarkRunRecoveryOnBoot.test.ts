/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  recoverOrphanBenchmarkRuns,
  recoverOrphanBenchmarkRunsSafely,
} from '@/server/services/benchmarkRunRecoveryOnBoot';
import * as benchmarksRoute from '@/server/routes/storage/benchmarks';
import * as statsModule from '@/server/services/benchmarkRunStats';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/server/routes/storage/benchmarks', () => ({
  isRunActiveInThisProcess: jest.fn().mockReturnValue(false),
}));

jest.mock('@/server/services/benchmarkRunStats', () => ({
  refreshBenchmarkRunStatsByRunId: jest.fn().mockResolvedValue(undefined),
}));

const mockIsActive = benchmarksRoute.isRunActiveInThisProcess as jest.MockedFunction<
  typeof benchmarksRoute.isRunActiveInThisProcess
>;
const mockRefresh = statsModule.refreshBenchmarkRunStatsByRunId as jest.MockedFunction<
  typeof statsModule.refreshBenchmarkRunStatsByRunId
>;

interface MockOpts {
  benchmarks: any[];
  getAllThrows?: boolean;
  updateThrowsFor?: Set<string>;
}

function mockStorage(opts: MockOpts) {
  const updateCalls: Array<{ id: string; updates: any }> = [];
  const benchmarks = JSON.parse(JSON.stringify(opts.benchmarks)); // deep clone
  const storage: Partial<IStorageModule> = {
    benchmarks: {
      getAll: jest.fn().mockImplementation(async ({ from = 0, size = 100 }: any = {}) => {
        if (opts.getAllThrows) throw new Error('cluster down');
        const slice = benchmarks.slice(from, from + size);
        return { items: slice, total: benchmarks.length };
      }),
      update: jest.fn().mockImplementation(async (id: string, updates: any) => {
        if (opts.updateThrowsFor?.has(id)) throw new Error(`update ${id} failed`);
        updateCalls.push({ id, updates });
        const idx = benchmarks.findIndex((b: any) => b.id === id);
        if (idx >= 0) benchmarks[idx] = { ...benchmarks[idx], ...updates };
        return benchmarks[idx];
      }),
      updateRun: jest.fn(),
    } as any,
  };
  return { storage: storage as IStorageModule, updateCalls };
}

const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // 4h ago
const recently = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5m ago

function bm(overrides: any) {
  return { id: 'bm-1', name: 'B', testCaseIds: [], runs: [], ...overrides };
}

function run(overrides: any) {
  return {
    id: 'run-1',
    createdAt: longAgo,
    status: 'running',
    results: {},
    ...overrides,
  };
}

describe('recoverOrphanBenchmarkRuns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsActive.mockReturnValue(false);
    delete process.env.BENCHMARK_RUN_RECOVERY_DISABLED;
    delete process.env.BENCHMARK_RUN_STALE_AFTER_MS;
    delete process.env.BENCHMARK_RUN_RECOVERY_PAGE_SIZE;
  });

  it('marks unstarted (pending, no reportId) results as failed and the run as failed', async () => {
    const benchmarks = [bm({
      runs: [run({
        results: {
          tcA: { reportId: 'r1', status: 'completed' },          // keep
          tcB: { reportId: '', status: 'pending' },              // -> failed
          tcC: { reportId: '', status: 'running' },              // -> failed
          tcD: { reportId: 'r2', status: 'completed' },          // keep
        },
      })],
    })];
    const { storage, updateCalls } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.staleRuns).toBe(1);
    expect(stat.runsMarkedFailed).toBe(1);
    expect(stat.resultsMarkedFailed).toBe(2);
    expect(stat.errors).toBe(0);

    expect(updateCalls).toHaveLength(1);
    const savedRun = updateCalls[0].updates.runs[0];
    expect(savedRun.status).toBe('failed');
    expect(savedRun.results.tcA.status).toBe('completed');
    expect(savedRun.results.tcB.status).toBe('failed');
    expect(savedRun.results.tcB.error).toMatch(/boot recovery/);
    expect(savedRun.results.tcC.status).toBe('failed');
    expect(savedRun.results.tcD.status).toBe('completed');

    expect(mockRefresh).toHaveBeenCalledWith(storage, 'bm-1', 'run-1');
  });

  it('skips runs that are not running', async () => {
    const benchmarks = [bm({
      runs: [
        run({ id: 'run-1', status: 'completed' }),
        run({ id: 'run-2', status: 'failed' }),
        run({ id: 'run-3', status: 'cancelled' }),
      ],
    })];
    const { storage, updateCalls } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('skips running runs that are still recent', async () => {
    const benchmarks = [bm({
      runs: [run({ createdAt: recently, results: { tcA: { reportId: '', status: 'pending' } } })],
    })];
    const { storage, updateCalls } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('skips runs that are still active in the current process', async () => {
    mockIsActive.mockImplementation((id) => id === 'run-1');
    const benchmarks = [bm({ runs: [run({ id: 'run-1' })] })];
    const { storage, updateCalls } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('preserves completed/failed results during recovery', async () => {
    const benchmarks = [bm({
      runs: [run({
        results: {
          tcA: { reportId: 'r1', status: 'completed' },
          tcB: { reportId: 'r2', status: 'failed', error: 'agent crashed' },
          tcC: { reportId: '', status: 'pending' },
        },
      })],
    })];
    const { storage, updateCalls } = mockStorage({ benchmarks });

    await recoverOrphanBenchmarkRuns(storage);

    const savedRun = updateCalls[0].updates.runs[0];
    expect(savedRun.results.tcA).toEqual({ reportId: 'r1', status: 'completed' });
    expect(savedRun.results.tcB).toEqual({ reportId: 'r2', status: 'failed', error: 'agent crashed' });
    expect(savedRun.results.tcC.status).toBe('failed');
  });

  it('honours BENCHMARK_RUN_STALE_AFTER_MS env override', async () => {
    process.env.BENCHMARK_RUN_STALE_AFTER_MS = '60'; // 60ms — everything fresh becomes stale
    const benchmarks = [bm({
      runs: [run({ createdAt: new Date(Date.now() - 10_000).toISOString(), results: { a: { reportId: '', status: 'pending' } } })],
    })];
    const { storage } = mockStorage({ benchmarks });
    const stat = await recoverOrphanBenchmarkRuns(storage);
    expect(stat.staleRuns).toBe(1);
    expect(stat.resultsMarkedFailed).toBe(1);
  });

  it('continues paging until short page is returned', async () => {
    process.env.BENCHMARK_RUN_RECOVERY_PAGE_SIZE = '2';
    const benchmarks = [
      bm({ id: 'bm-1', runs: [run({ id: 'run-1', results: { a: { reportId: '', status: 'pending' } } })] }),
      bm({ id: 'bm-2', runs: [run({ id: 'run-2', results: { a: { reportId: '', status: 'pending' } } })] }),
      bm({ id: 'bm-3', runs: [run({ id: 'run-3', results: { a: { reportId: '', status: 'pending' } } })] }),
    ];
    const { storage } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.scannedBenchmarks).toBe(3);
    expect(stat.staleRuns).toBe(3);
    expect((storage.benchmarks.getAll as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('counts errors when getAll fails and stops paging', async () => {
    const { storage } = mockStorage({ benchmarks: [], getAllThrows: true });
    const stat = await recoverOrphanBenchmarkRuns(storage);
    expect(stat.errors).toBe(1);
    expect(stat.scannedBenchmarks).toBe(0);
  });

  it('counts errors but continues when a benchmark update fails', async () => {
    const benchmarks = [
      bm({ id: 'bm-1', runs: [run({ id: 'run-1', results: { a: { reportId: '', status: 'pending' } } })] }),
      bm({ id: 'bm-2', runs: [run({ id: 'run-2', results: { b: { reportId: '', status: 'pending' } } })] }),
    ];
    const { storage } = mockStorage({ benchmarks, updateThrowsFor: new Set(['bm-1']) });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.errors).toBe(1);
    expect(stat.staleRuns).toBe(2);
    expect(stat.runsMarkedFailed).toBe(2);     // both attempted
    expect(mockRefresh).toHaveBeenCalledTimes(1); // only bm-2 reached the refresh step
    expect(mockRefresh).toHaveBeenCalledWith(storage, 'bm-2', 'run-2');
  });

  it('counts errors when refresh fails', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('refresh failed'));
    const benchmarks = [bm({
      runs: [run({ results: { a: { reportId: '', status: 'pending' } } })],
    })];
    const { storage } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);
    expect(stat.errors).toBe(1);
    expect(stat.runsMarkedFailed).toBe(1);
  });

  it('BENCHMARK_RUN_RECOVERY_DISABLED=1 short-circuits', async () => {
    process.env.BENCHMARK_RUN_RECOVERY_DISABLED = '1';
    const benchmarks = [bm({ runs: [run({ results: { a: { reportId: '', status: 'pending' } } })] })];
    const { storage, updateCalls } = mockStorage({ benchmarks });

    const stat = await recoverOrphanBenchmarkRuns(storage);

    expect(stat.scannedBenchmarks).toBe(0);
    expect(stat.staleRuns).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(storage.benchmarks.getAll).not.toHaveBeenCalled();
  });
});

describe('recoverOrphanBenchmarkRunsSafely', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never throws even when storage explodes', async () => {
    const storage = {
      benchmarks: { getAll: jest.fn().mockRejectedValue(new Error('boom')) } as any,
    } as unknown as IStorageModule;

    await expect(recoverOrphanBenchmarkRunsSafely(storage)).resolves.toBeUndefined();
  });

  it('logs a summary line', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const benchmarks = [bm({ runs: [run({ results: { a: { reportId: '', status: 'pending' } } })] })];
    const { storage } = mockStorage({ benchmarks });

    await recoverOrphanBenchmarkRunsSafely(storage);
    const summary = log.mock.calls.map(c => c.join(' ')).find(line => line.includes('[benchmarkRunRecovery]'));
    expect(summary).toBeDefined();
    log.mockRestore();
  });
});
