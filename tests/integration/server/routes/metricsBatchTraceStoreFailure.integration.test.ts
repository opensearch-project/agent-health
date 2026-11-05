/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * POST /api/metrics/batch when the trace store FAILS — the real route and the
 * real metricsService over HTTP, with only the observability client swapped
 * for one whose `search` behaves like opensearch-js under load (TimeoutError
 * "Request timed out") on one chunk and answers on the other.
 *
 * Regression (2026-10-22, 62-run benchmark on a shared cluster): the service
 * swallowed the timeout into the "queried, zero spans" result shape
 * (`status: 'pending', hasSpans: false`), so the benchmark Runs tab rendered
 * every row '— / No spans found for this run yet' for runs that have 62/62
 * traced cases. The route must now answer those keys with the per-key error
 * shape (`status: 'error', error`) — the one it already uses for an
 * unconfigured source and that every caller filters with `'error' in m` —
 * while the keys of the chunk that DID answer come back computed, and the
 * aggregate counts only the successful ones.
 */

import express from 'express';
import request from 'supertest';

// The route reaches the trace store only through the sealed IObservabilityModule
// (getObservabilityModule); hand it the REAL OpenSearch module over the fake client
// so route → module → metricsService → DSL all run unmocked.
jest.mock('@/server/services/observabilityClient', () => ({
  getObservabilityModule: jest.fn(),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import metricsRoutes from '@/server/routes/metrics';
import { getObservabilityModule } from '@/server/services/observabilityClient';
import { OpenSearchObservabilityModule } from '@/server/adapters/observability/OpenSearchObservabilityModule';

const mockGetObservabilityModule = getObservabilityModule as jest.MockedFunction<typeof getObservabilityModule>;
const OTEL_INDEXES = { traces: 'otel-v1-apm-span-*', logs: 'ml-commons-logs-*', metrics: 'otel-v1-apm-service-map*' };

const span = (runId: string, inTok: number, outTok: number) => ({
  _source: {
    traceId: `trace-${runId}`, spanId: `span-${runId}`, name: 'chat', serviceName: 'example-agent',
    startTime: '2026-10-22T20:00:00.000Z', endTime: '2026-10-22T20:00:02.000Z',
    attributes: {
      'agent_health.run.id': runId, 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'example-model',
      'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': outTok,
    },
  },
});

describe('POST /api/metrics/batch — trace-store failure on one chunk (real route + real service)', () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(metricsRoutes);

  // 52 keys => two server-side chunks (50 + 2). Chunk 1 times out, chunk 2 answers.
  const keys = Array.from({ length: 52 }, (_, i) => `run-${String(i).padStart(2, '0')}`);
  let search: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    search = jest.fn(async (params: any) => {
      const requested: string[] = params.body.query.bool.must[0].bool.should
        .flatMap((c: any) => Object.values(c.terms ?? {}) as string[][])
        .flat();
      if (requested.includes('run-00')) {
        const err = new Error('Request timed out');
        err.name = 'TimeoutError';
        throw err;
      }
      return { body: { hits: { total: { value: 2 }, hits: [span('run-50', 100, 10), span('run-51', 200, 20)] } } };
    });
    mockGetObservabilityModule.mockReturnValue(new OpenSearchObservabilityModule({ search } as any, OTEL_INDEXES));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); jest.clearAllMocks(); });

  it('answers the timed-out chunk\'s keys with status "error" + the message (spans UNKNOWN), the other chunk computed, aggregate over the successful keys only', async () => {
    const res = await request(app).post('/api/metrics/batch').send({ runIds: keys });
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledTimes(2);

    const metrics: any[] = res.body.metrics;
    expect(metrics).toHaveLength(52);
    expect(metrics.map(m => m.runId)).toEqual(keys);   // one entry per key, in request order

    const failed = metrics.slice(0, 50);
    for (const m of failed) {
      expect(m.status).toBe('error');
      expect(m.error).toBe('Request timed out');
      // NOT the "no spans" shape: hasSpans is absent, never false.
      expect(m.hasSpans).toBeUndefined();
      expect('error' in m).toBe(true);
    }

    const [ok50, ok51] = metrics.slice(50);
    expect(ok50).toMatchObject({ runId: 'run-50', status: 'success', hasSpans: true, totalTokens: 110, llmCalls: 1 });
    expect(ok51).toMatchObject({ runId: 'run-51', status: 'success', hasSpans: true, totalTokens: 220, llmCalls: 1 });
    expect(ok50.error).toBeUndefined();

    // Aggregate ignores the failed keys (same as the "not configured" error entries always were).
    expect(res.body.aggregate.totalRuns).toBe(2);
    expect(res.body.aggregate.totalInputTokens).toBe(300);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/OpenSearch metrics query failed for chunk \(50 run IDs\): Request timed out/));
  });

  it('a chunk that answers with ZERO spans is still the "no spans" shape (status pending, hasSpans false) — distinguishable from a failure', async () => {
    search.mockResolvedValue({ body: { hits: { total: { value: 0 }, hits: [] } } });
    const res = await request(app).post('/api/metrics/batch').send({ runIds: ['run-a', 'run-b'] });
    expect(res.status).toBe(200);
    for (const m of res.body.metrics) {
      expect(m).toMatchObject({ status: 'pending', hasSpans: false });
      expect(m.error).toBeUndefined();
    }
  });
});
