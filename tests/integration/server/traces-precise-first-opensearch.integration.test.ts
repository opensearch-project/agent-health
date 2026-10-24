/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Precise-first trace correlation through the REAL `POST /api/traces` route,
 * the REAL `OpenSearchObservabilityModule` and the REAL `fetchTraces` DSL —
 * only the cluster is faked: an in-memory index whose field resolution mirrors
 * the two schemas live clusters hold (Data Prepper flat `span.attributes.*@*`
 * and nested `attributes.*` with `.keyword` sub-fields), evaluating the exact
 * `bool` / `term` / `terms` / `range` / `match` / `wildcard` query the service
 * sends, with `sort` + `search_after` paging.
 *
 * Fixture = what a benchmark at concurrency 3 really writes: three runs of the
 * SAME agent whose wall-clock windows overlap, each a single W3C trace holding
 *   eval `test_case` root (agent-health, carries the run id)
 *     └ agent `POST /invoke` (carries the run id via baggage)
 *         ├ `chat`                       (run id)
 *         ├ `execute_tool search`        (run id)
 *         │   ├ `GET /search`  HTTP child — NO identity attributes
 *         │   └ `opensearch.query` DB child — NO identity attributes
 *     └ judge `chat` (gen_ai.operation.name = evaluation)
 * plus a fourth run whose agent emits NO correlator at all (Strategy-C-only:
 * its eval span and its agent spans are on different traces), and a
 * third-party trace that fills the OTEL-standard ids with its own thread id.
 *
 * Pre-fix (`bool.should` union of every clause) the run-report request for
 * run 1 returned every run's tree. Now: exact first, window only as fallback,
 * window result post-filtered per trace, `correlation` names the strategy.
 */

import express, { Express } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const AGENT = 'retrieval-agent';
const EVAL_SERVICE = 'agent-health';
const T = (s: string) => Date.parse(`2026-03-01T10:${s}Z`);
const ISO = (ms: number) => new Date(ms).toISOString().replace('Z', '000000Z'); // ns precision like Data Prepper
const RUN = (n: number) => `run-${n}-concurrent`;
const TRACE = (c: string) => c.repeat(32);

interface Doc { [k: string]: any }

/** Data Prepper flat-@ schema (what an OSI pipeline writes). */
function flat(d: { traceId: string; spanId: string; parentSpanId?: string; name: string; startMs: number; durMs?: number; service: string; attrs?: Record<string, string> }): Doc {
  const doc: Doc = {
    traceId: d.traceId, spanId: d.spanId, parentSpanId: d.parentSpanId ?? '', name: d.name,
    kind: 'SPAN_KIND_INTERNAL', serviceName: d.service,
    startTime: ISO(d.startMs), endTime: ISO(d.startMs + (d.durMs ?? 300)), durationInNanos: (d.durMs ?? 300) * 1e6,
    'status.code': 1, 'resource.attributes.service@name': d.service,
  };
  for (const [k, v] of Object.entries(d.attrs ?? {})) doc[`span.attributes.${k.replace(/\./g, '@')}`] = v;
  return doc;
}

/** Nested plain-raw schema (OTel collector → ss4o-style index). */
function nested(d: { traceId: string; spanId: string; parentSpanId?: string; name: string; startMs: number; durMs?: number; service: string; attrs?: Record<string, string> }): Doc {
  return {
    traceId: d.traceId, spanId: d.spanId, parentSpanId: d.parentSpanId ?? '', name: d.name,
    kind: 'SPAN_KIND_INTERNAL', serviceName: d.service,
    startTime: ISO(d.startMs), endTime: ISO(d.startMs + (d.durMs ?? 300)), durationInNanos: (d.durMs ?? 300) * 1e6,
    status: { code: 1 }, attributes: { ...(d.attrs ?? {}) }, resource: { attributes: { 'service.name': d.service } },
  };
}

/** One real-shaped run: eval root + agent subtree (identity-less HTTP/DB leaves) + judge span, one trace. */
function runTree(n: number, startMs: number, shape: typeof flat | typeof nested): Doc[] {
  const traceId = TRACE(String(n));
  const id = (k: number) => `${n}${k}`.padEnd(16, '0');
  const runAttrs = { 'agent_health.run.id': RUN(n), 'gen_ai.conversation.id': RUN(n) };
  return [
    shape({ traceId, spanId: id(1), name: 'test_case', startMs, durMs: 40_000, service: EVAL_SERVICE, attrs: { ...runAttrs, 'gen_ai.operation.name': 'evaluation' } }),
    shape({ traceId, spanId: id(2), parentSpanId: id(1), name: 'POST /invoke', startMs: startMs + 500, durMs: 20_000, service: AGENT, attrs: runAttrs }),
    shape({ traceId, spanId: id(3), parentSpanId: id(2), name: 'chat', startMs: startMs + 1_000, service: AGENT, attrs: { ...runAttrs, 'gen_ai.operation.name': 'chat' } }),
    shape({ traceId, spanId: id(4), parentSpanId: id(2), name: 'execute_tool search', startMs: startMs + 2_000, service: AGENT, attrs: { ...runAttrs, 'gen_ai.operation.name': 'execute_tool' } }),
    shape({ traceId, spanId: id(5), parentSpanId: id(4), name: 'GET /search', startMs: startMs + 2_100, service: AGENT, attrs: { 'http.request.method': 'GET' } }),
    shape({ traceId, spanId: id(6), parentSpanId: id(4), name: 'opensearch.query', startMs: startMs + 2_200, service: AGENT, attrs: { 'db.system': 'opensearch' } }),
    shape({ traceId, spanId: id(7), parentSpanId: id(1), name: 'chat', startMs: startMs + 30_000, service: EVAL_SERVICE, attrs: { ...runAttrs, 'gen_ai.operation.name': 'evaluation' } }),
  ];
}

const T0 = T('00:00.000');
const INDEX: Doc[] = [
  ...runTree(1, T0, flat),             // 10:00:00 – 10:00:40
  ...runTree(2, T0 + 5_000, nested),   // 10:00:05 – 10:00:45 (overlaps run 1)
  ...runTree(3, T0 + 10_000, flat),    // 10:00:10 – 10:00:50 (overlaps both)
  // Run 4: Strategy-C-only agent. Its eval span is on its own trace and carries the
  // run id; the agent's spans are on ANOTHER trace with no correlator at all.
  flat({ traceId: TRACE('e'), spanId: '4100000000000000', name: 'test_case', startMs: T0 + 15_000, durMs: 30_000, service: EVAL_SERVICE, attrs: { 'agent_health.run.id': RUN(4), 'gen_ai.operation.name': 'evaluation' } }),
  flat({ traceId: TRACE('4'), spanId: '4200000000000000', name: 'POST /invoke', startMs: T0 + 15_500, durMs: 10_000, service: AGENT }),
  flat({ traceId: TRACE('4'), spanId: '4300000000000000', parentSpanId: '4200000000000000', name: 'chat', startMs: T0 + 16_000, service: AGENT }),
  flat({ traceId: TRACE('4'), spanId: '4400000000000000', parentSpanId: '4300000000000000', name: 'GET /search', startMs: T0 + 16_100, service: AGENT }),
  // A third-party agent run inside the window filling the OTEL-standard ids with its own thread/session id.
  nested({ traceId: TRACE('f'), spanId: 'f100000000000000', name: 'POST /invoke', startMs: T0 + 20_000, service: AGENT, attrs: { 'gen_ai.conversation.id': 'thread-42', 'session.id': 'sess-third-party' } }),
  // Same agent, an hour later — outside every window.
  flat({ traceId: TRACE('9'), spanId: '9100000000000000', name: 'POST /invoke', startMs: T0 + 3_600_000, service: AGENT }),
];

// ---------------------------------------------------------------------------
// Fake cluster: evaluates the DSL fetchTraces sends, sorted + search_after.
// ---------------------------------------------------------------------------

function resolveField(doc: Doc, field: string): unknown {
  if (field in doc) return doc[field];
  // `.keyword` exists on text-mapped (nested-schema) fields, not on flat-@ docs.
  if (field.endsWith('.keyword')) {
    const base = field.slice(0, -'.keyword'.length);
    return base.startsWith('attributes.') && doc.attributes ? doc.attributes[base.slice('attributes.'.length)] : undefined;
  }
  if (field.startsWith('attributes.')) return doc.attributes?.[field.slice('attributes.'.length)];
  if (field.startsWith('resource.attributes.')) return doc.resource?.attributes?.[field.slice('resource.attributes.'.length)];
  return undefined;
}

function matches(clause: any, doc: Doc): boolean {
  if (!clause || typeof clause !== 'object') return true;
  if (clause.term) {
    const [field, val] = Object.entries(clause.term)[0] as [string, unknown];
    return resolveField(doc, field) === val;
  }
  if (clause.terms) {
    const [field, vals] = Object.entries(clause.terms)[0] as [string, unknown[]];
    return vals.includes(resolveField(doc, field) as never);
  }
  if (clause.range) {
    const [field, bounds] = Object.entries(clause.range)[0] as [string, any];
    const t = Date.parse(String(resolveField(doc, field)));
    if (bounds.gte !== undefined && t < Date.parse(bounds.gte)) return false;
    if (bounds.lte !== undefined && t > Date.parse(bounds.lte)) return false;
    return true;
  }
  if (clause.match) {
    const [field, val] = Object.entries(clause.match)[0] as [string, string];
    return String(resolveField(doc, field) ?? '').toLowerCase().includes(String(val).toLowerCase());
  }
  if (clause.wildcard) {
    const [field, spec] = Object.entries(clause.wildcard)[0] as [string, any];
    const v = resolveField(doc, field);
    if (typeof v !== 'string') return false;
    const re = new RegExp('^' + String(spec.value).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', spec.case_insensitive ? 'i' : '');
    return re.test(v);
  }
  if (clause.bool) {
    const { must = [], should = [], minimum_should_match } = clause.bool;
    const mustOk = (must as any[]).every((c) => matches(c, doc));
    const shouldOk = should.length === 0 || (minimum_should_match ?? 0) === 0 ? true : (should as any[]).some((c) => matches(c, doc));
    return mustOk && shouldOk;
  }
  throw new Error(`fake cluster: unsupported clause ${JSON.stringify(clause)}`);
}

const searchCalls: any[] = [];
function fakeSearch({ body }: any) {
  searchCalls.push(body);
  const sorted = INDEX.filter((d) => matches(body.query, d)).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  let from = 0;
  if (body.search_after) {
    const [after] = body.search_after as [number];
    from = sorted.findIndex((d) => Date.parse(d.startTime) < after);
    if (from < 0) from = sorted.length;
  }
  const page = sorted.slice(from, from + (body.size ?? 100));
  return Promise.resolve({
    body: {
      hits: {
        total: { value: sorted.length },
        hits: page.map((d) => ({ _source: d, sort: [Date.parse(d.startTime)] })),
      },
    },
  });
}

jest.mock('@opensearch-project/opensearch', () => {
  const actual = jest.requireActual('@opensearch-project/opensearch');
  return {
    ...actual,
    Client: jest.fn().mockImplementation(() => ({ search: fakeSearch, cat: { indices: async () => ({ statusCode: 200 }) }, close: async () => {} })),
  };
});

import tracesRoutes from '@/server/routes/traces';
import { __resetObservabilityCachesForTests } from '@/server/services/observabilityClient';

// The run-report Traces tab's window for run 1: [start − 60 s, end + 60 s] — it
// contains every other run's agent spans (concurrency 3).
const WINDOW_RUN1 = [{ serviceName: AGENT, startedAt: T0 - 60_000, endedAt: T0 + 40_000 + 60_000 }];
const ids = (spans: any[]) => spans.map((s) => s.spanId).sort();
const AGENT_SPANS_OF = (n: number) => [`${n}2`, `${n}3`, `${n}4`, `${n}5`, `${n}6`].map((p) => p.padEnd(16, '0'));

describe('precise-first trace correlation (integration, OpenSearch module over a fake cluster)', () => {
  let app: Express;
  const ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'OBSERVABILITY_TYPE', 'AGENT_HEALTH_DATA_DIR'];
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.OBSERVABILITY_TYPE;
    process.env.OPENSEARCH_LOGS_ENDPOINT = 'http://fake-cluster.invalid:9200';
    process.env.OPENSEARCH_LOGS_USERNAME = 'reader';
    process.env.OPENSEARCH_LOGS_PASSWORD = 'reader';
    __resetObservabilityCachesForTests();
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(tracesRoutes);
  });

  afterAll(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetObservabilityCachesForTests();
  });

  beforeEach(() => { searchCalls.length = 0; });

  it('sanity: the service-name window alone sees all four runs + the third-party trace (what the old union pulled in)', async () => {
    const res = await request(app).post('/api/traces').send({ agents: WINDOW_RUN1, size: 1000 }).expect(200);
    expect(res.body.backend).toBe('opensearch');
    // 3 × 5 agent spans + run 4's 3 agent spans + the third-party root; eval/judge spans are another service.
    expect(res.body.spans).toHaveLength(19);
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 0 });
  });

  it('run-report request (traceId + runId + window) for run 1 returns ONLY run 1\'s trace — eval root, agent subtree incl. identity-less HTTP/DB leaves, judge span', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE('1'), runIds: [RUN(1)], agents: WINDOW_RUN1, size: 1000 })
      .expect(200);
    const spans: any[] = res.body.spans;
    expect(ids(spans)).toEqual(['11', '12', '13', '14', '15', '16', '17'].map((p) => p.padEnd(16, '0')));
    expect(spans.every((s) => s.traceId === TRACE('1'))).toBe(true);
    expect(spans.filter((s) => !s.parentSpanId)).toHaveLength(1);
    expect(res.body.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });
    // (fetchTraces always hands back the last hit's sort values as a cursor; `hasMore` is the signal.)
    expect(res.body).toMatchObject({ total: 7, hasMore: false, backend: 'opensearch' });
    // ONE cluster round-trip: the window was never consulted.
    expect(searchCalls).toHaveLength(1);
    expect(JSON.stringify(searchCalls[0].query)).not.toContain('"serviceName"');
  });

  it('the exact query is schema-agnostic: run 2 (nested attributes) by run id only, both run-id attributes + .keyword paths', async () => {
    const res = await request(app).post('/api/traces').send({ runIds: [RUN(2)], agents: WINDOW_RUN1, size: 1000 }).expect(200);
    // Identity-less leaves (25, 26) carry no run id — Strategy B alone cannot see them; Strategy A (traceId) does.
    expect(ids(res.body.spans)).toEqual(['21', '22', '23', '24', '27'].map((p) => p.padEnd(16, '0')));
    expect(res.body.correlation.strategy).toBe('runIds');
  });

  it('a Strategy-C-only run (its agent stamped nothing): eval span kept in front, window fallback, every other run\'s WHOLE trace dropped (leaves follow their root), third-party trace kept', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE('e'), runIds: [RUN(4)], agents: [{ serviceName: AGENT, startedAt: T0 + 15_000 - 60_000, endedAt: T0 + 45_000 + 60_000 }], size: 1000 })
      .expect(200);
    const spans: any[] = res.body.spans;
    expect(spans[0].spanId).toBe('4100000000000000'); // our own eval span, found by the exact phase
    expect(ids(spans)).toEqual(['4100000000000000', '4200000000000000', '4300000000000000', '4400000000000000', 'f100000000000000']);
    // 15 spans dropped: runs 1–3's agent subtrees (5 each), INCLUDING the 2 identity-less leaves per run.
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 15 });
    expect(spans.some((s) => AGENT_SPANS_OF(1).includes(s.spanId) || AGENT_SPANS_OF(2).includes(s.spanId) || AGENT_SPANS_OF(3).includes(s.spanId))).toBe(false);
    expect(res.body.total).toBe(5);
    expect(searchCalls).toHaveLength(2); // exact, then window
  });

  it('a stale report session id does not zero out a trace-id match (sessionId is unioned, not a must-filter)', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE('3'), runIds: [RUN(3)], sessionId: 'sess-stale-not-on-any-span', agents: WINDOW_RUN1, size: 1000 })
      .expect(200);
    expect(ids(res.body.spans)).toEqual(['31', '32', '33', '34', '35', '36', '37'].map((p) => p.padEnd(16, '0')));
    expect(res.body.correlation.strategy).toBe('traceId');
  });

  it('sessionId alone (+ window) matches the third-party trace exactly and never falls back', async () => {
    const res = await request(app).post('/api/traces').send({ sessionId: 'sess-third-party', agents: WINDOW_RUN1, size: 1000 }).expect(200);
    expect(ids(res.body.spans)).toEqual(['f100000000000000']);
    expect(res.body.correlation).toEqual({ strategy: 'sessionId', windowFiltered: 0 });
    expect(searchCalls).toHaveLength(1);
  });

  it('pagination continues the phase that produced page 1 (search_after wrapped in the phase cursor)', async () => {
    const first = await request(app).post('/api/traces')
      .send({ traceId: TRACE('1'), runIds: [RUN(1)], agents: WINDOW_RUN1, size: 4 })
      .expect(200);
    expect(first.body.spans).toHaveLength(4);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.correlation.strategy).toBe('traceId');

    const second = await request(app).post('/api/traces')
      .send({ traceId: TRACE('1'), runIds: [RUN(1)], agents: WINDOW_RUN1, size: 4, cursor: first.body.nextCursor })
      .expect(200);
    expect(second.body.spans).toHaveLength(3);
    expect(second.body.spans.every((s: any) => s.traceId === TRACE('1'))).toBe(true);
    expect(second.body.correlation.strategy).toBe('traceId');
    expect(ids([...first.body.spans, ...second.body.spans])).toEqual(['11', '12', '13', '14', '15', '16', '17'].map((p) => p.padEnd(16, '0')));
    // Both pages were exact-phase queries (search_after on the second), never the window.
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[1].search_after).toBeDefined();
    expect(JSON.stringify(searchCalls[1].query)).not.toContain('"serviceName"');
  });

  it('a plain time-range browse is one query with no correlation field', async () => {
    const res = await request(app).post('/api/traces').send({ startTime: T0 - 1_000, endTime: T0 + 60_000, size: 100 }).expect(200);
    expect(res.body.spans.length).toBeGreaterThan(0);
    expect(res.body.correlation).toBeUndefined();
    expect(searchCalls).toHaveLength(1);
  });
});
