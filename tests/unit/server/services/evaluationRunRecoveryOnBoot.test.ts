/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  recoverOrphanEvaluationRuns,
  recoverOrphanEvaluationRunsSafely,
} from '@/server/services/evaluationRunRecoveryOnBoot';
import * as evaluationRunsRoute from '@/server/routes/storage/evaluationRuns';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/server/routes/storage/evaluationRuns', () => ({
  isEvaluationRunActiveInThisProcess: jest.fn().mockReturnValue(false),
}));

const mockIsActive = evaluationRunsRoute.isEvaluationRunActiveInThisProcess as jest.MockedFunction<
  typeof evaluationRunsRoute.isEvaluationRunActiveInThisProcess
>;

function evaluationRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    docType: 'evaluation-run',
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    agentKey: 'demo',
    modelId: 'demo-model',
    sources: [],
    trigger: 'ui',
    testCaseSnapshots: [],
    results: {},
    ...overrides,
  } as any;
}

function mockStorage(initialRuns: any[], options: { listThrows?: boolean; updateThrows?: Set<string> } = {}) {
  const runs = initialRuns.map(run => structuredClone(run));
  const list = jest.fn().mockImplementation(async ({ status, from = 0, size = 100 }: any = {}) => {
    if (options.listThrows) throw new Error('storage unavailable');
    const filtered = status ? runs.filter(run => run.status === status) : runs;
    return { items: filtered.slice(from, from + size).map(run => structuredClone(run)), total: filtered.length };
  });
  const update = jest.fn().mockImplementation(async (id: string, patch: any) => {
    if (options.updateThrows?.has(id)) throw new Error(`update ${id} failed`);
    const index = runs.findIndex(run => run.id === id);
    runs[index] = { ...runs[index], ...patch };
    return structuredClone(runs[index]);
  });
  const storage = {
    evaluationRuns: { list, update },
  } as unknown as IStorageModule;
  return { storage, runs, list, update };
}

describe('recoverOrphanEvaluationRuns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsActive.mockReturnValue(false);
    delete process.env.EVALUATION_RUN_RECOVERY_DISABLED;
    delete process.env.EVALUATION_RUN_RECOVERY_PAGE_SIZE;
    delete process.env.EVALUATION_RUN_RECOVERY_MAX_PAGES;
  });

  it('finalizes orphaned running docs and preserves persisted per-case results', async () => {
    const results = {
      'case-done': { reportId: 'report-1', status: 'completed' },
      'case-live': { reportId: '', status: 'running' },
    };
    const { storage, runs, update } = mockStorage([
      evaluationRun('orphan', { results }),
      evaluationRun('complete', { status: 'completed' }),
    ]);

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat).toMatchObject({ scannedRuns: 1, orphanedRuns: 1, runsMarkedFailed: 1, errors: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('orphan', expect.objectContaining({
      status: 'failed',
      error: 'interrupted: server restarted mid-run',
      completedAt: expect.any(String),
    }));
    expect(update.mock.calls[0][1]).not.toHaveProperty('results');
    expect(runs.find(run => run.id === 'orphan')?.results).toEqual(results);
    expect(runs.find(run => run.id === 'complete')?.status).toBe('completed');
  });

  it('does not finalize a run registered as active in this process', async () => {
    mockIsActive.mockImplementation(id => id === 'active');
    const { storage, runs, update } = mockStorage([
      evaluationRun('active'),
      evaluationRun('orphan'),
    ]);

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat).toMatchObject({ scannedRuns: 2, activeRunsSkipped: 1, orphanedRuns: 1, runsMarkedFailed: 1 });
    expect(update).toHaveBeenCalledWith('orphan', expect.any(Object));
    expect(runs.find(run => run.id === 'active')?.status).toBe('running');
  });

  it('snapshots every page before updates so filtering cannot skip runs', async () => {
    process.env.EVALUATION_RUN_RECOVERY_PAGE_SIZE = '2';
    const { storage, list, update } = mockStorage([
      evaluationRun('run-1'), evaluationRun('run-2'), evaluationRun('run-3'),
    ]);

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.runsMarkedFailed).toBe(3);
    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ from: 0, size: 2, status: 'running' }));
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ from: 2, size: 2, status: 'running' }));
    expect(list.mock.invocationCallOrder[1]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  it('falls back to safe pagination defaults for invalid environment values', async () => {
    process.env.EVALUATION_RUN_RECOVERY_PAGE_SIZE = '0';
    process.env.EVALUATION_RUN_RECOVERY_MAX_PAGES = 'not-a-number';
    const { storage, list } = mockStorage([evaluationRun('orphan')]);

    await recoverOrphanEvaluationRuns(storage);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ from: 0, size: 100 }));
  });

  it('defensively ignores terminal documents returned by an over-broad adapter', async () => {
    const terminal = evaluationRun('already-complete', { status: 'completed' });
    const update = jest.fn();
    const storage = {
      evaluationRuns: {
        list: jest.fn().mockResolvedValue({ items: [terminal], total: 1 }),
        update,
      },
    } as unknown as IStorageModule;

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat).toMatchObject({ scannedRuns: 1, orphanedRuns: 0, runsMarkedFailed: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('is idempotent when invoked again', async () => {
    const { storage, update } = mockStorage([evaluationRun('orphan')]);

    const first = await recoverOrphanEvaluationRuns(storage);
    const second = await recoverOrphanEvaluationRuns(storage);

    expect(first.runsMarkedFailed).toBe(1);
    expect(second).toMatchObject({ scannedRuns: 0, orphanedRuns: 0, runsMarkedFailed: 0 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('counts list and per-run update errors without throwing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const listFailure = mockStorage([], { listThrows: true });
    await expect(recoverOrphanEvaluationRuns(listFailure.storage)).resolves.toMatchObject({ errors: 1 });

    const updateFailure = mockStorage(
      [evaluationRun('bad'), evaluationRun('good')],
      { updateThrows: new Set(['bad']) },
    );
    const stat = await recoverOrphanEvaluationRuns(updateFailure.storage);
    expect(stat).toMatchObject({ orphanedRuns: 2, runsMarkedFailed: 1, errors: 1 });
    expect(updateFailure.runs.find(run => run.id === 'good')?.status).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('supports disabling recovery for isolated test processes', async () => {
    process.env.EVALUATION_RUN_RECOVERY_DISABLED = '1';
    const { storage, list, update } = mockStorage([evaluationRun('orphan')]);

    const stat = await recoverOrphanEvaluationRuns(storage);

    expect(stat.scannedRuns).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('recoverOrphanEvaluationRunsSafely', () => {
  it('logs a recovery summary and never rejects for an incomplete storage adapter', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(recoverOrphanEvaluationRunsSafely({} as IStorageModule)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[evaluationRunRecovery]'));
    warn.mockRestore();
    log.mockRestore();
  });

  it('contains an unexpected top-level recovery failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const now = jest.spyOn(Date, 'now').mockImplementationOnce(() => {
      throw new Error('clock unavailable');
    });

    await expect(recoverOrphanEvaluationRunsSafely({} as IStorageModule)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unhandled failure: clock unavailable'));
    now.mockRestore();
    warn.mockRestore();
  });
});
