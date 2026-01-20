/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import logsRoutes from '@/server/routes/logs';
import { fetchLogs, fetchLogsLegacy } from '@/server/services/logsService';

// Mock the logs service
jest.mock('@/server/services/logsService', () => ({
  fetchLogs: jest.fn(),
  fetchLogsLegacy: jest.fn(),
}));

const mockFetchLogs = fetchLogs as jest.MockedFunction<typeof fetchLogs>;
const mockFetchLogsLegacy = fetchLogsLegacy as jest.MockedFunction<typeof fetchLogsLegacy>;

// Helper to create mock request/response
function createMocks(body: any = {}) {
  const req = {
    body,
  } as Request;
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

describe('Logs Routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      OPENSEARCH_LOGS_ENDPOINT: 'http://localhost:9200',
      OPENSEARCH_LOGS_USERNAME: 'admin',
      OPENSEARCH_LOGS_PASSWORD: 'admin',
      OPENSEARCH_LOGS_INDEX: 'test-logs-*',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('POST /api/logs', () => {
    it('should return logs from service', async () => {
      const mockResult = {
        hits: { hits: [], total: { value: 1 } },
        logs: [{ timestamp: '2024-01-01', index: 'test-logs', message: 'Test log', level: 'info', source: 'test' }],
        total: 1,
      };
      mockFetchLogs.mockResolvedValue(mockResult);

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'test-run-123' }),
        expect.objectContaining({
          endpoint: 'http://localhost:9200',
          indexPattern: 'test-logs-*',
        })
      );
      expect(res.json).toHaveBeenCalledWith(mockResult);
    });

    it('should use default size of 100', async () => {
      mockFetchLogs.mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, logs: [] as any, total: 0 });

      const { req, res } = createMocks({ runId: 'test' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(
        expect.objectContaining({ size: 100 }),
        expect.any(Object)
      );
    });

    it('should accept custom size', async () => {
      mockFetchLogs.mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, logs: [] as any, total: 0 });

      const { req, res } = createMocks({ runId: 'test', size: 50 });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(
        expect.objectContaining({ size: 50 }),
        expect.any(Object)
      );
    });

    it('should pass query and time range filters', async () => {
      mockFetchLogs.mockResolvedValue({ hits: { hits: [], total: { value: 0 } }, logs: [] as any, total: 0 });

      const { req, res } = createMocks({
        runId: 'test',
        query: 'error',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-02T00:00:00Z',
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(mockFetchLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'error',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-02T00:00:00Z',
        }),
        expect.any(Object)
      );
    });

    it('should return 500 on service error', async () => {
      mockFetchLogs.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({ runId: 'test' });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('Connection refused'),
      });
    });
  });

  describe('POST /api/opensearch/logs (legacy)', () => {
    it('should return 400 when endpoint is missing', async () => {
      const { req, res } = createMocks({
        indexPattern: 'logs-*',
        query: { match_all: {} },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('endpoint'),
      });
    });

    it('should return 400 when indexPattern is missing', async () => {
      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        query: { match_all: {} },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('indexPattern'),
      });
    });

    it('should return 400 when query is missing', async () => {
      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('query'),
      });
    });

    it('should call legacy logs service', async () => {
      const mockResult = { hits: { hits: [], total: 0 } };
      mockFetchLogsLegacy.mockResolvedValue(mockResult);

      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: { match_all: {} },
        auth: { username: 'admin', password: 'admin' },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(mockFetchLogsLegacy).toHaveBeenCalledWith({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: { match_all: {} },
        auth: { username: 'admin', password: 'admin' },
      });
      expect(res.json).toHaveBeenCalledWith(mockResult);
    });

    it('should return 500 on proxy error', async () => {
      mockFetchLogsLegacy.mockRejectedValue(new Error('Network error'));

      const { req, res } = createMocks({
        endpoint: 'http://localhost:9200',
        indexPattern: 'logs-*',
        query: { match_all: {} },
      });
      const handler = getRouteHandler(logsRoutes, 'post', '/api/opensearch/logs');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('Network error'),
      });
    });
  });
});
