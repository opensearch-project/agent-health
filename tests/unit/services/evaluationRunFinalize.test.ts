/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  finalizeEvaluationRun,
  buildCancelledMarkers,
  computeTerminalStats,
  CANCELLED_NOT_STARTED_ENTRY,
} from '@/services/evaluationRunFinalize';

function makeStorage(persistedResults: Record<string, any>, snapshots = [{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }]) {
  const doc: any = { id: 'run-1', docType: 'evaluation-run', status: 'running', results: persistedResults, testCaseSnapshots: snapshots };
  const evaluationRuns = {
    mergeMissingResults: jest.fn(async (_id: string, entries: Record<string, any>) => {
      for (const [k, v] of Object.entries(entries)) if (!(k in doc.results)) doc.results[k] = v;
      return true;
    }),
    getById: jest.fn(async () => ({ ...doc, results: { ...doc.results } })),
    update: jest.fn(async (_id: string, fields: any) => { Object.assign(doc, fields); return { ...doc }; }),
  };
  return { storage: { evaluationRuns } as any, evaluationRuns, doc };
}

describe('evaluationRunFinalize', () => {
  it('buildCancelledMarkers: one frozen-shape marker per planned case with no in-memory result', () => {
    const markers = buildCancelledMarkers(['a', 'b', 'c'], { b: { reportId: 'r', status: 'completed' } });
    expect(markers).toEqual({ a: { reportId: '', status: 'cancelled' }, c: { reportId: '', status: 'cancelled' } });
    expect(markers.a).toEqual(CANCELLED_NOT_STARTED_ENTRY);
    expect(markers.a).not.toBe(CANCELLED_NOT_STARTED_ENTRY); // a copy, not the shared frozen object
    expect(buildCancelledMarkers(['a'], undefined)).toEqual({ a: { reportId: '', status: 'cancelled' } });
  });

  it('computeTerminalStats: stats over the PERSISTED results, terminal-aware', () => {
    const stats = computeTerminalStats(
      { results: { a: { reportId: 'r', status: 'completed', passFailStatus: 'passed' } } as any, testCaseSnapshots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as any },
      'cancelled',
    );
    expect(stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 });
  });

  it('completed run: merges in-memory results add-if-absent, then writes status/stats/completedAt WITHOUT `results`', async () => {
    // Persisted doc already has tc-1 (written mid-run by updateResult) with a
    // verdict that differs from the (stale) in-memory copy — persisted wins.
    const { storage, evaluationRuns, doc } = makeStorage({ 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } });
    const completedRun = {
      results: {
        'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'failed' }, // stale in-memory
        'tc-2': { reportId: 'r2', status: 'completed', passFailStatus: 'passed' }, // lost per-case write → healed
        'tc-3': { reportId: '', status: 'failed', error: 'boom' },
      },
      testCaseSnapshots: [{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }],
    } as any;

    const out = await finalizeEvaluationRun(storage, { runId: 'run-1', finalStatus: 'completed', completedRun, completedAt: 'T' });

    expect(evaluationRuns.mergeMissingResults).toHaveBeenCalledWith('run-1', completedRun.results);
    expect(doc.results['tc-1'].passFailStatus).toBe('passed'); // NOT clobbered by the stale in-memory copy
    expect(doc.results['tc-2']).toEqual(completedRun.results['tc-2']); // healed
    const [, fields] = evaluationRuns.update.mock.calls[0];
    expect(fields).toEqual({ status: 'completed', completedAt: 'T', stats: { passed: 2, failed: 1, errored: 0, pending: 0, notRun: 0, total: 3 } });
    expect(fields).not.toHaveProperty('results');
    expect(out.cancelledMarkers).toEqual({});
    expect(out.stats.notRun).toBe(0);
  });

  it('cancelled run: stamps `cancelled` markers for never-started planned cases and reports them as notRun (zero pending)', async () => {
    const { storage, evaluationRuns, doc } = makeStorage({ 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } });
    const completedRun = {
      results: { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } },
      testCaseSnapshots: [{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }],
    } as any;

    const out = await finalizeEvaluationRun(storage, { runId: 'run-1', finalStatus: 'cancelled', completedRun });

    expect(out.cancelledMarkers).toEqual({ 'tc-2': { reportId: '', status: 'cancelled' }, 'tc-3': { reportId: '', status: 'cancelled' } });
    expect(doc.results['tc-2']).toEqual({ reportId: '', status: 'cancelled' });
    expect(doc.results['tc-3']).toEqual({ reportId: '', status: 'cancelled' });
    const [, fields] = evaluationRuns.update.mock.calls[0];
    expect(fields.status).toBe('cancelled');
    expect(typeof fields.completedAt).toBe('string');
    expect(fields.stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 });
    expect(fields).not.toHaveProperty('results');
  });

  it('a cancelled marker never overwrites a verdict that landed concurrently (add-if-absent)', async () => {
    // tc-2 finished and persisted between the runner snapshot and finalization.
    const { storage, doc } = makeStorage({
      'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' },
      'tc-2': { reportId: 'r2', status: 'completed', passFailStatus: 'failed' },
    });
    const completedRun = { results: { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: [{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }] } as any;
    const out = await finalizeEvaluationRun(storage, { runId: 'run-1', finalStatus: 'cancelled', completedRun });
    expect(doc.results['tc-2']).toEqual({ reportId: 'r2', status: 'completed', passFailStatus: 'failed' });
    expect(out.stats).toEqual({ passed: 1, failed: 1, errored: 0, pending: 0, notRun: 1, total: 3 });
  });

  it('throws when the run vanished between execution and finalization', async () => {
    const { storage, evaluationRuns } = makeStorage({});
    evaluationRuns.getById.mockResolvedValue(null as any);
    await expect(finalizeEvaluationRun(storage, { runId: 'gone', finalStatus: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } as any }))
      .rejects.toThrow('Evaluation run gone not found during finalization');
    expect(evaluationRuns.update).not.toHaveBeenCalled();
  });
});
