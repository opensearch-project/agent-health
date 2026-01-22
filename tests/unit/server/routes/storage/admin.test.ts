/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import adminRoutes from '@/server/routes/storage/admin';

// Mock client methods
const mockClusterHealth = jest.fn();
const mockIndicesExists = jest.fn();
const mockIndicesCreate = jest.fn();
const mockCount = jest.fn();
const mockSearch = jest.fn();
const mockIndex = jest.fn();

// Create mock client
const mockClient = {
  cluster: { health: mockClusterHealth },
  indices: { exists: mockIndicesExists, create: mockIndicesCreate },
  count: mockCount,
  search: mockSearch,
  index: mockIndex,
};

// Mock the storageClient middleware
jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn(),
  requireStorageClient: jest.fn(),
  INDEXES: {
    testCases: 'test-cases-index',
    experiments: 'experiments-index',
    runs: 'runs-index',
    analytics: 'analytics-index',
  },
}));

// Mock dataSourceConfig
jest.mock('@/server/middleware/dataSourceConfig', () => ({
  resolveStorageConfig: jest.fn(),
}));

// Mock adapters
jest.mock('@/server/adapters/index', () => ({
  testStorageConnection: jest.fn(),
}));

// Mock configService
jest.mock('@/server/services/configService', () => ({
  getConfigStatus: jest.fn(),
  saveStorageConfig: jest.fn(),
  saveObservabilityConfig: jest.fn(),
  clearStorageConfig: jest.fn(),
  clearObservabilityConfig: jest.fn(),
}));

// Import mocked adapter functions
import { testStorageConnection } from '@/server/adapters/index';

// Import mocked configService functions
import {
  getConfigStatus,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
} from '@/server/services/configService';

const mockGetConfigStatus = getConfigStatus as jest.Mock;
const mockSaveStorageConfig = saveStorageConfig as jest.Mock;
const mockSaveObservabilityConfig = saveObservabilityConfig as jest.Mock;
const mockClearStorageConfig = clearStorageConfig as jest.Mock;
const mockClearObservabilityConfig = clearObservabilityConfig as jest.Mock;
import { resolveStorageConfig } from '@/server/middleware/dataSourceConfig';

const mockTestStorageConnection = testStorageConnection as jest.Mock;
const mockResolveStorageConfig = resolveStorageConfig as jest.Mock;

// Mock index mappings
jest.mock('@/server/constants/indexMappings', () => ({
  INDEX_MAPPINGS: {
    'test-cases-index': { mappings: {} },
    'experiments-index': { mappings: {} },
    'runs-index': { mappings: {} },
    'analytics-index': { mappings: {} },
  },
}));

// Import mocked functions
import {
  isStorageAvailable,
  requireStorageClient,
} from '@/server/middleware/storageClient';

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
    storageClient: mockClient,
    storageConfig: { endpoint: 'https://localhost:9200' },
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
    // Default: storage is available
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
    // Default: config resolved
    mockResolveStorageConfig.mockReturnValue({ endpoint: 'https://localhost:9200' });
  });

  describe('GET /api/storage/health', () => {
    it('should return ok status when cluster is healthy', async () => {
      mockTestStorageConnection.mockResolvedValue({
        status: 'ok',
        clusterName: 'test-cluster',
        clusterStatus: 'green',
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(mockTestStorageConnection).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          cluster: expect.objectContaining({ status: 'green' }),
        })
      );
    });

    it('should return not_configured when storage not configured', async () => {
      mockResolveStorageConfig.mockReturnValue(null);

      const { req, res } = createMocks();
      req.storageClient = null;
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'not_configured',
        message: 'Storage not configured',
      });
    });

    it('should return error status on health check failure', async () => {
      mockTestStorageConnection.mockResolvedValue({
        status: 'error',
        message: 'Connection refused',
      });

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

  // ============================================================================
  // Configuration Management Tests
  // ============================================================================

  describe('GET /api/storage/config/status', () => {
    it('should return config status', async () => {
      mockGetConfigStatus.mockReturnValue({
        storage: { configured: true, source: 'file', endpoint: 'https://storage.com' },
        observability: { configured: true, source: 'environment', endpoint: 'https://obs.com' },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/config/status');

      await handler(req, res);

      expect(mockGetConfigStatus).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        storage: { configured: true, source: 'file', endpoint: 'https://storage.com' },
        observability: { configured: true, source: 'environment', endpoint: 'https://obs.com' },
      });
    });

    it('should handle errors', async () => {
      mockGetConfigStatus.mockImplementation(() => {
        throw new Error('Config read failed');
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/config/status');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Config read failed' });
    });
  });

  describe('POST /api/storage/config/storage', () => {
    it('should save storage config', async () => {
      const { req, res } = createMocks({}, {
        endpoint: 'https://new-storage.com',
        username: 'user',
        password: 'pass',
      });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/storage');

      await handler(req, res);

      expect(mockSaveStorageConfig).toHaveBeenCalledWith({
        endpoint: 'https://new-storage.com',
        username: 'user',
        password: 'pass',
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Storage configuration saved',
      });
    });

    it('should require endpoint', async () => {
      const { req, res } = createMocks({}, { username: 'user' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/storage');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Endpoint is required' });
    });
  });

  describe('POST /api/storage/config/observability', () => {
    it('should save observability config', async () => {
      const { req, res } = createMocks({}, {
        endpoint: 'https://new-obs.com',
        username: 'user',
        indexes: { traces: 'traces-*' },
      });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/observability');

      await handler(req, res);

      expect(mockSaveObservabilityConfig).toHaveBeenCalledWith({
        endpoint: 'https://new-obs.com',
        username: 'user',
        indexes: { traces: 'traces-*' },
      });
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Observability configuration saved',
      });
    });

    it('should require endpoint', async () => {
      const { req, res } = createMocks({}, { indexes: { traces: 'traces-*' } });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/observability');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Endpoint is required' });
    });
  });

  describe('DELETE /api/storage/config/storage', () => {
    it('should clear storage config', async () => {
      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'delete', '/api/storage/config/storage');

      await handler(req, res);

      expect(mockClearStorageConfig).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Storage configuration cleared',
      });
    });

    it('should handle clear errors', async () => {
      mockClearStorageConfig.mockImplementation(() => {
        throw new Error('Clear failed');
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'delete', '/api/storage/config/storage');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Clear failed' });
    });
  });

  describe('DELETE /api/storage/config/observability', () => {
    it('should clear observability config', async () => {
      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'delete', '/api/storage/config/observability');

      await handler(req, res);

      expect(mockClearObservabilityConfig).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Observability configuration cleared',
      });
    });
  });
});
