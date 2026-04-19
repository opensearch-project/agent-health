/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import runsRoutes from '@/server/routes/storage/runs';

// Mock storage module methods
const mockRunsGetAll = jest.fn();
const mockRunsGetById = jest.fn();
const mockRunsCreate = jest.fn();
const mockRunsUpdate = jest.fn();
const mockRunsDelete = jest.fn();
const mockRunsSearch = jest.fn();
const mockRunsGetByTestCase = jest.fn();
const mockRunsGetByExperiment = jest.fn();
const mockRunsGetByExperimentRun = jest.fn();
const mockRunsGetIterations = jest.fn();
const mockRunsAddAnnotation = jest.fn();
const mockRunsUpdateAnnotation = jest.fn();
const mockRunsDeleteAnnotation = jest.fn();
const mockRunsBulkCreate = jest.fn();
const mockRunsCountsByTestCase = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksUpdateRun = jest.fn();
const mockIsConfigured = jest.fn();

// Create mock storage module
const mockStorageModule = {
  runs: {
    getAll: mockRunsGetAll,
    getById: mockRunsGetById,
    create: mockRunsCreate,
    update: mockRunsUpdate,
    delete: mockRunsDelete,
    search: mockRunsSearch,
    getByTestCase: mockRunsGetByTestCase,
    getByExperiment: mockRunsGetByExperiment,
    getByExperimentRun: mockRunsGetByExperimentRun,
    getIterations: mockRunsGetIterations,
    addAnnotation: mockRunsAddAnnotation,
    updateAnnotation: mockRunsUpdateAnnotation,
    deleteAnnotation: mockRunsDeleteAnnotation,
    bulkCreate: mockRunsBulkCreate,
    countsByTestCase: mockRunsCountsByTestCase,
  },
  benchmarks: {
    getById: mockBenchmarksGetById,
    updateRun: mockBenchmarksUpdateRun,
  },
  isConfigured: mockIsConfigured,
};

// Mock the storage adapter
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(() => mockStorageModule),
}));

// Mock sample runs
jest.mock('@/cli/demo/sampleRuns', () => ({
  SAMPLE_RUNS: [
    {
      id: 'demo-run-1',
      testCaseId: 'demo-test-case-1',
      experimentId: 'demo-experiment-1',
      experimentRunId: 'demo-exp-run-1',
      status: 'completed',
      passFailStatus: 'passed',
      timestamp: '2024-01-01T00:00:00Z',
    },
    {
      id: 'demo-run-2',
      testCaseId: 'demo-test-case-2',
      experimentId: 'demo-experiment-1',
      experimentRunId: 'demo-exp-run-1',
      status: 'completed',
      passFailStatus: 'failed',
      timestamp: '2024-01-02T00:00:00Z',
    },
  ],
  getSampleRun: (id: string) => {
    if (id === 'demo-run-1') {
      return {
        id: 'demo-run-1',
        testCaseId: 'demo-test-case-1',
        status: 'completed',
        timestamp: '2024-01-01T00:00:00Z',
      };
    }
    return null;
  },
  getSampleRunsByTestCase: (testCaseId: string) => {
    if (testCaseId === 'demo-test-case-1') {
      return [{ id: 'demo-run-1', testCaseId: 'demo-test-case-1' }];
    }
    return [];
  },
  getSampleRunsByBenchmark: (benchmarkId: string) => {
    if (benchmarkId === 'demo-experiment-1') {
      return [
        { id: 'demo-run-1', experimentId: 'demo-experiment-1' },
        { id: 'demo-run-2', experimentId: 'demo-experiment-1' },
      ];
    }
    return [];
  },
  getSampleRunsByBenchmarkRun: (benchmarkId: string, runId: string) => {
    if (benchmarkId === 'demo-experiment-1' && runId === 'demo-exp-run-1') {
      return [
        { id: 'demo-run-1', experimentId: 'demo-experiment-1', experimentRunId: 'demo-exp-run-1' },
        { id: 'demo-run-2', experimentId: 'demo-experiment-1', experimentRunId: 'demo-exp-run-1' },
      ];
    }
    return [];
  },
}));

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}, query: any = {}) {
  const req = {
    params,
    body,
    query,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

// Helper to get route handler
function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('Runs Storage Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
  });

  describe('GET /api/storage/runs', () => {
    it('should return combined sample and real runs', async () => {
      mockRunsGetAll.mockResolvedValue({
        items: [
          {
            id: 'run-123',
            testCaseId: 'tc-123',
            createdAt: '2024-02-01T00:00:00Z',
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { size: '50', from: '0' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs');

      await handler(req, res);

      expect(mockRunsGetAll).toHaveBeenCalledWith({ size: 50, from: 0, _source: undefined });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'run-123' }),
            expect.objectContaining({ id: 'demo-run-1' }),
          ]),
        })
      );
    });

    it('should forward fields query param as _source to storage adapter', async () => {
      mockRunsGetAll.mockResolvedValue({ items: [], total: 0 });

      const { req, res } = createMocks({}, {}, { fields: 'id,testCaseId,passFailStatus' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs');

      await handler(req, res);

      expect(mockRunsGetAll).toHaveBeenCalledWith({
        size: 100,
        from: 0,
        _source: ['id', 'testCaseId', 'passFailStatus'],
      });
    });

    it('should not pass _source when fields query param is missing', async () => {
      mockRunsGetAll.mockResolvedValue({ items: [], total: 0 });

      const { req, res } = createMocks({}, {}, {});
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs');

      await handler(req, res);

      expect(mockRunsGetAll).toHaveBeenCalledWith({
        size: 100,
        from: 0,
        _source: undefined,
      });
    });

    it('should return only sample data when storage unavailable', async () => {
      mockRunsGetAll.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-run-1' }),
          ]),
        })
      );
    });
  });

  describe('GET /api/storage/runs/:id', () => {
    it('should return sample run for demo ID', async () => {
      const { req, res } = createMocks({ id: 'demo-run-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'demo-run-1',
          testCaseId: 'demo-test-case-1',
        })
      );
    });

    it('should return 404 for non-existent sample ID', async () => {
      const { req, res } = createMocks({ id: 'demo-nonexistent' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Run not found' });
    });

    it('should fetch from storage for non-sample ID', async () => {
      mockRunsGetById.mockResolvedValue({
        id: 'run-123',
        testCaseId: 'tc-123',
      });

      const { req, res } = createMocks({ id: 'run-123' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

      await handler(req, res);

      expect(mockRunsGetById).toHaveBeenCalledWith('run-123');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-123' })
      );
    });

    it('should return 404 when run not found', async () => {
      mockRunsGetById.mockResolvedValue(null);

      const { req, res } = createMocks({ id: 'run-nonexistent' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/runs', () => {
    it('should reject creating run with demo prefix', async () => {
      const { req, res } = createMocks({}, { id: 'demo-new-run' });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('demo- prefix'),
        })
      );
    });

    it('should create new run', async () => {
      const newRun = { id: 'run-123', testCaseId: 'tc-123', status: 'pending' };
      mockRunsCreate.mockResolvedValue(newRun);

      const { req, res } = createMocks({}, { testCaseId: 'tc-123' });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs');

      await handler(req, res);

      expect(mockRunsCreate).toHaveBeenCalledWith(expect.objectContaining({ testCaseId: 'tc-123' }));
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(newRun);
    });
  });

  describe('PATCH /api/storage/runs/:id', () => {
    it('should reject modifying sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-run-1' }, { status: 'completed' });
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should reject empty updates', async () => {
      const { req, res } = createMocks({ id: 'run-123' }, {});
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No updates provided' });
    });

    it('should update run', async () => {
      const updatedRun = { id: 'run-123', status: 'completed' };
      mockRunsUpdate.mockResolvedValue(updatedRun);

      const { req, res } = createMocks({ id: 'run-123' }, { status: 'completed' });
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(mockRunsUpdate).toHaveBeenCalledWith('run-123', { status: 'completed' });
      expect(res.json).toHaveBeenCalledWith(updatedRun);
    });

    it('should return 404 when run not found', async () => {
      mockRunsUpdate.mockRejectedValue(new Error('Run not found'));

      const { req, res } = createMocks({ id: 'run-nonexistent' }, { status: 'completed' });
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should trigger benchmark stats refresh on metricsStatus update', async () => {
      const updatedRun = { id: 'run-123', status: 'completed', metricsStatus: 'completed' };
      mockRunsGetById.mockResolvedValue({
        id: 'run-123',
        experimentId: 'bench-123',
      });
      mockRunsUpdate.mockResolvedValue(updatedRun);
      mockBenchmarksGetById.mockResolvedValue({
        id: 'bench-123',
        runs: [{
          id: 'run-1',
          results: { 'tc-1': { reportId: 'run-123' } },
        }],
      });

      const { req, res } = createMocks({ id: 'run-123' }, { metricsStatus: 'completed' });
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(updatedRun);

      // Allow fire-and-forget promise to resolve
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockBenchmarksGetById).toHaveBeenCalledWith('bench-123');
    });
  });

  describe('DELETE /api/storage/runs/:id', () => {
    it('should reject deleting sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-run-1' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should delete run', async () => {
      mockRunsDelete.mockResolvedValue({ deleted: true });

      const { req, res } = createMocks({ id: 'run-123' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

      await handler(req, res);

      expect(mockRunsDelete).toHaveBeenCalledWith('run-123');
      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });

    it('should return 404 when run not found', async () => {
      mockRunsDelete.mockResolvedValue({ deleted: false });

      const { req, res } = createMocks({ id: 'run-nonexistent' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/runs/search', () => {
    it('should search runs with filters', async () => {
      mockRunsSearch.mockResolvedValue({
        items: [{ id: 'run-123', status: 'completed' }],
        total: 1,
      });

      const { req, res } = createMocks({}, {
        experimentId: 'exp-123',
        status: 'completed',
        passFailStatus: 'passed',
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/search');

      await handler(req, res);

      expect(mockRunsSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          experimentId: 'exp-123',
          status: 'completed',
          passFailStatus: 'passed',
        }),
        expect.objectContaining({ size: 100, from: 0 }),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });

    it('should filter sample data', async () => {
      mockRunsSearch.mockResolvedValue({
        items: [],
        total: 0,
      });

      const { req, res } = createMocks({}, {
        experimentId: 'demo-experiment-1',
        testCaseId: 'demo-test-case-1',
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/search');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-run-1' }),
          ]),
        })
      );
    });

    it('should handle storage unavailability gracefully', async () => {
      mockRunsSearch.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({}, {
        experimentId: 'demo-experiment-1',
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/search');

      await handler(req, res);

      // Should still return sample data even when storage fails
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
        })
      );
    });
  });

  describe('GET /api/storage/runs/by-test-case/:testCaseId', () => {
    it('should return runs for test case', async () => {
      mockRunsGetByTestCase.mockResolvedValue({
        items: [{ id: 'run-123', testCaseId: 'tc-123' }],
        total: 1,
      });

      const { req, res } = createMocks({ testCaseId: 'tc-123' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-test-case/:testCaseId');

      await handler(req, res);

      expect(mockRunsGetByTestCase).toHaveBeenCalledWith('tc-123', 100, 0);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
          size: 100,
          from: 0,
        })
      );
    });

    it('should return sample runs for demo test case', async () => {
      mockRunsGetByTestCase.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({ testCaseId: 'demo-test-case-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-test-case/:testCaseId');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-run-1' }),
          ]),
        })
      );
    });

    it('should pass from parameter to storage query', async () => {
      mockRunsGetByTestCase.mockResolvedValue({
        items: [{ id: 'run-101', testCaseId: 'tc-123' }],
        total: 150,
      });

      const { req, res } = createMocks({ testCaseId: 'tc-123' }, {}, { size: '100', from: '100' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-test-case/:testCaseId');

      await handler(req, res);

      // Verify from is passed to storage adapter
      expect(mockRunsGetByTestCase).toHaveBeenCalledWith('tc-123', 100, 100);
    });

    it('should return real total reflecting all matching documents', async () => {
      mockRunsGetByTestCase.mockResolvedValue({
        items: [{ id: 'run-1', testCaseId: 'demo-test-case-1' }],
        total: 236,
      });

      const { req, res } = createMocks({ testCaseId: 'demo-test-case-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-test-case/:testCaseId');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      // Total = 236 (real) + 1 (sample for demo-test-case-1)
      expect(response.total).toBe(237);
    });

    it('should only include sample data on first page (from=0)', async () => {
      mockRunsGetByTestCase.mockResolvedValue({
        items: [{ id: 'run-101', testCaseId: 'demo-test-case-1' }],
        total: 150,
      });

      const { req, res } = createMocks({ testCaseId: 'demo-test-case-1' }, {}, { from: '100' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-test-case/:testCaseId');

      await handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      // On page 2 (from=100), sample data should NOT be included in runs
      const sampleRunIds = response.runs.filter((r: any) => r.id.startsWith('demo-'));
      expect(sampleRunIds).toHaveLength(0);
      // But total should still include sample count
      expect(response.total).toBe(151); // 150 real + 1 sample
    });
  });

  describe('GET /api/storage/runs/by-benchmark/:benchmarkId', () => {
    it('should return runs for benchmark', async () => {
      mockRunsGetByExperiment.mockResolvedValue([
        { id: 'run-123', experimentId: 'exp-123' },
      ]);

      const { req, res } = createMocks({ benchmarkId: 'exp-123' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-benchmark/:benchmarkId');

      await handler(req, res);

      expect(mockRunsGetByExperiment).toHaveBeenCalledWith('exp-123', 1000);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });

    it('should return sample runs for demo experiment', async () => {
      mockRunsGetByExperiment.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({ benchmarkId: 'demo-experiment-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-benchmark/:benchmarkId');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-run-1' }),
          ]),
        })
      );
    });
  });

  describe('GET /api/storage/runs/by-benchmark-run/:benchmarkId/:runId', () => {
    it('should return runs for benchmark run', async () => {
      mockRunsGetByExperimentRun.mockResolvedValue([
        { id: 'run-123', experimentId: 'exp-123', experimentRunId: 'run-1' },
      ]);

      const { req, res } = createMocks({ benchmarkId: 'exp-123', runId: 'run-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-benchmark-run/:benchmarkId/:runId');

      await handler(req, res);

      expect(mockRunsGetByExperimentRun).toHaveBeenCalledWith('exp-123', 'run-1', 1000);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });
  });

  describe('GET /api/storage/runs/iterations/:benchmarkId/:testCaseId', () => {
    it('should return iterations', async () => {
      mockRunsGetIterations.mockResolvedValue({
        items: [
          { id: 'run-123', iteration: 1 },
          { id: 'run-124', iteration: 2 },
        ],
        total: 2,
        maxIteration: 2,
      });

      const { req, res } = createMocks(
        { benchmarkId: 'exp-123', testCaseId: 'tc-123' },
        {},
        {}
      );
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/iterations/:benchmarkId/:testCaseId');

      await handler(req, res);

      expect(mockRunsGetIterations).toHaveBeenCalledWith('exp-123', 'tc-123', undefined);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
          maxIteration: expect.any(Number),
        })
      );
    });

    it('should filter by benchmarkRunId when provided', async () => {
      mockRunsGetIterations.mockResolvedValue({
        items: [],
        total: 0,
        maxIteration: 0,
      });

      const { req, res } = createMocks(
        { benchmarkId: 'exp-123', testCaseId: 'tc-123' },
        {},
        { benchmarkRunId: 'run-1' }
      );
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/iterations/:benchmarkId/:testCaseId');

      await handler(req, res);

      expect(mockRunsGetIterations).toHaveBeenCalledWith('exp-123', 'tc-123', 'run-1');
    });
  });

  describe('POST /api/storage/runs/:id/annotations', () => {
    it('should reject adding annotations to sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-run-1' }, { text: 'Test annotation' });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/:id/annotations');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should add annotation', async () => {
      const annotation = {
        id: 'ann-new',
        text: 'Test annotation',
        tags: ['bug'],
        createdAt: '2024-01-01T00:00:00Z',
      };
      mockRunsAddAnnotation.mockResolvedValue(annotation);

      const { req, res } = createMocks({ id: 'run-123' }, { text: 'Test annotation', tags: ['bug'] });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/:id/annotations');

      await handler(req, res);

      expect(mockRunsAddAnnotation).toHaveBeenCalledWith('run-123', { text: 'Test annotation', tags: ['bug'] });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test annotation',
          tags: ['bug'],
        })
      );
    });
  });

  describe('PUT /api/storage/runs/:id/annotations/:annotationId', () => {
    it('should reject modifying annotations on sample data', async () => {
      const { req, res } = createMocks(
        { id: 'demo-run-1', annotationId: 'ann-1' },
        { text: 'Updated' }
      );
      const handler = getRouteHandler(runsRoutes, 'put', '/api/storage/runs/:id/annotations/:annotationId');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should update annotation', async () => {
      const updatedAnnotation = {
        id: 'ann-1',
        text: 'Updated annotation',
        updatedAt: '2024-01-02T00:00:00Z',
      };
      mockRunsUpdateAnnotation.mockResolvedValue(updatedAnnotation);

      const { req, res } = createMocks(
        { id: 'run-123', annotationId: 'ann-1' },
        { text: 'Updated annotation' }
      );
      const handler = getRouteHandler(runsRoutes, 'put', '/api/storage/runs/:id/annotations/:annotationId');

      await handler(req, res);

      expect(mockRunsUpdateAnnotation).toHaveBeenCalledWith('run-123', 'ann-1', { text: 'Updated annotation' });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ann-1',
          text: 'Updated annotation',
        })
      );
    });
  });

  describe('DELETE /api/storage/runs/:id/annotations/:annotationId', () => {
    it('should reject deleting annotations from sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-run-1', annotationId: 'ann-1' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id/annotations/:annotationId');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should delete annotation', async () => {
      mockRunsDeleteAnnotation.mockResolvedValue({ deleted: true });

      const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id/annotations/:annotationId');

      await handler(req, res);

      expect(mockRunsDeleteAnnotation).toHaveBeenCalledWith('run-123', 'ann-1');
      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });
  });

  describe('POST /api/storage/runs/bulk', () => {
    it('should reject non-array input', async () => {
      const { req, res } = createMocks({}, { runs: 'not-an-array' });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'runs must be an array' });
    });

    it('should reject runs with demo prefix', async () => {
      const { req, res } = createMocks({}, { runs: [{ id: 'demo-new' }] });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('demo- prefix'),
        })
      );
    });

    it('should bulk create runs', async () => {
      mockRunsBulkCreate.mockResolvedValue({ created: 2, errors: 0 });

      const { req, res } = createMocks({}, {
        runs: [
          { testCaseId: 'tc-1' },
          { testCaseId: 'tc-2' },
        ],
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

      await handler(req, res);

      expect(mockRunsBulkCreate).toHaveBeenCalledWith([
        { testCaseId: 'tc-1' },
        { testCaseId: 'tc-2' },
      ]);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          created: 2,
          errors: 0,
        })
      );
    });
  });
});

describe('Runs Storage Routes - Error Handling (500 errors)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
  });

  it('GET /api/storage/runs/:id should handle errors', async () => {
    mockRunsGetById.mockRejectedValue(new Error('Database error'));

    const { req, res } = createMocks({ id: 'run-123' });
    const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Database error' });
  });

  it('POST /api/storage/runs should handle errors', async () => {
    mockRunsCreate.mockRejectedValue(new Error('Create failed'));

    const { req, res } = createMocks({}, { testCaseId: 'tc-123' });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Create failed' });
  });

  it('PATCH /api/storage/runs/:id should handle non-404 errors', async () => {
    mockRunsUpdate.mockRejectedValue(new Error('Update failed'));

    const { req, res } = createMocks({ id: 'run-123' }, { status: 'completed' });
    const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
  });

  it('DELETE /api/storage/runs/:id should handle non-404 errors', async () => {
    mockRunsDelete.mockRejectedValue(new Error('Delete failed'));

    const { req, res } = createMocks({ id: 'run-123' });
    const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
  });

  it('POST /api/storage/runs/:id/annotations should handle errors', async () => {
    mockRunsAddAnnotation.mockRejectedValue(new Error('Annotation failed'));

    const { req, res } = createMocks({ id: 'run-123' }, { text: 'Test' });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/:id/annotations');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Annotation failed' });
  });

  it('PUT /api/storage/runs/:id/annotations/:annotationId should handle errors', async () => {
    mockRunsUpdateAnnotation.mockRejectedValue(new Error('Update failed'));

    const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' }, { text: 'Test' });
    const handler = getRouteHandler(runsRoutes, 'put', '/api/storage/runs/:id/annotations/:annotationId');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
  });

  it('DELETE /api/storage/runs/:id/annotations/:annotationId should handle errors', async () => {
    mockRunsDeleteAnnotation.mockRejectedValue(new Error('Delete failed'));

    const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' });
    const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id/annotations/:annotationId');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
  });

  it('POST /api/storage/runs/bulk should handle errors', async () => {
    mockRunsBulkCreate.mockRejectedValue(new Error('Bulk failed'));

    const { req, res } = createMocks({}, { runs: [{ testCaseId: 'tc-1' }] });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bulk failed' });
  });

  describe('GET /api/storage/runs/counts-by-test-case', () => {
    it('should be registered before :id route so it is reachable', () => {
      // Verify the counts-by-test-case route exists and is a GET handler
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/counts-by-test-case');
      expect(handler).toBeDefined();

      // Verify the route is registered before the parameterized :id route
      // This ensures Express doesn't match "counts-by-test-case" as an :id
      const routes = (runsRoutes as any).stack
        .filter((layer: any) => layer.route && layer.route.methods.get)
        .map((layer: any) => layer.route.path);
      const countsIndex = routes.indexOf('/api/storage/runs/counts-by-test-case');
      const idIndex = routes.indexOf('/api/storage/runs/:id');
      expect(countsIndex).toBeGreaterThanOrEqual(0);
      expect(idIndex).toBeGreaterThanOrEqual(0);
      expect(countsIndex).toBeLessThan(idIndex);
    });

    it('should return merged sample and real counts', async () => {
      mockRunsCountsByTestCase.mockResolvedValue({
        'tc-real-1': 5,
        'tc-real-2': 3,
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/counts-by-test-case');

      await handler(req, res);

      const response = res.json as jest.Mock;
      const { counts } = response.mock.calls[0][0];

      // Sample runs: demo-test-case-1 has 1, demo-test-case-2 has 1
      expect(counts['demo-test-case-1']).toBe(1);
      expect(counts['demo-test-case-2']).toBe(1);
      // Real data
      expect(counts['tc-real-1']).toBe(5);
      expect(counts['tc-real-2']).toBe(3);
    });

    it('should return only sample counts when storage is unavailable', async () => {
      mockRunsCountsByTestCase.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/counts-by-test-case');

      await handler(req, res);

      const response = res.json as jest.Mock;
      const { counts } = response.mock.calls[0][0];

      expect(counts['demo-test-case-1']).toBe(1);
      expect(counts['demo-test-case-2']).toBe(1);
    });

    it('should handle storage errors gracefully', async () => {
      mockRunsCountsByTestCase.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/counts-by-test-case');

      await handler(req, res);

      const response = res.json as jest.Mock;
      const { counts } = response.mock.calls[0][0];

      // Should still return sample counts even when storage fails
      expect(counts['demo-test-case-1']).toBe(1);
      expect(counts['demo-test-case-2']).toBe(1);
    });

    it('should merge counts when sample and real data share test case IDs', async () => {
      mockRunsCountsByTestCase.mockResolvedValue({
        'demo-test-case-1': 2,
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/counts-by-test-case');

      await handler(req, res);

      const response = res.json as jest.Mock;
      const { counts } = response.mock.calls[0][0];

      // 1 from sample + 2 from real = 3
      expect(counts['demo-test-case-1']).toBe(3);
    });
  });
});

describe('Runs Storage Routes - refreshBenchmarkRunStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
  });

  it('should recompute stats from reports when metricsStatus changes', async () => {
    // Setup: report belongs to a benchmark
    mockRunsGetById
      .mockResolvedValueOnce({ id: 'run-123', experimentId: 'bench-1' }) // first call: fetch report for experimentId
      .mockResolvedValueOnce({ id: 'run-123', passFailStatus: 'passed' }); // second call: in refreshBenchmarkRunStats
    mockRunsUpdate.mockResolvedValue({ id: 'run-123', metricsStatus: 'completed' });
    mockBenchmarksGetById.mockResolvedValue({
      id: 'bench-1',
      runs: [{
        id: 'brun-1',
        results: { 'tc-1': { reportId: 'run-123' } },
      }],
    });
    mockBenchmarksUpdateRun.mockResolvedValue(true);

    const { req, res } = createMocks({ id: 'run-123' }, { metricsStatus: 'completed' });
    const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

    await handler(req, res);

    // Allow fire-and-forget promise to resolve
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockBenchmarksGetById).toHaveBeenCalledWith('bench-1');
    expect(mockBenchmarksUpdateRun).toHaveBeenCalledWith(
      'bench-1',
      'brun-1',
      expect.objectContaining({
        stats: expect.objectContaining({
          passed: expect.any(Number),
          failed: expect.any(Number),
          pending: expect.any(Number),
          total: expect.any(Number),
        }),
      })
    );
  });
});
