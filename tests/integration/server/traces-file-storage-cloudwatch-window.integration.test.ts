/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #640 — Traces tab empty with FILE storage + the CloudWatch backend.
 *
 * Two defects compounded into "No traces available" for a run whose spans
 * were present (and whose header metrics resolved fine):
 *
 *  1. client: `toTestCaseRun` mapped `timestamp: stored.createdAt`, which the
 *     FILE adapter never writes (it writes `timestamp`) → the run inspector
 *     built the Strategy-C `agents[]` window around Date.now().
 *  2. server: `CloudWatchTracesOperations.fetchSources` narrowed the EXACT
 *     correlators (traceId / runIds / session id) to that window.
 *
 * This boots the REAL file storage adapter (isolated data dir) behind the real
 * storage routes on an ephemeral port, drives the REAL browser storage client
 * (`asyncRunStorage`) against it, and the real traces/metrics routes with
 * `OBSERVABILITY_TYPE=cloudwatch`. Only the AWS network hop is faked — the real
 * `@aws-sdk/client-cloudwatch-logs` command objects are intercepted at `send()`
 * — and, unlike the sibling cloudwatch-observability suite, the fake HONOURS
 * the time bounds on BOTH read paths the way CloudWatch does, because the bug
 * is precisely that the module asked for the wrong bounds. The fixture spans
 * are re-stamped to a run that happened two hours before the test runs.
 */

import express, { Express } from 'express';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  FilterLogEventsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import spanFixture from '../../fixtures/cloudwatch/aws-spans-trace.json';
import type { EvaluationReport } from '@/types';

// --- the run: two hours ago, re-stamped onto the synthetic fixture ------------

const RUN = 'cw-run-2'; // agent_health.run.id on every fixture span
const SERVICE = 'demo-retrieval-agent';
const FIXTURE_START_MS = Math.min(...(spanFixture as any[]).map((r) => Math.floor(Number(r.startTimeUnixNano) / 1e6)));
const FIXTURE_END_MS = Math.max(...(spanFixture as any[]).map((r) => Math.floor(Number(r.endTimeUnixNano) / 1e6)));
const RUN_DURATION_MS = FIXTURE_END_MS - FIXTURE_START_MS;
const RUN_STARTED_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_NS = BigInt(RUN_STARTED_MS - FIXTURE_START_MS) * 1_000_000n;
const spanRecords: string[] = (spanFixture as any[]).map((r) =>
  JSON.stringify({
    ...r,
    startTimeUnixNano: (BigInt(r.startTimeUnixNano) + SHIFT_NS).toString(),
    endTimeUnixNano: (BigInt(r.endTimeUnixNano) + SHIFT_NS).toString(),
  })
);

// --- fake CloudWatch Logs transport (honours time bounds on both paths) -------

const sent: any[] = [];
function recordMs(message: string): number | undefined {
  try {
    const n = JSON.parse(message)?.startTimeUnixNano;
    return n === undefined ? undefined : Math.floor(Number(n) / 1e6);
  } catch {
    return undefined;
  }
}
const inBounds = (startMs: number, endMs: number) => (s: string) => {
  const t = recordMs(s);
  return t === undefined || (t >= startMs && t <= endMs);
};
/** Insights StartQuery bounds are seconds; remembered per queryId for GetQueryResults. */
const queryBounds = new Map<string, { startMs: number; endMs: number }>();

function fakeSend(command: any): any {
  sent.push(command);
  const input = command.input;
  if (command instanceof DescribeLogGroupsCommand) {
    return { logGroups: ['aws/spans'].filter((g) => g.startsWith(input.logGroupNamePrefix || '')).map((n) => ({ logGroupName: n })) };
  }
  if (command instanceof FilterLogEventsCommand) {
    if (input.logGroupName !== 'aws/spans') throw Object.assign(new Error('The specified log group does not exist.'), { name: 'ResourceNotFoundException' });
    const terms = input.filterPattern ? [...(input.filterPattern as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)) : [];
    const events = spanRecords
      .filter((s) => (terms.length ? terms.some((t: string) => s.includes(t)) : true))
      .filter(inBounds(input.startTime, input.endTime))
      .map((s) => ({ message: s, timestamp: recordMs(s), logStreamName: 'default' }));
    return { events };
  }
  if (command instanceof StartQueryCommand) {
    const id = `q-${queryBounds.size + 1}`;
    queryBounds.set(id, { startMs: input.startTime * 1000, endMs: input.endTime * 1000 });
    return { queryId: id };
  }
  if (command instanceof GetQueryResultsCommand) {
    const b = queryBounds.get(input.queryId)!;
    const results = spanRecords.filter(inBounds(b.startMs, b.endMs)).map((m) => [{ field: '@message', value: m }]);
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
import metricsRoutes from '@/server/routes/metrics';
import runRoutes from '@/server/routes/storage/runs';
import { setStorageModule } from '@/server/adapters';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { __resetObservabilityCachesForTests } from '@/server/services/observabilityClient';

/** The window the run inspector derives from a report (components/RunDetailsContent.tsx, fetchTracesForReport). */
function inspectorWindow(report: Pick<EvaluationReport, 'timestamp' | 'performanceMetrics' | 'sessionId'>) {
  const SLACK_MS = 60_000;
  const FALLBACK_LOOKBACK_MS = 30 * 60_000;
  const endedAt = Date.parse(report.timestamp || '') || Date.now();
  const durationMs = report.performanceMetrics?.durationMs ?? 0;
  const lookbackMs = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  return { serviceName: SERVICE, startedAt: endedAt - lookbackMs, endedAt: endedAt + SLACK_MS, ...(report.sessionId ? { sessionId: report.sessionId } : {}) };
}

const insightsQueries = () => sent.filter((c) => c instanceof StartQueryCommand).map((c) => c.input as { startTime: number; endTime: number; queryString: string });

describe('#640 — file storage + CloudWatch: the run inspector finds a run\'s spans by exact id', () => {
  let app: Express;
  let server: Server;
  let dataDir: string;
  // The REAL browser storage client, loaded after AH_PORT points at this suite's server.
  let asyncRunStorage: typeof import('@/services/storage/asyncRunStorage').asyncRunStorage;
  const ENV = ['OBSERVABILITY_TYPE', 'CLOUDWATCH_REGION', 'CLOUDWATCH_AWS_PROFILE', 'OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AH_PORT'];
  const saved: Record<string, string | undefined> = {};
  /** Id the storage client assigned on save (saveReport mints its own report id). */
  let reportId: string;

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    process.env.OBSERVABILITY_TYPE = 'cloudwatch';
    process.env.CLOUDWATCH_REGION = 'us-east-1';
    process.env.CLOUDWATCH_AWS_PROFILE = 'test-profile';
    __resetObservabilityCachesForTests();

    dataDir = mkdtempSync(path.join(tmpdir(), 'ah-640-file-storage-'));
    setStorageModule(new FileStorageModule(dataDir), { backend: 'file', configKey: null, error: null, configuredEndpoint: null });

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(runRoutes);
    app.use(tracesRoutes);
    app.use(metricsRoutes);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    process.env.AH_PORT = String((server.address() as AddressInfo).port);
    // lib/config computes the storage API URL from AH_PORT at import time.
    jest.isolateModules(() => {
      asyncRunStorage = require('@/services/storage/asyncRunStorage').asyncRunStorage;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
    setStorageModule(new FileStorageModule(), { backend: 'file', configKey: null, error: null, configuredEndpoint: null });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetObservabilityCachesForTests();
  });

  beforeEach(() => {
    sent.length = 0;
    queryBounds.clear();
    __resetObservabilityCachesForTests();
  });

  it('a run persisted to FILE storage reads back through the real client with the run\'s timestamp (the file adapter writes `timestamp`, no `createdAt`)', async () => {
    // The runner persists through the storage API without a createdAt (the
    // OpenSearch adapter stamps one, the file adapter stamps only `timestamp`).
    // Report shape of a REST agent run with Strategy D (session.id = run id).
    const created = await request(app).post('/api/storage/runs').send({
      runId: RUN,
      sessionId: RUN,
      timestamp: new Date(RUN_STARTED_MS).toISOString(),
      testCaseId: 'ahtest-640-case',
      testCaseVersion: 1,
      agentName: 'Demo Agent',
      agentId: 'demo-retrieval', // storage shape (server/services/storage/index.ts saveReportWithClient): agentId = the agent key
      modelId: 'demo-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: { accuracy: 100 },
      llmJudgeReasoning: 'fine',
      performanceMetrics: { durationMs: RUN_DURATION_MS, totalSteps: 1, toolCalls: 3, llmCalls: 4 },
    });
    expect(created.status).toBe(201);
    reportId = created.body.id;
    expect(created.body.timestamp).toBe(new Date(RUN_STARTED_MS).toISOString());
    expect(created.body.createdAt).toBeUndefined(); // the shape the client must map (#640)

    // Red on main: toTestCaseRun read createdAt only → timestamp undefined.
    const back = await asyncRunStorage.getReportById(reportId);
    expect(back?.timestamp).toBe(new Date(RUN_STARTED_MS).toISOString());
    expect(back?.runId).toBe(RUN);
    expect(back?.sessionId).toBe(RUN);
    expect(back?.performanceMetrics?.durationMs).toBe(RUN_DURATION_MS);
  });

  it('the Traces-tab request derived from that report returns the run\'s spans (window built around the run, not around now)', async () => {
    const back = (await asyncRunStorage.getReportById(reportId))!;
    const win = inspectorWindow(back);
    expect(win.endedAt).toBeLessThan(Date.now() - 60 * 60 * 1000); // the window is the run's, two hours ago

    const res = await request(app).post('/api/traces').send({ size: 1000, runIds: [RUN], agents: [win] });
    expect(res.status).toBe(200);
    expect(res.body.backend).toBe('cloudwatch');
    expect(res.body.total).toBe(12);
    expect(res.body.warning).toBeUndefined();
    expect(res.body.spans.every((s: any) => s.attributes['agent_health.run.id'] === RUN)).toBe(true);
  });

  it('even a STALE window (built around now, as the un-fixed client did) does not narrow the exact ids: the run is still found by runId / session id', async () => {
    const now = Date.now();
    const stale = { serviceName: SERVICE, startedAt: now - 3 * 60_000, endedAt: now + 60_000, sessionId: RUN };
    // Exactly the request the issue captured from the browser.
    const res = await request(app).post('/api/traces').send({ size: 1000, runIds: [RUN], agents: [stale] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12); // red on main: 0 (scan narrowed to the stale window)
    expect(res.body.warning).toBeUndefined();
    const [insights] = insightsQueries();
    expect(insights.endTime - insights.startTime).toBeGreaterThanOrEqual(7 * 86_400); // the lookback, not the 4-minute window
    expect(insights.queryString).toContain(`\`attributes.agent_health.run.id\` in ["${RUN}"]`);
    // The Strategy-C clause itself stays bounded to the (stale) window inside the query.
    expect(insights.queryString).toContain(`startTimeUnixNano >= ${stale.startedAt}000000`);

    // Header metrics for the same run were never affected (the batch path already scanned the lookback) — parity.
    const metrics = await request(app).get(`/api/metrics/${RUN}`);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toMatchObject({ runId: RUN, llmCalls: 4, toolCalls: 3, status: 'success' });
  });

  it('a window-only request (no exact id) is still narrowed to the window — the lookback is not scanned for a bare service name', async () => {
    const now = Date.now();
    const res = await request(app).post('/api/traces').send({ size: 1000, agents: [{ serviceName: SERVICE, startedAt: now - 3 * 60_000, endedAt: now + 60_000 }] });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(sent.some((c) => c instanceof FilterLogEventsCommand)).toBe(false);
    const [insights] = insightsQueries();
    expect(insights.endTime - insights.startTime).toBeLessThanOrEqual(15 * 60 + 1); // 4 min ± 5 min pad, clamped at now
  });

  afterAll(async () => {
    await request(app).delete(`/api/storage/runs/${encodeURIComponent(reportId)}`).catch(() => {});
  });
});
