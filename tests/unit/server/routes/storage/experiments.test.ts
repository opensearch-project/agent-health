/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import experimentsRoutes from '@/server/routes/storage/experiments';

// Mock the opensearchClient
const mockSearch = jest.fn();
const mockIndex = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockBulk = jest.fn();

jest.mock('@/server/services/opensearchClient', () => ({
  getOpenSearchClient: () => ({
    search: mockSearch,
    index: mockIndex,
    get: mockGet,
    update: mockUpdate,
    delete: mockDelete,
    bulk: mockBulk,
  }),
  isStorageConfigured: jest.fn().mockReturnValue(true),
  INDEXES: { experiments: 'experiments-index', testCases: 'test-cases-index' },
}));

// Mock sample experiments
jest.mock('@/cli/demo/sampleExperiments', () => ({
  SAMPLE_EXPERIMENTS: [
    {
      id: 'demo-experiment-1',
      name: 'Sample Experiment',
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
    },
  ],
}));

// Mock experimentRunner
const mockExecuteRun = jest.fn();
const mockCreateCancellationToken = jest.fn(() => ({
  isCancelled: false,
  cancel: jest.fn(),
}));

jest.mock('@/services/experimentRunner', () => ({
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
function createMocks(params: any = {}, body: any = {}) {
  const req = {
    params,
    body,
    on: jest.fn(),
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
  });

  describe('GET /api/storage/experiments', () => {
    it('should return combined sample and real experiments', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _source: {
                  id: 'exp-123',
                  name: 'Real Experiment',
                  createdAt: '2024-02-01T00:00:00Z',
                },
              },
            ],
          },
        },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          experiments: expect.arrayContaining([
            expect.objectContaining({ id: 'exp-123' }),
            expect.objectContaining({ id: 'demo-experiment-1' }),
          ]),
        })
      );
    });

    it('should return only sample data when OpenSearch unavailable', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          experiments: expect.arrayContaining([
            expect.objectContaining({ id: 'demo-experiment-1' }),
          ]),
        })
      );
    });
  });

  describe('GET /api/storage/experiments/:id', () => {
    it('should return sample experiment for demo ID', async () => {
      const { req, res } = createMocks({ id: 'demo-experiment-1' });
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'demo-experiment-1',
          name: 'Sample Experiment',
        })
      );
    });

    it('should return 404 for non-existent sample ID', async () => {
      const { req, res } = createMocks({ id: 'demo-nonexistent' });
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Experiment not found' });
    });

    it('should fetch from OpenSearch for non-sample ID', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: {
            id: 'exp-123',
            name: 'Real Experiment',
          },
        },
      });

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

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
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should handle 404 error from OpenSearch', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockGet.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/experiments', () => {
    it('should reject creating experiment with demo prefix', async () => {
      const { req, res } = createMocks(
        {},
        { id: 'demo-new-exp', name: 'Invalid Experiment' }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments');

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
        { name: 'New Experiment', testCaseIds: ['tc-1'] }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments');

      await handler(req, res);

      expect(mockIndex).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Experiment',
        })
      );
    });

    it('should use provided ID', async () => {
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res } = createMocks(
        {},
        { id: 'custom-exp-123', name: 'New Experiment' }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments');

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
          name: 'New Experiment',
          runs: [{ name: 'Run 1', agentKey: 'agent', modelId: 'model' }],
        }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments');

      await handler(req, res);

      const createdExp = (res.json as jest.Mock).mock.calls[0][0];
      expect(createdExp.runs[0].id).toBeDefined();
      expect(createdExp.runs[0].createdAt).toBeDefined();
    });
  });

  describe('PUT /api/storage/experiments/:id', () => {
    it('should reject modifying sample data', async () => {
      const { req, res } = createMocks(
        { id: 'demo-experiment-1' },
        { runs: [] }
      );
      const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample data'),
        })
      );
    });

    it('should reject request without runs', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { name: 'Updated' }
      );
      const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Only runs can be updated. Provide { runs: [...] }',
      });
    });

    it('should update runs', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: { id: 'exp-123', name: 'Experiment', runs: [] },
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
      const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

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
      const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /api/storage/experiments/:id', () => {
    it('should reject deleting sample data', async () => {
      const { req, res } = createMocks({ id: 'demo-experiment-1' });
      const handler = getRouteHandler(experimentsRoutes, 'delete', '/api/storage/experiments/:id');

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
      const handler = getRouteHandler(experimentsRoutes, 'delete', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(mockDelete).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });

    it('should return 404 when experiment not found', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockDelete.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-nonexistent' });
      const handler = getRouteHandler(experimentsRoutes, 'delete', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/experiments/bulk', () => {
    it('should reject non-array input', async () => {
      const { req, res } = createMocks({}, { experiments: 'not-an-array' });
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/bulk');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'experiments must be an array',
      });
    });

    it('should reject experiments with demo prefix', async () => {
      const { req, res } = createMocks(
        {},
        { experiments: [{ id: 'demo-new', name: 'Invalid' }] }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/bulk');

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
          experiments: [
            { name: 'Experiment 1', testCaseIds: [] },
            { name: 'Experiment 2', testCaseIds: [] },
          ],
        }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/bulk');

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

  describe('POST /api/storage/experiments/:id/execute', () => {
    it('should reject executing sample experiments', async () => {
      const { req, res } = createMocks(
        { id: 'demo-experiment-1' },
        { name: 'Run', agentKey: 'agent', modelId: 'model' }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('sample experiments'),
        })
      );
    });

    it('should validate run configuration - missing name', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { agentKey: 'agent', modelId: 'model' }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should setup SSE and execute run', async () => {
      mockGet.mockResolvedValue({
        body: {
          found: true,
          _source: {
            id: 'exp-123',
            name: 'Test Experiment',
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
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.flushHeaders).toHaveBeenCalled();
      expect(res.write).toHaveBeenCalled();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('POST /api/storage/experiments/:id/cancel', () => {
    it('should return error when runId not provided', async () => {
      const { req, res } = createMocks({ id: 'exp-123' }, {});
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/cancel');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'runId is required' });
    });

    it('should return 404 when run not found in active runs', async () => {
      const { req, res } = createMocks(
        { id: 'exp-123' },
        { runId: 'nonexistent-run' }
      );
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/cancel');

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
    const { isStorageConfigured } = require('@/server/services/opensearchClient');
    (isStorageConfigured as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    const { isStorageConfigured } = require('@/server/services/opensearchClient');
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
  });

  it('GET /api/storage/experiments/:id should return 404 for non-sample ID when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('POST /api/storage/experiments should return error when not configured', async () => {
    const { req, res } = createMocks({}, { name: 'Test' });
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('PUT /api/storage/experiments/:id should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
    const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('DELETE /api/storage/experiments/:id should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'exp-123' });
    const handler = getRouteHandler(experimentsRoutes, 'delete', '/api/storage/experiments/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('POST /api/storage/experiments/bulk should return error when not configured', async () => {
    const { req, res } = createMocks({}, { experiments: [] });
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/bulk');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('POST /api/storage/experiments/:id/execute should return error when not configured', async () => {
    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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

  describe('GET /api/storage/experiments - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      // Mock isStorageConfigured to throw
      const { isStorageConfigured } = require('@/server/services/opensearchClient');
      (isStorageConfigured as jest.Mock).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unexpected error' });

      // Restore
      (isStorageConfigured as jest.Mock).mockReturnValue(true);
    });
  });

  describe('GET /api/storage/experiments/:id - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockGet.mockRejectedValue(new Error('Database connection lost'));

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(experimentsRoutes, 'get', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Database connection lost' });
    });
  });

  describe('POST /api/storage/experiments - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockIndex.mockRejectedValue(new Error('Index write failed'));

      const { req, res } = createMocks({}, { name: 'Test Experiment' });
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Index write failed' });
    });
  });

  describe('PUT /api/storage/experiments/:id - Error cases', () => {
    it('should handle 404 from OpenSearch get', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockGet.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
      const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Experiment not found' });
    });

    it('should handle unexpected errors and return 500', async () => {
      mockGet.mockResolvedValue({ body: { found: true, _source: { id: 'exp-123' } } });
      mockIndex.mockRejectedValue(new Error('Update failed'));

      const { req, res } = createMocks({ id: 'exp-123' }, { runs: [] });
      const handler = getRouteHandler(experimentsRoutes, 'put', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
    });
  });

  describe('DELETE /api/storage/experiments/:id - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockDelete.mockRejectedValue(new Error('Delete failed'));

      const { req, res } = createMocks({ id: 'exp-123' });
      const handler = getRouteHandler(experimentsRoutes, 'delete', '/api/storage/experiments/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
    });
  });

  describe('POST /api/storage/experiments/bulk - Error cases', () => {
    it('should handle unexpected errors and return 500', async () => {
      mockBulk.mockRejectedValue(new Error('Bulk insert failed'));

      const { req, res } = createMocks({}, { experiments: [{ name: 'Exp1' }] });
      const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/bulk');

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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Experiment not found' });
  });

  it('should handle unexpected errors during execute', async () => {
    mockGet.mockRejectedValue(new Error('Connection timeout'));

    const { req, res } = createMocks(
      { id: 'exp-123' },
      { name: 'Run', agentKey: 'agent', modelId: 'model' }
    );
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
          name: 'Test Experiment',
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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
          name: 'Test Experiment',
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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

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
    const handler = getRouteHandler(experimentsRoutes, 'post', '/api/storage/experiments/:id/execute');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'modelId is required and must be a string',
    });
  });
});
