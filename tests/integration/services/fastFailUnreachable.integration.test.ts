/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests — fast-fail for unreachable agent endpoints. Real server,
 * real storage backend (whatever AH_PORT points at), real REST connector.
 *
 * Run:
 *   AH_PORT=4940 npm run test:integration -- --testPathPatterns=fastFailUnreachable
 *
 * Owner incident: a run against a DOWN endpoint spent the whole trace-polling
 * budget (minutes) on EVERY case before erroring it as a trace timeout, with
 * the real cause lost. Covered end-to-end through the HTTP API:
 *   1. a 5-case run of a `useTraces` REST agent against a CLOSED local port
 *      finalises in seconds (wall < 30 s), every report is a final
 *      `agent_failed` (never trace-polled) naming ECONNREFUSED + host, the
 *      breaker refuses the last 2 cases, and the run doc carries
 *      `agentFailureSummary`;
 *   2. the same agent against a local endpoint that answers 200 keeps the
 *      normal trace-mode behaviour (the report enters trace polling).
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
      context: [], expectedTrajectory: [], expectedOutcomes: ['ok'], labels: ['@integration-test'],
    }),
  });
  if (!r.ok) throw new Error(`create test case: ${r.status} ${await r.text()}`);
  const tc = await r.json();
  tracker.testCase(tc.id);
  return tc.id;
}

/** Register a REST custom agent (useTraces so the trace-mode path is exercised). */
async function createRestAgent(name: string, endpoint: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/agents/custom`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, endpoint, connectorType: 'rest', useTraces: true }),
  });
  if (!r.ok) throw new Error(`create custom agent: ${r.status} ${await r.text()}`);
  const { agent } = await r.json();
  tracker.customAgent(agent.key);
  return agent.key as string;
}

/** POST the run and drain the SSE stream to completion; returns the run id + wall time. */
async function runToCompletion(body: Record<string, unknown>): Promise<{ runId: string; wallMs: number; sse: string }> {
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
  return { runId, wallMs: Date.now() - started, sse };
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

async function searchReportsByTestCase(testCaseId: string): Promise<any[]> {
  const r = await fetch(`${BASE_URL}/api/storage/runs/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCaseId, size: 50 }),
  });
  if (!r.ok) throw new Error(`search reports for ${testCaseId}: ${r.status}`);
  const body = await r.json();
  return (body.runs ?? []).filter((x: any) => x.testCaseId === testCaseId);
}

function trackReports(run: any) {
  for (const r of Object.values(run.results || {}) as any[]) if (r.reportId) tracker.run(r.reportId);
}

/** A port nothing listens on: bind an ephemeral port, close it, reuse the number. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port as number;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const RUN_BASE = { judgeModelId: 'demo-model', trigger: 'api', concurrency: 1 };

describe('fast-fail for unreachable agent endpoints (real server, real REST connector)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) console.warn(`Backend not available at ${BASE_URL} — skipping fast-fail tests`);
  });

  afterAll(async () => { await tracker.cleanup(); });

  it('5 cases against a closed port: finalises in seconds, agent_failed everywhere, breaker refuses the last 2, run summary set', async () => {
    if (!backendAvailable) return;
    const port = await closedPort();
    const agentKey = await createRestAgent(uniqueTestName('ff-dead-rest'), `http://127.0.0.1:${port}/agent`);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await createTestCase(uniqueTestName(`ff-dead-${i}`)));

    const { runId, wallMs } = await runToCompletion({
      ...RUN_BASE, agentKey, name: uniqueTestName('ff-dead-port'), sources: [{ type: 'test-case-ids', ids }],
    });
    // Pre-fix: TRACE_POLL_INTERVAL_MS × TRACE_POLL_MAX_ATTEMPTS per case (10 min each by default).
    expect(wallMs).toBeLessThan(30_000);

    const run = await getRun(runId);
    trackReports(run);
    expect(run.status).toBe('completed');
    expect(Object.keys(run.results)).toHaveLength(5);
    expect(run.stats).toMatchObject({ passed: 0, failed: 0, errored: 5, pending: 0, total: 5 });
    expect(run.agentFailureSummary).toBe(
      `Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, 127.0.0.1:${port}); 2 further cases were not attempted`,
    );

    const reports = await Promise.all(ids.map(id => getReport(run.results[id].reportId)));
    for (const r of reports) {
      expect(r.status).toBe('failed');
      expect(r.metricsStatus).toBe('error');
      expect(r.passFailStatus ?? null).toBeNull();
      expect(r.traceError).toMatch(/^Agent run did not complete \(kind=agent_failed\)/);
      expect(r.traceFetchAttempts ?? 0).toBe(0);
      expect(r.llmJudgeReasoning).toContain('**Agent run did not complete.**');
      // Host only — never the full URL.
      expect(r.traceError).not.toContain('/agent');
      expect(r.traceError).not.toContain('http://');
    }
    const dialled = reports.filter(r => r.traceError.includes(`ECONNREFUSED — connection refused while calling agent endpoint 127.0.0.1:${port}`));
    const refused = reports.filter(r => r.traceError.includes(`agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, 127.0.0.1:${port}); this case was not attempted`));
    expect(dialled).toHaveLength(3);
    expect(refused).toHaveLength(2);
  }, 120_000);

  it('an endpoint that answers 200 keeps the normal trace-mode behaviour (report enters trace polling; no summary)', async () => {
    if (!backendAvailable) return;
    // Minimal REST agent: answers every POST with a JSON response.
    const agentServer: Server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'Here are the products I found.' }));
      });
    });
    await new Promise<void>(resolve => agentServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (agentServer.address() as any).port as number;

    try {
      const agentKey = await createRestAgent(uniqueTestName('ff-ok-rest'), `http://127.0.0.1:${port}/agent`);
      const id = await createTestCase(uniqueTestName('ff-ok-0'));

      // The run stays in trace polling for the server's configured budget; we
      // only need to observe that the report ENTERED polling, so start the run
      // and read the report while (or after) it polls, then cancel.
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...RUN_BASE, agentKey, name: uniqueTestName('ff-ok-endpoint'), sources: [{ type: 'test-case-ids', ids: [id] }] }),
      });
      expect(res.ok).toBe(true);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let runId: string | undefined;
      while (!runId) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const m = text.match(/event: started\ndata: (.*)\n/);
        if (m) runId = JSON.parse(m[1]).runId;
      }
      expect(runId).toBeTruthy();
      tracker.evaluationRun(runId!);
      const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) return; } })();

      // Wait until the case has a report doc that the AGENT has answered, then
      // inspect it. The evaluation-run doc only records `results[id].reportId`
      // when the case COMPLETES — for a trace-mode case that is after the trace
      // poller gives up (the server default budget is 10 minutes), so the run
      // doc cannot be the source here. The runner pre-persists a placeholder
      // report for the case and updates it in place once the agent answers, so
      // search reports by test-case id instead (the same id-scoped lookup the
      // test-data tracker uses).
      let report: any;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const found = await searchReportsByTestCase(id);
        for (const r of found) tracker.run(r.id);
        const answered = found.find(r =>
          r.status === 'completed' &&
          // Either still polling, or the poller already finished (short budget on the server).
          (r.metricsStatus === 'pending' || r.metricsStatus === 'calculating' || (r.traceFetchAttempts ?? 0) > 0 || /kind=trace_/.test(r.traceError ?? '')),
        );
        if (answered) {
          report = answered;
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      expect(report).toBeDefined();
      // The agent answered: the case is NOT an agent failure and DID go to trace polling.
      expect(report.status).toBe('completed');
      expect(report.traceError ?? '').not.toContain('agent_failed');
      expect(report.trajectory.length).toBeGreaterThan(0);

      // Cancel so the shared server isn't left polling for this suite's run.
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' }).catch(() => {});
      await Promise.race([drain, new Promise(r => setTimeout(r, 15_000))]);
      const finalRun = await getRun(runId!);
      expect(finalRun.agentFailureSummary).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => agentServer.close(() => resolve()));
    }
  }, 120_000);
});
