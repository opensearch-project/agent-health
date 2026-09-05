/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Evaluation Runs API router
 * (server/routes/storage/evaluationRuns.ts) — GET list/by-id, POST create
 * (+SSE execution, cancellation, benchmark linking, error paths), cancel,
 * PUT upsert, DELETE, promote, and PATCH. Mounts the real router on a bare
 * Express app with every collaborator mocked.
 */

const mockEvaluationRunsList = jest.fn();
const mockEvaluationRunsGetById = jest.fn();
const mockEvaluationRunsCreate = jest.fn();
const mockEvaluationRunsUpdate = jest.fn();
const mockEvaluationRunsUpdateResult = jest.fn();
const mockEvaluationRunsDelete = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksUpdate = jest.fn();
const mockBenchmarksAddRun = jest.fn();
const mockEvaluationRunsMergeMissingResults = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    evaluationRuns: {
      list: (...args: any[]) => mockEvaluationRunsList(...args),
      getById: (...args: any[]) => mockEvaluationRunsGetById(...args),
      create: (...args: any[]) => mockEvaluationRunsCreate(...args),
      update: (...args: any[]) => mockEvaluationRunsUpdate(...args),
      updateResult: (...args: any[]) => mockEvaluationRunsUpdateResult(...args),
      mergeMissingResults: (...args: any[]) => mockEvaluationRunsMergeMissingResults(...args),
      delete: (...args: any[]) => mockEvaluationRunsDelete(...args),
    },
    benchmarks: {
      getById: (...args: any[]) => mockBenchmarksGetById(...args),
      update: (...args: any[]) => mockBenchmarksUpdate(...args),
      addRun: (...args: any[]) => mockBenchmarksAddRun(...args),
    },
  }),
}));

const mockResolveTestCaseSources = jest.fn();
jest.mock('@/services/sourceResolver', () => ({
  resolveTestCaseSources: (...args: any[]) => mockResolveTestCaseSources(...args),
}));

const mockExecuteEvaluationRun = jest.fn();
const mockCreateCancellationToken = jest.fn();
jest.mock('@/services/evaluationRunner', () => ({
  executeEvaluationRun: (...args: any[]) => mockExecuteEvaluationRun(...args),
  createCancellationToken: (...args: any[]) => mockCreateCancellationToken(...args),
}));

const mockPromoteRunToBenchmark = jest.fn();
jest.mock('@/services/benchmarkPromotion', () => ({
  promoteRunToBenchmark: (...args: any[]) => mockPromoteRunToBenchmark(...args),
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({ agents: [] }),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/resolveAgentModel', () => ({
  resolveAgentModel: jest.fn().mockReturnValue('resolved-model'),
}));

import express, { Application } from 'express';
const request = require('supertest');
import evaluationRunsRouter from '@/server/routes/storage/evaluationRuns';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(evaluationRunsRouter);
  return app;
}

const sampleTestCase = { id: 'tc-1', name: 'TC 1', version: 1 };

describe('Evaluation Runs API', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app = makeApp();

    mockResolveTestCaseSources.mockResolvedValue({
      testCases: [sampleTestCase],
      sources: [],
      evaluateFnMap: {},
      hooksByFile: {},
      testHookScopes: {},
    });
    mockCreateCancellationToken.mockReturnValue({ isCancelled: false, cancel: jest.fn() });
    mockExecuteEvaluationRun.mockResolvedValue({ results: {}, stats: { total: 1 } });
    mockEvaluationRunsCreate.mockResolvedValue(undefined);
    mockEvaluationRunsUpdate.mockResolvedValue({ id: 'eval-run-1', status: 'completed' });
    // Finalization (services/evaluationRunFinalize.ts) merges results, reads
    // the persisted doc back, then writes status/stats. Default: the doc
    // exists and carries whatever `create` was given.
    mockEvaluationRunsMergeMissingResults.mockResolvedValue(true);
    mockEvaluationRunsGetById.mockImplementation(async (id: string) => {
      const created = mockEvaluationRunsCreate.mock.calls.find((c: any[]) => c[0]?.id === id)?.[0];
      return created ? { ...created, results: created.results || {} } : null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/storage/evaluation-runs', () => {
    it('lists with default pagination and no filters', async () => {
      mockEvaluationRunsList.mockResolvedValue({ items: [], total: 0 });
      const res = await request(app).get('/api/storage/evaluation-runs');
      expect(res.status).toBe(200);
      expect(mockEvaluationRunsList).toHaveBeenCalledWith(expect.objectContaining({ from: 0, size: 50 }));
    });

    it('applies benchmarkId/agentKey/status/testCaseId/trigger/sort/order/from/size', async () => {
      mockEvaluationRunsList.mockResolvedValue({ items: [{ id: 'run-1' }], total: 1 });
      const res = await request(app).get(
        '/api/storage/evaluation-runs?benchmarkId=b1&agentKey=a1&status=completed&testCaseId=tc-1&trigger=cli&sort=completedAt&order=asc&from=5&size=10'
      );
      expect(res.status).toBe(200);
      expect(mockEvaluationRunsList).toHaveBeenCalledWith({
        benchmarkId: 'b1', agentKey: 'a1', status: 'completed', testCaseId: 'tc-1', trigger: 'cli',
        from: 5, size: 10, sort: 'completedAt', order: 'asc',
      });
      expect(res.body).toEqual({ evaluationRuns: [{ id: 'run-1' }], total: 1 });
    });

    it('500s when storage throws', async () => {
      mockEvaluationRunsList.mockRejectedValue(new Error('boom'));
      const res = await request(app).get('/api/storage/evaluation-runs');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/storage/evaluation-runs/:id', () => {
    it('404s when not found', async () => {
      mockEvaluationRunsGetById.mockResolvedValue(null);
      const res = await request(app).get('/api/storage/evaluation-runs/nope');
      expect(res.status).toBe(404);
    });

    it('returns the run', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      const res = await request(app).get('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'run-1' });
    });

    it('maps a meta.statusCode 404 error to a 404 response', async () => {
      const err: any = new Error('not found upstream');
      err.meta = { statusCode: 404 };
      mockEvaluationRunsGetById.mockRejectedValue(err);
      const res = await request(app).get('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(404);
    });

    it('500s on other errors', async () => {
      mockEvaluationRunsGetById.mockRejectedValue(new Error('cluster down'));
      const res = await request(app).get('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/storage/evaluation-runs', () => {
    const body = { sources: [{ testCaseId: 'tc-1' }], agentKey: 'mock-agent' };

    it('400s when sources is missing/empty or agentKey is missing', async () => {
      const res1 = await request(app).post('/api/storage/evaluation-runs').send({ agentKey: 'a1' });
      expect(res1.status).toBe(400);
      const res2 = await request(app).post('/api/storage/evaluation-runs').send({ sources: [] , agentKey: 'a1'});
      expect(res2.status).toBe(400);
      const res3 = await request(app).post('/api/storage/evaluation-runs').send({ sources: [{ testCaseId: 'tc-1' }] });
      expect(res3.status).toBe(400);
    });

    it('emits an SSE error and ends the stream when source resolution throws (after headers flushed)', async () => {
      mockResolveTestCaseSources.mockRejectedValue(new Error('file not found'));
      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200); // SSE stream already opened
      expect(res.text).toContain('event: error');
      expect(res.text).toContain('file not found');
    });

    it('creates the run, streams started/completed events, and executes successfully', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: started');
      expect(res.text).toContain('event: completed');
      expect(mockEvaluationRunsCreate).toHaveBeenCalled();
      expect(mockExecuteEvaluationRun).toHaveBeenCalled();
      const createdRun = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(createdRun.id).toEqual(expect.any(String));
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(createdRun.id, expect.objectContaining({ status: 'completed' }));
    });

    // Data-integrity contract (2026-09-04): the terminal write must NOT
    // re-send the in-memory `results` map — per-case verdicts were already
    // persisted atomically via updateResult, and a wholesale rewrite could
    // clobber a concurrently persisted entry. Results reach the doc only via
    // the add-if-absent merge; stats are recomputed from the persisted doc.
    it('finalizes via merge-if-absent + partial status/stats update — never a wholesale `results` overwrite', async () => {
      mockExecuteEvaluationRun.mockResolvedValue({
        results: { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } },
        stats: { passed: 99, failed: 0, pending: 0, total: 1 }, // deliberately wrong in-memory stats
        testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'tc-1' }],
      });
      // Persisted doc already has the verdict (written by updateResult mid-run).
      mockEvaluationRunsGetById.mockImplementation(async (id: string) => {
        const created = mockEvaluationRunsCreate.mock.calls.find((c: any[]) => c[0]?.id === id)?.[0];
        return created ? { ...created, results: { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } } } : null;
      });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200);

      const createdRun = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(mockEvaluationRunsMergeMissingResults).toHaveBeenCalledWith(
        createdRun.id,
        { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } },
      );
      const terminalUpdate = mockEvaluationRunsUpdate.mock.calls.find((c: any[]) => c[1]?.status === 'completed');
      expect(terminalUpdate).toBeDefined();
      expect(terminalUpdate![1]).not.toHaveProperty('results');
      // Stats come from the PERSISTED results, not the runner's in-memory blob.
      expect(terminalUpdate![1].stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 0, total: 1 });
    });

    it('links a completed run to its benchmark and updates testCaseIds when they changed', async () => {
      mockBenchmarksGetById.mockResolvedValue({ id: 'bench-1', testCaseIds: ['tc-old'] });
      mockBenchmarksAddRun.mockResolvedValue(true);

      const res = await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: 'bench-1' });

      expect(res.status).toBe(200);
      expect(mockBenchmarksUpdate).toHaveBeenCalledWith('bench-1', { testCaseIds: ['tc-1'] });
      expect(mockBenchmarksAddRun).toHaveBeenCalledWith('bench-1', expect.objectContaining({ id: expect.any(String) }));
    });

    it('emits an SSE error when the benchmarkId does not exist', async () => {
      mockBenchmarksGetById.mockResolvedValue(null);
      const res = await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: 'missing-bench' });
      expect(res.text).toContain('event: error');
      expect(res.text).toContain('Benchmark not found: missing-bench');
    });

    it('skips benchmarks.update when testCaseIds are unchanged', async () => {
      mockBenchmarksGetById.mockResolvedValue({ id: 'bench-1', testCaseIds: ['tc-1'] });
      mockBenchmarksAddRun.mockResolvedValue(true);
      await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: 'bench-1' });
      expect(mockBenchmarksUpdate).not.toHaveBeenCalled();
    });

    it('throws when linking a completed run to a benchmark that vanished mid-run', async () => {
      mockBenchmarksGetById.mockResolvedValue({ id: 'bench-1', testCaseIds: ['tc-1'] });
      mockBenchmarksAddRun.mockResolvedValue(false); // benchmark disappeared before linking

      const res = await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: 'bench-1' });

      expect(res.text).toContain('event: error');
      expect(res.text).toContain('Benchmark not found while linking completed run');
      // Failed-status update path also runs.
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'failed' }));
    });

    it('marks the run cancelled (not completed) when the cancellation token was tripped', async () => {
      mockCreateCancellationToken.mockReturnValue({ isCancelled: true, cancel: jest.fn() });
      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200);
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'cancelled' }));
    });

    it('on cancel, stamps explicit `cancelled` markers for planned cases that never started and reports them as notRun (not pending)', async () => {
      mockCreateCancellationToken.mockReturnValue({ isCancelled: true, cancel: jest.fn() });
      mockResolveTestCaseSources.mockResolvedValue({
        testCases: [
          { id: 'tc-1', name: 'One', version: 1 },
          { id: 'tc-2', name: 'Two', version: 1 },
          { id: 'tc-3', name: 'Three', version: 1 },
        ],
        sources: [], evaluateFnMap: {}, hooksByFile: {}, testHookScopes: {},
      });
      // Runner returns only the one case that finished before cancel; the
      // runner itself stamps markers in memory too, but the finalizer must
      // not depend on that — simulate a runner that didn't.
      mockExecuteEvaluationRun.mockResolvedValue({
        results: { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } },
        testCaseSnapshots: [{ id: 'tc-1' }, { id: 'tc-2' }, { id: 'tc-3' }],
      });
      let persistedResults: any = { 'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' } };
      mockEvaluationRunsMergeMissingResults.mockImplementation(async (_id: string, entries: any) => {
        for (const [k, v] of Object.entries(entries)) if (!(k in persistedResults)) persistedResults[k] = v;
        return true;
      });
      mockEvaluationRunsGetById.mockImplementation(async (id: string) => {
        const created = mockEvaluationRunsCreate.mock.calls.find((c: any[]) => c[0]?.id === id)?.[0];
        return created ? { ...created, results: persistedResults } : null;
      });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200);

      expect(mockEvaluationRunsMergeMissingResults).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        'tc-2': { reportId: '', status: 'cancelled' },
        'tc-3': { reportId: '', status: 'cancelled' },
      }));
      const terminalUpdate = mockEvaluationRunsUpdate.mock.calls.find((c: any[]) => c[1]?.status === 'cancelled');
      expect(terminalUpdate![1].stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 });
    });

    it('forwards onProgress and onTestCaseComplete callbacks that stream SSE and persist results', async () => {
      mockExecuteEvaluationRun.mockImplementation(async (_run: any, _testCases: any, opts: any) => {
        opts.onProgress({ percent: 50 });
        await opts.onTestCaseComplete('tc-1', { reportId: 'r1', status: 'completed' });
        return { results: {}, stats: {} };
      });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.text).toContain('event: progress');
      expect(res.text).toContain('event: testCaseComplete');
      expect(mockEvaluationRunsUpdateResult).toHaveBeenCalledWith(expect.any(String), 'tc-1', { reportId: 'r1', status: 'completed' });
    });

    it('emits an SSE error and marks the run failed when execution throws', async () => {
      mockExecuteEvaluationRun.mockRejectedValue(new Error('agent crashed'));
      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.text).toContain('event: error');
      expect(res.text).toContain('agent crashed');
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'failed', error: 'agent crashed' }));
    });

    it('keeps going (logs only) when the failed-status update itself throws', async () => {
      mockExecuteEvaluationRun.mockRejectedValue(new Error('agent crashed'));
      mockEvaluationRunsUpdate.mockRejectedValueOnce(new Error('update also failed'));

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.text).toContain('event: error');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to update run status'));
    });

    it('resolves judgeModelId/evaluatorId/concurrency through onto the created run', async () => {
      await request(app).post('/api/storage/evaluation-runs').send({
        ...body, judgeModelId: 'judge-1', evaluatorId: 'ev-1', concurrency: 3, name: 'My Run', description: 'desc',
      });

      const createdRun = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(createdRun.judgeModelId).toBe('judge-1');
      expect(createdRun.evaluatorId).toBe('ev-1');
      expect(createdRun.concurrency).toBe(3);
      expect(createdRun.name).toBe('My Run');
      expect(createdRun.description).toBe('desc');
      expect(createdRun.modelId).toBe('resolved-model');
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/cancel', () => {
    it('404s when there is no active cancellation token for the id', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs/nope/cancel');
      expect(res.status).toBe(404);
    });

    it('cancels an active run and marks it cancelled', async () => {
      // Prime an active cancellation token by starting (and not finishing) a run.
      // executeEvaluationRun is called strictly AFTER storage.evaluationRuns.create()
      // in the route handler, so resolving `executionStarted` from inside the mock's
      // own invocation deterministically proves create() has already run --
      // no timing-dependent polling/sleep needed.
      let resolveExec: (v: any) => void;
      let signalStarted: () => void;
      const executionStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
      mockExecuteEvaluationRun.mockImplementation(() => {
        signalStarted();
        return new Promise((resolve) => { resolveExec = resolve; });
      });
      const cancelFn = jest.fn();
      mockCreateCancellationToken.mockReturnValue({ isCancelled: false, cancel: cancelFn });

      const postPromise = request(app).post('/api/storage/evaluation-runs').send({ sources: [{ testCaseId: 'tc-1' }], agentKey: 'a1' });
      postPromise.catch(() => {}); // kick off dispatch immediately (supertest is thenable-lazy)
      await executionStarted;

      const runId = mockEvaluationRunsCreate.mock.calls[0][0].id;
      const cancelRes = await request(app).post(`/api/storage/evaluation-runs/${runId}/cancel`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body).toEqual({ success: true, draining: true });
      expect(cancelFn).toHaveBeenCalled();
      // Cancel is a REQUEST: it stamps cancelRequestedAt and must NOT publish a
      // terminal status while in-flight cases are still draining — the
      // executor's finalization writes `cancelled` once it has drained.
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(runId, expect.objectContaining({ cancelRequestedAt: expect.any(String) }));
      expect(mockEvaluationRunsUpdate).not.toHaveBeenCalledWith(runId, expect.objectContaining({ status: 'cancelled' }));

      resolveExec!({ results: {}, stats: {} });
      await postPromise;
    });

    it('500s when the update call throws', async () => {
      let resolveExec: (v: any) => void;
      let signalStarted: () => void;
      const executionStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
      mockExecuteEvaluationRun.mockImplementation(() => {
        signalStarted();
        return new Promise((resolve) => { resolveExec = resolve; });
      });
      mockCreateCancellationToken.mockReturnValue({ isCancelled: false, cancel: jest.fn() });

      const postPromise = request(app).post('/api/storage/evaluation-runs').send({ sources: [{ testCaseId: 'tc-1' }], agentKey: 'a1' });
      postPromise.catch(() => {});
      await executionStarted;
      const runId = mockEvaluationRunsCreate.mock.calls[0][0].id;

      mockEvaluationRunsUpdate.mockRejectedValueOnce(new Error('boom'));
      const cancelRes = await request(app).post(`/api/storage/evaluation-runs/${runId}/cancel`);
      expect(cancelRes.status).toBe(500);

      resolveExec!({ results: {}, stats: {} });
      await postPromise;
    });
  });

  describe('PUT /api/storage/evaluation-runs/:id', () => {
    it('creates a new run (201) when none exists yet', async () => {
      mockEvaluationRunsGetById.mockResolvedValue(null);
      const res = await request(app).put('/api/storage/evaluation-runs/run-1').send({ agentKey: 'a1' });
      expect(res.status).toBe(201);
      expect(mockEvaluationRunsCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1', docType: 'evaluation-run' }));
    });

    it('updates an existing run (200) when one exists', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      mockEvaluationRunsUpdate.mockResolvedValue({ id: 'run-1', agentKey: 'a2' });
      const res = await request(app).put('/api/storage/evaluation-runs/run-1').send({ agentKey: 'a2' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'run-1', agentKey: 'a2' });
    });

    it('500s on error', async () => {
      mockEvaluationRunsGetById.mockRejectedValue(new Error('boom'));
      const res = await request(app).put('/api/storage/evaluation-runs/run-1').send({});
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /api/storage/evaluation-runs/:id', () => {
    it('404s when not found', async () => {
      mockEvaluationRunsGetById.mockResolvedValue(null);
      const res = await request(app).delete('/api/storage/evaluation-runs/nope');
      expect(res.status).toBe(404);
    });

    it('deletes an existing run', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockEvaluationRunsDelete).toHaveBeenCalledWith('run-1');
    });

    it('maps a meta.statusCode 404 error to a 404 response', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      const err: any = new Error('not found');
      err.meta = { statusCode: 404 };
      mockEvaluationRunsDelete.mockRejectedValue(err);
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(404);
    });

    it('500s on other errors', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      mockEvaluationRunsDelete.mockRejectedValue(new Error('cluster down'));
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/promote', () => {
    it('400s when benchmarkName is missing', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/promote').send({});
      expect(res.status).toBe(400);
    });

    it('promotes successfully', async () => {
      mockPromoteRunToBenchmark.mockResolvedValue({ benchmark: { id: 'b1' }, run: { id: 'run-1' } });
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/promote').send({ benchmarkName: 'New Bench' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ benchmark: { id: 'b1' }, run: { id: 'run-1' } });
    });

    it('404s when the underlying run is not found', async () => {
      mockPromoteRunToBenchmark.mockRejectedValue(new Error('Evaluation run not found: run-1'));
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/promote').send({ benchmarkName: 'x' });
      expect(res.status).toBe(404);
    });

    it('400s when the run is already associated with a benchmark', async () => {
      mockPromoteRunToBenchmark.mockRejectedValue(new Error('Run already has benchmark bench-1'));
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/promote').send({ benchmarkName: 'x' });
      expect(res.status).toBe(400);
    });

    it('500s on other errors', async () => {
      mockPromoteRunToBenchmark.mockRejectedValue(new Error('cluster down'));
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/promote').send({ benchmarkName: 'x' });
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /api/storage/evaluation-runs/:id', () => {
    it('404s when not found', async () => {
      mockEvaluationRunsGetById.mockResolvedValue(null);
      const res = await request(app).patch('/api/storage/evaluation-runs/nope').send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    it('updates only the allowed fields (name/description/benchmarkId)', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      mockEvaluationRunsUpdate.mockResolvedValue({ id: 'run-1', name: 'New name' });

      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: 'New name', notAllowed: 'x' });

      expect(res.status).toBe(200);
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith('run-1', { name: 'New name' });
    });

    it('trims whitespace off a renamed value before persisting', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      mockEvaluationRunsUpdate.mockResolvedValue({ id: 'run-1', name: 'New name' });

      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: '  New name  ' });

      expect(res.status).toBe(200);
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith('run-1', { name: 'New name' });
    });

    it('rejects an empty name with 400 and does not call update', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });

      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must not be empty/);
      expect(mockEvaluationRunsUpdate).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only name with 400', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });

      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: '   ' });

      expect(res.status).toBe(400);
      expect(mockEvaluationRunsUpdate).not.toHaveBeenCalled();
    });

    it('rejects a non-string name with 400', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });

      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: 42 });

      expect(res.status).toBe(400);
      expect(mockEvaluationRunsUpdate).not.toHaveBeenCalled();
    });

    it('rejects a name over the 200-char cap with 400', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });

      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: 'x'.repeat(201) });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/200 characters or fewer/);
      expect(mockEvaluationRunsUpdate).not.toHaveBeenCalled();
    });

    it('a rename does not touch other fields (no version bump / stats change smuggled in)', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      mockEvaluationRunsUpdate.mockResolvedValue({ id: 'run-1', name: 'New name' });

      const res = await request(app)
        .patch('/api/storage/evaluation-runs/run-1')
        .send({ name: 'New name', stats: { passed: 999 }, version: 5, status: 'failed' });

      expect(res.status).toBe(200);
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith('run-1', { name: 'New name' });
    });

    it('maps a meta.statusCode 404 error to a 404 response', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      const err: any = new Error('not found');
      err.meta = { statusCode: 404 };
      mockEvaluationRunsUpdate.mockRejectedValue(err);
      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: 'x' });
      expect(res.status).toBe(404);
    });

    it('500s on other errors', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1' });
      mockEvaluationRunsUpdate.mockRejectedValue(new Error('cluster down'));
      const res = await request(app).patch('/api/storage/evaluation-runs/run-1').send({ name: 'x' });
      expect(res.status).toBe(500);
    });
  });
});
