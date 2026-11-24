/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Several observability sources read side by side — HTTP integration.
 *
 * Real routers (traces / logs / metrics / observability) over one composite
 * built from two REAL backend modules:
 *   - primary: OpenSearch (env `OPENSEARCH_LOGS_*`), the OpenSearch Client the
 *     factory would construct replaced by an in-memory fake `search`;
 *   - "Team CloudWatch": a TS-authored additional source, the AWS SDK client's
 *     `send` replaced by an in-memory fake over the aws/spans fixture.
 * What is asserted is what a browser sees: merged spans tagged per source,
 * a named warning when one source fails, metrics taken from exactly one
 * source, per-source health.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { FilterLogEventsCommand, StartQueryCommand, GetQueryResultsCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import spanFixture from '../../fixtures/cloudwatch/aws-spans-trace.json';

// ---- fake CloudWatch transport (same as the single-backend suite) ----------
const groups: Record<string, string[]> = { 'aws/spans': (spanFixture as any[]).map((r) => JSON.stringify(r)) };
let cwDown = false;
function fakeSend(command: any): any {
  if (cwDown) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
  const input = command.input;
  if (command instanceof DescribeLogGroupsCommand) return { logGroups: Object.keys(groups).filter((g) => g.startsWith(input.logGroupNamePrefix || '')).map((n) => ({ logGroupName: n })) };
  if (command instanceof FilterLogEventsCommand) {
    const msgs = groups[input.logGroupName];
    if (!msgs) throw Object.assign(new Error('The specified log group does not exist.'), { name: 'ResourceNotFoundException' });
    const m = /\{ \$\.traceId = "([0-9a-f]+)" \}/.exec(input.filterPattern || '');
    const terms = !m && input.filterPattern ? [...(input.filterPattern as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)) : [];
    return { events: msgs.filter((s) => (m ? JSON.parse(s).traceId === m[1] : terms.length ? terms.some((t: string) => s.includes(t)) : true)).map((s) => ({ message: s, timestamp: 1788467284282 })) };
  }
  if (command instanceof StartQueryCommand) return { queryId: `q-${input.logGroupNames.join(',')}` };
  if (command instanceof GetQueryResultsCommand) return { status: 'Complete', results: (groups[(input.queryId as string).replace(/^q-/, '')] || []).map((m) => [{ field: '@message', value: m }]) };
  throw new Error(`unexpected command ${command.constructor.name}`);
}
jest.mock('@aws-sdk/client-cloudwatch-logs', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudwatch-logs');
  return { ...actual, CloudWatchLogsClient: jest.fn().mockImplementation(() => ({ send: (cmd: any) => Promise.resolve().then(() => fakeSend(cmd)), destroy: () => {} })) };
});

// ---- fake OpenSearch client for the primary source --------------------------
const OS_TRACE = 'b'.repeat(32);
const osSpan = (spanId: string, parentSpanId: string | undefined, name: string, attrs: Record<string, unknown>, offsetMs: number) => ({
  traceId: OS_TRACE, spanId, parentSpanId, name, kind: 'SPAN_KIND_INTERNAL', serviceName: 'my-agent',
  startTime: new Date(1788467284282 + offsetMs).toISOString(), endTime: new Date(1788467284282 + offsetMs + 50).toISOString(), durationInNanos: 50e6,
  status: { code: 1 }, attributes: { 'agent_health.run.id': 'os-run-1', ...attrs },
});
const OS_DOCS = [
  osSpan('os000000000000a1', undefined, 'invoke_agent my-agent', { 'gen_ai.operation.name': 'invoke_agent' }, 0),
  osSpan('os000000000000a2', 'os000000000000a1', 'chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 500, 'gen_ai.usage.output_tokens': 40 }, 10),
];
let osDown = false;
jest.mock('@/server/services/opensearchClientFactory', () => ({
  ...jest.requireActual('@/server/services/opensearchClientFactory'),
  createOpenSearchClient: jest.fn(() => ({
    close: async () => {},
    cat: { indices: async () => ({ statusCode: 200, body: [] }) },
    search: async ({ body }: any) => {
      if (osDown) throw new Error('my cluster: connect ECONNREFUSED');
      const q = JSON.stringify(body.query);
      const hits = OS_DOCS.filter((d) => q.includes(OS_TRACE) || q.includes('os-run-1') || q.includes('my-agent') || !q.includes('term'));
      return { body: { hits: { total: { value: hits.length }, hits: hits.map((d) => ({ _source: d, sort: [d.startTime] })) } } };
    },
  })),
}));

import tracesRoutes from '@/server/routes/traces';
import logsRoutes from '@/server/routes/logs';
import metricsRoutes from '@/server/routes/metrics';
import observabilityRoutes from '@/server/routes/observability';
import { getObservabilitySourcesFromTs } from '@/server/services/configService';
import { __resetObservabilityCachesForTests } from '@/server/services/observabilityClient';

const CW_TRACE = 'a54f35c518ca4fe4b86b07f10aeea457';
const CW_RUN = 'cw-run-2';

describe('several observability sources side by side (HTTP integration)', () => {
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
    app.use(tracesRoutes);
    app.use(logsRoutes);
    app.use(metricsRoutes);
    app.use(observabilityRoutes);
  });
  afterAll(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    (getObservabilitySourcesFromTs as jest.Mock).mockReturnValue([]);
    __resetObservabilityCachesForTests();
  });
  beforeEach(() => { cwDown = false; osDown = false; __resetObservabilityCachesForTests(); });

  it('GET /api/traces/health reports the composite backend naming both sources', async () => {
    const res = await request(app).get('/api/traces/health');
    expect(res.status).toBe(200);
    expect(res.body.backend).toBe('composite');
  });

  it('GET /api/observability/sources/health lists every source with its own health', async () => {
    const res = await request(app).get('/api/observability/sources/health');
    expect(res.status).toBe(200);
    expect(res.body.sources.map((s: any) => [s.id, s.name, s.type, s.health.status])).toEqual([
      ['primary', 'primary', 'opensearch', 'ok'],
      ['team-cw', 'Team CloudWatch', 'cloudwatch', 'ok'],
    ]);
  });

  it('POST /api/traces merges a trace from each source into one answer, each span tagged with its source', async () => {
    const res = await request(app).post('/api/traces').send({ runIds: ['os-run-1', CW_RUN], size: 100 });
    expect(res.status).toBe(200);
    expect(res.body.backend).toBe('composite');
    expect(res.body.total).toBe(2 + 12);
    const bySource = new Map<string, number>();
    for (const s of res.body.spans) bySource.set(s.attributes['agent_health.source'], (bySource.get(s.attributes['agent_health.source']) ?? 0) + 1);
    expect(Object.fromEntries(bySource)).toEqual({ primary: 2, 'Team CloudWatch': 12 });
    expect(res.body.warning).toBeUndefined();
  });

  it('when one source is down the other still answers and the failure is named in the warning', async () => {
    osDown = true;
    const res = await request(app).post('/api/traces').send({ traceId: CW_TRACE, size: 100 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    expect(res.body.warning).toMatch(/Some sources could not be read — primary: my cluster: connect ECONNREFUSED/);
  });

  it('metrics come from exactly one source per run — never summed across sources', async () => {
    const res = await request(app).post('/api/metrics/batch').send({ runIds: ['os-run-1', CW_RUN] });
    expect(res.status).toBe(200);
    const [os, cw] = res.body.metrics;
    expect(os).toMatchObject({ runId: 'os-run-1', inputTokens: 500, llmCalls: 1, source: 'primary' });
    expect(cw).toMatchObject({ runId: CW_RUN, inputTokens: 21476, source: 'Team CloudWatch' });
  });

  it('a metrics-store failure in one source does not hide a run the other source holds', async () => {
    cwDown = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post('/api/metrics/batch').send({ runIds: ['os-run-1', CW_RUN] });
    warn.mockRestore();
    const [os, cw] = res.body.metrics;
    expect(os).toMatchObject({ runId: 'os-run-1', inputTokens: 500, status: 'success' });
    expect(cw).toMatchObject({ runId: CW_RUN, status: 'error' });
    expect(cw.error).toMatch(/Team CloudWatch: .*Rate exceeded/);
  });
});
