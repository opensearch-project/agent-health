/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import adminRoutes from '@/server/routes/storage/admin';

// Mock the opensearchClient
const mockClusterHealth = jest.fn();
const mockIndicesExists = jest.fn();
const mockIndicesCreate = jest.fn();
const mockCount = jest.fn();
const mockSearch = jest.fn();
const mockIndex = jest.fn();

jest.mock('@/server/services/opensearchClient', () => ({
  getOpenSearchClient: () => ({
    cluster: { health: mockClusterHealth },
    indices: { exists: mockIndicesExists, create: mockIndicesCreate },
    count: mockCount,
    search: mockSearch,
    index: mockIndex,
  }),
  isStorageConfigured: jest.fn().mockReturnValue(true),
  INDEXES: {
    testCases: 'test-cases-index',
    experiments: 'experiments-index',
    runs: 'runs-index',
    analytics: 'analytics-index',
  },
}));

// Mock index mappings
jest.mock('@/server/constants/indexMappings', () => ({
  INDEX_MAPPINGS: {
    'test-cases-index': { mappings: {} },
    'experiments-index': { mappings: {} },
    'runs-index': { mappings: {} },
    'analytics-index': { mappings: {} },
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

// Helper to create mock request/response with promise-based json tracking
function createMocks(params: any = {}, body: any = {}, query: any = {}) {
  let resolveJson: (value: any) => void;
  const jsonPromise = new Promise((resolve) => {
    resolveJson = resolve;
  });

  const req = {
    params,
    body,
    query,
  } as unknown as Request;
  const res = {
    json: jest.fn().mockImplementation((data) => {
      resolveJson!(data);
      return res;
    }),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res, jsonPromise };
}

// Helper to get route handler - handles wrapped async handlers
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

// Helper to call async wrapped handlers with proper error handling
async function callHandler(handler: any, req: Request, res: Response, jsonPromise: Promise<any>) {
  const next = jest.fn();
  handler(req, res, next);
  // Wait for response or error
  await jsonPromise;
  // If next was called with an error, throw it
  if (next.mock.calls.length > 0 && next.mock.calls[0][0]) {
    throw next.mock.calls[0][0];
  }
}

describe('Admin Storage Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/storage/health', () => {
    it('should return ok status when cluster is healthy', async () => {
      mockClusterHealth.mockResolvedValue({
        body: { status: 'green', cluster_name: 'test-cluster' },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(mockClusterHealth).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          cluster: expect.objectContaining({ status: 'green' }),
        })
      );
    });

    it('should return not_configured when storage not configured', async () => {
      const { isStorageConfigured } = require('@/server/services/opensearchClient');
      (isStorageConfigured as jest.Mock).mockReturnValueOnce(false);

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'not_configured',
        message: 'Storage environment variables not set',
      });
    });

    it('should return error status on health check failure', async () => {
      mockClusterHealth.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: 'Connection refused',
      });
    });
  });

  describe('POST /api/storage/init-indexes', () => {
    it('should create indexes that do not exist', async () => {
      mockIndicesExists.mockResolvedValue({ body: false });
      mockIndicesCreate.mockResolvedValue({ body: { acknowledged: true } });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/init-indexes');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockIndicesExists).toHaveBeenCalled();
      expect(mockIndicesCreate).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: expect.objectContaining({
            'test-cases-index': { status: 'created' },
          }),
        })
      );
    });

    it('should skip indexes that already exist', async () => {
      mockIndicesExists.mockResolvedValue({ body: true });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/init-indexes');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockIndicesCreate).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: expect.objectContaining({
            'test-cases-index': { status: 'exists' },
          }),
        })
      );
    });

    it('should handle index creation errors', async () => {
      mockIndicesExists.mockResolvedValue({ body: false });
      mockIndicesCreate.mockRejectedValue(new Error('Index creation failed'));

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/init-indexes');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          results: expect.objectContaining({
            'test-cases-index': { status: 'error', error: 'Index creation failed' },
          }),
        })
      );
    });
  });

  describe('GET /api/storage/stats', () => {
    it('should return document counts for all indexes', async () => {
      mockCount.mockResolvedValue({ body: { count: 100 } });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/stats');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockCount).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            'test-cases-index': { count: 100 },
          }),
        })
      );
    });

    it('should handle count errors per index', async () => {
      mockCount.mockRejectedValue(new Error('Index not found'));

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/stats');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            'test-cases-index': { count: 0, error: 'Index not found' },
          }),
        })
      );
    });
  });

  describe('POST /api/storage/backfill-analytics', () => {
    it('should backfill analytics from runs', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _source: {
                  id: 'run-1',
                  experimentId: 'exp-1',
                  testCaseId: 'tc-1',
                  passFailStatus: 'passed',
                  metrics: { accuracy: 0.9 },
                },
              },
              {
                _source: {
                  id: 'run-2',
                  experimentId: 'exp-1',
                  testCaseId: 'tc-2',
                  passFailStatus: 'failed',
                },
              },
            ],
          },
        },
      });
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/backfill-analytics');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockSearch).toHaveBeenCalled();
      expect(mockIndex).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalledWith({
        backfilled: 2,
        errors: 0,
        total: 2,
      });
    });

    it('should handle backfill errors for individual runs', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'run-1' } },
              { _source: { id: 'run-2' } },
            ],
          },
        },
      });
      mockIndex
        .mockResolvedValueOnce({ body: { result: 'created' } })
        .mockRejectedValueOnce(new Error('Index failed'));

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/backfill-analytics');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.json).toHaveBeenCalledWith({
        backfilled: 1,
        errors: 1,
        total: 2,
      });
    });

    it('should flatten metrics with metric_ prefix', async () => {
      mockSearch.mockResolvedValue({
        body: {
          hits: {
            hits: [
              {
                _source: {
                  id: 'run-1',
                  metrics: { accuracy: 0.9, faithfulness: 0.85 },
                },
              },
            ],
          },
        },
      });
      mockIndex.mockResolvedValue({ body: { result: 'created' } });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/backfill-analytics');

      await callHandler(handler, req, res, jsonPromise);

      const indexCall = mockIndex.mock.calls[0][0];
      expect(indexCall.body.metric_accuracy).toBe(0.9);
      expect(indexCall.body.metric_faithfulness).toBe(0.85);
    });
  });
});
