/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the evaluation-runs image-digest wiring added alongside
 * content-addressed benchmark images (server/routes/storage/evaluationRuns.ts):
 *   - GET .../evaluation-runs?imageDigest=... filter passthrough
 *   - POST .../evaluation-runs stamps run.imageDigest and find-or-creates the
 *     corresponding benchmark image, failure-safe (never blocks the run).
 *
 * Mounts the real router on a bare Express app with every collaborator
 * mocked (storage adapter, source resolver, evaluation runner, config).
 */

const mockEvaluationRunsList = jest.fn();
const mockEvaluationRunsCreate = jest.fn();
const mockEvaluationRunsUpdate = jest.fn();
const mockEvaluationRunsUpdateResult = jest.fn();
const mockImagesCreate = jest.fn();
const mockImagesUpdate = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksAddRun = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    evaluationRuns: {
      list: (...args: any[]) => mockEvaluationRunsList(...args),
      create: (...args: any[]) => mockEvaluationRunsCreate(...args),
      update: (...args: any[]) => mockEvaluationRunsUpdate(...args),
      updateResult: (...args: any[]) => mockEvaluationRunsUpdateResult(...args),
      getById: jest.fn(),
    },
    images: {
      create: (...args: any[]) => mockImagesCreate(...args),
      update: (...args: any[]) => mockImagesUpdate(...args),
    },
    benchmarks: {
      getById: (...args: any[]) => mockBenchmarksGetById(...args),
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

jest.mock('@/services/benchmarkPromotion', () => ({
  promoteRunToBenchmark: jest.fn(),
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({ agents: [] }),
  // Per-run config re-read (server/services/runEnvironment.ts) — same shape.
  loadConfig: jest.fn().mockResolvedValue({ agents: [], models: {} }),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/resolveAgentModel', () => ({
  resolveAgentModel: jest.fn().mockReturnValue('resolved-model'),
}));

const mockComputeImageDigest = jest.fn();
const mockBuildImageDoc = jest.fn();
jest.mock('@/lib/benchmarkImage', () => ({
  computeImageDigest: (...args: any[]) => mockComputeImageDigest(...args),
  buildImageDoc: (...args: any[]) => mockBuildImageDoc(...args),
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

describe('Evaluation Runs API — image digest wiring', () => {
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
    mockComputeImageDigest.mockReturnValue('digest-xyz');
    mockBuildImageDoc.mockReturnValue({ digest: 'digest-xyz' });
    mockImagesCreate.mockResolvedValue({ digest: 'digest-xyz', tags: [] });
    mockImagesUpdate.mockResolvedValue({ digest: 'digest-xyz', tags: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/storage/evaluation-runs', () => {
    it('passes imageDigest through as a filter', async () => {
      mockEvaluationRunsList.mockResolvedValue({ items: [], total: 0 });
      await request(app).get('/api/storage/evaluation-runs?imageDigest=digest-xyz');
      expect(mockEvaluationRunsList).toHaveBeenCalledWith(
        expect.objectContaining({ imageDigest: 'digest-xyz' })
      );
    });

    it('omits imageDigest from filters when not provided', async () => {
      mockEvaluationRunsList.mockResolvedValue({ items: [], total: 0 });
      await request(app).get('/api/storage/evaluation-runs');
      const callArg = mockEvaluationRunsList.mock.calls[0][0];
      expect(callArg.imageDigest).toBeUndefined();
    });
  });

  describe('POST /api/storage/evaluation-runs — digest stamping', () => {
    const body = { sources: [{ testCaseId: 'tc-1' }], agentKey: 'mock-agent' };

    it('computes the digest, stamps run.imageDigest, and find-or-creates the image', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200); // SSE stream, 200 default
      expect(mockComputeImageDigest).toHaveBeenCalledWith(
        expect.objectContaining({ testCases: [sampleTestCase] })
      );
      expect(mockBuildImageDoc).toHaveBeenCalled();
      expect(mockImagesCreate).toHaveBeenCalledWith({ digest: 'digest-xyz' });
      expect(mockImagesUpdate).toHaveBeenCalledWith('digest-xyz', { lastRunAt: expect.any(String) });

      const createdRun = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(createdRun.imageDigest).toBe('digest-xyz');
    });

    it('derives evalConditions from evaluatorId and judgeModelId on the request', async () => {
      await request(app)
        .post('/api/storage/evaluation-runs')
        .send({ ...body, evaluatorId: 'ev-1', judgeModelId: 'judge-1' });

      expect(mockComputeImageDigest).toHaveBeenCalledWith({
        testCases: [sampleTestCase],
        evalConditions: { evaluatorId: 'ev-1', judgeModelId: 'judge-1' },
      });
    });

    it('is failure-safe: digest stamping errors do not block run creation/execution', async () => {
      mockComputeImageDigest.mockImplementation(() => { throw new Error('digest boom'); });

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Image digest stamping failed'),
        'digest boom'
      );
      // Run creation still happened without an imageDigest.
      expect(mockEvaluationRunsCreate).toHaveBeenCalled();
      const createdRun = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(createdRun.imageDigest).toBeUndefined();
      expect(mockExecuteEvaluationRun).toHaveBeenCalled();
    });

    it('swallows a failing images.update lastRunAt bump without failing the run', async () => {
      mockImagesUpdate.mockRejectedValue(new Error('update failed'));

      const res = await request(app).post('/api/storage/evaluation-runs').send(body);

      expect(res.status).toBe(200);
      expect(mockEvaluationRunsCreate).toHaveBeenCalled();
      const createdRun = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(createdRun.imageDigest).toBe('digest-xyz');
    });
  });
});
