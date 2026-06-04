/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  refreshBenchmarkRunStatsByReportId,
  refreshBenchmarkRunStatsByRunId,
} from '@/server/services/benchmarkRunStats';
import type { IStorageModule } from '@/server/adapters/types';

interface MockOpts {
  benchmark: any;
  reports: Record<string, any>;
}

function mockStorage(opts: MockOpts) {
  const updateRunCalls: Array<{ benchmarkId: string; runId: string; updates: any }> = [];
  const storage: Partial<IStorageModule> = {
    benchmarks: {
      getById: jest.fn().mockResolvedValue(opts.benchmark),
      updateRun: jest.fn().mockImplementation(async (benchmarkId, runId, updates) => {
        updateRunCalls.push({ benchmarkId, runId, updates });
        return true;
      }),
    } as any,
    runs: {
      getById: jest.fn().mockImplementation(async (id: string) => opts.reports[id] ?? null),
    } as any,
  };
  return { storage: storage as IStorageModule, updateRunCalls };
}

describe('refreshBenchmarkRunStatsByReportId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('locates run by reportId, recomputes stats, and persists', async () => {
    const benchmark = {
      id: 'bm-1',
      runs: [
        { id: 'run-1', results: { tcA: { reportId: 'r1' }, tcB: { reportId: 'r2' } } },
        { id: 'run-2', results: { tcC: { reportId: 'r3' } } },
      ],
    };
    const reports = {
      r1: { passFailStatus: 'passed' },
      r2: { passFailStatus: 'failed' },
      r3: { passFailStatus: 'passed' },
    };
    const { storage, updateRunCalls } = mockStorage({ benchmark, reports });
    await refreshBenchmarkRunStatsByReportId(storage, 'bm-1', 'r2');

    expect(updateRunCalls).toHaveLength(1);
    expect(updateRunCalls[0].runId).toBe('run-1');
    expect(updateRunCalls[0].updates.stats).toEqual({ passed: 1, failed: 1, pending: 0, errored: 0, total: 2 });
  });

  it('counts pending/calculating reports as pending', async () => {
    const benchmark = {
      id: 'bm-1',
      runs: [{ id: 'run-1', results: {
        a: { reportId: 'r1' }, b: { reportId: 'r2' }, c: { reportId: 'r3' }, d: { reportId: 'r4' },
      } }],
    };
    const reports = {
      r1: { metricsStatus: 'pending', passFailStatus: 'passed' },
      r2: { metricsStatus: 'calculating' },
      r3: { metricsStatus: 'ready', passFailStatus: 'passed' },
      r4: { metricsStatus: 'ready', passFailStatus: 'failed' },
    };
    const { storage, updateRunCalls } = mockStorage({ benchmark, reports });

    await refreshBenchmarkRunStatsByReportId(storage, 'bm-1', 'r1');

    expect(updateRunCalls[0].updates.stats).toEqual({ passed: 1, failed: 1, pending: 2, errored: 0, total: 4 });
  });

  it('counts failed-but-no-report results as failed (boot-recovery path)', async () => {
    const benchmark = {
      id: 'bm-1',
      runs: [{ id: 'run-1', results: {
        a: { reportId: 'r1' },
        b: { reportId: '', status: 'failed' },   // boot-recovered
        c: { reportId: '', status: 'pending' },  // never started
      } }],
    };
    const reports = { r1: { passFailStatus: 'passed' } };
    const { storage, updateRunCalls } = mockStorage({ benchmark, reports });

    await refreshBenchmarkRunStatsByReportId(storage, 'bm-1', 'r1');

    expect(updateRunCalls[0].updates.stats).toEqual({ passed: 1, failed: 1, pending: 1, errored: 0, total: 3 });
  });

  it('is a no-op when benchmark not found', async () => {
    const { storage, updateRunCalls } = mockStorage({ benchmark: null, reports: {} });
    await refreshBenchmarkRunStatsByReportId(storage, 'bm-1', 'r1');
    expect(updateRunCalls).toHaveLength(0);
  });

  it('is a no-op when no run owns the report id', async () => {
    const benchmark = { id: 'bm-1', runs: [{ id: 'run-1', results: { a: { reportId: 'rZ' } } }] };
    const { storage, updateRunCalls } = mockStorage({ benchmark, reports: {} });
    await refreshBenchmarkRunStatsByReportId(storage, 'bm-1', 'r1');
    expect(updateRunCalls).toHaveLength(0);
  });

  it('handles getById failures by counting that report as pending', async () => {
    const benchmark = { id: 'bm-1', runs: [{ id: 'run-1', results: { a: { reportId: 'r1' } } }] };
    const storage = mockStorage({ benchmark, reports: {} }).storage;
    (storage.runs.getById as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await refreshBenchmarkRunStatsByReportId(storage, 'bm-1', 'r1');
    expect(storage.benchmarks.updateRun).toHaveBeenCalledWith('bm-1', 'run-1', expect.objectContaining({
      stats: { passed: 0, failed: 0, pending: 1, errored: 0, total: 1 },
    }));
  });
});

describe('refreshBenchmarkRunStatsByRunId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('locates run by runId and persists fresh stats', async () => {
    const benchmark = {
      id: 'bm-1',
      runs: [
        { id: 'run-1', results: { a: { reportId: 'r1' } } },
        { id: 'run-2', results: {
          a: { reportId: 'r2' },
          b: { reportId: '', status: 'failed' },
        } },
      ],
    };
    const reports = { r1: { passFailStatus: 'passed' }, r2: { passFailStatus: 'passed' } };
    const { storage, updateRunCalls } = mockStorage({ benchmark, reports });

    await refreshBenchmarkRunStatsByRunId(storage, 'bm-1', 'run-2');

    expect(updateRunCalls).toHaveLength(1);
    expect(updateRunCalls[0].runId).toBe('run-2');
    expect(updateRunCalls[0].updates.stats).toEqual({ passed: 1, failed: 1, pending: 0, errored: 0, total: 2 });
  });

  it('is a no-op when runId not found', async () => {
    const benchmark = { id: 'bm-1', runs: [{ id: 'run-1', results: {} }] };
    const { storage, updateRunCalls } = mockStorage({ benchmark, reports: {} });
    await refreshBenchmarkRunStatsByRunId(storage, 'bm-1', 'run-X');
    expect(updateRunCalls).toHaveLength(0);
  });

  it('is a no-op when benchmark not found', async () => {
    const { storage, updateRunCalls } = mockStorage({ benchmark: null, reports: {} });
    await refreshBenchmarkRunStatsByRunId(storage, 'bm-1', 'run-1');
    expect(updateRunCalls).toHaveLength(0);
  });
});
