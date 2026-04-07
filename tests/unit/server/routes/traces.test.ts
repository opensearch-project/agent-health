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
  getAllSampleTraceSpansWithRecentTimestamps,
  isSampleTraceId,
} from '@/cli/demo/sampleTraces';

// Mock the traces service
jest.mock('@/server/services/tracesService', () => ({
  fetchTraces: jest.fn(),
  checkTracesHealth: jest.fn(),
}));

// Mock the client factory
jest.mock('@/server/services/opensearchClientFactory', () => ({
  createOpenSearchClient: jest.fn().mockReturnValue({ close: jest.fn().mockResolvedValue(undefined) }),
}));

// Mock the sample traces
jest.mock('@/cli/demo/sampleTraces', () => ({
  getSampleSpansForRunIds: jest.fn().mockReturnValue([]),
  getSampleSpansByTraceId: jest.fn().mockReturnValue([]),
  getAllSampleTraceSpans: jest.fn().mockReturnValue([]),
  getAllSampleTraceSpansWithRecentTimestamps: jest.fn().mockReturnValue([]),
  isSampleTraceId: jest.fn().mockReturnValue(false),
}));

const mockFetchTraces = fetchTraces as jest.MockedFunction<typeof fetchTraces>;
const mockCheckTracesHealth = checkTracesHealth as jest.MockedFunction<typeof checkTracesHealth>;
const mockGetSampleSpansForRunIds = getSampleSpansForRunIds as jest.MockedFunction<typeof getSampleSpansForRunIds>;
const mockGetSampleSpansByTraceId = getSampleSpansByTraceId as jest.MockedFunction<typeof getSampleSpansByTraceId>;
const mockGetAllSampleTraceSpans = getAllSampleTraceSpans as jest.MockedFunction<typeof getAllSampleTraceSpans>;
const mockGetAllSampleTraceSpansWithRecentTimestamps = getAllSampleTraceSpansWithRecentTimestamps as jest.MockedFunction<typeof getAllSampleTraceSpansWithRecentTimestamps>;
const mockIsSampleTraceId = isSampleTraceId as jest.MockedFunction<typeof isSampleTraceId>;

// Helper to create mock request/response
function createMocks(body: any = {}, headers: any = {}) {
  const req = {
    body,
    headers,
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
    mockGetAllSampleTraceSpansWithRecentTimestamps.mockReturnValue([]);
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
        expect.any(Object),
        expect.any(String)
      );
      expect(res.json).toHaveBeenCalledWith({ spans: [], total: 0, nextCursor: null, hasMore: false, warning: undefined });
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
        expect.any(Object),
        expect.any(String)
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
        expect.any(Object),
        expect.any(String)
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
        nextCursor: null,
        hasMore: false,
        warning: undefined,
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
        nextCursor: null,
        hasMore: false,
        warning: undefined,
      });
    });

    it('should use default size of 100', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });

      const { req, res } = createMocks({ traceId: 'trace-123' });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ size: 100 }),
        expect.any(Object),
        expect.any(String)
      );
    });

    it('should return only sample data with warning when logs not configured', async () => {
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
        nextCursor: null,
        hasMore: false,
        warning: 'Observability data source not configured',
      });
    });

    it('should return sample data with warning when logs fetch fails', async () => {
      const sampleSpans = [{ traceId: 'sample', spanId: 'ss1', name: 'sample' }];
      mockGetSampleSpansForRunIds.mockReturnValue(sampleSpans as any);
      mockFetchTraces.mockRejectedValue(new Error('Connection failed'));

      const { req, res } = createMocks({ runIds: ['run-1'] });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        spans: sampleSpans,
        total: 1,
        nextCursor: null,
        hasMore: false,
        warning: 'Connection failed',
      });
    });

    it('should return live traces for time-range-only query', async () => {
      const liveSpans = [
        { traceId: 'live-1', spanId: 'ls1', name: 'live-span', startTime: '2024-01-01', endTime: '2024-01-01', duration: 50, status: 'OK' as const, attributes: {}, events: [] },
      ];
      mockFetchTraces.mockResolvedValue({ spans: liveSpans as any, total: 1 });

      const { req, res } = createMocks({
        startTime: 1704067200000,
        endTime: 1704153600000,
      });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ startTime: 1704067200000, endTime: 1704153600000 }),
        expect.any(Object),
        expect.any(String)
      );
      expect(mockGetSampleSpansForRunIds).not.toHaveBeenCalled();
      expect(mockGetSampleSpansByTraceId).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        spans: liveSpans,
        total: 1,
        nextCursor: null,
        hasMore: false,
        warning: undefined,
      });
    });

    it('should surface OpenSearch error as warning in response', async () => {
      mockFetchTraces.mockRejectedValue(new Error('index_not_found_exception'));

      const { req, res } = createMocks({ traceId: 'trace-123' });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        spans: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
        warning: 'index_not_found_exception',
      });
    });

    it('should return demo spans with warning when observability config is missing for time-range query', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = '';
      const demoSpans = [
        { traceId: 'demo-trace-001', spanId: 'ds1', name: 'demo-span', startTime: '2024-01-01', endTime: '2024-01-01', duration: 100, status: 'OK' as const, attributes: { 'service.name': 'travel-planner' } },
        { traceId: 'demo-trace-002', spanId: 'ds2', name: 'demo-span-2', startTime: '2024-01-01', endTime: '2024-01-01', duration: 200, status: 'OK' as const, attributes: { 'service.name': 'other-service' } },
      ];
      mockGetAllSampleTraceSpansWithRecentTimestamps.mockReturnValue(demoSpans as any);

      const { req, res } = createMocks({
        startTime: 1704067200000,
        endTime: 1704153600000,
      });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockFetchTraces).not.toHaveBeenCalled();
      expect(mockGetAllSampleTraceSpansWithRecentTimestamps).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        spans: demoSpans,
        total: 2,
        nextCursor: null,
        hasMore: false,
        warning: 'Observability data source not configured',
      });
    });

    it('should filter demo spans by serviceName when no config', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = '';
      const demoSpans = [
        { traceId: 'demo-trace-001', spanId: 'ds1', name: 'span-a', startTime: '2024-01-01', endTime: '2024-01-01', duration: 100, status: 'OK' as const, attributes: { 'service.name': 'travel-planner' } },
        { traceId: 'demo-trace-002', spanId: 'ds2', name: 'span-b', startTime: '2024-01-01', endTime: '2024-01-01', duration: 200, status: 'OK' as const, attributes: { 'service.name': 'other-service' } },
      ];
      mockGetAllSampleTraceSpansWithRecentTimestamps.mockReturnValue(demoSpans as any);

      const { req, res } = createMocks({
        startTime: 1704067200000,
        endTime: 1704153600000,
        serviceName: 'travel-planner',
      });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        spans: [demoSpans[0]],
        total: 1,
        nextCursor: null,
        hasMore: false,
        warning: 'Observability data source not configured',
      });
    });

    it('should filter demo spans by textSearch when no config', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = '';
      const demoSpans = [
        { traceId: 'demo-trace-001', spanId: 'ds1', name: 'invoke_agent Weather Agent', startTime: '2024-01-01', endTime: '2024-01-01', duration: 100, status: 'OK' as const, attributes: { 'service.name': 'travel-planner' } },
        { traceId: 'demo-trace-002', spanId: 'ds2', name: 'chat claude-sonnet-4', startTime: '2024-01-01', endTime: '2024-01-01', duration: 200, status: 'OK' as const, attributes: { 'service.name': 'travel-planner' } },
      ];
      mockGetAllSampleTraceSpansWithRecentTimestamps.mockReturnValue(demoSpans as any);

      const { req, res } = createMocks({
        startTime: 1704067200000,
        endTime: 1704153600000,
        textSearch: 'weather',
      });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        spans: [demoSpans[0]],
        total: 1,
        nextCursor: null,
        hasMore: false,
        warning: 'Observability data source not configured',
      });
    });

    it('should NOT return demo spans for time-range query when config exists', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });

      const { req, res } = createMocks({
        startTime: 1704067200000,
        endTime: 1704153600000,
      });
      const handler = getRouteHandler(tracesRoutes, 'post', '/api/traces');

      await handler(req, res);

      expect(mockGetSampleSpansForRunIds).not.toHaveBeenCalled();
      expect(mockGetSampleSpansByTraceId).not.toHaveBeenCalled();
      expect(mockGetAllSampleTraceSpansWithRecentTimestamps).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        spans: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
        warning: undefined,
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

      expect(mockCheckTracesHealth).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String)
      );
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
