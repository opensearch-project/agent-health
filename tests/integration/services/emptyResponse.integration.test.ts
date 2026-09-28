/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests — empty agent responses are agent failures, never judged.
 * Real server, real storage backend (whatever AH_PORT points at), real REST
 * connector, real judge route (demo judge).
 *
 * Run:
 *   AH_PORT=4970 npm run test:integration -- --testPathPatterns=emptyResponse
 *
 * Owner incident: an HTTP agent answered 200 with an empty payload (its model
 * call had failed silently); the placeholder text rendered for it was sent to
 * the LLM judge, which PASSED it on a lenient rubric ("Any reply at all").
 * Covered end-to-end through the HTTP API:
 *   1. a stub REST agent answering `200 {}` → every report is a final
 *      `agent_empty_response` (structured `agentError`, no verdict, judge
 *      never called), the run completes with every case *errored*, the run doc
 *      carries the empty-response summary, and the breaker trips at 3;
 *   2. the same rubric against a stub that returns a real answer IS judged
 *      (the demo judge produces a verdict) — the guard is not over-eager;
 *   3. `POST /api/judge` refuses an empty trajectory with 422 / EMPTY_RESPONSE;
 *   4. retry-judgement on the empty run re-judges nothing.
 */

import { createServer, type Server } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    return (await r.json()).status === 'ok';
  } catch { return false; }
};

async function createTestCase(name: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, category: 'Test', difficulty: 'Easy', initialPrompt: `search products for ${name}`,
      context: [], expectedTrajectory: [], expectedOutcomes: ['Any reply at all.'], labels: ['@integration-test'],
    }),
  });
  if (!r.ok) throw new Error(`create test case: ${r.status} ${await r.text()}`);
  const tc = await r.json();
  tracker.testCase(tc.id);
  return tc.id;
}

/** Register a plain (non-trace) REST custom agent so the eager judge path is exercised. */
async function createRestAgent(name: string, endpoint: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/agents/custom`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, endpoint, connectorType: 'rest', useTraces: false }),
  });
  if (!r.ok) throw new Error(`create custom agent: ${r.status} ${await r.text()}`);
  const { agent } = await r.json();
  tracker.customAgent(agent.key);
  return agent.key as string;
}

/** A local stub REST agent answering every POST with `body`; counts requests. */
async function stubAgent(body: unknown): Promise<{ port: number; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as any).port as number,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    hits: () => hits,
  };
}

/** POST the run and drain the SSE stream to completion; returns the run id + wall time. */
async function runToCompletion(body: Record<string, unknown>): Promise<{ runId: string; wallMs: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`start run: ${res.status} ${await res.text()}`);
  const sse = await res.text();
  const m = sse.match(/event: started\ndata: (.*)\n/);
  if (!m) throw new Error(`no started event in: ${sse.slice(0, 300)}`);
  const runId = JSON.parse(m[1]).runId as string;
  tracker.evaluationRun(runId);
  return { runId, wallMs: Date.now() - started };
}

async function getRun(runId: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
  if (!r.ok) throw new Error(`get run ${runId}: ${r.status}`);
  return r.json();
}

async function getReport(reportId: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/runs/${reportId}`);
  if (!r.ok) throw new Error(`get report ${reportId}: ${r.status}`);
  const body = await r.json();
  return body.run ?? body;
}

function trackReports(run: any) {
  for (const r of Object.values(run.results || {}) as any[]) if (r.reportId) tracker.run(r.reportId);
}

const RUN_BASE = { judgeModelId: 'demo-model', trigger: 'api', concurrency: 1 };

describe('empty agent responses (real server, real REST connector, demo judge)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) console.warn(`Backend not available at ${BASE_URL} — skipping empty-response tests`);
  });

  afterAll(async () => { await tracker.cleanup(); });

  it('a stub answering `200 {}`: every report is agent_empty_response with agentError, no verdict, run errored, breaker trips at 3, retry re-judges nothing', async () => {
    if (!backendAvailable) return;
    const stub = await stubAgent({});
    try {
      const agentKey = await createRestAgent(uniqueTestName('empty-rest'), `http://127.0.0.1:${stub.port}/agent`);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await createTestCase(uniqueTestName(`empty-${i}`)));

      const { runId, wallMs } = await runToCompletion({
        ...RUN_BASE, agentKey, name: uniqueTestName('empty-body-run'), sources: [{ type: 'test-case-ids', ids }],
      });
      expect(wallMs).toBeLessThan(60_000);

      const run = await getRun(runId);
      trackReports(run);
      expect(run.status).toBe('completed');
      expect(Object.keys(run.results)).toHaveLength(5);
      // Bucketed errored: NOT passed, NOT pending.
      expect(run.stats).toMatchObject({ passed: 0, failed: 0, errored: 5, pending: 0, total: 5 });
      // Three empties tripped the breaker; two cases were refused without dialling.
      expect(stub.hits()).toBe(3);
      expect(run.agentFailureSummary).toBe(
        `Agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, 127.0.0.1:${stub.port}); 2 further cases were not attempted`,
      );

      const reports = await Promise.all(ids.map(id => getReport(run.results[id].reportId)));
      for (const r of reports) {
        expect(r.status).toBe('failed');
        expect(r.metricsStatus).toBe('error');
        expect(r.passFailStatus ?? null).toBeNull();
        expect(r.agentError?.stage).toBe('agent');
        // Judge never produced anything.
        expect(r.llmJudgeResponse ?? undefined).toBeUndefined();
        expect(r.performanceMetrics?.judgeDurationMs ?? undefined).toBeUndefined();
        expect(r.traceError).not.toContain('http://');
      }
      const empties = reports.filter(r => r.agentError.kind === 'empty-response');
      expect(empties).toHaveLength(3);
      for (const r of empties) {
        expect(r.agentError).toMatchObject({ code: 'EMPTY_RESPONSE' });
        expect(r.agentError.message).toContain(`EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint 127.0.0.1:${stub.port}`);
        expect(r.traceError).toMatch(/^Agent returned an empty response \(kind=agent_empty_response\): EMPTY_RESPONSE — /);
        expect(r.llmJudgeReasoning).toContain('**Agent returned an empty response.**');
        // What the agent returned is kept on the report (REST connector JSON echo of `{}`).
        expect(r.trajectory).toEqual([expect.objectContaining({ type: 'response', content: '{}' })]);
        expect(r.rawEvents).toEqual([{}]);
      }
      const refused = reports.filter(r => r.agentError.kind === 'unreachable');
      expect(refused).toHaveLength(2);
      expect(refused[0].traceError).toContain(`3 consecutive empty responses (EMPTY_RESPONSE, 127.0.0.1:${stub.port}); this case was not attempted`);

      // Retry judgement cannot flip an empty response: nothing is selected.
      const retry = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
      });
      expect(retry.status).toBe(202);
      // Zero cases selected even under scope=all — agent failures are not rejudgeable output.
      expect((await retry.json()).total).toBe(0);
      const after = await getRun(runId);
      expect(after.stats).toMatchObject({ passed: 0, errored: 5 });
      for (const id of ids) expect((await getReport(after.results[id].reportId)).passFailStatus ?? null).toBeNull();
    } finally {
      await stub.close();
    }
  }, 120_000);

  it('a stub returning a real answer under the same lenient rubric IS judged (demo judge verdict, no agentError, no summary)', async () => {
    if (!backendAvailable) return;
    const stub = await stubAgent({ response: 'Here are the products I found: trail shoe, road shoe.' });
    try {
      const agentKey = await createRestAgent(uniqueTestName('answer-rest'), `http://127.0.0.1:${stub.port}/agent`);
      const ids = [await createTestCase(uniqueTestName('answer-0')), await createTestCase(uniqueTestName('answer-1'))];
      const { runId } = await runToCompletion({ ...RUN_BASE, agentKey, name: uniqueTestName('real-answer-run'), sources: [{ type: 'test-case-ids', ids }] });
      const run = await getRun(runId);
      trackReports(run);
      expect(run.status).toBe('completed');
      expect(run.agentFailureSummary).toBeUndefined();
      expect(run.stats.errored).toBe(0);
      expect(run.stats.passed + run.stats.failed).toBe(2);
      for (const id of ids) {
        const r = await getReport(run.results[id].reportId);
        expect(r.agentError ?? undefined).toBeUndefined();
        expect(['passed', 'failed']).toContain(r.passFailStatus);
        expect(r.metricsStatus).not.toBe('error');
      }
    } finally {
      await stub.close();
    }
  }, 120_000);

  it('a structured-results payload with a null answer is judged, not treated as empty', async () => {
    if (!backendAvailable) return;
    const stub = await stubAgent({ answer: null, results: [{ id: 'p1', title: 'Trail shoe' }, { id: 'p2', title: 'Road shoe' }] });
    try {
      const agentKey = await createRestAgent(uniqueTestName('results-rest'), `http://127.0.0.1:${stub.port}/agent`);
      const ids = [await createTestCase(uniqueTestName('results-0'))];
      const { runId } = await runToCompletion({ ...RUN_BASE, agentKey, name: uniqueTestName('structured-results-run'), sources: [{ type: 'test-case-ids', ids }] });
      const run = await getRun(runId);
      trackReports(run);
      expect(run.stats.errored).toBe(0);
      const r = await getReport(run.results[ids[0]].reportId);
      expect(r.agentError ?? undefined).toBeUndefined();
      expect(['passed', 'failed']).toContain(r.passFailStatus);
    } finally {
      await stub.close();
    }
  }, 120_000);

  it('POST /api/judge refuses an empty trajectory (422, code EMPTY_RESPONSE) and judges a real one', async () => {
    if (!backendAvailable) return;
    const empty = await fetch(`${BASE_URL}/api/judge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trajectory: [{ type: 'response', content: '{}' }], rawEvents: [{}], expectedOutcomes: ['Any reply at all.'], modelId: 'demo-model' }),
    });
    expect(empty.status).toBe(422);
    const body = await empty.json();
    expect(body).toMatchObject({ code: 'EMPTY_RESPONSE', notJudged: true, passFailStatus: null });
    expect(body.error).toMatch(/^not judged: empty response — /);

    const real = await fetch(`${BASE_URL}/api/judge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trajectory: [{ type: 'response', content: 'Here are the products.' }], expectedOutcomes: ['Any reply at all.'], modelId: 'demo-model' }),
    });
    expect(real.status).toBe(200);
    expect(['passed', 'failed']).toContain((await real.json()).passFailStatus);
  }, 30_000);
});
