/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import benchmarksRoutes from '@/server/routes/storage/benchmarks';

// Mock client methods
const mockSearch = jest.fn();
const mockIndex = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockBulk = jest.fn();

// Create mock client
const mockClient = {
  search: mockSearch,
  index: mockIndex,
  get: mockGet,
  update: mockUpdate,
  delete: mockDelete,
  bulk: mockBulk,
};

// Mock the storageClient middleware
jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn(),
  requireStorageClient: jest.fn(),
  INDEXES: { benchmarks: 'experiments-index', testCases: 'test-cases-index', runs: 'runs-index' },
}));

// Import mocked functions
import {
  isStorageAvailable,
  requireStorageClient,
} from '@/server/middleware/storageClient';

// Mock sample benchmarks
jest.mock('@/cli/demo/sampleBenchmarks', () => ({
  SAMPLE_BENCHMARKS: [
    {
      id: 'demo-experiment-1',
      name: 'Sample Benchmark',
      description: 'A sample experiment',
      testCaseIds: ['demo-test-case-1'],
      runs: [
        {
          id: 'demo-run-1',
          name: 'Sample Run',
          agentKey: 'test-agent',
          modelId: 'test-model',
          status: 'completed',
          results: {},
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
      createdAt: '2024-01-01T00:00:00Z',
    },
  ],
  isSampleExperimentId: (id: string) => id.startsWith('demo-'),
}));

// Mock sample test cases
jest.mock('@/cli/demo/sampleTestCases', () => ({
  SAMPLE_TEST_CASES: [
    {
      id: 'demo-test-case-1',
      name: 'Sample Test Case 1',
      description: 'A sample test case',
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: 'Test prompt',
      context: [],
      expectedOutcomes: ['Expected outcome'],
      labels: [],
      currentVersion: 1,
      versions: [],
      isPromoted: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ],
}));

// Mock benchmarkRunner
const mockExecuteRun = jest.fn();
const mockCreateCancellationToken = jest.fn(() => ({
  isCancelled: false,
  cancel: jest.fn(),
}));

jest.mock('@/services/benchmarkRunner', () => ({
  executeRun: (...args: any[]) => mockExecuteRun(...args),
  createCancellationToken: () => mockCreateCancellationToken(),
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
    on: jest.fn(),
    storageClient: mockClient,
    storageConfig: { endpoint: 'https://localhost:9200' },
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    headersSent: false,
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

describe('Experiments Storage Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: storage is available
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  describe('GET /api/storage/benchmarks', () => {
    it('should return combined sample and real experiments', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _source: {
                  id: 'exp-123',
                  name: 'Real Benchmark',
                  createdAt: '2024-02-01T00:00:00Z',
                },
              },
            ],
          },
        },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          benchmarks: expect.arrayContaining([
            expect.objectContaining({ id: 'exp-123' }),
            expect.objectContaining({ id: 'demo-experiment-1' }),
          ]),
        })
      );
    });

    it('should return only sample data when OpenSearch unavailable', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          benchmarks: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-experiment-1' }),
          ]),
        })
      );
    });
  });

  describe('GET /api/storage/benchmarks/:id', () => {
    it('should return sample experiment for demo ID', async () => {
      const { req, res } = createMocks({ id: 'demo-experiment-1' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'demo-experiment-1',
          name: 'Sample Benchmark',
        })
      );
    });

    it('should return 404 for non-existent sample ID', async () => {
      const { req, res } = createMocks({ id: 'demo-nonexistent' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
    });

    it('should fetch from OpenSearch for non-sample ID', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: {
            id: 'exp-123',
            name: 'Real Benchmark',
          },
        },
      });

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(mockGet).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'exp-123' })
      );
    });

    it('should return 404 when experiment not found in OpenSearch', async () => {
      mockGet.mockResolvedValue({
        body: { found: false },
      });

      const { req, res } = createMocks({ id: 'exp-nonexistent' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should handle 404 error from OpenSearch', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockGet.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/storage/benchmarks/:id/export', () => {
    it('should export test cases from sample benchmark', async () => {
      const { req, res } = createMocks({ id: 'demo-experiment-1' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('attachment; filename=')
      );
      const exportedData = (res.json as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(exportedData)).toBe(true);
      expect(exportedData.length).toBeGreaterThan(0);
      expect(exportedData[0]).toHaveProperty('name');
      expect(exportedData[0]).toHaveProperty('category');
      expect(exportedData[0]).toHaveProperty('difficulty');
      expect(exportedData[0]).toHaveProperty('initialPrompt');
      expect(exportedData[0]).toHaveProperty('expectedOutcomes');
      // Should not have system fields
      expect(exportedData[0].id).toBeUndefined();
      expect(exportedData[0].labels).toBeUndefined();
    });

    it('should export test cases from OpenSearch benchmark', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: {
            id: 'exp-123',
            name: 'Real Benchmark',
            testCaseIds: ['tc-real-1'],
            runs: [],
            createdAt: '2024-01-01T00:00:00Z',
          },
        },
      });
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [] },
          aggregations: {
            by_id: {
              buckets: [
                {
                  key: 'tc-real-1',
                  latest: {
                    hits: {
                      hits: [
                        {
                          _source: {
                            id: 'tc-real-1',
                            name: 'Real Test Case',
                            description: 'Desc',
                            category: 'RCA',
                            difficulty: 'Medium',
                            initialPrompt: 'Real prompt',
                            context: [],
                            expectedOutcomes: ['Real outcome'],
                            version: 1,
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      const exportedData = (res.json as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(exportedData)).toBe(true);
      expect(exportedData).toHaveLength(1);
      expect(exportedData[0].name).toBe('Real Test Case');
      expect(exportedData[0].initialPrompt).toBe('Real prompt');
    });

    it('should return 404 when benchmark not found', async () => {
      mockGet.mockResolvedValue({
        body: { found: false },
      });

      const { req, res } = createMocks({ id: 'exp-nonexistent' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
    });

    it('should return 404 for non-existent sample benchmark', async () => {
      const { req, res } = createMocks({ id: 'demo-nonexistent' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
    });

    it('should return empty array when benchmark has no resolvable test cases', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: {
            id: 'exp-empty',
            name: 'Empty Benchmark',
            testCaseIds: ['tc-nonexistent'],
            runs: [],
            createdAt: '2024-01-01T00:00:00Z',
          },
        },
      });
      mockSearch.mockResolvedValue({
        body: {
          hits: { hits: [] },
          aggregations: {
            by_id: {
              buckets: [],
            },
          },
        },
      });

      const { req, res } = createMocks({ id: 'exp-empty' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      const exportedData = (res.json as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(exportedData)).toBe(true);
      expect(exportedData).toHaveLength(0);
    });

    it('should handle 404 error from OpenSearch', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockGet.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/benchmarks', () => {
    it('should reject creating experiment with demo prefix', async () => {
      const { req, res } = createMocks(
        {},
        { id: 'demo-new-exp', name: 'Invalid Benchmark' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('demo- prefix'),
        })
      );
    });

    it('should create new experiment with generated ID', async () => {
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        {},
        { name: 'New Benchmark', testCaseIds: ['tc-1'] }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      expect(mockIndex).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Benchmark',
        })
      );
    });

    it('should use provided ID', async () => {
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        {},
        { id: 'custom-exp-123', name: 'New Benchmark' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'custom-exp-123' })
      );
    });

    it('should generate IDs for runs', async () => {
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        {},
        {
          name: 'New Benchmark',
          runs: [{ name: 'Run 1', agentKey: 'agent', modelId: 'model' }],
        }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      const createdExp = (res.json as jest.Mock).mock.calls[0][0];
      expect(createdExp.runs[0].id).toBeDefined();
      expect(createdExp.runs[0].createdAt).toBeDefined();
    });
  });

  describe('PUT /api/storage/benchmarks/:id', () => {
    it('should reject modifying sample data', async () => {
      const { req, res } = createMocks(
        { id: 'demo-experiment-1' },
        { runs: [] }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should update metadata without runs', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: { id: 'exp-123', name: 'Benchmark', testCaseIds: [], runs: [] },
        },
      });
      mockIndex.mockResolvedValue({ body: { result: 'updated' } });

      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Updated Name' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Updated Name' })
      );
    });

    it('should update runs', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: { id: 'exp-123', name: 'Benchmark', runs: [] },
        },
      });
      mockIndex.mockResolvedValue({ body: { result: 'updated' } });

      const { req, res } = createMocks(
        { id: 'exp-123' },
        {
          runs: [
            { name: 'New Run', agentKey: 'agent', modelId: 'model' },
          ],
        }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ name: 'New Run' }),
          ]),
        })
      );
    });

    it('should return 404 when experiment not found', async () => {
      mockGet.mockResolvedValue({
        body: { found: false },
      });

      const { req, res } = createMocks(
        { id: 'exp-nonexistent' },
        { runs: [] }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /api/storage/benchmarks/:id', () => {
    it('should reject deleting sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-experiment-1' });
      const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should delete experiment', async () => {
      mockDelete.mockResolvedValue({ body: {} });

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(mockDelete).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });

    it('should return 404 when experiment not found', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockDelete.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-nonexistent' });
      const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/benchmarks/bulk', () => {
    it('should reject non-array input', async () => {
      const { req, res } = createMocks({}, { benchmarks: 'not-an-array' });
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'benchmarks must be an array',
      });
    });

    it('should reject experiments with demo prefix', async () => {
      const { req, res } = createMocks(
        {},
        { benchmarks: [{ id: 'demo-new', name: 'Invalid' }] }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('demo- prefix'),
        })
      );
    });

    it('should bulk create experiments', async () => {
      mockBulk.mockResolvedValue({
        body: { errors: false },
      });

      const { req, res } = createMocks(
        {},
        {
          benchmarks: [
            { name: 'Benchmark 1', testCaseIds: [] },
            { name: 'Benchmark 2', testCaseIds: [] },
          ],
        }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/bulk');

      await handler(req, res);

      expect(mockBulk).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          created: 2,
          errors: false,
        })
      );
    });
  });

  describe('POST /api/storage/benchmarks/:id/execute', () => {
    it('should reject executing sample benchmarks', async () => {
      const { req, res } = createMocks(
        { id: 'demo-experiment-1' },
        { name: 'Run', agentKey: 'agent', modelId: 'model' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample benchmarks'),
        })
      );
    });

    it('should validate run configuration - missing name', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { agentKey: 'agent', modelId: 'model' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('name is required'),
        })
      );
    });

    it('should validate run configuration - missing agentKey', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', modelId: 'model' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('agentKey is required'),
        })
      );
    });

    it('should validate run configuration - missing modelId', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', agentKey: 'agent' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('modelId is required'),
        })
      );
    });

    it('should return 404 when experiment not found', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockGet.mockRejectedValue(error);

      const { req, res } = createMocks(
        { id: 'exp-nonexistent' },
        { name: 'Run', agentKey: 'agent', modelId: 'model' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should setup SSE and execute run', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: {
            id: 'exp-123',
            name: 'Test Benchmark',
            testCaseIds: ['demo-test-case-1'],
            runs: [],
          },
        },
      });
      mockUpdate.mockResolvedValue({ body: {} });
      mockSearch.mockResolvedValue({
        body: { hits: { hits: [] } },
      });

      const completedRun = {
        id: 'run-123',
        name: 'Run',
        agentKey: 'agent',
        modelId: 'model',
        status: 'completed',
        results: { 'demo-test-case-1': { reportId: 'report-1', status: 'completed' } },
        createdAt: '2024-01-01T00:00:00Z',
      };
      mockExecuteRun.mockResolvedValue(completedRun);

      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', agentKey: 'agent', modelId: 'model' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.flushHeaders).toHaveBeenCalled();
      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('POST /api/storage/benchmarks/:id/cancel', () => {
    it('should return error when runId not provided', async () => {
      const { req, res } = createMocks({ id: 'exp-123' }, {});
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/cancel');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'runId is required' });
    });

    it('should return 404 when run not found in active runs', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { runId: 'nonexistent-run' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/cancel');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Run not found or already completed',
      });
    });
  });
});

describe('Experiments Storage Routes - OpenSearch not configured', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isStorageAvailable as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('GET /api/storage/benchmarks/:id should return 404 for non-sample ID when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('GET /api/storage/benchmarks/:id/export should return 404 for non-sample ID when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
  });

  it('POST /api/storage/benchmarks should return error when not configured', async () => {
    const { req, res } = createMocks({}, { name: 'Test' });
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('PUT /api/storage/benchmarks/:id should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
    const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('DELETE /api/storage/benchmarks/:id should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('POST /api/storage/benchmarks/bulk should return error when not configured', async () => {
    const { req, res } = createMocks({}, { benchmarks: [] });
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/bulk');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('POST /api/storage/benchmarks/:id/execute should return error when not configured', async () => {
    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });
});

describe('Experiments Storage Routes - Error Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/storage/benchmarks - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      // Mock isStorageAvailable to throw
      (isStorageAvailable as jest.Mock).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unexpected error' });

      // Restore
      (isStorageAvailable as jest.Mock).mockReturnValue(true);
      (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
    });
  });

  describe('GET /api/storage/benchmarks/:id - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockGet.mockRejectedValue(new Error('Database connection lost'));

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Database connection lost' });
    });
  });

  describe('POST /api/storage/benchmarks - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockIndex.mockRejectedValue(new Error('Index write failed'));

      const { req, res } = createMocks({}, { name: 'Test Benchmark' });
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index write failed' });
    });
  });

  describe('PUT /api/storage/benchmarks/:id - Error cases', () => {
    it('should handle 404 from OpenSearch get', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockGet.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
    });

    it('should handle unexpected errors and return 500', async () => {
      mockGet.mockResolvedValue({ body: { found: true, _source: { id: 'exp-123' } } });
      mockIndex.mockRejectedValue(new Error('Update failed'));

      const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
    });
  });

  describe('DELETE /api/storage/benchmarks/:id - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockDelete.mockRejectedValue(new Error('Delete failed'));

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
    });
  });

  describe('POST /api/storage/benchmarks/bulk - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockBulk.mockRejectedValue(new Error('Bulk insert failed'));

      const { req, res } = createMocks({}, { benchmarks: [{ name: 'Benchmark1' }] });
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Bulk insert failed' });
    });
  });
});

describe('Experiments Storage Routes - Execute Error Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle 404 when experiment not found during execute', async () => {
    const error: any = new Error('Not found');
    error.meta = { statusCode: 404 };
    mockGet.mockRejectedValue(error);

    const { req, res } = createMocks(
      { id: 'exp-nonexistent' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
  });

  it('should handle unexpected errors during execute', async () => {
    mockGet.mockRejectedValue(new Error('Connection timeout'));

    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Connection timeout' });
  });

  it('should handle execution errors during run', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1'],
          runs: [],
        },
      },
    });
    mockUpdate.mockResolvedValue({ body: {} });
    mockSearch.mockResolvedValue({ body: { hits: { hits: [] } } });
    mockExecuteRun.mockRejectedValue(new Error('Agent execution failed'));

    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    // Should have sent error event
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"error"')
    );
    expect(res.end).toHaveBeenCalled();
  });

  it('should handle cancellation during run execution', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1', 'tc-2'],
          runs: [],
        },
      },
    });
    mockUpdate.mockResolvedValue({ body: {} });
    mockSearch.mockResolvedValue({ body: { hits: { hits: [] } } });

    // Mock cancellation token that's already cancelled
    mockCreateCancellationToken.mockReturnValue({
      isCancelled: true,
      cancel: jest.fn(),
    });

    mockExecuteRun.mockResolvedValue({
      id: 'run-123',
      name: 'Run',
      agentKey: 'agent',
      modelId: 'model',
      status: 'running',
      results: {
        'tc-1': { reportId: 'report-1', status: 'completed' },
        'tc-2': { reportId: '', status: 'pending' },
      },
    });

    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    // Should have sent cancelled event
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"cancelled"')
    );

    // Reset mock
    mockCreateCancellationToken.mockReturnValue({
      isCancelled: false,
      cancel: jest.fn(),
    });
  });
});

describe('Experiments Storage Routes - Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject execute with invalid config (not an object)', async () => {
    const { req, res } = createMocks(
      { id: 'exp-123' },
      null // null body
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Request body must be a valid run configuration object',
    });
  });

  it('should reject execute with empty name', async () => {
    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: '   ', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'name is required and must be a non-empty string',
    });
  });

  it('should reject execute with missing agentKey', async () => {
    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', modelId: 'model' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'agentKey is required and must be a string',
    });
  });

  it('should reject execute with missing modelId', async () => {
    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent' }
    );
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'modelId is required and must be a string',
    });
  });
});

describe('Benchmark Polling Mode (fields=polling)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('should apply _source_excludes when fields=polling', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          runs: [],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-123' }, {}, { fields: 'polling' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(mockGet).toHaveBeenCalledWith(
      expect.objectContaining({
        _source_excludes: 'versions,runs.testCaseSnapshots,runs.headers',
      })
    );
  });

  it('should strip versions, testCaseSnapshots, headers from sample data in polling mode', async () => {
    const { req, res } = createMocks({ id: 'demo-experiment-1' }, {}, { fields: 'polling' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.versions).toEqual([]);
    if (response.runs?.length > 0) {
      response.runs.forEach((run: any) => {
        expect(run.testCaseSnapshots).toEqual([]);
        expect(run.headers).toBeUndefined();
      });
    }
  });

  it('should not apply _source_excludes without fields param (backward compat)', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          runs: [],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(mockGet).toHaveBeenCalledWith(
      expect.not.objectContaining({
        _source_excludes: expect.anything(),
      })
    );
  });
});

describe('Benchmark Run Pagination (runsSize + runsOffset)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('should return sliced runs with totalRuns and hasMoreRuns', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          runs: [
            { id: 'run-1', name: 'Run 1', agentKey: 'a', modelId: 'm', createdAt: '2024-03-01T00:00:00Z', results: {} },
            { id: 'run-2', name: 'Run 2', agentKey: 'a', modelId: 'm', createdAt: '2024-02-01T00:00:00Z', results: {} },
            { id: 'run-3', name: 'Run 3', agentKey: 'a', modelId: 'm', createdAt: '2024-01-01T00:00:00Z', results: {} },
          ],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-123' }, {}, { runsSize: '2' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs).toHaveLength(2);
    expect(response.totalRuns).toBe(3);
    expect(response.hasMoreRuns).toBe(true);
  });

  it('should support runsOffset for loading older runs', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          runs: [
            { id: 'run-1', name: 'Run 1', agentKey: 'a', modelId: 'm', createdAt: '2024-03-01T00:00:00Z', results: {} },
            { id: 'run-2', name: 'Run 2', agentKey: 'a', modelId: 'm', createdAt: '2024-02-01T00:00:00Z', results: {} },
            { id: 'run-3', name: 'Run 3', agentKey: 'a', modelId: 'm', createdAt: '2024-01-01T00:00:00Z', results: {} },
          ],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-123' }, {}, { runsSize: '2', runsOffset: '2' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs).toHaveLength(1); // Only 1 run remaining at offset 2
    expect(response.totalRuns).toBe(3);
    expect(response.hasMoreRuns).toBe(false);
  });

  it('should return all runs without runsSize param (backward compat)', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-123',
          name: 'Test Benchmark',
          runs: [
            { id: 'run-1', name: 'Run 1', agentKey: 'a', modelId: 'm', createdAt: '2024-03-01T00:00:00Z', results: {} },
            { id: 'run-2', name: 'Run 2', agentKey: 'a', modelId: 'm', createdAt: '2024-02-01T00:00:00Z', results: {} },
          ],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs).toHaveLength(2);
    expect(response.totalRuns).toBeUndefined();
    expect(response.hasMoreRuns).toBeUndefined();
  });

  it('should apply run pagination to sample data', async () => {
    const { req, res } = createMocks({ id: 'demo-experiment-1' }, {}, { runsSize: '1' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs.length).toBeLessThanOrEqual(1);
    expect(response.totalRuns).toBeDefined();
    expect(typeof response.hasMoreRuns).toBe('boolean');
  });
});

describe('Lazy Stats Backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('should backfill stats for completed runs missing stats', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-backfill',
          name: 'Backfill Test',
          runs: [
            {
              id: 'run-old',
              name: 'Old Run',
              agentKey: 'agent',
              modelId: 'model',
              status: 'completed',
              createdAt: '2024-01-01T00:00:00Z',
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: 'report-2', status: 'completed' },
              },
            },
          ],
        },
      },
    });

    // Mock report search for computeStatsForRun
    mockSearch.mockResolvedValue({
      body: {
        hits: {
          hits: [
            { _source: { id: 'report-1', passFailStatus: 'passed' } },
            { _source: { id: 'report-2', passFailStatus: 'failed' } },
          ],
        },
      },
    });

    // Mock update for fire-and-forget persistence
    mockUpdate.mockResolvedValue({ body: {} });

    const { req, res } = createMocks({ id: 'exp-backfill' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    // Stats should be backfilled on the run
    expect(response.runs[0].stats).toBeDefined();
    expect(response.runs[0].stats.passed).toBe(1);
    expect(response.runs[0].stats.failed).toBe(1);
    expect(response.runs[0].stats.total).toBe(2);

    // Should have persisted stats back to OpenSearch
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'experiments-index',
        id: 'exp-backfill',
        body: expect.objectContaining({
          script: expect.objectContaining({
            params: expect.objectContaining({
              runId: 'run-old',
              stats: expect.objectContaining({ passed: 1, failed: 1, total: 2 }),
            }),
          }),
        }),
      })
    );
  });

  it('should not backfill runs that already have stats', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-with-stats',
          name: 'Has Stats',
          runs: [
            {
              id: 'run-with-stats',
              name: 'Run With Stats',
              agentKey: 'agent',
              modelId: 'model',
              status: 'completed',
              createdAt: '2024-01-01T00:00:00Z',
              stats: { passed: 3, failed: 0, pending: 0, total: 3 },
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
              },
            },
          ],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-with-stats' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    // Should not have searched for reports (no backfill needed)
    expect(mockSearch).not.toHaveBeenCalled();
    // Should not have called update to persist stats
    expect(mockUpdate).not.toHaveBeenCalled();

    // Should still return the existing stats
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs[0].stats).toEqual({ passed: 3, failed: 0, pending: 0, total: 3 });
  });

  it('should not backfill runs that are still running', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-running',
          name: 'Running Test',
          runs: [
            {
              id: 'run-running',
              name: 'Running Run',
              agentKey: 'agent',
              modelId: 'model',
              status: 'running',
              createdAt: '2024-01-01T00:00:00Z',
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: '', status: 'pending' },
              },
            },
          ],
        },
      },
    });

    const { req, res } = createMocks({ id: 'exp-running' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    // Should not have searched for reports (run is still running)
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('should handle backfill failures gracefully without breaking the response', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-fail',
          name: 'Fail Test',
          runs: [
            {
              id: 'run-fail',
              name: 'Failing Run',
              agentKey: 'agent',
              modelId: 'model',
              status: 'completed',
              createdAt: '2024-01-01T00:00:00Z',
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
              },
            },
          ],
        },
      },
    });

    // Mock report search to fail
    mockSearch.mockRejectedValue(new Error('Search failed'));

    const { req, res } = createMocks({ id: 'exp-fail' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    // Response should still be returned (backfill failure is non-fatal)
    expect(res.json).toHaveBeenCalled();
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.id).toBe('exp-fail');
  });

  it('should backfill stats in paginated mode', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-paginated',
          name: 'Paginated Test',
          runs: [
            {
              id: 'run-1',
              name: 'Run 1',
              agentKey: 'agent',
              modelId: 'model',
              status: 'completed',
              createdAt: '2024-02-01T00:00:00Z',
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
              },
            },
            {
              id: 'run-2',
              name: 'Run 2',
              agentKey: 'agent',
              modelId: 'model',
              status: 'completed',
              createdAt: '2024-01-01T00:00:00Z',
              results: {
                'tc-1': { reportId: 'report-2', status: 'completed' },
              },
            },
          ],
        },
      },
    });

    // Mock report search for computeStatsForRun
    mockSearch.mockResolvedValue({
      body: {
        hits: {
          hits: [
            { _source: { id: 'report-1', passFailStatus: 'passed' } },
          ],
        },
      },
    });
    mockUpdate.mockResolvedValue({ body: {} });

    const { req, res } = createMocks({ id: 'exp-paginated' }, {}, { runsSize: '1' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    // Should have backfilled stats on all runs (before pagination slicing)
    expect(response.totalRuns).toBe(2);
    // The returned paginated run should have stats
    expect(response.runs[0].stats).toBeDefined();
  });

  it('should backfill stats for cancelled runs', async () => {
    mockGet.mockResolvedValue({
      body: {
        found: true,
        _source: {
          id: 'exp-cancelled',
          name: 'Cancelled Test',
          runs: [
            {
              id: 'run-cancelled',
              name: 'Cancelled Run',
              agentKey: 'agent',
              modelId: 'model',
              status: 'cancelled',
              createdAt: '2024-01-01T00:00:00Z',
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: '', status: 'failed' },
              },
            },
          ],
        },
      },
    });

    mockSearch.mockResolvedValue({
      body: {
        hits: {
          hits: [
            { _source: { id: 'report-1', passFailStatus: 'passed' } },
          ],
        },
      },
    });
    mockUpdate.mockResolvedValue({ body: {} });

    const { req, res } = createMocks({ id: 'exp-cancelled' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs[0].stats).toBeDefined();
    expect(response.runs[0].stats.total).toBe(2);
  });
});
