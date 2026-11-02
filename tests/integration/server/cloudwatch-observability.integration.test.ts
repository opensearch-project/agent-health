/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CloudWatch observability backend — HTTP integration.
 *
 * Boots the real routers (traces / logs / metrics / observability)
 * with `OBSERVABILITY_TYPE=cloudwatch` and asserts the responses a browser or
 * the trace poller would see. Only the AWS network hop is faked: the real
 * `@aws-sdk/client-cloudwatch-logs` command objects are intercepted at
 * `send()`, so the test fails if the module stops issuing FilterLogEvents /
 * StartQuery / GetQueryResults / DescribeLogGroups with the expected inputs.
 */

import express, { Express } from 'express';
import request from 'supertest';
import {
  FilterLogEventsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import spanFixture from '../../fixtures/cloudwatch/aws-spans-trace.json';
import logFixture from '../../fixtures/cloudwatch/otel-logs.json';

// --- fake CloudWatch Logs transport -----------------------------------------

const sent: any[] = [];
const groups: Record<string, string[]> = {
  'aws/spans': (spanFixture as any[]).map((r) => JSON.stringify(r)),
  '/agent-health/demo-retrieval-agent': (logFixture as any[]).map((r) => JSON.stringify(r)),
};
let authFailure: Error | null = null;
/** When set, FilterLogEvents answers with a leftover nextToken (capped scan). */
let capScan = false;
/** Insights ingestion lag emulated by the fake (0 = fully indexed). */
let insightsLagMs = 0;
/** When set, every FilterLogEvents call is throttled. */
let throttleFilter = false;
function recordMs(message: string): number | undefined {
  try {
    const n = JSON.parse(message)?.startTimeUnixNano;
    return n === undefined ? undefined : Math.floor(Number(n) / 1e6);
  } catch {
    return undefined;
  }
}

function fakeSend(command: any): any {
  sent.push(command);
  if (authFailure) throw authFailure;
  const input = command.input;
  if (command instanceof DescribeLogGroupsCommand) {
    const names = Object.keys(groups).filter((g) => g.startsWith(input.logGroupNamePrefix || ''));
    return { logGroups: names.map((n) => ({ logGroupName: n })) };
  }
  if (command instanceof FilterLogEventsCommand) {
    if (throttleFilter) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const msgs = groups[input.logGroupName];
    if (!msgs) throw Object.assign(new Error('The specified log group does not exist.'), { name: 'ResourceNotFoundException' });
    const m = /\{ \$\.traceId = "([0-9a-f]+)" \}/.exec(input.filterPattern || '');
    const terms = !m && input.filterPattern ? [...(input.filterPattern as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)) : [];
    const events = msgs
      .filter((s) => (m ? JSON.parse(s).traceId === m[1] : terms.length ? terms.some((t: string) => s.includes(t)) : true))
      .filter((s) => { const t = recordMs(s); return t === undefined || (t >= input.startTime && t <= input.endTime); }) // CloudWatch honours the bounds
      .map((s) => ({ message: s, timestamp: recordMs(s) ?? 1788467284282, logStreamName: 'default' }));
    // A capped scan: CloudWatch keeps handing back a nextToken (the reader stops at its page budget).
    return capScan ? { events: input.nextToken ? [] : events, nextToken: 'more' } : { events };
  }
  if (command instanceof StartQueryCommand) {
    return { queryId: `q-${input.logGroupNames.join(',')}` };
  }
  if (command instanceof GetQueryResultsCommand) {
    const g = (input.queryId as string).replace(/^q-/, '');
    // Insights lags ingestion: records newer than the lag are not indexed yet.
    const cutoff = Date.now() - insightsLagMs;
    const results = (groups[g] || []).filter((m) => (recordMs(m) ?? 0) <= cutoff).map((m) => [{ field: '@message', value: m }]);
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

// Routes under test (real).
import tracesRoutes from '@/server/routes/traces';
import logsRoutes from '@/server/routes/logs';
import metricsRoutes from '@/server/routes/metrics';
import observabilityRoutes from '@/server/routes/observability';
import { __resetObservabilityCachesForTests } from '@/server/services/observabilityClient';

const TRACE = 'a54f35c518ca4fe4b86b07f10aeea457';
const RUN = 'cw-run-2';
const SERVICE = 'demo-retrieval-agent';

describe('CloudWatch observability backend (HTTP integration)', () => {
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
    app.use(logsRoutes);
    app.use(metricsRoutes);
    app.use(observabilityRoutes);
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
    authFailure = null;
    capScan = false;
    insightsLagMs = 0;
    throttleFilter = false;
    groups['aws/spans'] = (spanFixture as any[]).map((r) => JSON.stringify(r));
    __resetObservabilityCachesForTests();
  });

  it('POST /api/traces by traceId returns the normalized tree (fresh FilterLogEvents slice ∥ indexed Insights)', async () => {
    const res = await request(app).post('/api/traces').send({ traceId: TRACE, size: 100 });
    expect(res.status).toBe(200);
    expect(res.body.backend).toBe('cloudwatch');
    expect(res.body.total).toBe(12);
    expect(res.body.warning).toBeUndefined();
    const root = res.body.spans.find((s: any) => s.spanId === 'aaad0bc29275b362');
    expect(root).toMatchObject({ traceId: TRACE, parentSpanId: 'b7ad6b7169203331', name: 'POST /invoke', status: 'OK', duration: 11442 });
    expect(root.attributes['service.name']).toBe(SERVICE);
    expect(root.attributes['agent_health.run.id']).toBe(RUN);
    const filters = sent.filter((c) => c instanceof FilterLogEventsCommand);
    expect(filters[0].input).toMatchObject({ logGroupName: 'aws/spans', filterPattern: `"${TRACE}"` });
    // the fresh slice (newest 20 min, read in 5-min partitions newest first), not the 7-day lookback
    expect(filters).toHaveLength(4);
    expect(filters.map((c) => c.input.endTime)).toEqual([...filters.map((c) => c.input.endTime)].sort((a, b) => b - a));
    expect(Math.max(...filters.map((c) => c.input.endTime)) - Math.min(...filters.map((c) => c.input.startTime))).toBe(20 * 60 * 1000);
    const start = sent.find((c) => c instanceof StartQueryCommand);
    expect(start.input.queryString).toContain(`traceId = "${TRACE}"`);
    expect(start.input.endTime - start.input.startTime).toBeGreaterThanOrEqual(7 * 86_400); // seconds (floor/ceil); the lookback
    expect(start.input.endTime - start.input.startTime).toBeLessThanOrEqual(7 * 86_400 + 1);
  });

  it('POST /api/traces returns a span ingested seconds ago even though Insights has not indexed it yet', async () => {
    insightsLagMs = 5 * 60 * 1000;
    const nowNanos = `${Date.now() - 2000}000000`;
    const fresh = { ...(spanFixture as any[])[0], traceId: 'c'.repeat(32), spanId: 'c0ffee0000000001', parentSpanId: undefined, startTimeUnixNano: nowNanos, endTimeUnixNano: nowNanos };
    groups['aws/spans'] = [...groups['aws/spans'], JSON.stringify(fresh)];
    const res = await request(app).post('/api/traces').send({ traceId: 'c'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.spans[0].spanId).toBe('c0ffee0000000001');
    expect(res.body.warning).toBeUndefined();
  });

  it('POST /api/traces in the run-report shape (traceId + runIds + agents) issues one term scan and one Insights query', async () => {
    const res = await request(app).post('/api/traces').send({
      traceId: 'f'.repeat(32),
      runIds: [RUN],
      agents: [{ serviceName: SERVICE, startedAt: 1788467284000, endedAt: 1788467300000 }],
      size: 1000,
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    const filter = sent.find((c) => c instanceof FilterLogEventsCommand);
    expect(filter.input.filterPattern).toBe(`?"${'f'.repeat(32)}" ?"${RUN}"`);
    expect(sent.filter((c) => c instanceof StartQueryCommand)).toHaveLength(1);
  });

  it('POST /api/traces with only a service window (Strategy C) goes through Logs Insights', async () => {
    const res = await request(app).post('/api/traces').send({
      agents: [{ serviceName: SERVICE, startedAt: 1788467284000, endedAt: 1788467300000 }],
      size: 1000,
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    const start = sent.find((c) => c instanceof StartQueryCommand);
    expect(start.input.logGroupNames).toEqual(['aws/spans']);
    expect(start.input.queryString).toContain(`\`resource.attributes.service.name\` = "${SERVICE}"`);
    expect(sent.some((c) => c instanceof GetQueryResultsCommand)).toBe(true);
  });

  it('POST /api/traces still validates the request before touching AWS', async () => {
    const res = await request(app).post('/api/traces').send({});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('POST /api/logs correlates by traceId in the per-service log group', async () => {
    const res = await request(app).post('/api/logs').send({ traceId: TRACE, serviceName: SERVICE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, backend: 'cloudwatch' });
    expect(res.body.logs.map((l: any) => l.spanId).sort()).toEqual(['aaad0bc29275b362', 'aaad0bc29275b362', 'b93daa8692261d13']);
    const filter = sent.find((c) => c instanceof FilterLogEventsCommand && c.input.logGroupName !== 'aws/spans');
    expect(filter.input).toMatchObject({ logGroupName: `/agent-health/${SERVICE}`, filterPattern: `"${TRACE}"` });
  });

  it('POST /api/logs without a service discovers groups under the template prefix', async () => {
    const res = await request(app).post('/api/logs').send({ traceId: TRACE });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const describe = sent.find((c) => c instanceof DescribeLogGroupsCommand);
    expect(describe.input.logGroupNamePrefix).toBe('/agent-health/');
  });

  it('GET /api/metrics/:runId computes tokens/cost from aws/spans with the shared (main) token math', async () => {
    const res = await request(app).get(`/api/metrics/${RUN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runId: RUN, traceId: TRACE, inputTokens: 42952, outputTokens: 1686, totalTokens: 44638, llmCalls: 4, toolCalls: 3, status: 'success' });
    expect(res.body.costUsd).toBeGreaterThan(0);
  });

  it('POST /api/metrics/batch aggregates across runs and reports unknown runs as empty', async () => {
    const res = await request(app).post('/api/metrics/batch').send({ runIds: [RUN, 'nope'] });
    expect(res.status).toBe(200);
    expect(res.body.metrics[0]).toMatchObject({ runId: RUN, totalTokens: 44638 });
    expect(res.body.metrics[1]).toMatchObject({ runId: 'nope', totalTokens: 0 });
    expect(res.body.aggregate.totalRuns).toBe(2);
  });

  it('GET /api/traces/health reports the CloudWatch backend', async () => {
    const res = await request(app).get('/api/traces/health');
    expect(res.status).toBe(200);
    // validateAwsCredentials probes Bedrock with real credentials — on a CI box
    // without AWS access the route answers an auth error before reaching our
    // backend; both shapes are acceptable here as long as nothing crashes.
    if (res.body.status === 'ok') {
      expect(res.body).toMatchObject({ status: 'ok', index: 'aws/spans', backend: 'cloudwatch' });
    } else {
      expect(res.body.errorCategory).toBe('auth');
    }
  });

  it('POST /api/observability/test-connection validates a CloudWatch config without an endpoint', async () => {
    const res = await request(app).post('/api/observability/test-connection').send({ type: 'cloudwatch', awsRegion: 'us-east-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', clusterName: 'CloudWatch Logs (us-east-1)', clusterStatus: 'aws/spans' });
    expect(res.body.message).toBeUndefined(); // a per-service log group exists

    const missingRegion = await request(app).post('/api/observability/test-connection').send({ type: 'cloudwatch' });
    expect(missingRegion.status).toBe(400);

    delete groups['/agent-health/demo-retrieval-agent'];
    try {
      const noLogs = await request(app).post('/api/observability/test-connection').send({ type: 'cloudwatch', awsRegion: 'us-east-1' });
      expect(noLogs.body.status).toBe('ok');
      expect(noLogs.body.message).toMatch(/No log groups matching/);
    } finally {
      groups['/agent-health/demo-retrieval-agent'] = (logFixture as any[]).map((r) => JSON.stringify(r));
    }
  });

  it('a fresh scan that exhausts its page budget is surfaced as a partial-results warning on /api/traces and partial metrics — the data still comes from Insights', async () => {
    capScan = true;
    const traces = await request(app).post('/api/traces').send({ traceId: TRACE });
    expect(traces.status).toBe(200);
    expect(traces.body.total).toBe(12);
    expect(traces.body.warning).toMatch(/partial/i);
    const metrics = await request(app).get(`/api/metrics/${RUN}`);
    expect(metrics.body).toMatchObject({ runId: RUN, inputTokens: 42952, partial: true });
  });

  it('a throttled FilterLogEvents does not fail the request: Insights answers, flagged partial', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    throttleFilter = true;
    const traces = await request(app).post('/api/traces').send({ traceId: TRACE });
    expect(traces.status).toBe(200);
    expect(traces.body.total).toBe(12);
    expect(traces.body.warning).toMatch(/partial/i);
    warn.mockRestore();
  });

  it('a 60-day /api/traces range is answered from the newest 30 days WITH a partial warning (documented bound)', async () => {
    // Anchor the 60-day range on the FIXTURE's time, not the wall clock: the
    // fixture spans are dated 2026-09-03, so a range ending at Date.now()
    // stopped containing them exactly 60 days later and the test went red on
    // 2026-11-02 with no code change. One day after the newest fixture span
    // keeps the range realistic (end of range = "now" for the request).
    const fixtureEndMs = Math.max(...(spanFixture as any[]).map((s) => Math.floor(Number(s.endTimeUnixNano) / 1_000_000)));
    const now = fixtureEndMs + 86_400_000;
    const res = await request(app).post('/api/traces').send({ traceId: TRACE, startTime: now - 60 * 86_400_000, endTime: now });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    expect(res.body.warning).toMatch(/partial.*time-window/i);
    const scan = sent.find((c) => c instanceof StartQueryCommand).input;
    expect(scan.endTime - scan.startTime).toBeLessThanOrEqual(30 * 86_400 + 1); // Insights takes seconds
  });

  it('a trace-store failure on /api/metrics is status error (unknown), not "no spans" (reviewer probe)', async () => {
    authFailure = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get(`/api/metrics/${RUN}`);
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runId: RUN, status: 'error', totalTokens: 0 });
    expect(res.body.error).toMatch(/Rate exceeded/);
    expect(res.body.hasSpans).toBeUndefined();
  });

  it('surfaces expired credentials as a classified auth error instead of a 500 stack', async () => {
    authFailure = Object.assign(new Error('The security token included in the request is expired'), { name: 'ExpiredTokenException' });
    const tc = await request(app).post('/api/observability/test-connection').send({ type: 'cloudwatch', awsRegion: 'us-east-1' });
    expect(tc.body.status).toBe('error');
    expect(tc.body.message).toMatch(/expired/);
    expect(tc.body.message).toMatch(/Refresh the AWS credentials/);

    const traces = await request(app).post('/api/traces').send({ traceId: TRACE });
    expect(traces.status).toBe(200); // the route degrades to a warning, same as the OpenSearch backend
    expect(traces.body.total).toBe(0);
    expect(traces.body.warning).toMatch(/expired/);
  });
});
