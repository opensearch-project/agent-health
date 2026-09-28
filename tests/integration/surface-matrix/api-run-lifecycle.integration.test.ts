/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · API · evaluation-run lifecycle: cancel · retry-judgement · delete
 *
 * The three actions the run inspector's kebab menu exposes, pinned at the HTTP
 * level against real runs of the fixture REST agent:
 *   - CANCEL a running run: `POST /:id/cancel` → 200 `{ success: true,
 *     draining: true }`; the run reaches a terminal `cancelled` state, the
 *     cases that never started are marked `cancelled`, and the SSE stream the
 *     creator was reading ends with `completed` carrying `status: 'cancelled'`.
 *     Cancelling a run that already finished → 400 "not currently running";
 *     unknown id → 404;
 *   - RETRY JUDGEMENT on a completed run: `POST /:id/retry-judgement?scope=all`
 *     → 202 `{ jobId, status: 'running', total }`; `GET
 *     /:id/retry-judgement/status` polls to `completed` with a summary
 *     (`retried` = N, `succeeded` = N, `failed` = 0); the reports keep a
 *     verdict. On a still-running run → 409; unknown id → 404; status for a
 *     run that never had a job → 404;
 *   - DELETE `/:id` → 200 `{ success: true, projectionDeleted }`; afterwards the
 *     run is 404, the benchmark's `runs[]` no longer lists it, and — as
 *     documented in AGENTS.md ("Deleting a benchmark or evaluation run does
 *     NOT delete its reports") — the per-case reports are STILL readable.
 *     Deleting again → 404.
 */

import * as http from 'http';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, DEMO_MODEL, api, backendReady, caseInput, createBenchmark, createTestCase, getBenchmark,
  getEvaluationRun, getReport, httpRequest, parseSse, postSse, registerRestAgent, reportIdsOf, sleep,
  waitForReportsResolved, waitForTerminalRun,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 180_000;

/**
 * Start a run and resolve as soon as its `started` event arrives, while the
 * stream keeps being consumed in the background (so the test can cancel it).
 */
function startRunStreaming(body: unknown): Promise<{ runId: string; done: Promise<any[]> }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/storage/evaluation-runs', BASE_URL);
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'text/event-stream' } },
      (res) => {
        let text = '';
        let resolvedStart = false;
        const done = new Promise<any[]>((resolveDone) => {
          res.on('data', (c) => {
            text += c.toString();
            if (!resolvedStart) {
              const started = parseSse(text).find((e) => e.event === 'started');
              if (started) { resolvedStart = true; resolve({ runId: started.data.runId, done }); }
            }
          });
          res.on('end', () => resolveDone(parseSse(text)));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('surface-matrix · API · run lifecycle (cancel / retry-judgement / delete)', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let fastAgent: TraceparentRestAgent;
  let slowAgent: TraceparentRestAgent;
  let fastKey: string;
  let slowKey: string;
  let testCaseIds: string[] = [];
  let benchmarkId: string;

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    fastAgent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    // 3s per answer: long enough to cancel mid-run, short enough for CI.
    slowAgent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces`, delayMs: 3_000 });
    fastKey = await registerRestAgent(fastAgent, { useTraces: true, label: 'lifecycle-fast' });
    slowKey = await registerRestAgent(slowAgent, { useTraces: true, label: 'lifecycle-slow' });
    tracker.customAgent(fastKey);
    tracker.customAgent(slowKey);
    for (let i = 1; i <= 3; i++) {
      const tc = await createTestCase(caseInput('api-lifecycle', i));
      tracker.testCase(tc.id);
      testCaseIds.push(tc.id);
    }
    const bm = await createBenchmark(uniqueTestName('api-lifecycle-bench'), testCaseIds);
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (fastAgent) await fastAgent.close();
    if (slowAgent) await slowAgent.close();
    await tracker.cleanup();
  }, 60_000);

  async function completedRun(): Promise<any> {
    const res = await postSse('/api/storage/evaluation-runs', {
      name: uniqueTestName('lifecycle-run'),
      sources: [{ type: 'benchmark', benchmarkId }],
      agentKey: fastKey,
      judgeModelId: DEMO_MODEL,
      benchmarkId,
    });
    const started = res.events.find((e) => e.event === 'started')!.data;
    tracker.evaluationRun(started.runId);
    const run = await waitForTerminalRun(started.runId);
    for (const id of reportIdsOf(run)) tracker.run(id);
    await waitForReportsResolved(reportIdsOf(run));
    return run;
  }

  it('cancel: a running run drains to `cancelled`; never-started cases are marked cancelled; the creator stream ends', async () => {
    if (!ready) return;
    const { runId, done } = await startRunStreaming({
      name: uniqueTestName('lifecycle-cancel'),
      sources: [{ type: 'benchmark', benchmarkId }],
      agentKey: slowKey,
      judgeModelId: DEMO_MODEL,
      concurrency: 1,
    });
    tracker.evaluationRun(runId);
    // Let the first case get in flight, then cancel.
    await sleep(500);
    const cancel = await httpRequest('POST', `/api/storage/evaluation-runs/${encodeURIComponent(runId)}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ success: true, draining: true });

    const events = await done;
    const terminal = events.find((e) => e.event === 'completed')?.data;
    expect(terminal?.status).toBe('cancelled');

    const run = await waitForTerminalRun(runId);
    for (const id of reportIdsOf(run)) tracker.run(id);
    expect(run.status).toBe('cancelled');
    const statuses = Object.values(run.results as Record<string, any>).map((r) => r.status);
    expect(statuses).toContain('cancelled');
    // Fewer agent calls than cases — the cancel actually stopped work.
    expect(slowAgent.invocations.length).toBeLessThan(testCaseIds.length);

    // Already finished → 400; unknown → 404.
    const again = await httpRequest('POST', `/api/storage/evaluation-runs/${encodeURIComponent(runId)}/cancel`);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/not currently running/);
    expect((await httpRequest('POST', `/api/storage/evaluation-runs/${uniqueTestName('nope')}/cancel`)).status).toBe(404);
  }, TEST_TIMEOUT);

  it('retry-judgement: 202 + status poll → completed summary; 404 unknown run, 404 status before any job', async () => {
    if (!ready) return;
    const run = await completedRun();
    const n = Object.keys(run.results).length;

    expect((await httpRequest('GET', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}/retry-judgement/status`)).status).toBe(404);

    const accepted = await httpRequest('POST', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}/retry-judgement?scope=all`);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ jobId: run.id, status: 'running', total: n });

    let status: any;
    const deadline = Date.now() + 60_000;
    do {
      await sleep(300);
      status = (await httpRequest('GET', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}/retry-judgement/status`)).body;
    } while (status?.status === 'running' && Date.now() < deadline);
    expect(status.status).toBe('completed');
    expect(status.summary).toMatchObject({ retried: n, succeeded: n, failed: 0 });

    for (const report of await waitForReportsResolved(reportIdsOf(run))) {
      expect(['passed', 'failed']).toContain(report.passFailStatus);
    }
    expect((await httpRequest('POST', `/api/storage/evaluation-runs/${uniqueTestName('nope')}/retry-judgement`)).status).toBe(404);
  }, TEST_TIMEOUT);

  it('retry-judgement is refused (409) while the run is still executing', async () => {
    if (!ready) return;
    const { runId, done } = await startRunStreaming({
      name: uniqueTestName('lifecycle-retry-running'),
      sources: [{ type: 'test-case-ids', ids: [testCaseIds[0]] }],
      agentKey: slowKey,
      judgeModelId: DEMO_MODEL,
    });
    tracker.evaluationRun(runId);
    const refused = await httpRequest('POST', `/api/storage/evaluation-runs/${encodeURIComponent(runId)}/retry-judgement`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/still executing/);
    await done;
    for (const id of reportIdsOf(await waitForTerminalRun(runId))) tracker.run(id);
  }, TEST_TIMEOUT);

  it('delete: run gone (404), benchmark.runs[] projection gone, reports deliberately kept', async () => {
    if (!ready) return;
    const run = await completedRun();
    const reportIds = reportIdsOf(run);
    expect((await getBenchmark(benchmarkId)).runs.map((r: any) => r.id)).toContain(run.id);

    const del = await httpRequest('DELETE', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ success: true, projectionDeleted: true, benchmarkId });

    expect((await httpRequest('GET', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`)).status).toBe(404);
    expect((await getBenchmark(benchmarkId)).runs.map((r: any) => r.id)).not.toContain(run.id);
    // No cascade to the per-case reports (documented contract).
    for (const id of reportIds) expect((await getReport(id)).id).toBe(id);
    expect((await httpRequest('DELETE', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`)).status).toBe(404);
  }, TEST_TIMEOUT);

  it('a completed run and its reports are readable through the reads the inspector uses', async () => {
    if (!ready) return;
    const run = await getEvaluationRun((await completedRun()).id);
    expect(run.status).toBe('completed');
    const batch = await api<{ runs: any[] }>('GET', `/api/storage/runs?ids=${reportIdsOf(run).join(',')}&fields=id,status,passFailStatus,metricsStatus`);
    expect(batch.runs).toHaveLength(reportIdsOf(run).length);
    for (const r of batch.runs) expect(r).toMatchObject({ status: 'completed', metricsStatus: 'ready' });
  }, TEST_TIMEOUT);
});
