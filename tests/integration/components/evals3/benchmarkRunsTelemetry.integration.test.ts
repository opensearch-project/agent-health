/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the benchmark pages' telemetry data path end to end against
 * the REAL server (whatever `AH_PORT` points at — file or OpenSearch storage).
 *
 * Owner ask (2026-09-09): "telemetry should be emitted for all the pages,
 * especially the benchmarks page." The Runs table / run inspector get their
 * Tokens · Cost · LLM calls · Time/case from `useRunTelemetry`, which:
 *   1. reads the run's reports through the lightweight summaries batch
 *      (`GET /api/storage/runs?ids=…&fields=…`) — the summary MUST now carry
 *      runId / sessionId / traceId / connectorProtocol / performanceMetrics,
 *      or the batch call has nothing to correlate with;
 *   2. issues ONE `POST /api/metrics/batch` keyed by the reports' runIds with
 *      `sessionIds` + `traceIds` + Strategy-C `agents` hints — the route must
 *      accept that body and answer one entry per key, in order.
 *
 * There is no trace cluster in the test environment, so the metrics come
 * back as the route's per-key "not configured" error shape; that IS the
 * shape the hook has to tolerate (→ "—" cells), so it is asserted here. The
 * validation cases (400s) stay deterministic regardless of backend.
 *
 * Skips gracefully when the backend is down. Everything created is tracked
 * by id and deleted.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';
import { buildJudgeAgentsHints } from '@/services/traces/judgeAgentsHints';
import { aggregateRunTelemetry, buildRunTelemetryCorrelation } from '@/lib/runTelemetry';

const TEST_TIMEOUT = 30_000;
const BASE_URL = getTestBackendUrl();

const json = async (res: Response) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };
const post = (path: string, body: unknown) =>
  fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('Benchmark pages telemetry data path (summaries → POST /api/metrics/batch)', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  const runId = `run-tel-int-${Date.now()}`;
  let reportId: string | null = null;
  let restReportId: string | null = null;

  beforeAll(async () => {
    try { backendAvailable = (await fetch(`${BASE_URL}/health`)).ok; } catch { backendAvailable = false; }
    if (!backendAvailable) {
      console.warn('Backend not available at', BASE_URL, '- skipping telemetry data-path integration tests');
      return;
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const tc = await json(await post('/api/storage/test-cases', {
      name: uniqueTestName('tel-int-tc'), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
    }));
    testCaseId = tc.id || tc.testCase?.id;
    tracker.testCase(testCaseId!);

    // A subprocess-style report: native runId + session.id + eval traceId + wall-clock.
    const rep = await json(await post('/api/storage/runs', {
      testCaseId, testCaseVersion: 1, agentKey: 'demo', agentName: 'demo', modelId: 'demo-model', modelName: 'demo-model',
      status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: { accuracy: 90 },
      connectorProtocol: 'claude-code',
      runId: `${runId}-agent-0`, traceId: 'b'.repeat(32), sessionId: `${runId}-session-0`,
      performanceMetrics: { durationMs: 44_000, agentDurationMs: 42_000 },
      experimentRunId: runId,
    }));
    reportId = rep.id;
    tracker.run(reportId!);

    // A REST-style report: NO runId/sessionId/traceId — must still be keyed (by report id).
    const rest = await json(await post('/api/storage/runs', {
      testCaseId, testCaseVersion: 1, agentKey: 'demo-rest', agentName: 'demo-rest', modelId: 'demo-model', modelName: 'demo-model',
      status: 'completed', passFailStatus: 'failed', trajectory: [], metrics: { accuracy: 20 },
      connectorProtocol: 'rest',
      performanceMetrics: { durationMs: 12_000, agentDurationMs: 11_000 },
      experimentRunId: runId,
    }));
    restReportId = rest.id;
    tracker.run(restReportId!);

    const bm = await json(await post('/api/storage/benchmarks', {
      name: uniqueTestName('tel-int-benchmark'), description: 'telemetry data path', testCaseIds: [testCaseId], runs: [], currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId] }],
    }));
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId!);

    const evalRunRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: runId, name: uniqueTestName('tel-int-run'), docType: 'evaluation-run', benchmarkId,
        status: 'completed', agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'demo-judge-model',
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        sources: [], trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {
          [testCaseId!]: { reportId, status: 'completed', passFailStatus: 'passed' },
          [`${testCaseId}-rest`]: { reportId: restReportId, status: 'completed', passFailStatus: 'failed' },
        },
      }),
    });
    if (evalRunRes.ok) tracker.evaluationRun(runId);
  }, TEST_TIMEOUT);

  afterAll(async () => { await tracker.cleanup(); });

  it('the lightweight summaries batch now carries every correlation field the telemetry hook needs', async () => {
    if (!backendAvailable) return;
    const fields = ['status', 'passFailStatus', 'metricsStatus', 'traceId', 'runId', 'sessionId', 'judgeModelId', 'modelId', 'agentId', 'testCaseId', 'createdAt', 'annotations', 'metrics', 'connectorProtocol', 'performanceMetrics'];
    const res = await fetch(`${BASE_URL}/api/storage/runs?ids=${reportId},${restReportId}&fields=${fields.join(',')}`);
    expect(res.status).toBe(200);
    const { runs } = await res.json();
    const byId = Object.fromEntries(runs.map((r: any) => [r.id, r]));

    expect(byId[reportId!]).toMatchObject({
      runId: `${runId}-agent-0`, sessionId: `${runId}-session-0`, traceId: 'b'.repeat(32),
      connectorProtocol: 'claude-code', performanceMetrics: { durationMs: 44_000 },
    });
    expect(byId[reportId!].trajectory).toBeUndefined();          // still a projection, not the full doc
    expect(byId[restReportId!]).toMatchObject({ connectorProtocol: 'rest', performanceMetrics: { durationMs: 12_000 } });
    expect(byId[restReportId!].runId).toBeUndefined();
  }, TEST_TIMEOUT);

  it('the evaluation run is listed under the benchmark and yields exactly the request the hook sends', async () => {
    if (!backendAvailable) return;
    const list = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${benchmarkId}&size=100`)).json();
    const run = (list.evaluationRuns || []).find((r: any) => r.id === runId);
    expect(run).toBeDefined();

    const reports = {
      [reportId!]: { id: reportId!, runId: `${runId}-agent-0`, sessionId: `${runId}-session-0`, traceId: 'b'.repeat(32), agentKey: 'demo', connectorProtocol: 'claude-code' as const, timestamp: new Date().toISOString(), performanceMetrics: { durationMs: 44_000, agentDurationMs: 1 } },
      [restReportId!]: { id: restReportId!, agentKey: 'demo-rest', connectorProtocol: 'rest' as const, timestamp: new Date().toISOString(), performanceMetrics: { durationMs: 12_000, agentDurationMs: 1 } },
    };
    const c = buildRunTelemetryCorrelation([run], reports);
    expect(c.keys.sort()).toEqual([`${runId}-agent-0`, restReportId!].sort());
    expect(c.sessionIdByKey).toEqual({ [`${runId}-agent-0`]: `${runId}-session-0` });
    expect(c.traceIdByKey).toEqual({ [`${runId}-agent-0`]: 'b'.repeat(32) });
    expect(c.agentsByKey[`${runId}-agent-0`]).toEqual(buildJudgeAgentsHints(reports[reportId!]));
    expect(c.agentsByKey[restReportId!]).toBeUndefined();   // generic transport, no override → no guessed service name
  }, TEST_TIMEOUT);

  it('POST /api/metrics/batch accepts runIds + sessionIds + traceIds + agents and answers one entry per key, in order', async () => {
    if (!backendAvailable) return;
    const key = `${runId}-agent-0`;
    const res = await post('/api/metrics/batch', {
      runIds: [key, restReportId],
      sessionIds: { [key]: `${runId}-session-0` },
      traceIds: { [key]: 'b'.repeat(32) },
      agents: { [key]: [{ serviceName: 'claude-code-agent', startedAt: Date.now() - 200_000, endedAt: Date.now() + 200_000, sessionId: `${runId}-session-0` }] },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.metrics)).toBe(true);
    expect(data.metrics.map((m: any) => m.runId)).toEqual([key, restReportId]);
    // Each entry is either a real metrics result or the per-key error shape —
    // both are what the hook consumes.
    for (const m of data.metrics) {
      expect(typeof m.runId).toBe('string');
      expect('error' in m || 'totalTokens' in m).toBe(true);
    }

    // The roll-up of exactly this response for the run: with no trace cluster
    // configured every key is an error entry → hasSpans false, but the
    // wall-clock median is still there (it comes from the reports, not traces).
    const run = { id: runId, results: { a: { reportId: reportId! }, b: { reportId: restReportId! } } };
    const reports = {
      [reportId!]: { id: reportId!, runId: key, timestamp: new Date().toISOString(), performanceMetrics: { durationMs: 44_000, agentDurationMs: 1 } },
      [restReportId!]: { id: restReportId!, timestamp: new Date().toISOString(), performanceMetrics: { durationMs: 12_000, agentDurationMs: 1 } },
    };
    const metricsByKey = Object.fromEntries(data.metrics.map((m: any) => [m.runId, m]));
    const t = aggregateRunTelemetry(run, reports, metricsByKey)!;
    expect(t.totalCases).toBe(2);
    expect(t.medianDurationMs).toBe(28_000);
    if (data.metrics.every((m: any) => 'error' in m)) {
      expect(t.hasSpans).toBe(false);
      expect(t.spansCases).toBe(0);
    }
  }, TEST_TIMEOUT);

  const bad: Array<[string, unknown, RegExp]> = [
    ['runIds missing', {}, /runIds must be an array/],
    ['runIds not an array', { runIds: 'x' }, /runIds must be an array/],
    ['sessionIds is an array', { runIds: ['a'], sessionIds: ['a'] }, /sessionIds/],
    ['sessionIds is a string', { runIds: ['a'], sessionIds: 'x' }, /sessionIds/],
    ['traceIds is an array', { runIds: ['a'], traceIds: ['a'] }, /traceIds/],
  ];
  it.each(bad)('still 400s when %s', async (_label, body, re) => {
    if (!backendAvailable) return;
    const res = await post('/api/metrics/batch', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(re);
  }, TEST_TIMEOUT);

  it('an empty page (no reports) sends no keys → the route answers an empty list, never an error', async () => {
    if (!backendAvailable) return;
    const res = await post('/api/metrics/batch', { runIds: [], sessionIds: {}, traceIds: {}, agents: {} });
    expect(res.status).toBe(200);
    expect((await res.json()).metrics).toEqual([]);
  }, TEST_TIMEOUT);
});
