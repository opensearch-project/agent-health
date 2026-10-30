/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An errored SPAN inside a trace that WAS found is not a trace-store failure —
 * HTTP integration over the real `/api/metrics/batch` route and a real
 * composite of two backend modules:
 *   - primary: OpenSearch (env `OPENSEARCH_LOGS_*`), its client replaced by an
 *     in-memory fake `search` holding a control run (no errored span);
 *   - "Team CloudWatch": a TS-authored additional source, the AWS SDK client's
 *     `send` replaced by an in-memory fake over a 59-span agent trace whose
 *     2nd tool call failed (OTel status ERROR) — the shape a REST agent whose
 *     traces land in a CloudWatch source produces.
 *
 * Pre-fix the composite took the CloudWatch result's `status: 'error'` (the
 * agent's own failing tool call) for a failed store query, dropped the only
 * source holding the run, and answered
 * `{ status: 'error', error: 'Team CloudWatch: trace-store query failed' }`
 * with 306K tokens attached — which every consumer renders as "Metrics
 * unavailable". A REAL store failure (the source throws) must still read error.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { FilterLogEventsCommand, StartQueryCommand, GetQueryResultsCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { buildAgentTraceWithErrorSpan, toCloudWatchSpanRecord, AGENT_TRACE_FIXTURE } from '../../../helpers/agentTraceWithErrorSpan';

const ERR_RUN = 'run-with-failing-tool-call';
const ERR_TRACE = 'e'.repeat(32);
const OK_RUN = 'run-control-no-errors';
const OK_TRACE = 'd'.repeat(32);
const T0 = Date.parse('2026-03-01T10:00:00Z');

// ---- fake CloudWatch transport over the error-span trace --------------------
const cwRecords = buildAgentTraceWithErrorSpan({ runId: ERR_RUN, traceId: ERR_TRACE, startedAt: T0 }).map((d) => JSON.stringify(toCloudWatchSpanRecord(d)));
const groups: Record<string, string[]> = { 'aws/spans': cwRecords };
let cwDown = false;
function fakeSend(command: any): any {
  if (cwDown) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  const input = command.input;
  if (command instanceof DescribeLogGroupsCommand) return { logGroups: Object.keys(groups).filter((g) => g.startsWith(input.logGroupNamePrefix || '')).map((n) => ({ logGroupName: n })) };
  if (command instanceof FilterLogEventsCommand) {
    const msgs = groups[input.logGroupName];
    if (!msgs) throw Object.assign(new Error('The specified log group does not exist.'), { name: 'ResourceNotFoundException' });
    const terms = input.filterPattern ? [...(input.filterPattern as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)) : [];
    return { events: msgs.filter((s) => (terms.length ? terms.some((t: string) => s.includes(t)) : true)).map((s) => ({ message: s, timestamp: T0 })) };
  }
  if (command instanceof StartQueryCommand) return { queryId: `q-${input.logGroupNames.join(',')}` };
  if (command instanceof GetQueryResultsCommand) return { status: 'Complete', results: (groups[(input.queryId as string).replace(/^q-/, '')] || []).map((m) => [{ field: '@message', value: m }]) };
  throw new Error(`unexpected command ${command.constructor.name}`);
}
jest.mock('@aws-sdk/client-cloudwatch-logs', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudwatch-logs');
  return { ...actual, CloudWatchLogsClient: jest.fn().mockImplementation(() => ({ send: (cmd: any) => Promise.resolve().then(() => fakeSend(cmd)), destroy: () => {} })) };
});

// ---- fake OpenSearch client for the primary source (control run) -------------
const OS_DOCS = buildAgentTraceWithErrorSpan({ runId: OK_RUN, traceId: OK_TRACE, startedAt: T0 + 3_600_000, withErrorSpan: false });
jest.mock('@/server/services/opensearchClientFactory', () => ({
  ...jest.requireActual('@/server/services/opensearchClientFactory'),
  createOpenSearchClient: jest.fn(() => ({
    close: async () => {},
    cat: { indices: async () => ({ statusCode: 200, body: [] }) },
    search: async ({ body }: any) => {
      const q = JSON.stringify(body.query);
      const hits = q.includes(OK_RUN) || q.includes(OK_TRACE) ? OS_DOCS : [];
      return { body: { hits: { total: { value: hits.length }, hits: hits.map((d) => ({ _source: d, sort: [d.startTime] })) } } };
    },
  })),
}));

import metricsRoutes from '@/server/routes/metrics';
import { getObservabilitySourcesFromTs } from '@/server/services/configService';
import { __resetObservabilityCachesForTests } from '@/server/services/observabilityClient';

describe('POST /api/metrics/batch on a composite backend — an errored span is not a store failure (HTTP integration)', () => {
  let app: Express;
  const ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_TRACES_INDEX', 'OBSERVABILITY_TYPE'];
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.OBSERVABILITY_TYPE;
    process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://my-cluster.example';
    process.env.OPENSEARCH_LOGS_TRACES_INDEX = 'otel-v1-apm-span-*';
    (getObservabilitySourcesFromTs as jest.Mock).mockReturnValue([{ id: 'team-cw', name: 'Team CloudWatch', type: 'cloudwatch', awsRegion: 'us-east-1' }]);
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(metricsRoutes);
  });
  afterAll(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    (getObservabilitySourcesFromTs as jest.Mock).mockReturnValue([]);
    __resetObservabilityCachesForTests();
  });
  beforeEach(() => { cwDown = false; __resetObservabilityCachesForTests(); });

  it('the fixture is real-shaped: 59 spans incl. our eval span, 2 of them ERROR (one failing tool call + its HTTP child)', () => {
    expect(cwRecords).toHaveLength(AGENT_TRACE_FIXTURE.spanCount);
    const parsed = cwRecords.map((s) => JSON.parse(s));
    expect(parsed.filter((r) => r.status.code === 'ERROR').map((r) => r.name)).toEqual(['execute_tool search_index', 'POST /{index}/_search']);
    expect(parsed.some((r) => r.name === 'test_case')).toBe(true);
  });

  it('a run whose trace has one failing tool call gets its tokens / cost / LLM calls from the source holding it — no `error`, failing spans reported as agentErrorSpans', async () => {
    const res = await request(app).post('/api/metrics/batch').send({ runIds: [ERR_RUN, OK_RUN], traceIds: { [ERR_RUN]: ERR_TRACE, [OK_RUN]: OK_TRACE } });
    expect(res.status).toBe(200);
    const [err, ok] = res.body.metrics;
    expect(err).toMatchObject({
      runId: ERR_RUN, source: 'Team CloudWatch', hasSpans: true, status: 'success',
      totalTokens: 306_000, inputTokens: 300_000, outputTokens: 6_000, llmCalls: AGENT_TRACE_FIXTURE.llmCalls, toolCalls: AGENT_TRACE_FIXTURE.toolCalls,
      agentErrorSpans: AGENT_TRACE_FIXTURE.errorSpans,
    });
    expect(err.costUsd).toBeGreaterThan(0);
    expect(err.error).toBeUndefined();
    expect(ok).toMatchObject({ runId: OK_RUN, source: 'primary', hasSpans: true, status: 'success', totalTokens: 306_000 });
    expect(ok.agentErrorSpans).toBeUndefined();
    // The route's aggregate counts both as answered (neither is an error entry).
    expect(res.body.aggregate.totalRuns).toBe(2);
    expect(res.body.aggregate.successRate).toBe(1);
  });

  it('a REAL store failure in the source holding the run still reads error (unknown, retry) — never zeros; the other source\'s run is unaffected', async () => {
    cwDown = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post('/api/metrics/batch').send({ runIds: [ERR_RUN, OK_RUN], traceIds: { [ERR_RUN]: ERR_TRACE, [OK_RUN]: OK_TRACE } });
    warn.mockRestore();
    expect(res.status).toBe(200);
    const [err, ok] = res.body.metrics;
    expect(err).toMatchObject({ runId: ERR_RUN, status: 'error' });
    expect(err.error).toMatch(/^Team CloudWatch: .*Rate exceeded/);
    expect(err.hasSpans).toBeUndefined();
    expect(ok).toMatchObject({ runId: OK_RUN, source: 'primary', totalTokens: 306_000 });
    expect(res.body.aggregate.totalRuns).toBe(1);
  });
});
