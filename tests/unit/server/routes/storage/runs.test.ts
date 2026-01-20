/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import runsRoutes from '@/server/routes/storage/runs';

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
  INDEXES: { runs: 'runs-index' },
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
  getSampleRunsByExperiment: (experimentId: string) => {
    if (experimentId === 'demo-experiment-1') {
      return [
        { id: 'demo-run-1', experimentId: 'demo-experiment-1' },
        { id: 'demo-run-2', experimentId: 'demo-experiment-1' },
      ];
    }
    return [];
  },
  getSampleRunsByExperimentRun: (experimentId: string, runId: string) => {
    if (experimentId === 'demo-experiment-1' && runId === 'demo-exp-run-1') {
      return [{ id: 'demo-run-1', experimentId, experimentRunId: runId }];
    }
    return [];
  },
}));

// Mock storage service
const mockCreateRun = jest.fn();
const mockGetRunById = jest.fn();
const mockUpdateRun = jest.fn();

jest.mock('@/server/services/storage/index', () => ({
  createRun: (...args: any[]) => mockCreateRun(...args),
  getRunById: (...args: any[]) => mockGetRunById(...args),
  updateRun: (...args: any[]) => mockUpdateRun(...args),
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
  });

  describe('GET /api/storage/runs', () => {
    it('should return combined sample and real runs', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _source: {
                  id: 'run-123',
                  testCaseId: 'tc-123',
                  createdAt: '2024-02-01T00:00:00Z',
                },
              },
            ],
          },
        },
      });

      const { req, res } = createMocks({}, {}, { size: '50', from: '0' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'run-123' }),
            expect.objectContaining({ id: 'demo-run-1' }),
          ]),
        })
      );
    });

    it('should return only sample data when OpenSearch unavailable', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

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

    it('should fetch from OpenSearch for non-sample ID', async () => {
      mockGetRunById.mockResolvedValue({
        id: 'run-123',
        testCaseId: 'tc-123',
      });

      const { req, res } = createMocks({ id: 'run-123' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

      await handler(req, res);

      expect(mockGetRunById).toHaveBeenCalledWith('run-123');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-123' })
      );
    });

    it('should return 404 when run not found', async () => {
      mockGetRunById.mockResolvedValue(null);

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
      mockCreateRun.mockResolvedValue(newRun);

      const { req, res } = createMocks({}, { testCaseId: 'tc-123' });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs');

      await handler(req, res);

      expect(mockCreateRun).toHaveBeenCalled();
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
      mockUpdateRun.mockResolvedValue(updatedRun);

      const { req, res } = createMocks({ id: 'run-123' }, { status: 'completed' });
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(mockUpdateRun).toHaveBeenCalledWith('run-123', { status: 'completed' });
      expect(res.json).toHaveBeenCalledWith(updatedRun);
    });

    it('should return 404 when run not found', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockUpdateRun.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'run-nonexistent' }, { status: 'completed' });
      const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
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
      mockDelete.mockResolvedValue({ body: {} });

      const { req, res } = createMocks({ id: 'run-123' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

      await handler(req, res);

      expect(mockDelete).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ deleted: true });
    });

    it('should return 404 when run not found', async () => {
      const error: any = new Error('Not found');
      error.meta = { statusCode: 404 };
      mockDelete.mockRejectedValue(error);

      const { req, res } = createMocks({ id: 'run-nonexistent' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/storage/runs/search', () => {
    it('should search runs with filters', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'run-123', status: 'completed' } },
            ],
          },
        },
      });

      const { req, res } = createMocks({}, {
        experimentId: 'exp-123',
        status: 'completed',
        passFailStatus: 'passed',
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/search');

      await handler(req, res);

      expect(mockSearch).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });

    it('should filter sample data', async () => {
      mockSearch.mockResolvedValue({
        body: { hits: { hits: [] } },
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

    it('should handle date range filter', async () => {
      mockSearch.mockResolvedValue({
        body: { hits: { hits: [] } },
      });

      const { req, res } = createMocks({}, {
        dateRange: { start: '2024-01-01', end: '2024-02-01' },
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/search');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual(
        expect.objectContaining({
          range: expect.any(Object),
        })
      );
    });
  });

  describe('GET /api/storage/runs/by-test-case/:testCaseId', () => {
    it('should return runs for test case', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'run-123', testCaseId: 'tc-123' } },
            ],
          },
        },
      });

      const { req, res } = createMocks({ testCaseId: 'tc-123' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-test-case/:testCaseId');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });

    it('should return sample runs for demo test case', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

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
  });

  describe('GET /api/storage/runs/by-experiment/:experimentId', () => {
    it('should return runs for experiment', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'run-123', experimentId: 'exp-123' } },
            ],
          },
        },
      });

      const { req, res } = createMocks({ experimentId: 'exp-123' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-experiment/:experimentId');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });

    it('should return sample runs for demo experiment', async () => {
      mockSearch.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({ experimentId: 'demo-experiment-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-experiment/:experimentId');

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

  describe('GET /api/storage/runs/by-experiment-run/:experimentId/:runId', () => {
    it('should return runs for experiment run', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'run-123', experimentId: 'exp-123', experimentRunId: 'run-1' } },
            ],
          },
        },
      });

      const { req, res } = createMocks({ experimentId: 'exp-123', runId: 'run-1' });
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/by-experiment-run/:experimentId/:runId');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
        })
      );
    });
  });

  describe('GET /api/storage/runs/iterations/:experimentId/:testCaseId', () => {
    it('should return iterations', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'run-123', iteration: 1 } },
              { _source: { id: 'run-124', iteration: 2 } },
            ],
          },
        },
      });

      const { req, res } = createMocks(
        { experimentId: 'exp-123', testCaseId: 'tc-123' },
        {},
        {}
      );
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/iterations/:experimentId/:testCaseId');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.any(Array),
          total: expect.any(Number),
          maxIteration: expect.any(Number),
        })
      );
    });

    it('should filter by experimentRunId when provided', async () => {
      mockSearch.mockResolvedValue({
        body: { hits: { hits: [] } },
      });

      const { req, res } = createMocks(
        { experimentId: 'exp-123', testCaseId: 'tc-123' },
        {},
        { experimentRunId: 'run-1' }
      );
      const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/iterations/:experimentId/:testCaseId');

      await handler(req, res);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.must).toContainEqual({ term: { experimentRunId: 'run-1' } });
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
      mockUpdate.mockResolvedValue({ body: {} });

      const { req, res } = createMocks({ id: 'run-123' }, { text: 'Test annotation', tags: ['bug'] });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/:id/annotations');

      await handler(req, res);

      expect(mockUpdate).toHaveBeenCalled();
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
      mockUpdate.mockResolvedValue({ body: {} });

      const { req, res } = createMocks(
        { id: 'run-123', annotationId: 'ann-1' },
        { text: 'Updated annotation' }
      );
      const handler = getRouteHandler(runsRoutes, 'put', '/api/storage/runs/:id/annotations/:annotationId');

      await handler(req, res);

      expect(mockUpdate).toHaveBeenCalled();
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
      mockUpdate.mockResolvedValue({ body: {} });

      const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' });
      const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id/annotations/:annotationId');

      await handler(req, res);

      expect(mockUpdate).toHaveBeenCalled();
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
      mockBulk.mockResolvedValue({ body: { errors: false } });

      const { req, res } = createMocks({}, {
        runs: [
          { testCaseId: 'tc-1' },
          { testCaseId: 'tc-2' },
        ],
      });
      const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

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
});

describe('Runs Storage Routes - OpenSearch not configured', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { isStorageConfigured } = require('@/server/services/opensearchClient');
    (isStorageConfigured as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    const { isStorageConfigured } = require('@/server/services/opensearchClient');
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
  });

  it('GET /api/storage/runs/:id should return 404 for non-sample ID when not configured', async () => {
    const { req, res } = createMocks({ id: 'run-123' });
    const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('POST /api/storage/runs should return error when not configured', async () => {
    const { req, res } = createMocks({}, { testCaseId: 'tc-123' });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('not configured'),
      })
    );
  });

  it('PATCH /api/storage/runs/:id should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'run-123' }, { status: 'completed' });
    const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('DELETE /api/storage/runs/:id should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'run-123' });
    const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('POST /api/storage/runs/:id/annotations should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'run-123' }, { text: 'Test' });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/:id/annotations');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('PUT /api/storage/runs/:id/annotations/:annotationId should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' }, { text: 'Test' });
    const handler = getRouteHandler(runsRoutes, 'put', '/api/storage/runs/:id/annotations/:annotationId');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('DELETE /api/storage/runs/:id/annotations/:annotationId should return error when not configured', async () => {
    const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' });
    const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id/annotations/:annotationId');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('POST /api/storage/runs/bulk should return error when not configured', async () => {
    const { req, res } = createMocks({}, { runs: [] });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('Runs Storage Routes - Error Handling (500 errors)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { isStorageConfigured } = require('@/server/services/opensearchClient');
    (isStorageConfigured as jest.Mock).mockReturnValue(true);
  });

  it('GET /api/storage/runs/:id should handle errors', async () => {
    mockGetRunById.mockRejectedValue(new Error('Database error'));

    const { req, res } = createMocks({ id: 'run-123' });
    const handler = getRouteHandler(runsRoutes, 'get', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Database error' });
  });

  it('POST /api/storage/runs should handle errors', async () => {
    mockCreateRun.mockRejectedValue(new Error('Create failed'));

    const { req, res } = createMocks({}, { testCaseId: 'tc-123' });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Create failed' });
  });

  it('PATCH /api/storage/runs/:id should handle non-404 errors', async () => {
    mockUpdateRun.mockRejectedValue(new Error('Update failed'));

    const { req, res } = createMocks({ id: 'run-123' }, { status: 'completed' });
    const handler = getRouteHandler(runsRoutes, 'patch', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
  });

  it('DELETE /api/storage/runs/:id should handle non-404 errors', async () => {
    mockDelete.mockRejectedValue(new Error('Delete failed'));

    const { req, res } = createMocks({ id: 'run-123' });
    const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
  });

  it('POST /api/storage/runs/:id/annotations should handle errors', async () => {
    mockUpdate.mockRejectedValue(new Error('Update failed'));

    const { req, res } = createMocks({ id: 'run-123' }, { text: 'Test' });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/:id/annotations');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
  });

  it('PUT /api/storage/runs/:id/annotations/:annotationId should handle errors', async () => {
    mockUpdate.mockRejectedValue(new Error('Update failed'));

    const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' }, { text: 'Test' });
    const handler = getRouteHandler(runsRoutes, 'put', '/api/storage/runs/:id/annotations/:annotationId');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Update failed' });
  });

  it('DELETE /api/storage/runs/:id/annotations/:annotationId should handle errors', async () => {
    mockUpdate.mockRejectedValue(new Error('Delete failed'));

    const { req, res } = createMocks({ id: 'run-123', annotationId: 'ann-1' });
    const handler = getRouteHandler(runsRoutes, 'delete', '/api/storage/runs/:id/annotations/:annotationId');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Delete failed' });
  });

  it('POST /api/storage/runs/bulk should handle errors', async () => {
    mockBulk.mockRejectedValue(new Error('Bulk failed'));

    const { req, res } = createMocks({}, { runs: [{ testCaseId: 'tc-1' }] });
    const handler = getRouteHandler(runsRoutes, 'post', '/api/storage/runs/bulk');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bulk failed' });
  });
});
