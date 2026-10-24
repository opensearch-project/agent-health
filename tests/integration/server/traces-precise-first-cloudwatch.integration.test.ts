/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Precise-first trace correlation through the REAL `POST /api/traces` route
 * and the REAL `CloudWatchObservabilityModule` (`OBSERVABILITY_TYPE=cloudwatch`).
 * Only the AWS network hop is faked: the real `@aws-sdk/client-cloudwatch-logs`
 * commands are intercepted at `send()` over an in-memory `aws/spans` log group
 * holding Transaction-Search-shaped records (resource/scope/attributes blocks,
 * `startTimeUnixNano`, `durationNano`, string `status.code`).
 *
 * Fixture: a benchmark at concurrency 3 — three runs of one agent with
 * overlapping windows, each one trace of eval root → agent subtree (with
 * identity-less HTTP/DB leaves) → judge span — plus a Strategy-C-only run
 * (eval span on one trace, correlator-less agent spans on another).
 *
 * Asserts the behaviour AND the cost profile: the exact phase narrows its
 * FilterLogEvents / Insights scan to the run's window (the `scanWindow` hint
 * the precise-first layer derives from the `agents[]` it strips), so a
 * CloudWatch user does not pay a lookback-wide Insights scan for a lookup the
 * old union answered from a ~10-minute window.
 */

import express, { Express } from 'express';
import request from 'supertest';
import {
  FilterLogEventsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// ---------------------------------------------------------------------------
// Fixture (Transaction Search `aws/spans` record shape)
// ---------------------------------------------------------------------------

const AGENT = 'retrieval-agent';
const EVAL_SERVICE = 'agent-health';
const RUN = (n: number) => `run-${n}-concurrent`;
const TRACE = (c: string) => c.repeat(32);
// Recent (inside the module's default 7-day lookback), fixed for determinism.
const T0 = Date.now() - 2 * 60 * 60 * 1000;

function record(d: { traceId: string; spanId: string; parentSpanId?: string; name: string; startMs: number; durMs?: number; service: string; kind?: string; attrs?: Record<string, string> }) {
  const dur = d.durMs ?? 300;
  return {
    resource: { attributes: { 'service.name': d.service, 'telemetry.sdk.language': 'python', 'cloud.provider': 'aws' } },
    scope: { name: 'demo_agent', version: '' },
    traceId: d.traceId, spanId: d.spanId, ...(d.parentSpanId ? { parentSpanId: d.parentSpanId } : {}),
    flags: 768, name: d.name, kind: d.kind ?? 'INTERNAL',
    startTimeUnixNano: d.startMs * 1e6, endTimeUnixNano: (d.startMs + dur) * 1e6, durationNano: dur * 1e6,
    attributes: { 'aws.local.service': d.service, 'aws.span.kind': d.kind ?? 'INTERNAL', ...(d.attrs ?? {}) },
    status: { code: 'OK' },
  };
}

function runTree(n: number, startMs: number) {
  const traceId = TRACE(String(n));
  const id = (k: number) => `${n}${k}`.padEnd(16, '0');
  const runAttrs = { 'agent_health.run.id': RUN(n), 'gen_ai.conversation.id': RUN(n) };
  return [
    record({ traceId, spanId: id(1), name: 'test_case', startMs, durMs: 40_000, service: EVAL_SERVICE, attrs: { ...runAttrs, 'gen_ai.operation.name': 'evaluation' } }),
    record({ traceId, spanId: id(2), parentSpanId: id(1), name: 'POST /invoke', startMs: startMs + 500, durMs: 20_000, service: AGENT, kind: 'SERVER', attrs: { ...runAttrs, 'http.request.method': 'POST', 'http.route': '/invoke' } }),
    record({ traceId, spanId: id(3), parentSpanId: id(2), name: 'chat', startMs: startMs + 1_000, service: AGENT, attrs: { ...runAttrs, 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'demo-model', 'gen_ai.usage.input_tokens': '100', 'gen_ai.usage.output_tokens': '10' } }),
    record({ traceId, spanId: id(4), parentSpanId: id(2), name: 'execute_tool search', startMs: startMs + 2_000, service: AGENT, attrs: { ...runAttrs, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    record({ traceId, spanId: id(5), parentSpanId: id(4), name: 'GET /search', startMs: startMs + 2_100, service: AGENT, kind: 'CLIENT', attrs: { 'http.request.method': 'GET' } }),
    record({ traceId, spanId: id(6), parentSpanId: id(4), name: 'opensearch.query', startMs: startMs + 2_200, service: AGENT, kind: 'CLIENT', attrs: { 'db.system': 'opensearch' } }),
    record({ traceId, spanId: id(7), parentSpanId: id(1), name: 'chat', startMs: startMs + 30_000, service: EVAL_SERVICE, attrs: { ...runAttrs, 'gen_ai.operation.name': 'evaluation' } }),
  ];
}

const RECORDS = [
  ...runTree(1, T0),
  ...runTree(2, T0 + 5_000),
  ...runTree(3, T0 + 10_000),
  record({ traceId: TRACE('e'), spanId: '4100000000000000', name: 'test_case', startMs: T0 + 15_000, durMs: 30_000, service: EVAL_SERVICE, attrs: { 'agent_health.run.id': RUN(4), 'gen_ai.operation.name': 'evaluation' } }),
  record({ traceId: TRACE('4'), spanId: '4200000000000000', name: 'POST /invoke', startMs: T0 + 15_500, durMs: 10_000, service: AGENT, kind: 'SERVER' }),
  record({ traceId: TRACE('4'), spanId: '4300000000000000', parentSpanId: '4200000000000000', name: 'chat', startMs: T0 + 16_000, service: AGENT }),
  record({ traceId: TRACE('4'), spanId: '4400000000000000', parentSpanId: '4300000000000000', name: 'GET /search', startMs: T0 + 16_100, service: AGENT, kind: 'CLIENT' }),
  record({ traceId: TRACE('f'), spanId: 'f100000000000000', name: 'POST /invoke', startMs: T0 + 20_000, service: AGENT, kind: 'SERVER', attrs: { 'gen_ai.conversation.id': 'thread-42', 'session.id': 'sess-third-party' } }),
];

// ---------------------------------------------------------------------------
// Fake CloudWatch Logs transport (same contract as cloudwatch-observability.integration.test.ts)
// ---------------------------------------------------------------------------

const sent: any[] = [];
const group: string[] = RECORDS.map((r) => JSON.stringify(r));
const recordMs = (message: string): number => Math.floor(Number(JSON.parse(message).startTimeUnixNano) / 1e6);

function fakeSend(command: any): any {
  sent.push(command);
  const input = command.input;
  if (command instanceof DescribeLogGroupsCommand) return { logGroups: [{ logGroupName: 'aws/spans' }] };
  if (command instanceof FilterLogEventsCommand) {
    if (input.logGroupName !== 'aws/spans') throw Object.assign(new Error('The specified log group does not exist.'), { name: 'ResourceNotFoundException' });
    // `?"a" ?"b"` term pattern → any record containing one of the quoted terms.
    const terms = input.filterPattern ? [...(input.filterPattern as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)) : [];
    const events = group
      .filter((s) => (terms.length ? terms.some((t: string) => s.includes(t)) : true))
      .filter((s) => { const t = recordMs(s); return t >= input.startTime && t <= input.endTime; })
      .map((s) => ({ message: s, timestamp: recordMs(s), logStreamName: 'default' }));
    return { events };
  }
  if (command instanceof StartQueryCommand) {
    // Insights honours the [startTime, endTime] seconds bounds; the predicate itself is applied in memory by the module.
    return { queryId: `q|${input.startTime}|${input.endTime}` };
  }
  if (command instanceof GetQueryResultsCommand) {
    const [, startS, endS] = (input.queryId as string).split('|').map(Number);
    const results = group
      .filter((m) => { const t = recordMs(m); return t >= startS * 1000 && t <= endS * 1000; })
      .map((m) => [{ field: '@message', value: m }]);
    return { status: 'Complete', results, statistics: { recordsMatched: results.length } };
  }
  throw new Error(`unexpected command ${command.constructor.name}`);
}

jest.mock('@aws-sdk/client-cloudwatch-logs', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudwatch-logs');
  return {
    ...actual,
    CloudWatchLogsClient: jest.fn().mockImplementation(() => ({
      send: (cmd: any) => Promise.resolve().then(() => fakeSend(cmd)),
      destroy: () => {},
    })),
  };
});

import tracesRoutes from '@/server/routes/traces';
import { __resetObservabilityCachesForTests } from '@/server/services/observabilityClient';
import { WINDOW_PAD_MS } from '@/server/adapters/observability/CloudWatchObservabilityModule';

const WINDOW_RUN1 = [{ serviceName: AGENT, startedAt: T0 - 60_000, endedAt: T0 + 40_000 + 60_000 }];
const ids = (spans: any[]) => spans.map((s) => s.spanId).sort();
const starts = () => sent.filter((c) => c instanceof StartQueryCommand);

describe('precise-first trace correlation (integration, CloudWatch module over a fake Logs transport)', () => {
  let app: Express;
  const ENV = ['OBSERVABILITY_TYPE', 'CLOUDWATCH_REGION', 'CLOUDWATCH_AWS_PROFILE', 'OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    process.env.OBSERVABILITY_TYPE = 'cloudwatch';
    process.env.CLOUDWATCH_REGION = 'us-east-1';
    process.env.CLOUDWATCH_AWS_PROFILE = 'test-profile';
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

  beforeEach(() => {
    sent.length = 0;
    __resetObservabilityCachesForTests(); // fresh module → no page snapshot carried between cases
  });

  it('sanity: the window alone returns every run of the agent (the old union\'s population)', async () => {
    const res = await request(app).post('/api/traces').send({ agents: WINDOW_RUN1, size: 1000 }).expect(200);
    expect(res.body.backend).toBe('cloudwatch');
    expect(res.body.spans).toHaveLength(19);
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 0 });
  });

  it('run-report request for run 1: only run 1\'s trace (7 spans, one root), matched by trace id, window never queried', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE('1'), runIds: [RUN(1)], agents: WINDOW_RUN1, size: 1000 })
      .expect(200);
    expect(ids(res.body.spans)).toEqual(['11', '12', '13', '14', '15', '16', '17'].map((p) => p.padEnd(16, '0')));
    expect(res.body.spans.filter((s: any) => !s.parentSpanId)).toHaveLength(1);
    expect(res.body.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });
    expect(res.body.warning).toBeUndefined();
    // Exactly one Insights query (the exact phase) and its predicate has no service-window clause.
    expect(starts()).toHaveLength(1);
    expect(starts()[0].input.queryString).toContain(`traceId = "${TRACE('1')}"`);
    expect(starts()[0].input.queryString).not.toContain('service.name');
    // FilterLogEvents was asked for the exact ids only.
    const filter = sent.find((c) => c instanceof FilterLogEventsCommand);
    expect(filter.input.filterPattern).toBe(`?"${TRACE('1')}" ?"${RUN(1)}"`);
  });

  it('cost profile: the exact phase narrows its scan to the run window (±pad) instead of the whole lookback', async () => {
    await request(app).post('/api/traces').send({ traceId: TRACE('1'), runIds: [RUN(1)], agents: WINDOW_RUN1, size: 1000 }).expect(200);
    const q = starts()[0].input;
    // StartQuery bounds are epoch SECONDS (floor/ceil).
    expect(q.startTime).toBe(Math.floor((WINDOW_RUN1[0].startedAt - WINDOW_PAD_MS) / 1000));
    expect(q.endTime).toBe(Math.ceil((WINDOW_RUN1[0].endedAt + WINDOW_PAD_MS) / 1000));
    const filters = sent.filter((c) => c instanceof FilterLogEventsCommand);
    expect(Math.min(...filters.map((c) => c.input.startTime))).toBeGreaterThanOrEqual(WINDOW_RUN1[0].startedAt - WINDOW_PAD_MS);
    expect(Math.max(...filters.map((c) => c.input.endTime))).toBeLessThanOrEqual(WINDOW_RUN1[0].endedAt + WINDOW_PAD_MS);
  });

  it('Strategy-C-only run: eval span in front, window fallback drops runs 1–3 whole (identity-less leaves follow their root), keeps the third-party trace', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE('e'), runIds: [RUN(4)], agents: [{ serviceName: AGENT, startedAt: T0 + 15_000 - 60_000, endedAt: T0 + 45_000 + 60_000 }], size: 1000 })
      .expect(200);
    const spans: any[] = res.body.spans;
    expect(spans[0].spanId).toBe('4100000000000000');
    expect(ids(spans)).toEqual(['4100000000000000', '4200000000000000', '4300000000000000', '4400000000000000', 'f100000000000000']);
    expect(res.body.correlation).toEqual({ strategy: 'window', windowFiltered: 15 });
    expect(starts()).toHaveLength(2); // exact, then the window
  });

  it('a stale session id on the report cannot zero out the trace-id match (sessionId unioned in matchesQuery)', async () => {
    const res = await request(app).post('/api/traces')
      .send({ traceId: TRACE('2'), runIds: [RUN(2)], sessionId: 'sess-stale', agents: WINDOW_RUN1, size: 1000 })
      .expect(200);
    expect(ids(res.body.spans)).toEqual(['21', '22', '23', '24', '25', '26', '27'].map((p) => p.padEnd(16, '0')));
    expect(res.body.correlation.strategy).toBe('traceId');
  });

  it('offset pagination stays inside the exact phase', async () => {
    const first = await request(app).post('/api/traces').send({ traceId: TRACE('3'), runIds: [RUN(3)], agents: WINDOW_RUN1, size: 5 }).expect(200);
    expect(first.body.spans).toHaveLength(5);
    expect(first.body.hasMore).toBe(true);
    const second = await request(app).post('/api/traces').send({ traceId: TRACE('3'), runIds: [RUN(3)], agents: WINDOW_RUN1, size: 5, cursor: first.body.nextCursor }).expect(200);
    expect(second.body.spans).toHaveLength(2);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.correlation.strategy).toBe('traceId');
    expect(ids([...first.body.spans, ...second.body.spans])).toEqual(['31', '32', '33', '34', '35', '36', '37'].map((p) => p.padEnd(16, '0')));
  });
});
