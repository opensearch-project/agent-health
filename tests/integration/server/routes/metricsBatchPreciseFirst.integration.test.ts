/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * POST /api/metrics/batch — PRECISE-FIRST correlation through the REAL route
 * and the REAL metricsService, against an in-memory trace store that
 * evaluates the exact OpenSearch DSL the service sends.
 *
 * Regression (2026-10-22, 62-case benchmark at concurrency 5 on a shared
 * cluster): the batch route unioned the Strategy-C service-name + time-window
 * clause with the exact correlators (traceId / run-id attributes /
 * session.id) and handed every span no id claimed to the nearest overlapping
 * window. Concurrent cases of the SAME agent have overlapping windows, so each
 * case's totals absorbed its neighbours' identity-less LLM spans and the spans
 * of other runs of that agent — measured on one run: 9.36M tokens / 364 LLM
 * calls by ids alone vs 16.4M / 640 with the window unioned in (+75%).
 *
 * The rule now matches `/api/traces` (AGENTS.md → "Strategy C — FALLBACK, not
 * a peer"), per key: exact correlators first; if they found any of the AGENT's
 * spans (eval/judge spans don't count), that is the answer; otherwise the
 * window, post-filtered per trace by Agent Health's own run id.
 *
 * Fixture = what that run looks like: three concurrent cases of one agent
 * (identical `service.name`, windows overlapping), each with its eval
 * `test_case` span; case 1's LLM children carry no id (only its root does),
 * case 2 stamps every span, case 3's connector echoed nothing (window-only
 * surrogate key, eval span stamped `agent_health.run.id = ''`); a fourth run
 * of the same agent nobody asked for; both index shapes (OSI flat-@ and
 * nested). All names synthetic.
 */

import express from 'express';
import request from 'supertest';

jest.mock('@/server/services/observabilityClient', () => ({
  getObservabilityClient: jest.fn(),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import metricsRoutes from '@/server/routes/metrics';
import { getObservabilityClient } from '@/server/services/observabilityClient';
import { createFakeTraceClient, flatAttrs, type FakeSpanDoc } from '@/tests/helpers/fakeTraceStore';

const mockGetObservabilityClient = getObservabilityClient as jest.MockedFunction<typeof getObservabilityClient>;

const SVC = 'example-agent';
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const iso = (offsetS: number) => new Date(T0 + offsetS * 1000).toISOString().replace('Z', '000000Z');

function doc(overrides: FakeSpanDoc): FakeSpanDoc {
  return {
    parentSpanId: '', kind: 'SPAN_KIND_INTERNAL', serviceName: SVC,
    durationInNanos: 1_000_000_000, status: { code: 1, message: '' },
    ...overrides,
  };
}
const llmAttrs = (inTok: number, extra: Record<string, unknown> = {}) => ({
  'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'anthropic.claude-sonnet-4',
  'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': 10, ...extra,
});
const evalSpan = (traceId: string, offsetS: number, runId: string) => doc({
  traceId, spanId: `${traceId}-eval`, name: 'test_case', serviceName: 'agent-health', startTime: iso(offsetS), endTime: iso(offsetS + 45),
  attributes: { 'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': runId },
});

// Three concurrent cases: roots at +0 / +5 / +10 s, each ≈40 s long.
// Window per case = report timestamp ± (duration + 60 s slack) → all three overlap.
const win = (startS: number) => ({ serviceName: SVC, startedAt: T0 + (startS - 60) * 1000, endedAt: T0 + (startS + 100) * 1000 });

const INDEX: FakeSpanDoc[] = [
  // case 1 (nested shape) — root carries run-1 and the W3C trace id; LLM children carry NOTHING.
  evalSpan('t1', 0, 'run-1'),
  doc({ traceId: 't1', spanId: 't1-root', name: 'invoke_agent', startTime: iso(0), endTime: iso(40), attributes: { 'gen_ai.operation.name': 'invoke_agent', 'agent_health.run.id': 'run-1' } }),
  doc({ traceId: 't1', spanId: 't1-llm-a', name: 'chat', startTime: iso(2), endTime: iso(3), attributes: llmAttrs(100) }),
  doc({ traceId: 't1', spanId: 't1-llm-b', name: 'chat', startTime: iso(20), endTime: iso(21), attributes: llmAttrs(100) }),
  doc({ traceId: 't1', spanId: 't1-http', name: 'POST /v1/messages', kind: 'SPAN_KIND_CLIENT', startTime: iso(2), endTime: iso(3), attributes: { 'http.request.method': 'POST' } }),
  // case 2 (OSI flat-@ shape) — every span stamped with run-2.
  evalSpan('t2', 5, 'run-2'),
  doc({ traceId: 't2', spanId: 't2-root', name: 'invoke_agent', startTime: iso(5), endTime: iso(45), ...flatAttrs({ 'gen_ai.operation.name': 'invoke_agent', 'agent_health.run.id': 'run-2' }) }),
  doc({ traceId: 't2', spanId: 't2-llm-a', name: 'chat', startTime: iso(7), endTime: iso(8), ...flatAttrs(llmAttrs(1000, { 'agent_health.run.id': 'run-2' })) }),
  doc({ traceId: 't2', spanId: 't2-llm-b', name: 'chat', startTime: iso(30), endTime: iso(31), ...flatAttrs(llmAttrs(1000, { 'agent_health.run.id': 'run-2' })) }),
  // case 3 — REST connector echoed no id: report has no runId, is keyed by its own id; eval span stamped ''.
  evalSpan('t3', 10, ''),
  doc({ traceId: 't3-agent', spanId: 't3-llm-a', name: 'chat', startTime: iso(12), endTime: iso(13), attributes: llmAttrs(10) }),
  doc({ traceId: 't3-agent', spanId: 't3-llm-b', name: 'chat', startTime: iso(35), endTime: iso(36), attributes: llmAttrs(10) }),
  // a fourth run of the same agent, same minute, not requested.
  doc({ traceId: 't9', spanId: 't9-root', name: 'invoke_agent', startTime: iso(8), endTime: iso(48), attributes: { 'gen_ai.operation.name': 'invoke_agent', 'agent_health.run.id': 'run-9' } }),
  doc({ traceId: 't9', spanId: 't9-llm-a', name: 'chat', startTime: iso(9), endTime: iso(10), attributes: llmAttrs(50_000) }),
  doc({ traceId: 't9', spanId: 't9-llm-b', name: 'chat', startTime: iso(25), endTime: iso(26), attributes: llmAttrs(50_000) }),
];

describe('POST /api/metrics/batch — precise-first correlation (real route + real service + DSL-evaluating trace store)', () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(metricsRoutes);

  let client: ReturnType<typeof createFakeTraceClient>;
  beforeEach(() => {
    client = createFakeTraceClient(INDEX);
    mockGetObservabilityClient.mockReturnValue({ client: client as any, indexes: { traces: 'otel-v1-apm-span-*' } } as any);
  });
  afterEach(() => jest.clearAllMocks());

  // The body the benchmark Runs table sends (lib/runTelemetry.ts): every report under its key with A/B/D + C riding along.
  const body = {
    runIds: ['run-1', 'run-2', 'report-3'],
    traceIds: { 'run-1': 't1', 'run-2': 't2' },
    agents: { 'run-1': [win(0)], 'run-2': [win(5)], 'report-3': [win(10)] },
  };

  it('each key\'s totals equal its OWN spans: ids-found keys ignore the overlapping windows, the id-less key falls back to its window minus other runs\' traces', async () => {
    const res = await request(app).post('/api/metrics/batch').send(body);
    expect(res.status).toBe(200);
    expect(client.search).toHaveBeenCalledTimes(1); // still ONE query per chunk

    const byKey = new Map<string, any>(res.body.metrics.map((m: any) => [m.runId, m]));
    // case 1: root carries the id, children follow the trace (Strategy A) — 2 LLM calls, 200 in-tokens. Pre-fix: + t2/t3/t9 window spans.
    expect(byKey.get('run-1')).toEqual(expect.objectContaining({ status: 'success', hasSpans: true, inputTokens: 200, llmCalls: 2, correlatedBy: 'ids' }));
    // case 2: every span stamped — exactly its own 2 LLM calls.
    expect(byKey.get('run-2')).toEqual(expect.objectContaining({ status: 'success', hasSpans: true, inputTokens: 2000, llmCalls: 2, correlatedBy: 'ids' }));
    // case 3: nothing exact → window; t1/t2/t9 traces identify as other runs → dropped; its own identity-less spans kept.
    expect(byKey.get('report-3')).toEqual(expect.objectContaining({ status: 'success', hasSpans: true, inputTokens: 20, llmCalls: 2, correlatedBy: 'window' }));
    // Nothing of run-9's 100k tokens anywhere; the aggregate is the honest sum.
    expect(res.body.aggregate.totalInputTokens).toBe(2220);
    expect(res.body.metrics.map((m: any) => m.llmCalls)).toEqual([2, 2, 2]);
  });

  it('the single-run route applies the same rule (run-2 with its window hint = its own spans only)', async () => {
    const h = win(5);
    const res = await request(app)
      .get(`/api/metrics/run-2?traceId=t2&serviceName=${SVC}&startedAt=${h.startedAt}&endedAt=${h.endedAt}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ inputTokens: 2000, llmCalls: 2, correlatedBy: 'ids' }));
  });

  it('a request with NO window hints is unchanged: exact correlators only', async () => {
    const res = await request(app).post('/api/metrics/batch').send({ runIds: ['run-1', 'run-2', 'report-3'], traceIds: { 'run-1': 't1' } });
    expect(res.status).toBe(200);
    const byKey = new Map<string, any>(res.body.metrics.map((m: any) => [m.runId, m]));
    expect(byKey.get('run-1')).toEqual(expect.objectContaining({ inputTokens: 200, llmCalls: 2, correlatedBy: 'ids' }));
    expect(byKey.get('run-2')).toEqual(expect.objectContaining({ inputTokens: 2000, llmCalls: 2, correlatedBy: 'ids' }));
    expect(byKey.get('report-3')).toEqual(expect.objectContaining({ status: 'pending', hasSpans: false }));
  });
});
