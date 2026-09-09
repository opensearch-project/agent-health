/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server/services/runDelete.ts — one delete for both persisted forms of a
 * run (standalone evaluation-run doc + legacy projection embedded in
 * benchmark.runs[]), plus cancel-before-delete for a still-running run.
 */

import { deleteRunEverywhere, resolveRunBenchmarkId, isSampleRunOrBenchmarkId } from '@/server/services/runDelete';
import { registerRunCanceller, cancelActiveRun } from '@/server/services/runCancellation';

function makeStorage(overrides: {
  doc?: any;
  deleteRun?: jest.Mock;
  deleteDoc?: jest.Mock;
} = {}) {
  const deleteRun = overrides.deleteRun ?? jest.fn(async () => true);
  const deleteDoc = overrides.deleteDoc ?? jest.fn(async () => ({ deleted: true }));
  return {
    storage: {
      evaluationRuns: {
        getById: jest.fn(async () => overrides.doc ?? null),
        delete: deleteDoc,
      },
      benchmarks: { deleteRun },
    } as any,
    deleteRun,
    deleteDoc,
  };
}

describe('resolveRunBenchmarkId', () => {
  it('prefers benchmarkId, falls back to a benchmark source, else undefined', () => {
    expect(resolveRunBenchmarkId({ benchmarkId: 'b1', sources: [] })).toBe('b1');
    expect(resolveRunBenchmarkId({ sources: [{ type: 'benchmark', benchmarkId: 'b2' }] } as any)).toBe('b2');
    expect(resolveRunBenchmarkId({ sources: [{ type: 'test-case-ids', ids: [] }] } as any)).toBeUndefined();
    expect(resolveRunBenchmarkId(null)).toBeUndefined();
  });
});

describe('deleteRunEverywhere', () => {
  it('dual-written run: deletes the doc AND the embedded projection of the associated benchmark', async () => {
    const { storage, deleteRun, deleteDoc } = makeStorage({ doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' } });
    const result = await deleteRunEverywhere(storage, 'r1');
    expect(deleteDoc).toHaveBeenCalledWith('r1');
    expect(deleteRun).toHaveBeenCalledWith('b1', 'r1');
    expect(result).toEqual({ deleted: true, docDeleted: true, docSkippedNotOwned: false, projectionDeleted: true, benchmarkId: 'b1', cancelled: false });
  });

  it('standalone doc (never embedded): doc removed, projection miss is not an error', async () => {
    const { storage } = makeStorage({
      doc: { id: 'r1', status: 'completed', sources: [{ type: 'benchmark', benchmarkId: 'b1' }] },
      deleteRun: jest.fn(async () => false),
    });
    const result = await deleteRunEverywhere(storage, 'r1');
    expect(result.deleted).toBe(true);
    expect(result.docDeleted).toBe(true);
    expect(result.projectionDeleted).toBe(false);
    expect(result.benchmarkId).toBe('b1');
  });

  it('legacy embedded-only run (no doc): projection removed via the caller-supplied benchmarkId', async () => {
    const { storage, deleteDoc, deleteRun } = makeStorage();
    const result = await deleteRunEverywhere(storage, 'legacy-run', { benchmarkId: 'b1' });
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(deleteRun).toHaveBeenCalledWith('b1', 'legacy-run');
    expect(result).toEqual({ deleted: true, docDeleted: false, docSkippedNotOwned: false, projectionDeleted: true, benchmarkId: 'b1', cancelled: false });
  });

  it('nothing found anywhere → deleted:false (route maps it to 404)', async () => {
    const { storage } = makeStorage({ deleteRun: jest.fn(async () => false) });
    const result = await deleteRunEverywhere(storage, 'ghost', { benchmarkId: 'b1' });
    expect(result.deleted).toBe(false);
  });

  it('ad-hoc run with no benchmark: never touches benchmarks.deleteRun', async () => {
    const { storage, deleteRun } = makeStorage({ doc: { id: 'r1', status: 'completed', sources: [{ type: 'test-case-ids', ids: [] }] } });
    const result = await deleteRunEverywhere(storage, 'r1');
    expect(deleteRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deleted: true, docDeleted: true, projectionDeleted: false, benchmarkId: undefined });
  });

  it('running run: asks cancelActive to stop the executor before deleting the doc, and reports cancelled', async () => {
    const { storage, deleteDoc } = makeStorage({ doc: { id: 'r1', status: 'running', benchmarkId: 'b1' } });
    const order: string[] = [];
    deleteDoc.mockImplementation(async () => { order.push('delete-doc'); return { deleted: true }; });
    const cancelActive = jest.fn((id: string) => { order.push(`cancel:${id}`); return true; });
    const result = await deleteRunEverywhere(storage, 'r1', { cancelActive });
    expect(cancelActive).toHaveBeenCalledWith('r1');
    expect(order).toEqual(['cancel:r1', 'delete-doc']);
    expect(result.cancelled).toBe(true);
  });

  // codex_review: projection first, doc second — a failure between the two
  // leaves a doc-only run (still listed, still deletable by retry) rather
  // than an embedded-only ghost that only the nested-run URL can reach.
  it('removes the embedded projection BEFORE the document', async () => {
    const order: string[] = [];
    const { storage } = makeStorage({
      doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' },
      deleteRun: jest.fn(async () => { order.push('projection'); return true; }),
      deleteDoc: jest.fn(async () => { order.push('doc'); return { deleted: true }; }),
    });
    await deleteRunEverywhere(storage, 'r1');
    expect(order).toEqual(['projection', 'doc']);
  });

  it('a non-404 projection failure surfaces BEFORE the document is touched', async () => {
    const { storage, deleteDoc } = makeStorage({
      doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' },
      deleteRun: jest.fn(async () => { throw new Error('cluster down'); }),
    });
    await expect(deleteRunEverywhere(storage, 'r1')).rejects.toThrow('cluster down');
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  // codex_review: the nested-run route must not be able to delete a doc that
  // is not this benchmark's — including an UNLINKED doc (no benchmark at all).
  describe('ownership when the caller names a benchmark', () => {
    it('deletes the doc when it belongs to that benchmark (benchmarkId or a benchmark source)', async () => {
      const a = makeStorage({ doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' } });
      expect(await deleteRunEverywhere(a.storage, 'r1', { benchmarkId: 'b1' })).toMatchObject({ docDeleted: true, docSkippedNotOwned: false });
      const b = makeStorage({ doc: { id: 'r1', status: 'completed', sources: [{ type: 'benchmark', benchmarkId: 'b1' }] } });
      expect(await deleteRunEverywhere(b.storage, 'r1', { benchmarkId: 'b1' })).toMatchObject({ docDeleted: true });
    });

    it('leaves a doc that belongs to ANOTHER benchmark alone (projection only)', async () => {
      const { storage, deleteDoc } = makeStorage({ doc: { id: 'r1', status: 'running', benchmarkId: 'b-other' } });
      const cancelActive = jest.fn(() => true);
      const result = await deleteRunEverywhere(storage, 'r1', { benchmarkId: 'b1', cancelActive });
      expect(deleteDoc).not.toHaveBeenCalled();
      expect(cancelActive).not.toHaveBeenCalled();
      expect(result).toMatchObject({ deleted: true, docDeleted: false, docSkippedNotOwned: true, projectionDeleted: true, benchmarkId: 'b1' });
    });

    it('leaves an UNLINKED doc (no benchmark anywhere) alone', async () => {
      const { storage, deleteDoc } = makeStorage({ doc: { id: 'r1', status: 'completed', sources: [{ type: 'test-case-ids', ids: [] }] }, deleteRun: jest.fn(async () => false) });
      const result = await deleteRunEverywhere(storage, 'r1', { benchmarkId: 'b1' });
      expect(deleteDoc).not.toHaveBeenCalled();
      expect(result).toMatchObject({ deleted: false, docDeleted: false, docSkippedNotOwned: true });
    });
  });

  it('never removes a projection from sample/demo data', async () => {
    const { storage, deleteRun } = makeStorage({ doc: { id: 'r1', status: 'completed', benchmarkId: 'demo-bench-1' } });
    const result = await deleteRunEverywhere(storage, 'r1');
    expect(deleteRun).not.toHaveBeenCalled();
    expect(result.projectionDeleted).toBe(false);
    expect(isSampleRunOrBenchmarkId('demo-run-1')).toBe(true);
    expect(isSampleRunOrBenchmarkId('eval-run-1')).toBe(false);
    expect(isSampleRunOrBenchmarkId(undefined)).toBe(false);
  });

  it('uses a caller-supplied doc instead of re-reading (no second getById)', async () => {
    const { storage } = makeStorage();
    const result = await deleteRunEverywhere(storage, 'r1', { doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' } as any });
    expect(storage.evaluationRuns.getById).not.toHaveBeenCalled();
    expect(result).toMatchObject({ docDeleted: true, benchmarkId: 'b1' });
  });

  it('running run with no live executor in this process: cancelled:false, still deleted', async () => {
    const { storage } = makeStorage({ doc: { id: 'r1', status: 'running' } });
    const result = await deleteRunEverywhere(storage, 'r1', { cancelActive: () => false });
    expect(result).toMatchObject({ deleted: true, cancelled: false });
  });

  it('terminal run: cancelActive is not consulted', async () => {
    const { storage } = makeStorage({ doc: { id: 'r1', status: 'completed' } });
    const cancelActive = jest.fn(() => true);
    await deleteRunEverywhere(storage, 'r1', { cancelActive });
    expect(cancelActive).not.toHaveBeenCalled();
  });

  it('a 404 from benchmarks.deleteRun (benchmark itself gone) is swallowed; other errors propagate', async () => {
    const notFound: any = new Error('nf'); notFound.meta = { statusCode: 404 };
    const { storage } = makeStorage({ doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' }, deleteRun: jest.fn(async () => { throw notFound; }) });
    await expect(deleteRunEverywhere(storage, 'r1')).resolves.toMatchObject({ deleted: true, projectionDeleted: false });

    const boom = makeStorage({ doc: { id: 'r1', status: 'completed', benchmarkId: 'b1' }, deleteRun: jest.fn(async () => { throw new Error('cluster down'); }) });
    await expect(deleteRunEverywhere(boom.storage, 'r1')).rejects.toThrow('cluster down');
  });
});

describe('runCancellation registry', () => {
  it('fans out to every registered canceller and reports true if any held the run', () => {
    const a = jest.fn((id: string) => id === 'a-run');
    const b = jest.fn((id: string) => id === 'b-run');
    const offA = registerRunCanceller(a);
    const offB = registerRunCanceller(b);
    try {
      expect(cancelActiveRun('b-run')).toBe(true);
      expect(a).toHaveBeenCalledWith('b-run');
      expect(b).toHaveBeenCalledWith('b-run');
      expect(cancelActiveRun('nobody')).toBe(false);
    } finally {
      offA(); offB();
    }
    expect(cancelActiveRun('a-run')).toBe(false); // unregistered
  });

  it('a throwing canceller is logged and does not block the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = jest.fn(() => { throw new Error('boom'); });
    const ok = jest.fn(() => true);
    const offBoom = registerRunCanceller(boom);
    const offOk = registerRunCanceller(ok);
    try {
      expect(cancelActiveRun('r')).toBe(true);
      expect(ok).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally { offBoom(); offOk(); warn.mockRestore(); }
  });
});
