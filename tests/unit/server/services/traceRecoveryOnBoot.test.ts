/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { resumePendingTracePolls, resumePendingTracePollsSafely } from '@/server/services/traceRecoveryOnBoot';
import * as benchmarkRunner from '@/services/benchmarkRunner';
import type { IStorageModule } from '@/server/adapters/types';
import type { EvaluationReport, TestCase } from '@/types';

// Spy on the trace polling restart \u2014 we don't want a real polling loop
// kicking off during tests.
jest.mock('@/services/benchmarkRunner', () => {
  const actual = jest.requireActual('@/services/benchmarkRunner');
  return {
    ...actual,
    startTracePollingForReportWithModule: jest.fn().mockResolvedValue(undefined),
  };
});

const startPollingMock = benchmarkRunner.startTracePollingForReportWithModule as jest.MockedFunction<
  typeof benchmarkRunner.startTracePollingForReportWithModule
>;

function makeReport(overrides: Partial<EvaluationReport>): EvaluationReport {
  return {
    id: 'report-1',
    timestamp: new Date().toISOString(),
    testCaseId: 'tc-1',
    agentName: 'demo',
    modelName: 'claude',
    status: 'completed',
    trajectory: [],
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 } as any,
    llmJudgeReasoning: '',
    runId: 'run-abc',
    metricsStatus: 'pending',
    ...overrides,
  } as EvaluationReport;
}

function makeTc(id = 'tc-1'): TestCase {
  return {
    id,
    name: 'Test Case',
    description: '',
    labels: [],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '',
    updatedAt: '',
    initialPrompt: 'q',
    expectedOutcomes: { rootCauses: [], requiredFacts: [], conclusions: [] } as any,
  } as unknown as TestCase;
}

interface MockStorageOpts {
  reports: EvaluationReport[];
  testCases?: Record<string, TestCase | null>;
  // If true, getAll will throw
  getAllThrows?: boolean;
  // If set, update will throw for these ids
  updateThrowsFor?: Set<string>;
  testCaseGetThrowsFor?: Set<string>;
}

function mockStorage(opts: MockStorageOpts) {
  const updateCalls: Array<{ id: string; updates: any }> = [];
  const reports = [...opts.reports];

  const storage: Partial<IStorageModule> = {
    runs: {
      getAll: jest.fn().mockImplementation(async ({ from = 0, size = 100 }: { from?: number; size?: number } = {}) => {
        if (opts.getAllThrows) throw new Error('cluster down');
        const slice = reports.slice(from, from + size);
        return { items: slice, total: reports.length };
      }),
      update: jest.fn().mockImplementation(async (id: string, updates: any) => {
        if (opts.updateThrowsFor?.has(id)) throw new Error(`update ${id} failed`);
        updateCalls.push({ id, updates });
        const idx = reports.findIndex(r => r.id === id);
        if (idx >= 0) reports[idx] = { ...reports[idx], ...updates } as EvaluationReport;
        return reports[idx];
      }),
    } as any,
    testCases: {
      getById: jest.fn().mockImplementation(async (id: string) => {
        if (opts.testCaseGetThrowsFor?.has(id)) throw new Error(`load ${id} failed`);
        if (!opts.testCases) return makeTc(id);
        return opts.testCases[id] ?? null;
      }),
    } as any,
  };

  return { storage: storage as IStorageModule, updateCalls };
}

describe('resumePendingTracePolls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRACE_RECOVERY_DISABLED;
    delete process.env.TRACE_RECOVERY_MAX_AGE_MS;
    delete process.env.TRACE_RECOVERY_PAGE_SIZE;
    delete process.env.TRACE_RECOVERY_MAX_PAGES;
  });

  it('resumes polling for recent pending reports with a runId', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1' });
    const r2 = makeReport({ id: 'r2', metricsStatus: 'pending', runId: 'run-2' });
    const { storage } = mockStorage({ reports: [r1, r2] });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.scanned).toBe(2);
    expect(stat.pendingFound).toBe(2);
    expect(stat.resumed).toBe(2);
    expect(stat.failedOut).toBe(0);
    expect(stat.errors).toBe(0);
    expect(startPollingMock).toHaveBeenCalledTimes(2);
    expect(startPollingMock.mock.calls[0][0].id).toBe('r1');
    expect(startPollingMock.mock.calls[1][0].id).toBe('r2');
  });

  it('also resumes reports stuck in calculating', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'calculating', runId: 'run-1' });
    const { storage } = mockStorage({ reports: [r1] });
    const stat = await resumePendingTracePolls(storage);
    expect(stat.pendingFound).toBe(1);
    expect(stat.resumed).toBe(1);
  });

  it('ignores reports that already have terminal metricsStatus', async () => {
    const reports = [
      makeReport({ id: 'r1', metricsStatus: 'ready', runId: 'run-1' }),
      makeReport({ id: 'r2', metricsStatus: 'error', runId: 'run-2' }),
      makeReport({ id: 'r3', metricsStatus: undefined, runId: 'run-3' }),
    ];
    const { storage, updateCalls } = mockStorage({ reports });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.pendingFound).toBe(0);
    expect(stat.resumed).toBe(0);
    expect(stat.failedOut).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(startPollingMock).not.toHaveBeenCalled();
  });

  it('marks pending reports without a runId as error (cannot resume)', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: undefined });
    const { storage, updateCalls } = mockStorage({ reports: [r1] });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.pendingFound).toBe(1);
    expect(stat.resumed).toBe(0);
    expect(stat.failedOut).toBe(1);
    expect(startPollingMock).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('r1');
    expect(updateCalls[0].updates.metricsStatus).toBe('error');
    expect(updateCalls[0].updates.traceError).toMatch(/No runId/);
  });

  it('marks pending reports older than max age as error', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-old', timestamp: tenDaysAgo });
    const { storage, updateCalls } = mockStorage({ reports: [r1] });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.failedOut).toBe(1);
    expect(stat.resumed).toBe(0);
    expect(updateCalls[0].updates.metricsStatus).toBe('error');
    expect(updateCalls[0].updates.traceError).toMatch(/older than/);
    expect(startPollingMock).not.toHaveBeenCalled();
  });

  it('honours TRACE_RECOVERY_MAX_AGE_MS env override', async () => {
    process.env.TRACE_RECOVERY_MAX_AGE_MS = '1'; // 1 ms => everything is "too old"
    // Use an explicit past timestamp so age > 1ms regardless of execution speed.
    const past = new Date(Date.now() - 1000).toISOString();
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1', timestamp: past });
    const { storage, updateCalls } = mockStorage({ reports: [r1] });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.failedOut).toBe(1);
    expect(stat.resumed).toBe(0);
    expect(updateCalls[0].updates.metricsStatus).toBe('error');
  });

  it('marks reports as error when their test case no longer exists', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1', testCaseId: 'tc-gone' });
    const { storage, updateCalls } = mockStorage({
      reports: [r1],
      testCases: { 'tc-gone': null },
    });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.failedOut).toBe(1);
    expect(stat.resumed).toBe(0);
    expect(startPollingMock).not.toHaveBeenCalled();
    expect(updateCalls[0].updates.metricsStatus).toBe('error');
    expect(updateCalls[0].updates.traceError).toMatch(/Test case tc-gone no longer exists/);
  });

  it('caches test case lookups across reports sharing the same test case', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1', testCaseId: 'tc-shared' });
    const r2 = makeReport({ id: 'r2', metricsStatus: 'pending', runId: 'run-2', testCaseId: 'tc-shared' });
    const { storage } = mockStorage({ reports: [r1, r2] });

    await resumePendingTracePolls(storage);

    expect(storage.testCases.getById).toHaveBeenCalledTimes(1);
    expect(startPollingMock).toHaveBeenCalledTimes(2);
  });

  it('counts errors when storage update fails but keeps scanning', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: undefined }); // -> failedOut path
    const r2 = makeReport({ id: 'r2', metricsStatus: 'pending', runId: 'run-2' });   // -> resumed path
    const { storage } = mockStorage({ reports: [r1, r2], updateThrowsFor: new Set(['r1']) });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.errors).toBe(1);
    expect(stat.failedOut).toBe(0);   // update failed, so not counted as failedOut
    expect(stat.resumed).toBe(1);     // r2 still resumed
  });

  it('counts errors when getAll fails and stops paging', async () => {
    const { storage } = mockStorage({ reports: [], getAllThrows: true });
    const stat = await resumePendingTracePolls(storage);
    expect(stat.errors).toBe(1);
    expect(stat.scanned).toBe(0);
  });

  it('continues paging until short page is returned', async () => {
    process.env.TRACE_RECOVERY_PAGE_SIZE = '2';
    const reports = [
      makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1' }),
      makeReport({ id: 'r2', metricsStatus: 'pending', runId: 'run-2' }),
      makeReport({ id: 'r3', metricsStatus: 'pending', runId: 'run-3' }),
    ];
    const { storage } = mockStorage({ reports });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.scanned).toBe(3);
    expect(stat.resumed).toBe(3);
    expect((storage.runs.getAll as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('TRACE_RECOVERY_DISABLED=1 short-circuits and does nothing', async () => {
    process.env.TRACE_RECOVERY_DISABLED = '1';
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1' });
    const { storage, updateCalls } = mockStorage({ reports: [r1] });

    const stat = await resumePendingTracePolls(storage);

    expect(stat.scanned).toBe(0);
    expect(stat.pendingFound).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(startPollingMock).not.toHaveBeenCalled();
    expect(storage.runs.getAll).not.toHaveBeenCalled();
  });

  it('handles failure of test case lookup as a recoverable error', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1', testCaseId: 'tc-bad' });
    const { storage, updateCalls } = mockStorage({
      reports: [r1],
      testCaseGetThrowsFor: new Set(['tc-bad']),
    });

    const stat = await resumePendingTracePolls(storage);

    // The lookup error increments errors; the missing test case then forces a
    // failedOut update (which records the report as error in storage).
    expect(stat.errors).toBe(1);
    expect(stat.failedOut).toBe(1);
    expect(stat.resumed).toBe(0);
    expect(updateCalls[0].updates.metricsStatus).toBe('error');
  });
});

describe('resumePendingTracePollsSafely', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRACE_RECOVERY_DISABLED;
  });

  it('never throws even if storage explodes', async () => {
    const storage = {
      runs: { getAll: jest.fn().mockRejectedValue(new Error('boom')) } as any,
      testCases: { getById: jest.fn() } as any,
    } as unknown as IStorageModule;

    await expect(resumePendingTracePollsSafely(storage)).resolves.toBeUndefined();
  });

  it('logs a summary line on success', async () => {
    const r1 = makeReport({ id: 'r1', metricsStatus: 'pending', runId: 'run-1' });
    const { storage } = mockStorage({ reports: [r1] });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await resumePendingTracePollsSafely(storage);

    const summary = log.mock.calls.map(c => c.join(' ')).find(line => line.includes('[traceRecovery]'));
    expect(summary).toBeDefined();
    log.mockRestore();
  });
});
