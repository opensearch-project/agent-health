/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import metricsRoutes from '@/server/routes/metrics';
import { computeMetrics, computeAggregateMetrics } from '@/server/services/metricsService';

// Mock the metrics service
jest.mock('@/server/services/metricsService', () => ({
  computeMetrics: jest.fn(),
  computeAggregateMetrics: jest.fn(),
}));

const mockComputeMetrics = computeMetrics as jest.MockedFunction<typeof computeMetrics>;
const mockComputeAggregateMetrics = computeAggregateMetrics as jest.MockedFunction<typeof computeAggregateMetrics>;

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}) {
  const req = {
    params,
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

describe('Metrics Routes', () => {
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
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('GET /api/metrics/:runId', () => {
    it('should return metrics for a run', async () => {
      const mockMetrics = {
        runId: 'test-run-123',
        traceId: 'trace-123',
        totalTokens: 1000,
        inputTokens: 800,
        outputTokens: 200,
        llmCalls: 3,
        toolCalls: 5,
        toolsUsed: ['search', 'query'],
        costUsd: 0.05,
        durationMs: 5000,
        status: 'success' as const,
      };
      mockComputeMetrics.mockResolvedValue(mockMetrics);

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      await handler(req, res);

      expect(mockComputeMetrics).toHaveBeenCalledWith('test-run-123', expect.objectContaining({
        endpoint: 'http://localhost:9200',
        indexPattern: 'otel-traces-*',
      }));
      expect(res.json).toHaveBeenCalledWith(mockMetrics);
    });

    it('should return 500 when OpenSearch not configured', async () => {
      process.env.OPENSEARCH_LOGS_ENDPOINT = '';

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('not configured'),
      });
    });

    it('should return 500 on service error', async () => {
      mockComputeMetrics.mockRejectedValue(new Error('Trace not found'));

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Trace not found',
      });
    });
  });

  describe('POST /api/metrics/batch', () => {
    it('should return metrics for multiple runs', async () => {
      const mockMetrics1 = {
        runId: 'run-1',
        traceId: 'trace-1',
        totalTokens: 500,
        inputTokens: 400,
        outputTokens: 100,
        llmCalls: 2,
        toolCalls: 3,
        toolsUsed: ['search'],
        costUsd: 0.02,
        durationMs: 2000,
        status: 'success' as const,
      };
      const mockMetrics2 = {
        runId: 'run-2',
        traceId: 'trace-2',
        totalTokens: 800,
        inputTokens: 600,
        outputTokens: 200,
        llmCalls: 3,
        toolCalls: 4,
        toolsUsed: ['query'],
        costUsd: 0.03,
        durationMs: 3000,
        status: 'success' as const,
      };
      mockComputeMetrics
        .mockResolvedValueOnce(mockMetrics1)
        .mockResolvedValueOnce(mockMetrics2);

      const mockAggregate = {
        totalRuns: 2,
        successRate: 100,
        totalCostUsd: 0.05,
        avgCostUsd: 0.025,
        avgDurationMs: 2500,
        p50DurationMs: 2500,
        p95DurationMs: 3000,
        avgTokens: 650,
        totalInputTokens: 1000,
        totalOutputTokens: 300,
        avgLlmCalls: 2.5,
        avgToolCalls: 3.5,
      };
      mockComputeAggregateMetrics.mockReturnValue(mockAggregate);

      const { req, res } = createMocks({}, { runIds: ['run-1', 'run-2'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(mockComputeMetrics).toHaveBeenCalledTimes(2);
      expect(mockComputeAggregateMetrics).toHaveBeenCalledWith([mockMetrics1, mockMetrics2]);
      expect(res.json).toHaveBeenCalledWith({
        metrics: [mockMetrics1, mockMetrics2],
        aggregate: mockAggregate,
      });
    });

    it('should return 400 when runIds is not an array', async () => {
      const { req, res } = createMocks({}, { runIds: 'not-an-array' });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'runIds must be an array',
      });
    });

    it('should return 500 when OpenSearch not configured', async () => {
      process.env.OPENSEARCH_LOGS_USERNAME = '';

      const { req, res } = createMocks({}, { runIds: ['run-1'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'OpenSearch traces not configured',
      });
    });

    it('should handle partial failures', async () => {
      const mockMetrics1 = {
        runId: 'run-1',
        traceId: 'trace-1',
        totalTokens: 500,
        inputTokens: 400,
        outputTokens: 100,
        llmCalls: 2,
        toolCalls: 3,
        toolsUsed: ['search'],
        costUsd: 0.02,
        durationMs: 2000,
        status: 'success' as const,
      };
      mockComputeMetrics
        .mockResolvedValueOnce(mockMetrics1)
        .mockRejectedValueOnce(new Error('Trace not found'));

      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 1,
        successRate: 100,
        totalCostUsd: 0.02,
        avgCostUsd: 0.02,
        avgDurationMs: 2000,
        p50DurationMs: 2000,
        p95DurationMs: 2000,
        avgTokens: 500,
        totalInputTokens: 400,
        totalOutputTokens: 100,
        avgLlmCalls: 2,
        avgToolCalls: 3,
      });

      const { req, res } = createMocks({}, { runIds: ['run-1', 'run-2'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        metrics: [
          mockMetrics1,
          { runId: 'run-2', error: 'Trace not found', status: 'error' },
        ],
        aggregate: expect.any(Object),
      });
    });

    it('should return 500 on unexpected error', async () => {
      // Force an error by making computeMetrics throw for all calls
      mockComputeMetrics.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const { req, res } = createMocks({}, { runIds: ['run-1'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
