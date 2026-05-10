/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import benchmarksRoutes from '@/server/routes/storage/benchmarks';

// Mock client methods (used ONLY by execute/cancel endpoints which use raw OpenSearch client)
const mockSearch = jest.fn();
const mockIndex = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockBulk = jest.fn();

// Create mock raw client (for execute/cancel paths only)
const mockClient = {
  search: mockSearch,
  index: mockIndex,
  get: mockGet,
  update: mockUpdate,
  delete: mockDelete,
  bulk: mockBulk,
};

// Mock storage adapter methods (used by most CRUD endpoints)
const mockBenchmarksGetAll = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksCreate = jest.fn();
const mockBenchmarksUpdate = jest.fn();
const mockBenchmarksDelete = jest.fn();
const mockBenchmarksBulkCreate = jest.fn();
const mockBenchmarksDeleteRun = jest.fn();
const mockBenchmarksUpdateRun = jest.fn();
const mockTestCasesGetAll = jest.fn();
const mockTestCasesGetById = jest.fn();
const mockRunsGetById = jest.fn();
const mockIsConfigured = jest.fn();

const mockStorage = {
  benchmarks: {
    getAll: mockBenchmarksGetAll,
    getById: mockBenchmarksGetById,
    create: mockBenchmarksCreate,
    update: mockBenchmarksUpdate,
    delete: mockBenchmarksDelete,
    bulkCreate: mockBenchmarksBulkCreate,
    deleteRun: mockBenchmarksDeleteRun,
    updateRun: mockBenchmarksUpdateRun,
  },
  testCases: {
    getAll: mockTestCasesGetAll,
    getById: mockTestCasesGetById,
  },
  runs: {
    getById: mockRunsGetById,
  },
  isConfigured: mockIsConfigured,
};

// Mock the storage adapter module
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(() => mockStorage),
}));

// Mock the storageClient middleware (still needed for execute/cancel endpoints)
jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn(),
  requireStorageClient: jest.fn(),
  INDEXES: { benchmarks: 'experiments-index', testCases: 'test-cases-index', runs: 'runs-index' },
}));

// Mock the benchmarkExport utility
jest.mock('@/lib/benchmarkExport', () => ({
  convertTestCasesToExportFormat: jest.fn((testCases: any[]) =>
    testCases.map((tc: any) => ({
      name: tc.name,
      description: tc.description || '',
      category: tc.category,
      difficulty: tc.difficulty,
      initialPrompt: tc.initialPrompt,
      context: tc.context || [],
      expectedOutcomes: tc.expectedOutcomes || [],
      ...(tc.subcategory ? { subcategory: tc.subcategory } : {}),
    }))
  ),
  generateExportFilename: jest.fn((name: string) => `${name || 'benchmark-export'}.json`),
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
  isSampleBenchmarkId: (id: string) => id.startsWith('demo-'),
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
    // Default: storage is available and configured
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
    mockIsConfigured.mockReturnValue(true);
  });

  describe('GET /api/storage/benchmarks', () => {
    it('should return combined sample and real experiments', async () => {
      mockBenchmarksGetAll.mockResolvedValue({
        items: [
          {
            id: 'exp-123',
            name: 'Real Benchmark',
            createdAt: '2024-02-01T00:00:00Z',
          },
        ],
        total: 1,
      });

      const { req, res } = createMocks({}, {}, { includeSample: 'true' });
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

    it('should return only sample data when storage unavailable', async () => {
      mockBenchmarksGetAll.mockRejectedValue(new Error('Connection refused'));

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

    it('should fetch from storage adapter for non-sample ID', async () => {
      mockBenchmarksGetById.mockResolvedValue({
        id: 'exp-123',
        name: 'Real Benchmark',
        runs: [],
      });

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(mockBenchmarksGetById).toHaveBeenCalledWith('exp-123');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'exp-123' })
      );
    });

    it('should return 404 when experiment not found in storage', async () => {
      mockBenchmarksGetById.mockResolvedValue(null);

      const { req, res } = createMocks({ id: 'exp-nonexistent' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should handle 404 error from storage adapter', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockBenchmarksGetById.mockRejectedValue(error);

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
    });

    it('should export test cases from real benchmark via storage adapter', async () => {
      mockBenchmarksGetById.mockResolvedValue({
        id: 'exp-123',
        name: 'Real Benchmark',
        testCaseIds: ['tc-real-1'],
        runs: [],
        createdAt: '2024-01-01T00:00:00Z',
      });
      mockTestCasesGetById.mockResolvedValue({
        id: 'tc-real-1',
        name: 'Real Test Case',
        description: 'Desc',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Real prompt',
        context: [],
        expectedOutcomes: ['Real outcome'],
        version: 1,
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
      mockBenchmarksGetById.mockResolvedValue(null);

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
      mockBenchmarksGetById.mockResolvedValue({
        id: 'exp-empty',
        name: 'Empty Benchmark',
        testCaseIds: ['tc-nonexistent'],
        runs: [],
        createdAt: '2024-01-01T00:00:00Z',
      });
      mockTestCasesGetById.mockRejectedValue(new Error('Not found'));

      const { req, res } = createMocks({ id: 'exp-empty' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      const exportedData = (res.json as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(exportedData)).toBe(true);
      expect(exportedData).toHaveLength(0);
    });

    it('should handle 404 error from storage adapter', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockBenchmarksGetById.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
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

    it('should create new experiment via storage adapter', async () => {
      mockBenchmarksCreate.mockImplementation(async (bench: any) => ({
        ...bench,
        id: bench.id || 'bench-generated-id',
        createdAt: bench.createdAt || new Date().toISOString(),
      }));

      const { req, res } = createMocks(
        {},
        { name: 'New Benchmark', testCaseIds: ['tc-1'] }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      expect(mockBenchmarksCreate).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Benchmark',
        })
      );
    });

    it('should use provided ID', async () => {
      mockBenchmarksCreate.mockImplementation(async (bench: any) => ({
        ...bench,
        createdAt: bench.createdAt || new Date().toISOString(),
      }));

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
      mockBenchmarksCreate.mockImplementation(async (bench: any) => ({
        ...bench,
        createdAt: bench.createdAt || new Date().toISOString(),
      }));

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
      mockBenchmarksGetById.mockResolvedValue({
        id: 'exp-123',
        name: 'Benchmark',
        testCaseIds: [],
        runs: [],
      });
      mockBenchmarksUpdate.mockImplementation(async (_id: string, updates: any) => ({
        id: 'exp-123',
        ...updates,
      }));

      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Updated Name' }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(mockBenchmarksUpdate).toHaveBeenCalledWith('exp-123', expect.objectContaining({ name: 'Updated Name' }));
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Updated Name' })
      );
    });

    it('should update runs', async () => {
      mockBenchmarksGetById.mockResolvedValue({
        id: 'exp-123',
        name: 'Benchmark',
        testCaseIds: [],
        runs: [],
      });
      mockBenchmarksUpdate.mockImplementation(async (_id: string, updates: any) => ({
        id: 'exp-123',
        ...updates,
      }));

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
      mockBenchmarksGetById.mockResolvedValue(null);

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

    it('should delete experiment via storage adapter', async () => {
      mockBenchmarksDelete.mockResolvedValue({ deleted: true });

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(mockBenchmarksDelete).toHaveBeenCalledWith('exp-123');
      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });

    it('should return 404 when experiment not found', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockBenchmarksDelete.mockRejectedValue(error);

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

    it('should bulk create experiments via storage adapter', async () => {
      mockBenchmarksBulkCreate.mockResolvedValue({
        created: 2,
        errors: 0,
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

      expect(mockBenchmarksBulkCreate).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          created: 2,
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

    it('should validate run configuration - concurrency below 1', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', agentKey: 'agent', modelId: 'model', concurrency: 0 }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('concurrency must be an integer between 1 and 20'),
        })
      );
    });

    it('should validate run configuration - concurrency above 20', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', agentKey: 'agent', modelId: 'model', concurrency: 21 }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('concurrency must be an integer between 1 and 20'),
        })
      );
    });

    it('should validate run configuration - non-integer concurrency', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', agentKey: 'agent', modelId: 'model', concurrency: 2.5 }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('concurrency must be an integer between 1 and 20'),
        })
      );
    });

    it('should accept valid concurrency values', async () => {
      (isStorageAvailable as jest.Mock).mockReturnValue(false);

      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Run', agentKey: 'agent', modelId: 'model', concurrency: 5 }
      );
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');

      await handler(req, res);

      // Should pass validation and reach storage check
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('OpenSearch not configured'),
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
      // Execute endpoint uses raw client, not adapter
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
      // getAllTestCases calls the adapter for real test cases
      mockTestCasesGetAll.mockResolvedValue({ items: [], total: 0 });
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

describe('Experiments Storage Routes - Storage not configured', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(false);
    (isStorageAvailable as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('GET /api/storage/benchmarks should return only sample data when not configured', async () => {
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
    // Should not have tried to fetch from storage
    expect(mockBenchmarksGetAll).not.toHaveBeenCalled();
  });

  it('GET /api/storage/benchmarks/:id should return 404 for non-sample ID when not configured', async () => {
    // When storage is not configured, adapter.getById returns null for non-existent IDs
    mockBenchmarksGetById.mockResolvedValue(null);

    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('GET /api/storage/benchmarks/:id/export should return 404 for non-sample ID when not configured', async () => {
    mockBenchmarksGetById.mockResolvedValue(null);

    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id/export');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
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
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  describe('GET /api/storage/benchmarks - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      // Force an error by making getStorageModule throw via isConfigured
      mockIsConfigured.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unexpected error' });

      // Restore
      mockIsConfigured.mockReturnValue(true);
    });
  });

  describe('GET /api/storage/benchmarks/:id - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockBenchmarksGetById.mockRejectedValue(new Error('Database connection lost'));

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Database connection lost' });
    });
  });

  describe('POST /api/storage/benchmarks - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockBenchmarksCreate.mockRejectedValue(new Error('Index write failed'));

      const { req, res } = createMocks({}, { name: 'Test Benchmark' });
      const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index write failed' });
    });
  });

  describe('PUT /api/storage/benchmarks/:id - Error cases', () => {
    it('should handle 404 from storage adapter get', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockBenchmarksGetById.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Benchmark not found' });
    });

    it('should handle unexpected errors and return 500', async () => {
      mockBenchmarksGetById.mockResolvedValue({
        id: 'exp-123',
        name: 'Benchmark',
        testCaseIds: [],
        runs: [],
      });
      mockBenchmarksUpdate.mockRejectedValue(new Error('Update failed'));

      const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
      const handler = getRouteHandler(benchmarksRoutes, 'put', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
    });
  });

  describe('DELETE /api/storage/benchmarks/:id - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockBenchmarksDelete.mockRejectedValue(new Error('Delete failed'));

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(benchmarksRoutes, 'delete', '/api/storage/benchmarks/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
    });
  });

  describe('POST /api/storage/benchmarks/bulk - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockBenchmarksBulkCreate.mockRejectedValue(new Error('Bulk insert failed'));

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
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
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
    mockTestCasesGetAll.mockResolvedValue({ items: [], total: 0 });
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
    mockTestCasesGetAll.mockResolvedValue({ items: [], total: 0 });
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
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
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
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('should return data from storage adapter when fields=polling', async () => {
    mockBenchmarksGetById.mockResolvedValue({
      id: 'exp-123',
      name: 'Test Benchmark',
      runs: [],
    });

    const { req, res } = createMocks({ id: 'exp-123' }, {}, { fields: 'polling' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(mockBenchmarksGetById).toHaveBeenCalledWith('exp-123');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exp-123' })
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

  it('should return full data without fields param (backward compat)', async () => {
    mockBenchmarksGetById.mockResolvedValue({
      id: 'exp-123',
      name: 'Test Benchmark',
      runs: [],
    });

    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    expect(mockBenchmarksGetById).toHaveBeenCalledWith('exp-123');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exp-123' })
    );
  });
});

describe('Benchmark Run Pagination (runsSize + runsOffset)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('should return sliced runs with totalRuns and hasMoreRuns', async () => {
    mockBenchmarksGetById.mockResolvedValue({
      id: 'exp-123',
      name: 'Test Benchmark',
      runs: [
        { id: 'run-1', name: 'Run 1', agentKey: 'a', modelId: 'm', createdAt: '2024-03-01T00:00:00Z', results: {} },
        { id: 'run-2', name: 'Run 2', agentKey: 'a', modelId: 'm', createdAt: '2024-02-01T00:00:00Z', results: {} },
        { id: 'run-3', name: 'Run 3', agentKey: 'a', modelId: 'm', createdAt: '2024-01-01T00:00:00Z', results: {} },
      ],
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
    mockBenchmarksGetById.mockResolvedValue({
      id: 'exp-123',
      name: 'Test Benchmark',
      runs: [
        { id: 'run-1', name: 'Run 1', agentKey: 'a', modelId: 'm', createdAt: '2024-03-01T00:00:00Z', results: {} },
        { id: 'run-2', name: 'Run 2', agentKey: 'a', modelId: 'm', createdAt: '2024-02-01T00:00:00Z', results: {} },
        { id: 'run-3', name: 'Run 3', agentKey: 'a', modelId: 'm', createdAt: '2024-01-01T00:00:00Z', results: {} },
      ],
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
    mockBenchmarksGetById.mockResolvedValue({
      id: 'exp-123',
      name: 'Test Benchmark',
      runs: [
        { id: 'run-1', name: 'Run 1', agentKey: 'a', modelId: 'm', createdAt: '2024-03-01T00:00:00Z', results: {} },
        { id: 'run-2', name: 'Run 2', agentKey: 'a', modelId: 'm', createdAt: '2024-02-01T00:00:00Z', results: {} },
      ],
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
    mockIsConfigured.mockReturnValue(true);
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
  });

  it('should backfill stats for completed runs missing stats', async () => {
    mockBenchmarksGetById.mockResolvedValue({
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
    });

    // Mock report fetching via storage adapter (backfill uses adapter, not raw client)
    mockRunsGetById
      .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed' })
      .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'failed' });

    // Mock updateRun for fire-and-forget persistence
    mockBenchmarksUpdateRun.mockResolvedValue(true);

    const { req, res } = createMocks({ id: 'exp-backfill' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    // Stats should be backfilled on the run
    expect(response.runs[0].stats).toBeDefined();
    expect(response.runs[0].stats.passed).toBe(1);
    expect(response.runs[0].stats.failed).toBe(1);
    expect(response.runs[0].stats.total).toBe(2);

    // Should have persisted stats via adapter
    expect(mockBenchmarksUpdateRun).toHaveBeenCalledWith(
      'exp-backfill',
      'run-old',
      expect.objectContaining({
        stats: expect.objectContaining({ passed: 1, failed: 1, total: 2 }),
      })
    );
  });

  it('should not backfill runs that already have stats', async () => {
    mockBenchmarksGetById.mockResolvedValue({
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
    });

    const { req, res } = createMocks({ id: 'exp-with-stats' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    // Should not have fetched reports (no backfill needed)
    expect(mockRunsGetById).not.toHaveBeenCalled();
    // Should not have called updateRun to persist stats
    expect(mockBenchmarksUpdateRun).not.toHaveBeenCalled();

    // Should still return the existing stats
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs[0].stats).toEqual({ passed: 3, failed: 0, pending: 0, total: 3 });
  });

  it('should not backfill runs that are still running', async () => {
    mockBenchmarksGetById.mockResolvedValue({
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
    });

    const { req, res } = createMocks({ id: 'exp-running' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    // Should not have fetched reports (run is still running)
    expect(mockRunsGetById).not.toHaveBeenCalled();
    expect(mockBenchmarksUpdateRun).not.toHaveBeenCalled();
  });

  it('should handle backfill failures gracefully without breaking the response', async () => {
    mockBenchmarksGetById.mockResolvedValue({
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
    });

    // Mock report fetch to fail
    mockRunsGetById.mockRejectedValue(new Error('Fetch failed'));

    const { req, res } = createMocks({ id: 'exp-fail' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    // Response should still be returned (backfill failure is non-fatal)
    expect(res.json).toHaveBeenCalled();
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.id).toBe('exp-fail');
  });

  it('should backfill stats in paginated mode', async () => {
    mockBenchmarksGetById.mockResolvedValue({
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
    });

    // Mock report fetching via storage adapter for computeStatsForRun
    mockRunsGetById
      .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed' })
      .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'passed' });
    mockBenchmarksUpdateRun.mockResolvedValue(true);

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
    mockBenchmarksGetById.mockResolvedValue({
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
    });

    mockRunsGetById.mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed' });
    mockBenchmarksUpdateRun.mockResolvedValue(true);

    const { req, res } = createMocks({ id: 'exp-cancelled' });
    const handler = getRouteHandler(benchmarksRoutes, 'get', '/api/storage/benchmarks/:id');

    await handler(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.runs[0].stats).toBeDefined();
    expect(response.runs[0].stats.total).toBe(2);
  });
});
