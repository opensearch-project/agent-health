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
const mockBenchmarksDeleteRun = jest.fn();
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
      deleteRun: (...args: any[]) => mockBenchmarksDeleteRun(...args),
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

const mockRetryJudgementForRun = jest.fn();
const mockCountRetryableCases = jest.fn();
jest.mock('@/services/evaluation/retryJudgement', () => ({
  retryJudgementForRun: (...args: any[]) => mockRetryJudgementForRun(...args),
  countRetryableCases: (...args: any[]) => mockCountRetryableCases(...args),
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

    it('carries concurrency through onto the embedded BenchmarkRun projection when linking a completed run (regression: this projection is a separate allow-list from asyncBenchmarkStorage\'s mappers)', async () => {
      mockBenchmarksGetById.mockResolvedValue({ id: 'bench-1', testCaseIds: ['tc-1'] });
      mockBenchmarksAddRun.mockResolvedValue(true);

      await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: 'bench-1', concurrency: 3 });

      expect(mockBenchmarksAddRun).toHaveBeenCalledWith('bench-1', expect.objectContaining({ concurrency: 3 }));
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
    it('404s when the run does not exist and there is no active cancellation token', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce(null);
      const res = await request(app).post('/api/storage/evaluation-runs/nope/cancel');
      expect(res.status).toBe(404);
    });

    it('400s when the run exists but is not running and there is no active cancellation token', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({ id: 'run-1', status: 'completed' });
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/cancel');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not currently running/i);
    });

    it('zombie fallback: marks a running run cancelled with an audit note when no executor is found', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({ id: 'zombie-1', status: 'running', createdAt: new Date(Date.now() - 10000).toISOString() });
      mockEvaluationRunsUpdate.mockResolvedValueOnce({ id: 'zombie-1', status: 'cancelled' });

      const res = await request(app).post('/api/storage/evaluation-runs/zombie-1/cancel');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.viaFallback).toBe(true);
      expect(mockEvaluationRunsUpdate).toHaveBeenCalledWith(
        'zombie-1',
        expect.objectContaining({ status: 'cancelled', cancelNote: expect.stringContaining('no active executor') })
      );
    });

    it('409s (retryable) instead of taking the zombie fallback when the run was created moments ago', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({ id: 'brand-new-1', status: 'running', createdAt: new Date().toISOString() });

      const res = await request(app).post('/api/storage/evaluation-runs/brand-new-1/cancel');

      expect(res.status).toBe(409);
      expect(mockEvaluationRunsUpdate).not.toHaveBeenCalled();
    });

    it('does not block the zombie fallback on legacy docs with no createdAt', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({ id: 'legacy-1', status: 'running' });
      mockEvaluationRunsUpdate.mockResolvedValueOnce({ id: 'legacy-1', status: 'cancelled' });

      const res = await request(app).post('/api/storage/evaluation-runs/legacy-1/cancel');

      expect(res.status).toBe(200);
      expect(res.body.viaFallback).toBe(true);
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

  describe('POST /api/storage/evaluation-runs/:id/rerun', () => {
    const sourceRun: any = {
      id: 'eval-run-src', docType: 'evaluation-run', name: 'Source Run', status: 'completed',
      agentKey: 'agent-a', modelId: 'model-a', judgeModelId: 'judge-a', evaluatorId: 'ev-a', concurrency: 2,
      sources: [{ type: 'test-case-ids', ids: ['tc-1'] }],
      testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'TC 1' }],
      results: {}, createdAt: '2026-01-01T00:00:00Z',
    };

    beforeEach(() => {
      mockEvaluationRunsGetById.mockResolvedValue(sourceRun);
      mockEvaluationRunsCreate.mockResolvedValue(undefined);
      mockExecuteEvaluationRun.mockResolvedValue({ results: {}, stats: { total: 1 } });
    });

    it('404s when the source run does not exist', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce(null);
      const res = await request(app).post('/api/storage/evaluation-runs/nope/rerun');
      expect(res.status).toBe(404);
    });

    it('duplicates the source config verbatim and reports modified:false when no overrides are sent', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs/eval-run-src/rerun').send({});
      expect(res.status).toBe(201);
      expect(res.body.modified).toBe(false);
      expect(res.body.run.modified).toBeUndefined();
      expect(res.body.run.rerunOf).toBe('eval-run-src');
      expect(res.body.run.agentKey).toBe('agent-a');
      expect(res.body.run.evaluatorId).toBe('ev-a');
      expect(res.body.run.concurrency).toBe(2);
    });

    it('applies overrides, flags modified:true, and still records rerunOf', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs/eval-run-src/rerun').send({
        agentKey: 'agent-b', concurrency: 5, name: 'Custom Name',
      });
      expect(res.status).toBe(201);
      expect(res.body.modified).toBe(true);
      expect(res.body.run.modified).toBe(true);
      expect(res.body.run.rerunOf).toBe('eval-run-src');
      expect(res.body.run.agentKey).toBe('agent-b');
      expect(res.body.run.concurrency).toBe(5);
      expect(res.body.run.name).toBe('Custom Name');
      // Unmentioned fields still carried over from the source.
      expect(res.body.run.evaluatorId).toBe('ev-a');
    });

    it('clears judgeModelId/evaluatorId via null overrides and flags modified:true', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs/eval-run-src/rerun').send({
        judgeModelId: null, evaluatorId: null,
      });
      expect(res.status).toBe(201);
      expect(res.body.modified).toBe(true);
      expect(res.body.run.judgeModelId).toBeUndefined();
      expect(res.body.run.evaluatorId).toBeUndefined();
    });

    it('400s when the source run has no agentKey and no override supplies one', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({ ...sourceRun, agentKey: undefined });
      const res = await request(app).post('/api/storage/evaluation-runs/eval-run-src/rerun').send({});
      expect(res.status).toBe(400);
    });

    it('409s when source resolution fails for the (possibly overridden) sources', async () => {
      mockResolveTestCaseSources.mockRejectedValueOnce(new Error('benchmark gone'));
      const res = await request(app).post('/api/storage/evaluation-runs/eval-run-src/rerun').send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/benchmark gone/);
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/retry-judgement (kebab entry point → shared 202+poll job)', () => {
    const summary = { retried: 1, succeeded: 1, failed: 0, results: [{ testCaseId: 'tc1', reportId: 'r1', outcome: 'succeeded', passFailStatus: 'passed' }] };

    beforeEach(() => {
      mockRetryJudgementForRun.mockReset();
      mockCountRetryableCases.mockReset();
      mockCountRetryableCases.mockResolvedValue(1);
    });

    /** Drive the background job to a terminal state via the status endpoint. */
    async function pollStatus(id: string, attempts = 50) {
      for (let i = 0; i < attempts; i++) {
        const res = await request(app).get(`/api/storage/evaluation-runs/${id}/retry-judgement/status`);
        if (res.status === 200 && res.body.status !== 'running') return res.body;
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error('retry-judgement job did not settle');
    }

    it('404s when the run does not exist', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce(null);
      const res = await request(app).post('/api/storage/evaluation-runs/nope/retry-judgement');
      expect(res.status).toBe(404);
    });

    it('409s when the run is still running, even with a judge-failed-shaped result', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({
        id: 'run-1', docType: 'evaluation-run', status: 'running',
        results: { tc1: { status: 'completed', reportId: 'r1' } },
      });
      const res = await request(app).post('/api/storage/evaluation-runs/run-1/retry-judgement');
      expect(res.status).toBe(409);
      expect(mockRetryJudgementForRun).not.toHaveBeenCalled();
    });

    it('202s immediately with the pre-flight total, then exposes the summary via the status poll', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({
        id: 'run-202', docType: 'evaluation-run', status: 'completed',
        results: { tc1: { status: 'completed', reportId: 'r1' } },
      });
      mockRetryJudgementForRun.mockResolvedValueOnce(summary);

      const res = await request(app).post('/api/storage/evaluation-runs/run-202/retry-judgement');
      expect(res.status).toBe(202);
      expect(res.body).toEqual(expect.objectContaining({ jobId: 'run-202', status: 'running', total: 1 }));
      expect(mockRetryJudgementForRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-202' }),
        expect.anything(),
        expect.objectContaining({ scope: 'errored' })
      );

      const job = await pollStatus('run-202');
      expect(job.status).toBe('completed');
      expect(job.summary).toEqual(summary);
    });

    it('surfaces a pipeline failure through the status poll (not a 500 on the POST)', async () => {
      mockEvaluationRunsGetById.mockResolvedValueOnce({
        id: 'run-fail', docType: 'evaluation-run', status: 'completed',
        results: { tc1: { status: 'completed', reportId: 'r1' } },
      });
      mockRetryJudgementForRun.mockRejectedValueOnce(new Error('judge down'));
      const res = await request(app).post('/api/storage/evaluation-runs/run-fail/retry-judgement');
      expect(res.status).toBe(202);
      const job = await pollStatus('run-fail');
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/judge down/);
    });

    it('409s a second concurrent retry-judgement request for the SAME run while the first is still in flight', async () => {
      const runDoc = {
        id: 'run-409', docType: 'evaluation-run', status: 'completed',
        results: { tc1: { status: 'completed', reportId: 'r1' } },
      };
      mockEvaluationRunsGetById.mockResolvedValue(runDoc);

      let resolveFirst: (v: any) => void;
      mockRetryJudgementForRun.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));

      const firstRes = await request(app).post('/api/storage/evaluation-runs/run-409/retry-judgement');
      expect(firstRes.status).toBe(202);

      const secondRes = await request(app).post('/api/storage/evaluation-runs/run-409/retry-judgement');
      expect(secondRes.status).toBe(409);
      expect(secondRes.body.error).toMatch(/already in progress/i);

      resolveFirst!(summary);
      const job = await pollStatus('run-409');
      expect(job.status).toBe('completed');
    });

    it('releases the in-progress guard after a failure, so a later request is not blocked forever', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({
        id: 'run-release', docType: 'evaluation-run', status: 'completed',
        results: { tc1: { status: 'completed', reportId: 'r1' } },
      });
      mockRetryJudgementForRun.mockRejectedValueOnce(new Error('judge down'));
      const failedRes = await request(app).post('/api/storage/evaluation-runs/run-release/retry-judgement');
      expect(failedRes.status).toBe(202);
      await pollStatus('run-release');

      mockRetryJudgementForRun.mockResolvedValueOnce(summary);
      const retryRes = await request(app).post('/api/storage/evaluation-runs/run-release/retry-judgement');
      expect(retryRes.status).toBe(202);
      await pollStatus('run-release');
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

    it('rejects sample/demo run ids with 400 (read-only), like every other storage route', async () => {
      const res = await request(app).delete('/api/storage/evaluation-runs/demo-run-1');
      expect(res.status).toBe(400);
      expect(mockEvaluationRunsGetById).not.toHaveBeenCalled();
      expect(mockEvaluationRunsDelete).not.toHaveBeenCalled();
    });

    it('deletes an existing ad-hoc run (no benchmark → no projection lookup)', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1', status: 'completed', sources: [{ type: 'test-case-ids', ids: [] }] });
      mockEvaluationRunsDelete.mockResolvedValue({ deleted: true });
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, cancelled: false, projectionDeleted: false });
      expect(mockEvaluationRunsDelete).toHaveBeenCalledWith('run-1');
      expect(mockBenchmarksDeleteRun).not.toHaveBeenCalled();
      // The pre-flight read is reused; no second getById.
      expect(mockEvaluationRunsGetById).toHaveBeenCalledTimes(1);
    });

    // Owner report: deleting a run from its page left a ghost row on the
    // benchmark page — the doc went away but the projection embedded in
    // benchmark.runs[] (dual-write, #399) did not.
    it('ALSO removes the projection embedded in the associated benchmark.runs[] (projection first, then doc)', async () => {
      const order: string[] = [];
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1', status: 'completed', benchmarkId: 'bench-1' });
      mockEvaluationRunsDelete.mockImplementation(async () => { order.push('doc'); return { deleted: true }; });
      mockBenchmarksDeleteRun.mockImplementation(async () => { order.push('projection'); return true; });
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, cancelled: false, projectionDeleted: true, benchmarkId: 'bench-1' });
      expect(mockBenchmarksDeleteRun).toHaveBeenCalledWith('bench-1', 'run-1');
      expect(order).toEqual(['projection', 'doc']);
    });

    it('resolves the benchmark from a `benchmark` source when benchmarkId is absent; a missing projection is fine', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1', status: 'completed', sources: [{ type: 'benchmark', benchmarkId: 'bench-2' }] });
      mockEvaluationRunsDelete.mockResolvedValue({ deleted: true });
      mockBenchmarksDeleteRun.mockResolvedValue(false);
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, cancelled: false, projectionDeleted: false, benchmarkId: 'bench-2' });
    });

    it('a RUNNING run executing in this process is cancelled before the delete', async () => {
      // Same deterministic pattern as the cancel tests: prime a live token by
      // starting (and not finishing) a run.
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
      postPromise.catch(() => {});
      await executionStarted;
      const runId = mockEvaluationRunsCreate.mock.calls[0][0].id;

      mockEvaluationRunsGetById.mockResolvedValue({ id: runId, status: 'running' });
      mockEvaluationRunsDelete.mockResolvedValue({ deleted: true });
      const res = await request(app).delete(`/api/storage/evaluation-runs/${runId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, cancelled: true });
      expect(cancelFn).toHaveBeenCalled();
      expect(mockEvaluationRunsDelete).toHaveBeenCalledWith(runId);

      resolveExec!({ results: {}, stats: {} });
      await postPromise;
    });

    it('a RUNNING run with no live executor here is deleted with cancelled:false (nothing to stop)', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'zombie-run', status: 'running' });
      mockEvaluationRunsDelete.mockResolvedValue({ deleted: true });
      const res = await request(app).delete('/api/storage/evaluation-runs/zombie-run');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, cancelled: false });
    });

    it('maps a meta.statusCode 404 error to a 404 response', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1', status: 'completed' });
      const err: any = new Error('not found');
      err.meta = { statusCode: 404 };
      mockEvaluationRunsDelete.mockRejectedValue(err);
      const res = await request(app).delete('/api/storage/evaluation-runs/run-1');
      expect(res.status).toBe(404);
    });

    it('500s on other errors', async () => {
      mockEvaluationRunsGetById.mockResolvedValue({ id: 'run-1', status: 'completed' });
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
