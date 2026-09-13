/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import metricsRoutes from '@/server/routes/metrics';
import { computeMetrics, computeBatchMetrics, computeAggregateMetrics } from '@/server/services/metricsService';

// Mock the metrics service
jest.mock('@/server/services/metricsService', () => ({
  computeMetrics: jest.fn(),
  computeBatchMetrics: jest.fn(),
  computeMetricsFromSampleSpans: jest.fn().mockReturnValue(null),
  computeAggregateMetrics: jest.fn(),
}));

// Mock the observability client
jest.mock('@/server/services/observabilityClient', () => ({
  getObservabilityClient: jest.fn(),
}));
import { getObservabilityClient } from '@/server/services/observabilityClient';
const mockGetObservabilityClient = getObservabilityClient as jest.MockedFunction<typeof getObservabilityClient>;

const mockComputeMetrics = computeMetrics as jest.MockedFunction<typeof computeMetrics>;
const mockComputeBatchMetrics = computeBatchMetrics as jest.MockedFunction<typeof computeBatchMetrics>;
const mockComputeAggregateMetrics = computeAggregateMetrics as jest.MockedFunction<typeof computeAggregateMetrics>;

// Helper to create mock request/response
function createMocks(params: any = {}, body: any = {}, headers: any = {}, query: any = {}) {
  const req = {
    params,
    body,
    headers,
    query,
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
  const mockClient = { search: jest.fn(), close: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockGetObservabilityClient.mockReturnValue({
      client: mockClient as any,
      indexes: { traces: 'otel-traces-*', logs: 'logs-*', metrics: 'metrics-*' },
    });
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
        client: mockClient,
        indexPattern: 'otel-traces-*',
      }), undefined, undefined, undefined);
      expect(res.json).toHaveBeenCalledWith(mockMetrics);
    });

    it('threads a ?sessionId= query param through as the Strategy-D correlator', async () => {
      mockComputeMetrics.mockResolvedValue({
        runId: 'test-run-123', traceId: null, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        llmCalls: 0, toolCalls: 0, toolsUsed: [], costUsd: 0, durationMs: 0, status: 'pending' as const,
      });

      const { req, res } = createMocks({ runId: 'test-run-123' }, {}, {}, { sessionId: 'session-aaa' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      await handler(req, res);

      expect(mockComputeMetrics).toHaveBeenCalledWith('test-run-123', expect.any(Object), 'session-aaa', undefined, undefined);
    });

    it('should forward a traceId query param to computeMetrics (Strategy A)', async () => {
      mockComputeMetrics.mockResolvedValue({
        runId: 'test-run-123',
        traceId: 'trace-abc',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        llmCalls: 0,
        toolCalls: 0,
        toolsUsed: [],
        costUsd: 0,
        durationMs: 0,
        status: 'success' as const,
      });

      const { req, res } = createMocks({ runId: 'test-run-123' }, {}, {}, { traceId: 'trace-abc' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      await handler(req, res);

      expect(mockComputeMetrics).toHaveBeenCalledWith(
        'test-run-123',
        expect.objectContaining({ client: mockClient, indexPattern: 'otel-traces-*' }),
        undefined,
        'trace-abc',
        undefined
      );
    });

    it('should return 503 when observability not configured', async () => {
      mockGetObservabilityClient.mockReturnValue(null);

      const { req, res } = createMocks({ runId: 'test-run-123' });
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Observability data source not configured',
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
    it('should return metrics for multiple runs using bulk query', async () => {
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
      mockComputeBatchMetrics.mockResolvedValue([mockMetrics1, mockMetrics2]);

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

      expect(mockComputeBatchMetrics).toHaveBeenCalledTimes(1);
      expect(mockComputeBatchMetrics).toHaveBeenCalledWith(
        ['run-1', 'run-2'],
        expect.objectContaining({ client: mockClient, indexPattern: 'otel-traces-*' }),
        undefined,
        undefined,
        undefined
      );
      expect(mockComputeAggregateMetrics).toHaveBeenCalledWith([mockMetrics1, mockMetrics2]);
      expect(res.json).toHaveBeenCalledWith({
        metrics: [mockMetrics1, mockMetrics2],
        aggregate: mockAggregate,
      });
    });

    it('should forward a traceIds map to computeBatchMetrics (Strategy A)', async () => {
      mockComputeBatchMetrics.mockResolvedValue([]);
      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 0, successRate: 0, totalCostUsd: 0, avgCostUsd: 0, avgDurationMs: 0,
        p50DurationMs: 0, p95DurationMs: 0, avgTokens: 0, totalInputTokens: 0,
        totalOutputTokens: 0, avgLlmCalls: 0, avgToolCalls: 0,
      });

      const { req, res } = createMocks({}, { runIds: ['run-1'], traceIds: { 'run-1': 'trace-1' } });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(mockComputeBatchMetrics).toHaveBeenCalledWith(
        ['run-1'],
        expect.objectContaining({ client: mockClient, indexPattern: 'otel-traces-*' }),
        undefined,
        { 'run-1': 'trace-1' },
        undefined
      );
    });

    it('should reject a non-object traceIds body field', async () => {
      const { req, res } = createMocks({}, { runIds: ['run-1'], traceIds: 'not-an-object' });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'traceIds must be an object mapping runId -> traceId',
      });
    });

    it('should drop non-string values from traceIds defensively', async () => {
      mockComputeBatchMetrics.mockResolvedValue([]);
      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 0, successRate: 0, totalCostUsd: 0, avgCostUsd: 0, avgDurationMs: 0,
        p50DurationMs: 0, p95DurationMs: 0, avgTokens: 0, totalInputTokens: 0,
        totalOutputTokens: 0, avgLlmCalls: 0, avgToolCalls: 0,
      });

      const { req, res } = createMocks({}, { runIds: ['run-1'], traceIds: { 'run-1': 42, 'run-2': 'trace-2' } });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(mockComputeBatchMetrics).toHaveBeenCalledWith(
        ['run-1'],
        expect.objectContaining({ client: mockClient, indexPattern: 'otel-traces-*' }),
        undefined,
        { 'run-2': 'trace-2' },
        undefined
      );
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

    it.each([
      ['a null element', ['run-1', null]],
      ['a numeric element', [42]],
      ['an empty-string element', ['']],
    ])('returns 400 (not 500) when runIds contains %s', async (_label, runIds) => {
      const { req, res } = createMocks({}, { runIds });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/runIds must contain only non-empty strings/) }));
      expect(mockComputeBatchMetrics).not.toHaveBeenCalled();
    });

    it('should return 400 when sessionIds is not a plain object (array/string/null)', async () => {
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
      for (const badSessionIds of ['not-an-object', ['a', 'b'], null]) {
        const { req, res } = createMocks({}, { runIds: ['run-1'], sessionIds: badSessionIds });
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/sessionIds/) }));
      }
    });

    // Strategy C (service.name + run window) parity with /api/traces: the
    // batch route accepts a runId -> hint[] map and forwards it, so a report
    // with NO correlation id at all can still be matched by its agent's spans.
    describe('agents (Strategy-C/D hints, same element shape as /api/traces agents[])', () => {
      const emptyAggregate = {
        totalRuns: 0, successRate: 0, totalCostUsd: 0, avgCostUsd: 0,
        avgDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, avgTokens: 0,
        totalInputTokens: 0, totalOutputTokens: 0, avgLlmCalls: 0, avgToolCalls: 0,
      };

      it('threads a well-formed agents map through to computeBatchMetrics (keys may be report ids, not run ids)', async () => {
        mockComputeBatchMetrics.mockResolvedValue([]);
        mockComputeAggregateMetrics.mockReturnValue(emptyAggregate);
        const hint = { serviceName: 'example-agent', startedAt: 1_000, endedAt: 2_000 };
        const hintWithSession = { serviceName: 'other-agent', startedAt: 3_000, endedAt: 4_000, sessionId: 'sess-1' };
        const { req, res } = createMocks({}, {
          runIds: ['report-no-runid', 'run-2', 'run-3'],
          agents: { 'report-no-runid': [hint], 'run-2': [hintWithSession], 'run-3': [] },
        });
        const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

        await handler(req, res);

        expect(mockComputeBatchMetrics).toHaveBeenCalledWith(
          ['report-no-runid', 'run-2', 'run-3'],
          expect.any(Object),
          undefined,
          undefined,
          // Empty hint arrays are dropped; everything else forwarded verbatim.
          { 'report-no-runid': [hint], 'run-2': [hintWithSession] }
        );
        expect(res.status).not.toHaveBeenCalledWith(400);
      });

      it('rejects a non-object agents field (array/string/null) with 400', async () => {
        const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');
        for (const bad of ['not-an-object', [{ serviceName: 'x', startedAt: 1, endedAt: 2 }], null]) {
          const { req, res } = createMocks({}, { runIds: ['run-1'], agents: bad });
          await handler(req, res);
          expect(res.status).toHaveBeenCalledWith(400);
          expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/agents/) }));
        }
        expect(mockComputeBatchMetrics).not.toHaveBeenCalled();
      });

      it.each([
        ['a hint that is not an object', ['nope']],
        ['a hint missing serviceName', [{ startedAt: 1, endedAt: 2 }]],
        ['a hint with an empty serviceName', [{ serviceName: '', startedAt: 1, endedAt: 2 }]],
        ['a hint with a non-numeric startedAt', [{ serviceName: 'x', startedAt: '1', endedAt: 2 }]],
        ['a hint with a NaN endedAt', [{ serviceName: 'x', startedAt: 1, endedAt: NaN }]],
        ['a hint with a non-string sessionId', [{ serviceName: 'x', startedAt: 1, endedAt: 2, sessionId: 7 }]],
        ['a hint whose window is inverted (endedAt < startedAt)', [{ serviceName: 'x', startedAt: 2000, endedAt: 1000 }]],
        ['a value that is not an array of hints', { serviceName: 'x', startedAt: 1, endedAt: 2 }],
      ])('rejects %s with 400 and never queries the cluster', async (_label, hints) => {
        const { req, res } = createMocks({}, { runIds: ['run-1'], agents: { 'run-1': hints } });
        const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(mockComputeBatchMetrics).not.toHaveBeenCalled();
      });
    });

    it('GET /api/metrics/:runId forwards a ?serviceName=&startedAt=&endedAt= window hint (Strategy C) and rejects a malformed one', async () => {
      mockComputeMetrics.mockResolvedValue({ runId: 'r', status: 'pending' } as any);
      const handler = getRouteHandler(metricsRoutes, 'get', '/api/metrics/:runId');

      const ok = createMocks({ runId: 'r' }, {}, {}, { serviceName: 'example-agent', startedAt: '1000', endedAt: '2000', sessionId: 'sess-9' });
      await handler(ok.req, ok.res);
      expect(mockComputeMetrics).toHaveBeenCalledWith(
        'r',
        expect.any(Object),
        'sess-9',
        undefined,
        [{ serviceName: 'example-agent', startedAt: 1000, endedAt: 2000, sessionId: 'sess-9' }]
      );

      mockComputeMetrics.mockClear();
      const bad = createMocks({ runId: 'r' }, {}, {}, { serviceName: 'example-agent', startedAt: 'yesterday' });
      await handler(bad.req, bad.res);
      expect(bad.res.status).toHaveBeenCalledWith(400);
      expect(mockComputeMetrics).not.toHaveBeenCalled();
    });

    it('threads a well-formed sessionIds map through to computeBatchMetrics, dropping non-string values', async () => {
      mockComputeBatchMetrics.mockResolvedValue([]);
      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 0, successRate: 0, totalCostUsd: 0, avgCostUsd: 0,
        avgDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, avgTokens: 0,
        totalInputTokens: 0, totalOutputTokens: 0, avgLlmCalls: 0, avgToolCalls: 0,
      });

      const { req, res } = createMocks({}, {
        runIds: ['run-1', 'run-2'],
        sessionIds: { 'run-1': 'session-aaa', 'run-2': 12345 },
      });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(mockComputeBatchMetrics).toHaveBeenCalledWith(
        ['run-1', 'run-2'],
        expect.any(Object),
        { 'run-1': 'session-aaa' },
        undefined,
        undefined
      );
    });

    it('should return individual error results when observability not configured', async () => {
      mockGetObservabilityClient.mockReturnValue(null);

      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 0,
        successRate: 0,
        totalCostUsd: 0,
        avgCostUsd: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        avgTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        avgLlmCalls: 0,
        avgToolCalls: 0,
      });

      const { req, res } = createMocks({}, { runIds: ['run-1'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        metrics: [expect.objectContaining({
          runId: 'run-1',
          error: 'Observability data source not configured',
          status: 'error',
        })],
      }));
    });

    it('should handle batch failure gracefully', async () => {
      mockComputeBatchMetrics.mockRejectedValue(new Error('OpenSearch connection failed'));

      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 0,
        successRate: 0,
        totalCostUsd: 0,
        avgCostUsd: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        avgTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        avgLlmCalls: 0,
        avgToolCalls: 0,
      });

      const { req, res } = createMocks({}, { runIds: ['run-1', 'run-2'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        metrics: [
          expect.objectContaining({ runId: 'run-1', error: 'OpenSearch connection failed', status: 'error' }),
          expect.objectContaining({ runId: 'run-2', error: 'OpenSearch connection failed', status: 'error' }),
        ],
      }));
    });

    it('should return per-run errors when computeBatchMetrics throws synchronously', async () => {
      mockComputeBatchMetrics.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      mockComputeAggregateMetrics.mockReturnValue({
        totalRuns: 0, successRate: 0, totalCostUsd: 0, avgCostUsd: 0,
        avgDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, avgTokens: 0,
        totalInputTokens: 0, totalOutputTokens: 0, avgLlmCalls: 0, avgToolCalls: 0,
      });

      const { req, res } = createMocks({}, { runIds: ['run-1'] });
      const handler = getRouteHandler(metricsRoutes, 'post', '/api/metrics/batch');

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        metrics: [expect.objectContaining({ runId: 'run-1', error: 'Unexpected error', status: 'error' })],
      }));
    });
  });
});
