/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · API · `POST /api/storage/evaluation-runs` (unified runner, SSE) + reads
 *
 * The one runner every surface now converges on. Pinned per source type:
 *   - `benchmark` source (+ `benchmarkId`): 200 SSE `started` → `progress`/
 *     `testCaseComplete` → `completed`; the run doc is `completed` with N
 *     results and `benchmarkId`; the benchmark's `runs[]` projection lists it;
 *   - `test-case-ids` source without `benchmarkId`: an ad-hoc run (no
 *     `benchmarkId` on the doc), same event contract;
 *   - `code-import` source: the SDK file's bodies execute (a failing matcher
 *     is a `failed` result);
 *   - `GET /api/storage/evaluation-runs/:id` returns the terminal doc
 *     (`status`, `results`, `stats`, `testCaseSnapshots`, `trigger`), 404 for
 *     an unknown id;
 *   - `GET /api/storage/evaluation-runs?benchmarkId=&trigger=&status=` filters;
 *   - validation: 400 without `sources`, 400 without `agentKey`; an unknown
 *     `benchmarkId` / unknown test case id ends the stream with an `error`
 *     event (never a hang); `modelId` is NOT required here.
 *   - `judgeModelId` selects the judge (the demo/mock judge in this matrix — the
 *     server's default judge is Bedrock, which needs credentials) and is
 *     persisted on the run doc.
 *   - every report is judged with resolved trace metrics (`metricsStatus: 'ready'`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, DEMO_MODEL, api, backendReady, caseInput, createBenchmark, createTestCase, describeResolvedReports, getBenchmark,
  getEvaluationRun, httpRequest, postSse, registerRestAgent, reportIdsOf, settleStorage, waitForReportsResolved, type SseEvent,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 180_000;
const CASES = 2;

describe('surface-matrix · API · POST /api/storage/evaluation-runs', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let testCaseIds: string[] = [];
  let benchmarkId: string;
  let tmpDir: string;

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    for (let i = 1; i <= CASES; i++) {
      const tc = await createTestCase(caseInput('api-evalrun', i));
      tracker.testCase(tc.id);
      testCaseIds.push(tc.id);
    }
    const bm = await createBenchmark(uniqueTestName('api-evalrun-bench'), testCaseIds);
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-api-evalrun-'));
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  function named(events: SseEvent[], name: string) {
    return events.filter((e) => e.event === name).map((e) => e.data);
  }

  /** Assert the SSE contract and return the terminal run doc (tracked). */
  async function assertStream(res: Awaited<ReturnType<typeof postSse>>, expectedCases: number) {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const [started] = named(res.events, 'started');
    expect(started).toBeDefined();
    expect(started.runId).toMatch(/^eval-run-/);
    expect(started.testCases).toHaveLength(expectedCases);
    tracker.evaluationRun(started.runId);
    expect(named(res.events, 'error')).toEqual([]);
    expect(named(res.events, 'testCaseComplete')).toHaveLength(expectedCases);
    const [completed] = named(res.events, 'completed');
    expect(completed).toBeDefined();
    expect(completed.id).toBe(started.runId);
    expect(completed.status).toBe('completed');

    const run = await getEvaluationRun(started.runId);
    for (const id of reportIdsOf(run)) tracker.run(id);
    expect(run.status).toBe('completed');
    expect(Object.keys(run.results)).toHaveLength(expectedCases);
    expect(run.testCaseSnapshots).toHaveLength(expectedCases);
    expect(typeof run.completedAt).toBe('string');
    expect(run.stats).toMatchObject({ total: expectedCases });
    return run;
  }

  it('benchmark source: completes, links into benchmark.runs[], reports judged with traces', async () => {
    if (!ready) return;
    const res = await postSse('/api/storage/evaluation-runs', {
      name: uniqueTestName('api-bench-run'),
      sources: [{ type: 'benchmark', benchmarkId }],
      agentKey,
      judgeModelId: DEMO_MODEL,
      benchmarkId,
      concurrency: 2,
      trigger: 'api',
    });
    const run = await assertStream(res, CASES);
    expect(run.benchmarkId).toBe(benchmarkId);
    expect(run.trigger).toBe('api');
    expect(run.agentKey).toBe(agentKey);
    expect(named(res.events, 'progress').length).toBeGreaterThan(0);

    const bench = await getBenchmark(benchmarkId);
    const projected = (bench.runs || []).find((r: any) => r.id === run.id);
    expect(projected).toBeDefined();
    expect(projected.status).toBe('completed');
    expect(Object.keys(projected.results)).toHaveLength(CASES);

    const reports = await waitForReportsResolved(reportIdsOf(run));
    expect(describeResolvedReports(reports, agent)).toEqual([]);
  }, TEST_TIMEOUT);

  it('test-case-ids source without benchmarkId: an ad-hoc run', async () => {
    if (!ready) return;
    const res = await postSse('/api/storage/evaluation-runs', {
      name: uniqueTestName('api-adhoc-run'),
      sources: [{ type: 'test-case-ids', ids: [testCaseIds[0]] }],
      agentKey,
      judgeModelId: DEMO_MODEL,
    });
    const run = await assertStream(res, 1);
    expect(run.judgeModelId).toBe(DEMO_MODEL);
    expect(run.benchmarkId).toBeFalsy();
    expect(run.trigger).toBe('manual'); // default when the caller sends none
    expect(Object.keys(run.results)).toEqual([testCaseIds[0]]);
    expect(describeResolvedReports(await waitForReportsResolved(reportIdsOf(run)), agent)).toEqual([]);
  }, TEST_TIMEOUT);

  it('code-import source: SDK bodies execute; a failing matcher is a failed result', async () => {
    if (!ready) return;
    const stamp = uniqueTestName('api-sdk');
    const file = path.join(tmpDir, `${stamp}.eval.js`);
    fs.writeFileSync(file, `
const { test, expect } = require('@opensearch-project/agent-health');
test('${stamp}-passes', { prompt: 'search products ${stamp}', labels: ['category:Smoke', 'difficulty:Easy'] }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include('answer for:');
});
test('${stamp}-fails', { labels: ['category:Smoke', 'difficulty:Easy'] }, () => { expect(1).to.equal(2); });
`);
    const res = await postSse('/api/storage/evaluation-runs', {
      name: uniqueTestName('api-code-run'),
      sources: [{ type: 'code-import', filenames: [file], testCaseIds: [] }],
      agentKey,
      judgeModelId: DEMO_MODEL,
    });
    const run = await assertStream(res, 2);
    for (const s of run.testCaseSnapshots) tracker.testCase(s.id);
    const byName = Object.fromEntries(run.testCaseSnapshots.map((s: any) => [s.name, run.results[s.id].status]));
    expect(byName[`${stamp}-passes`]).toBe('completed');
    expect(byName[`${stamp}-fails`]).toBe('failed');
  }, TEST_TIMEOUT);

  it('GET by id (200 terminal doc / 404 unknown) and list filters by benchmarkId, trigger, status', async () => {
    if (!ready) return;
    await settleStorage(); // list views lag one refresh on OpenSearch
    const listed = await api<{ evaluationRuns: any[]; total: number }>('GET', `/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&trigger=api&status=completed&size=10`);
    expect(listed.evaluationRuns.length).toBeGreaterThanOrEqual(1);
    for (const r of listed.evaluationRuns) expect(r).toMatchObject({ benchmarkId, trigger: 'api', status: 'completed' });
    const one = await httpRequest('GET', `/api/storage/evaluation-runs/${encodeURIComponent(listed.evaluationRuns[0].id)}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: listed.evaluationRuns[0].id, status: 'completed' });
    expect((await httpRequest('GET', `/api/storage/evaluation-runs/${uniqueTestName('nope')}`)).status).toBe(404);
    const other = await api<{ evaluationRuns: any[] }>('GET', `/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}&trigger=cli&size=10`);
    expect(other.evaluationRuns).toEqual([]);
  }, TEST_TIMEOUT);

  it('validation: 400 without sources / agentKey; unknown benchmark or case → SSE error event, stream closes', async () => {
    if (!ready) return;
    expect((await httpRequest('POST', '/api/storage/evaluation-runs', { agentKey })).status).toBe(400);
    expect((await httpRequest('POST', '/api/storage/evaluation-runs', { sources: [{ type: 'benchmark', benchmarkId }] })).status).toBe(400);

    const badBench = await postSse('/api/storage/evaluation-runs', { sources: [{ type: 'benchmark', benchmarkId: uniqueTestName('nope') }], agentKey });
    expect(badBench.status).toBe(200);
    expect(named(badBench.events, 'error')[0]?.error).toMatch(/Benchmark not found/);
    expect(named(badBench.events, 'started')).toEqual([]);

    const badCase = await postSse('/api/storage/evaluation-runs', { sources: [{ type: 'test-case-ids', ids: [uniqueTestName('nope')] }], agentKey });
    expect(named(badCase.events, 'error')[0]?.error).toMatch(/Test case not found/);
  }, TEST_TIMEOUT);
});
