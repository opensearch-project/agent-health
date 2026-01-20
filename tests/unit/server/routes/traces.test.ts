/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import tracesRoutes from '@/server/routes/traces';
import { fetchTraces, checkTracesHealth } from '@/server/services/tracesService';
import {
  getSampleSpansForRunIds,
  getSampleSpansByTraceId,
  getAllSampleTraceSpans,
  isSampleTraceId,
} from '@/cli/demo/sampleTraces';

// Mock the traces service
jest.mock('@/server/services/tracesService', () => ({
  fetchTraces: jest.fn(),
  checkTracesHealth: jest.fn(),
}));

// Mock the sample traces
jest.mock('@/cli/demo/sampleTraces', () => ({
  getSampleSpansForRunIds: jest.fn().mockReturnValue([]),
  getSampleSpansByTraceId: jest.fn().mockReturnValue([]),
  getAllSampleTraceSpans: jest.fn().mockReturnValue([]),
  isSampleTraceId: jest.fn().mockReturnValue(false),
}));

const mockFetchTraces = fetchTraces as jest.MockedFunction<typeof fetchTraces>;
const mockCheckTracesHealth = checkTracesHealth as jest.MockedFunction<typeof checkTracesHealth>;
const mockGetSampleSpansForRunIds = getSampleSpansForRunIds as jest.MockedFunction<typeof getSampleSpansForRunIds>;
const mockGetSampleSpansByTraceId = getSampleSpansByTraceId as jest.MockedFunction<typeof getSampleSpansByTraceId>;
const mockGetAllSampleTraceSpans = getAllSampleTraceSpans as jest.MockedFunction<typeof getAllSampleTraceSpans>;
const mockIsSampleTraceId = isSampleTraceId as jest.MockedFunction<typeof isSampleTraceId>;

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

describe('Traces Routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      OPENSEARCH_LOGS_ENDPOINT: 'http://localhost:9200',
      OPENSEARCH_LOGS_USERNAME: 'admin',
      OPENSEARCH_LOGS_PASSWORD: 'admin',
      OPENSEARCH_LOGS_TRACES_INDEX: 'otel-traces-*',
    };
    mockGetSampleSpansForRunIds.mockReturnValue([]);
    mockGetSampleSpansByTraceId.mockReturnValue([]);
    mockGetAllSampleTraceSpans.mockReturnValue([]);
    mockIsSampleTraceId.mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('POST /api/traces', () => {
    it('should return 400 when no filter provided', async () => {
      const { req, res } = createMocks({});
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('traceId, runIds, or time range'),
      });
    });

    it('should accept traceId filter', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });

      const { req, res } = createMocks({ traceId: 'trace-123' });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 'trace-123' }),
        expect.any(Object)
      );
      expect(res.json).toHaveBeenCalledWith({ spans: [], total: 0 });
    });

    it('should accept runIds filter', async () => {
      mockFetchTraces.mockResolvedValue({
        spans: [{ traceId: 't1', spanId: 's1', name: 'test', startTime: '2024-01-01', endTime: '2024-01-01', duration: 100, status: 'OK' as const, attributes: {}, events: [] }],
        total: 1,
      });

      const { req, res } = createMocks({ runIds: ['run-1', 'run-2'] });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ runIds: ['run-1', 'run-2'] }),
        expect.any(Object)
      );
    });

    it('should accept time range filter', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });

      const { req, res } = createMocks({
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-02T00:00:00Z',
      });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-02T00:00:00Z',
        }),
        expect.any(Object)
      );
    });

    it('should return sample spans for sample trace ID', async () => {
      const sampleSpans = [
        { traceId: 'sample-trace-1', spanId: 'ss1', name: 'sample' },
      ];
      mockIsSampleTraceId.mockReturnValue(true);
      mockGetSampleSpansByTraceId.mockReturnValue(sampleSpans as any);
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });

      const { req, res } = createMocks({ traceId: 'sample-trace-1' });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockGetSampleSpansByTraceId).toHaveBeenCalledWith('sample-trace-1');
      expect(res.json).toHaveBeenCalledWith({
        spans: sampleSpans,
        total: 1,
      });
    });

    it('should merge sample and real spans', async () => {
      const sampleSpans = [{ traceId: 'sample', spanId: 'ss1', name: 'sample' }];
      const realSpans = [{ traceId: 'real', spanId: 'rs1', name: 'real' }];

      mockGetSampleSpansForRunIds.mockReturnValue(sampleSpans as any);
      mockFetchTraces.mockResolvedValue({ spans: realSpans as any, total: 1 });

      const { req, res } = createMocks({ runIds: ['run-1'] });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        spans: [...sampleSpans, ...realSpans],
        total: 2,
      });
    });

    it('should use default size of 500', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });

      const { req, res } = createMocks({ traceId: 'trace-123' });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ size: 500 }),
        expect.any(Object)
      );
    });

    it('should return only sample data when logs not configured', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = '';
      const sampleSpans = [{ traceId: 'sample', spanId: 'ss1', name: 'sample' }];
      mockGetSampleSpansForRunIds.mockReturnValue(sampleSpans as any);

      const { req, res } = createMocks({ runIds: ['run-1'] });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        spans: sampleSpans,
        total: 1,
      });
    });

    it('should return sample data when logs fetch fails', async () => {
      const sampleSpans = [{ traceId: 'sample', spanId: 'ss1', name: 'sample' }];
      mockGetSampleSpansForRunIds.mockReturnValue(sampleSpans as any);
      mockFetchTraces.mockRejectedValue(new Error('Connection failed'));

      const { req, res } = createMocks({ runIds: ['run-1'] });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        spans: sampleSpans,
        total: 1,
      });
    });

    it('should return 500 on unexpected error', async () => {
      // Make sample spans throw
      mockGetSampleSpansForRunIds.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const { req, res } = createMocks({ runIds: ['run-1'] });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unexpected error',
      });
    });
  });

  describe('GET /api/traces/health', () => {
    it('should return sample_only when logs not configured', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = '';
      mockGetAllSampleTraceSpans.mockReturnValue([{ id: '1' }, { id: '2' }] as any);

      const { req, res } = createMocks();
      const handler = getRouteHandler(tracesRoutes, 'get', '/api/traces/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'sample_only',
        message: expect.stringContaining('not configured'),
        sampleTraceCount: 2,
      });
    });

    it('should call checkTracesHealth when configured', async () => {
      const healthResult = {
        status: 'ok' as const,
        index: 'otel-traces-*',
      };
      mockCheckTracesHealth.mockResolvedValue(healthResult);

      const { req, res } = createMocks();
      const handler = getRouteHandler(tracesRoutes, 'get', '/api/traces/health');

      await handler(req, res);

      expect(mockCheckTracesHealth).toHaveBeenCalledWith({
        endpoint: 'http://localhost:9200',
        username: 'admin',
        password: 'admin',
        indexPattern: 'otel-traces-*',
      });
      expect(res.json).toHaveBeenCalledWith(healthResult);
    });

    it('should return error status on health check failure', async () => {
      mockCheckTracesHealth.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(tracesRoutes, 'get', '/api/traces/health');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: 'Connection refused',
      });
    });
  });
});
