/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import adminRoutes from '@/server/routes/storage/admin';

// Mock client methods (still needed for init-indexes and OpenSearch stats path)
const mockClusterHealth = jest.fn();
const mockIndicesExists = jest.fn();
const mockIndicesCreate = jest.fn();
const mockIndicesPutSettings = jest.fn();
const mockIndicesPutMapping = jest.fn();
const mockIndicesDelete = jest.fn();
const mockIndicesGetSettings = jest.fn();
const mockReindex = jest.fn();
const mockCount = jest.fn();
const mockSearch = jest.fn();
const mockIndex = jest.fn();

// Create mock client
const mockClient = {
  cluster: { health: mockClusterHealth },
  indices: {
    exists: mockIndicesExists,
    create: mockIndicesCreate,
    putSettings: mockIndicesPutSettings,
    putMapping: mockIndicesPutMapping,
    delete: mockIndicesDelete,
    getSettings: mockIndicesGetSettings,
  },
  reindex: mockReindex,
  count: mockCount,
  search: mockSearch,
  index: mockIndex,
};

// Mock storage module methods returned by getStorageModule()
const mockTestCasesGetAll = jest.fn();
const mockBenchmarksGetAll = jest.fn();
const mockRunsGetAll = jest.fn();
const mockAnalyticsBackfill = jest.fn();
const mockStorageHealth = jest.fn();
const mockStorageIsConfigured = jest.fn().mockReturnValue(true);

const mockStorageModule = {
  testCases: { getAll: mockTestCasesGetAll },
  benchmarks: { getAll: mockBenchmarksGetAll },
  runs: { getAll: mockRunsGetAll },
  analytics: { backfill: mockAnalyticsBackfill },
  health: mockStorageHealth,
  isConfigured: mockStorageIsConfigured,
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

// Mock @opensearch-project/opensearch Client constructor
jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({})),
}));

// Mock opensearchClientFactory
jest.mock('@/server/services/opensearchClientFactory', () => ({
  createOpenSearchClient: jest.fn().mockReturnValue({ close: jest.fn() }),
}));

// Mock adapters - includes getStorageModule, testStorageConnection, isFileStorage, setStorageModule, and module constructors
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn(),
  testStorageConnection: jest.fn(),
  isFileStorage: jest.fn().mockReturnValue(false),
  setStorageModule: jest.fn(),
  OpenSearchStorageModule: jest.fn().mockImplementation(() => ({ type: 'opensearch' })),
  FileStorageModule: jest.fn().mockImplementation(() => ({ type: 'file' })),
}));

// Mock indexInitializer
jest.mock('@/server/services/indexInitializer', () => ({
  ensureIndexes: jest.fn(),
  ensureIndexesWithValidation: jest.fn(),
}));

// Mock mappingFixer
jest.mock('@/server/services/mappingFixer', () => ({
  reindexSingleIndex: jest.fn(),
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
import { getStorageModule, testStorageConnection, isFileStorage, setStorageModule, OpenSearchStorageModule, FileStorageModule } from '@/server/adapters/index';

// Import mocked indexInitializer
import { ensureIndexes, ensureIndexesWithValidation } from '@/server/services/indexInitializer';
const mockEnsureIndexes = ensureIndexes as jest.Mock;
const mockEnsureIndexesWithValidation = ensureIndexesWithValidation as jest.Mock;

// Import mocked mappingFixer
import { reindexSingleIndex } from '@/server/services/mappingFixer';
const mockReindexSingleIndex = reindexSingleIndex as jest.Mock;

// Import mocked configService functions
import {
  getConfigStatus,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
} from '@/server/services/configService';

const mockGetStorageModule = getStorageModule as jest.Mock;
const mockTestStorageConnection = testStorageConnection as jest.Mock;
const mockIsFileStorage = isFileStorage as jest.Mock;
const mockSetStorageModule = setStorageModule as jest.Mock;
const MockOpenSearchStorageModule = OpenSearchStorageModule as jest.Mock;
const MockFileStorageModule = FileStorageModule as jest.Mock;

const mockGetConfigStatus = getConfigStatus as jest.Mock;
const mockSaveStorageConfig = saveStorageConfig as jest.Mock;
const mockSaveObservabilityConfig = saveObservabilityConfig as jest.Mock;
const mockClearStorageConfig = clearStorageConfig as jest.Mock;
const mockClearObservabilityConfig = clearObservabilityConfig as jest.Mock;
import { resolveStorageConfig } from '@/server/middleware/dataSourceConfig';

const mockResolveStorageConfig = resolveStorageConfig as jest.Mock;

// Mock index mappings
jest.mock('@/server/constants/indexMappings', () => ({
  INDEX_MAPPINGS: {
    'test-cases-index': { mappings: { properties: { id: { type: 'keyword' } } } },
    'experiments-index': {
      settings: { 'index.mapping.total_fields.limit': 5000 },
      mappings: { properties: { id: { type: 'keyword' }, runs: { type: 'nested' } } },
    },
    'runs-index': {
      settings: { 'index.mapping.total_fields.limit': 2000 },
      mappings: { properties: { id: { type: 'keyword' } } },
    },
    'analytics-index': { mappings: { properties: { analyticsId: { type: 'keyword' } } } },
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
    // Default: storage is available (for OpenSearch path)
    (isStorageAvailable as jest.Mock).mockReturnValue(true);
    (requireStorageClient as jest.Mock).mockReturnValue(mockClient);
    // Default: config resolved
    mockResolveStorageConfig.mockReturnValue({ endpoint: 'https://localhost:9200' });
    // Default: not file storage (OpenSearch mode)
    mockIsFileStorage.mockReturnValue(false);
    // Default: getStorageModule returns the mock storage module
    mockGetStorageModule.mockReturnValue(mockStorageModule);
    // Default: ensureIndexes returns success for all indexes
    mockEnsureIndexes.mockResolvedValue({
      'test-cases-index': { status: 'created' },
      'experiments-index': { status: 'created' },
      'runs-index': { status: 'created' },
      'analytics-index': { status: 'created' },
    });
    // Default: ensureIndexesWithValidation returns success with no fixes needed
    mockEnsureIndexesWithValidation.mockResolvedValue({
      indexResults: {
        'test-cases-index': { status: 'created' },
        'experiments-index': { status: 'created' },
        'runs-index': { status: 'created' },
        'analytics-index': { status: 'created' },
      },
      validationResults: [],
    });
    // Default: reindexSingleIndex returns success
    mockReindexSingleIndex.mockResolvedValue({ documentsReindexed: 5 });
    // Default: getSettings returns typical index settings
    mockIndicesGetSettings.mockResolvedValue({
      body: { 'experiments-index': { settings: { index: { number_of_shards: '1', number_of_replicas: '1' } } } },
    });
  });

  // ============================================================================
  // Health Check Tests
  // ============================================================================

  describe('GET /api/storage/health', () => {
    it('should return health from storage module when using OpenSearch backend', async () => {
      mockStorageHealth.mockResolvedValue({
        status: 'ok',
        cluster: { status: 'green', name: 'test-cluster' },
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(mockGetStorageModule).toHaveBeenCalled();
      expect(mockStorageHealth).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        cluster: { status: 'green', name: 'test-cluster' },
      });
    });

    it('should return file backend status when using file storage', async () => {
      mockIsFileStorage.mockReturnValue(true);
      mockStorageHealth.mockResolvedValue({ status: 'ok' });
      mockResolveStorageConfig.mockReturnValue(null);

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        backend: 'file',
      });
    });

    it('should include OpenSearch connectivity when file storage is active but OpenSearch is configured', async () => {
      mockIsFileStorage.mockReturnValue(true);
      mockStorageHealth.mockResolvedValue({ status: 'ok' });
      mockResolveStorageConfig.mockReturnValue({ endpoint: 'https://localhost:9200' });
      mockTestStorageConnection.mockResolvedValue({
        status: 'ok',
        clusterName: 'test-cluster',
        clusterStatus: 'green',
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(mockTestStorageConnection).toHaveBeenCalledWith({ endpoint: 'https://localhost:9200' });
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        backend: 'file',
        opensearch: {
          status: 'ok',
          clusterName: 'test-cluster',
          clusterStatus: 'green',
        },
      });
    });

    it('should return error status on health check failure', async () => {
      mockStorageHealth.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: 'Connection refused',
      });
    });
  });

  // ============================================================================
  // Init Indexes Tests (still uses raw OpenSearch client)
  // ============================================================================

  describe('POST /api/storage/init-indexes', () => {
    it('should delegate to ensureIndexes and return results', async () => {
      mockEnsureIndexes.mockResolvedValue({
        'test-cases-index': { status: 'created' },
        'experiments-index': { status: 'exists', settingsUpdated: true, mappingsUpdated: true },
        'runs-index': { status: 'created' },
        'analytics-index': { status: 'error', error: 'Cluster read-only' },
      });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/init-indexes');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockEnsureIndexes).toHaveBeenCalledWith(mockClient);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        results: {
          'test-cases-index': { status: 'created' },
          'experiments-index': { status: 'exists', settingsUpdated: true, mappingsUpdated: true },
          'runs-index': { status: 'created' },
          'analytics-index': { status: 'error', error: 'Cluster read-only' },
        },
      });
    });

    it('should return error when storage not available (file storage mode)', async () => {
      (isStorageAvailable as jest.Mock).mockReturnValue(false);

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/init-indexes');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'OpenSearch storage not configured. File storage does not require index initialization.',
      });
      expect(mockEnsureIndexes).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Reindex Tests
  // ============================================================================

  describe('POST /api/storage/reindex', () => {
    it('should reindex an existing index successfully using reindexSingleIndex service', async () => {
      mockIndicesExists.mockResolvedValueOnce({ body: true }); // source exists
      mockReindexSingleIndex.mockResolvedValue({ documentsReindexed: 5 });

      const { req, res, jsonPromise } = createMocks({}, { index: 'experiments-index' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/reindex');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockReindexSingleIndex).toHaveBeenCalledWith(mockClient, 'experiments-index');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        index: 'experiments-index',
        documentsReindexed: 5,
      });
    });

    it('should return 400 when index is not provided', async () => {
      const { req, res, jsonPromise } = createMocks({}, {});
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/reindex');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'index is required in request body' });
    });

    it('should return 400 for unknown index name', async () => {
      const { req, res, jsonPromise } = createMocks({}, { index: 'unknown-index' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/reindex');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Unknown index') })
      );
    });

    it('should return 404 when source index does not exist', async () => {
      mockIndicesExists.mockResolvedValueOnce({ body: false }); // source doesn't exist

      const { req, res, jsonPromise } = createMocks({}, { index: 'experiments-index' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/reindex');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('does not exist') })
      );
    });

    it('should handle reindex failure and report temp index status', async () => {
      mockIndicesExists
        .mockResolvedValueOnce({ body: true })   // source exists
        .mockResolvedValueOnce({ body: true });   // temp still exists after failure
      mockReindexSingleIndex.mockRejectedValue(new Error('Reindex timeout'));

      const { req, res, jsonPromise } = createMocks({}, { index: 'experiments-index' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/reindex');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Reindex failed'),
          tempIndex: 'experiments-index_reindex_temp',
          hint: expect.stringContaining('still exists'),
        })
      );
    });

    it('should return error when storage not available', async () => {
      (isStorageAvailable as jest.Mock).mockReturnValue(false);

      const { req, res, jsonPromise } = createMocks({}, { index: 'experiments-index' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/reindex');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'OpenSearch storage not configured.' });
    });
  });

  // ============================================================================
  // Stats Tests
  // ============================================================================

  describe('GET /api/storage/stats', () => {
    it('should return document counts from OpenSearch when not file storage', async () => {
      mockIsFileStorage.mockReturnValue(false);
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

    it('should handle count errors per index in OpenSearch mode', async () => {
      mockIsFileStorage.mockReturnValue(false);
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

    it('should return file-based counts when using file storage', async () => {
      mockIsFileStorage.mockReturnValue(true);
      mockTestCasesGetAll.mockResolvedValue({ items: [], total: 5 });
      mockBenchmarksGetAll.mockResolvedValue({ items: [], total: 3 });
      mockRunsGetAll.mockResolvedValue({ items: [], total: 12 });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/stats');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockGetStorageModule).toHaveBeenCalled();
      expect(mockTestCasesGetAll).toHaveBeenCalled();
      expect(mockBenchmarksGetAll).toHaveBeenCalled();
      expect(mockRunsGetAll).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        stats: {
          test_cases: { count: 5 },
          benchmarks: { count: 3 },
          runs: { count: 12 },
          analytics: { count: 0 },
        },
        backend: 'file',
      });
    });

    it('should handle file storage stats errors', async () => {
      mockIsFileStorage.mockReturnValue(true);
      mockTestCasesGetAll.mockRejectedValue(new Error('Disk read error'));

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/stats');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.json).toHaveBeenCalledWith({
        stats: {},
        error: 'Disk read error',
        backend: 'file',
      });
    });

    it('should return unconfigured stats when OpenSearch storage not available', async () => {
      mockIsFileStorage.mockReturnValue(false);
      (isStorageAvailable as jest.Mock).mockReturnValue(false);

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'get', '/api/storage/stats');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            'test-cases-index': { count: 0, error: 'Storage not configured' },
          }),
        })
      );
    });
  });

  // ============================================================================
  // Backfill Analytics Tests (now uses storage adapter)
  // ============================================================================

  describe('POST /api/storage/backfill-analytics', () => {
    it('should backfill analytics via storage adapter', async () => {
      mockAnalyticsBackfill.mockResolvedValue({
        backfilled: 2,
        errors: 0,
        total: 2,
      });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/backfill-analytics');

      await callHandler(handler, req, res, jsonPromise);

      expect(mockGetStorageModule).toHaveBeenCalled();
      expect(mockAnalyticsBackfill).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        backfilled: 2,
        errors: 0,
        total: 2,
      });
    });

    it('should handle backfill errors', async () => {
      mockAnalyticsBackfill.mockResolvedValue({
        backfilled: 1,
        errors: 1,
        total: 2,
      });

      const { req, res, jsonPromise } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/backfill-analytics');

      await callHandler(handler, req, res, jsonPromise);

      expect(res.json).toHaveBeenCalledWith({
        backfilled: 1,
        errors: 1,
        total: 2,
      });
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
    it('should save storage config, validate mappings, and switch storage module', async () => {
      const setupResult = {
        indexResults: {
          'test-cases-index': { status: 'created' },
          'experiments-index': { status: 'created' },
        },
        validationResults: [
          { indexName: 'test-cases-index', status: 'ok', issues: [], documentCount: 0 },
        ],
      };
      mockEnsureIndexesWithValidation.mockResolvedValue(setupResult);

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
        tlsSkipVerify: undefined,
      });
      expect(mockEnsureIndexesWithValidation).toHaveBeenCalled();
      expect(MockOpenSearchStorageModule).toHaveBeenCalled();
      expect(mockSetStorageModule).toHaveBeenCalledWith(expect.any(Object));
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Storage configuration saved',
        connected: true,
        indexResults: setupResult.indexResults,
        validationResults: setupResult.validationResults,
        fixResults: undefined,
        needsReindex: false,
      });
    });

    it('should return needsReindex true when validation finds issues', async () => {
      const setupResult = {
        indexResults: { 'runs-index': { status: 'exists' } },
        validationResults: [
          {
            indexName: 'runs-index',
            status: 'needs_reindex',
            issues: [{ field: 'id', expectedType: 'keyword', actualType: 'text' }],
            documentCount: 42,
          },
        ],
        fixResults: [
          { indexName: 'runs-index', status: 'completed', documentCount: 42 },
        ],
      };
      mockEnsureIndexesWithValidation.mockResolvedValue(setupResult);

      const { req, res } = createMocks({}, {
        endpoint: 'https://new-storage.com',
      });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/storage');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          needsReindex: false,
          fixResults: setupResult.fixResults,
        })
      );
    });

    it('should return needsReindex true when fix failed', async () => {
      const setupResult = {
        indexResults: { 'runs-index': { status: 'exists' } },
        validationResults: [
          {
            indexName: 'runs-index',
            status: 'needs_reindex',
            issues: [{ field: 'id', expectedType: 'keyword', actualType: 'text' }],
            documentCount: 42,
          },
        ],
        fixResults: [
          { indexName: 'runs-index', status: 'failed', error: 'Reindex timeout' },
        ],
      };
      mockEnsureIndexesWithValidation.mockResolvedValue(setupResult);

      const { req, res } = createMocks({}, {
        endpoint: 'https://new-storage.com',
      });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/storage');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          needsReindex: true,
          fixResults: setupResult.fixResults,
        })
      );
      // Storage module should still be set despite fix failure
      expect(mockSetStorageModule).toHaveBeenCalled();
    });

    it('should require endpoint', async () => {
      const { req, res } = createMocks({}, { username: 'user' });
      const handler = getRouteHandler(adminRoutes, 'post', '/api/storage/config/storage');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Endpoint is required' });
      expect(mockSetStorageModule).not.toHaveBeenCalled();
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
    it('should clear storage config and revert to file storage', async () => {
      const { req, res } = createMocks();
      const handler = getRouteHandler(adminRoutes, 'delete', '/api/storage/config/storage');

      await handler(req, res);

      expect(mockClearStorageConfig).toHaveBeenCalled();
      expect(MockFileStorageModule).toHaveBeenCalled();
      expect(mockSetStorageModule).toHaveBeenCalledWith(expect.any(Object));
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
      expect(mockSetStorageModule).not.toHaveBeenCalled();
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
