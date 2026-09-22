/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: precise-first trace correlation through the REAL
 * `POST /api/traces` route + file observability backend (no mocks).
 *
 * Scenario (the reported bug): two runs of the SAME agent service overlap in
 * time (concurrency > 1). Run A's spans carry `gen_ai.conversation.id =
 * runA` on trace TA; run B's carry `runB` on trace TB. Pre-fix, the Traces
 * tab's query (`runIds` + `agents` window) unioned both trees. Now:
 *   - exact correlators (traceId / runIds / sessionId) are tried first and
 *     win on their own → ONE root, no run-B spans, `correlation.strategy`
 *     names the matcher;
 *   - the window is used only when they match nothing, and its result drops
 *     spans that name another run (`windowFiltered` counts them) while
 *     keeping spans that carry no run identity at all.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import otlpReceiverRoutes from '@/server/routes/otlpReceiver';
import tracesRoutes from '@/server/routes/traces';

const SERVICE = 'retrieval-agent';
const T0 = Date.parse('2026-03-01T10:00:00Z');
const NS = (ms: number) => `${ms}000000`; // epoch-ms → unix-nanos string

const TRACE_A = 'aaaa1111aaaa1111aaaa1111aaaa1111';
const TRACE_B = 'bbbb2222bbbb2222bbbb2222bbbb2222';
const TRACE_C = 'cccc3333cccc3333cccc3333cccc3333';
const RUN_A = 'run-a-precise';
const RUN_B = 'run-b-neighbour';
const RUN_C = 'run-c-window-only';

interface SpanSpec {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  attrs?: Record<string, string>;
}

function otlpPayload(spans: SpanSpec[]) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: SERVICE } }] },
      scopeSpans: [{
        scope: { name: 'test.tracer' },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: 2,
          startTimeUnixNano: NS(s.startMs),
          endTimeUnixNano: NS(s.startMs + 500),
          attributes: Object.entries(s.attrs ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
          status: { code: 1 },
        })),
      }],
    }],
  };
}

const window = [{ serviceName: SERVICE, startedAt: T0 - 60_000, endedAt: T0 + 120_000 }];
const roots = (spans: any[]) => spans.filter((s) => !s.parentSpanId);

describe('precise-first trace correlation (integration, file backend)', () => {
  let app: Express;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const OBS_ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'precise-first-int-'));
    for (const k of OBS_ENV) saved[k] = process.env[k];
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    delete process.env.OPENSEARCH_LOGS_USERNAME;
    delete process.env.OPENSEARCH_LOGS_PASSWORD;
    process.env.AGENT_HEALTH_DATA_DIR = dir;

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(otlpReceiverRoutes);
    app.use(tracesRoutes);

    // Run A and run B: same service, overlapping wall-clock, each tagged
    // with its own run id (the OTEL-standard attribute on A, our own on B's
    // child, to cover both RUN_ID_ATTRIBUTES).
    await request(app).post('/v1/traces').send(otlpPayload([
      { traceId: TRACE_A, spanId: 'a000000000000001', name: 'POST /invoke', startMs: T0, attrs: { 'gen_ai.conversation.id': RUN_A } },
      { traceId: TRACE_A, spanId: 'a000000000000002', parentSpanId: 'a000000000000001', name: 'chat', startMs: T0 + 100, attrs: { 'gen_ai.conversation.id': RUN_A } },
      { traceId: TRACE_A, spanId: 'a000000000000003', parentSpanId: 'a000000000000001', name: 'execute_tool search', startMs: T0 + 200, attrs: { 'gen_ai.conversation.id': RUN_A } },
      { traceId: TRACE_B, spanId: 'b000000000000001', name: 'POST /invoke', startMs: T0 + 1_000, attrs: { 'gen_ai.conversation.id': RUN_B } },
      { traceId: TRACE_B, spanId: 'b000000000000002', parentSpanId: 'b000000000000001', name: 'chat', startMs: T0 + 1_100, attrs: { 'agent_health.run.id': RUN_B } },
      // Identity-less child of run B (HTTP client span): must follow its trace, not survive as an orphan.
      { traceId: TRACE_B, spanId: 'b000000000000003', parentSpanId: 'b000000000000002', name: 'GET /search', startMs: T0 + 1_150 },
      // Run C: a Strategy-C-only agent — no run id, no session id, its own trace.
      { traceId: TRACE_C, spanId: 'c000000000000001', name: 'POST /invoke', startMs: T0 + 2_000 },
      { traceId: TRACE_C, spanId: 'c000000000000002', parentSpanId: 'c000000000000001', name: 'chat', startMs: T0 + 2_100 },
      // A span of another session (Strategy D identity) inside the window.
      { traceId: 'dddd4444dddd4444dddd4444dddd4444', spanId: 'd000000000000001', name: 'POST /invoke', startMs: T0 + 3_000, attrs: { 'session.id': 'sess-other' } },
    ])).expect(200);
  });

  afterAll(async () => {
    for (const k of OBS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('sanity: the window alone sees all three runs (the population the old union pulled in)', async () => {
    const res = await request(app).post('/api/traces').send({ agents: window, size: 1000 }).expect(200);
    expect(roots(res.body.spans)).toHaveLength(4);
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 0 });
  });

  it('Traces-tab query (traceId + runId + window): ONE root, no neighbour spans, matched by trace id', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE_A, runIds: [RUN_A], agents: window, size: 1000 })
      .expect(200);

    const spans = res.body.spans;
    expect(spans).toHaveLength(3);
    expect(roots(spans)).toHaveLength(1);
    expect(spans.every((s: any) => s.traceId === TRACE_A)).toBe(true);
    expect(spans.some((s: any) => s.attributes['gen_ai.conversation.id'] === RUN_B)).toBe(false);
    expect(res.body.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });
    expect(res.body).toMatchObject({ total: 3, hasMore: false, nextCursor: null, backend: 'file' });
  });

  it('runId only (+ window): still exact — matched by run id, both run-id attributes honoured', async () => {
    const a = await request(app).post('/api/traces').send({ runIds: [RUN_A], agents: window }).expect(200);
    expect(a.body.spans.map((s: any) => s.spanId).sort()).toEqual(['a000000000000001', 'a000000000000002', 'a000000000000003']);
    expect(a.body.correlation.strategy).toBe('runIds');

    // RUN_B is carried by gen_ai.conversation.id on the root and agent_health.run.id on the child.
    const b = await request(app).post('/api/traces').send({ runIds: [RUN_B], agents: window }).expect(200);
    expect(b.body.spans.map((s: any) => s.spanId).sort()).toEqual(['b000000000000001', 'b000000000000002']);
    // (b…03 carries no run id, so an exact runIds query can't see it — that is Strategy A's job.)
    expect(b.body.correlation.strategy).toBe('runIds');
  });

  it('sessionId (+ window): exact session.id match wins over the window', async () => {
    const res = await request(app).post('/api/traces').send({ sessionId: 'sess-other', agents: window }).expect(200);
    expect(res.body.spans.map((s: any) => s.spanId)).toEqual(['d000000000000001']);
    expect(res.body.correlation).toEqual({ strategy: 'sessionId', windowFiltered: 0 });
  });

  it('falls back to the window ONLY when the exact clauses match nothing, and drops other runs\' spans', async () => {
    // Run C's report has a runId/traceId the agent never stamped (Strategy-C agent).
    const res = await request(app).post('/api/traces')
      .send({ traceId: 'ffff0000ffff0000ffff0000ffff0000', runIds: [RUN_C], sessionId: 'sess-c', agents: window, size: 1000 })
      .expect(200);

    const spans = res.body.spans;
    // Kept: run C's untagged tree. Dropped: A (3), B (3 — incl. the identity-less
    // child, which follows its trace) by run id and D (1) by session.id.
    expect(spans.map((s: any) => s.spanId).sort()).toEqual(['c000000000000001', 'c000000000000002']);
    expect(roots(spans)).toHaveLength(1);
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 7 });
    expect(res.body.total).toBe(2);
  });

  it('window fallback without a requested sessionId keeps other-session spans (nothing to compare against)', async () => {
    const res = await request(app).post('/api/traces')
      .send({ runIds: [RUN_C], agents: window, size: 1000 })
      .expect(200);
    expect(res.body.spans.map((s: any) => s.spanId).sort())
      .toEqual(['c000000000000001', 'c000000000000002', 'd000000000000001']);
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 6 });
  });

  it('an exact query with no window hint behaves as before (single query, labelled)', async () => {
    const res = await request(app).post('/api/traces').send({ traceId: TRACE_B }).expect(200);
    expect(res.body.spans).toHaveLength(3);
    expect(res.body.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });
  });

  it('a plain time-range browse carries no correlation field', async () => {
    const res = await request(app).post('/api/traces')
      .send({ startTime: T0 - 1_000, endTime: T0 + 10_000, size: 100 })
      .expect(200);
    expect(res.body.spans.length).toBeGreaterThan(0);
    expect(res.body.correlation).toBeUndefined();
  });

  it('paginates within the phase that produced the first page', async () => {
    const first = await request(app).post('/api/traces')
      .send({ traceId: TRACE_A, runIds: [RUN_A], agents: window, size: 2 })
      .expect(200);
    expect(first.body.spans).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app).post('/api/traces')
      .send({ traceId: TRACE_A, runIds: [RUN_A], agents: window, size: 2, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.spans).toHaveLength(1);
    expect(second.body.spans[0].traceId).toBe(TRACE_A); // still the exact phase, never the window
    expect(second.body.hasMore).toBe(false);
    expect(second.body.correlation.strategy).toBe('traceId');
  });
});
