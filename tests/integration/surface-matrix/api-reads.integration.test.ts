/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · API · reads around a run: reports by test case, traces, config/status
 *
 * The read endpoints the UI and scripts lean on after a run:
 *   - `GET /api/storage/runs/by-test-case/:id` and `POST /api/storage/runs/search
 *     { testCaseId }` list the case's reports (newest first / with `total`);
 *   - `GET /api/storage/runs/:id` → the full report (trajectory, verdict,
 *     `metricsStatus`, `runId`, `traceId`); unknown → 404;
 *   - `POST /api/traces` for a report's correlators (`traceId` / `runIds`)
 *     returns the agent's spans — the `invoke_agent` root, `chat` and
 *     `execute_tool` children — with `backend` named; a request with no
 *     correlator and no time range → 400;
 *   - `GET /api/traces/health` → `{ status, backend }`;
 *   - `GET /health` → `{ status: 'ok', version, instance: { pid, cwd, port } }`;
 *   - `GET /api/storage/health` → `{ status: 'ok', backend: 'file' }` on file
 *     storage, `{ status: 'ok', cluster: { name, status } }` on OpenSearch;
 *   - `GET /api/storage/config/status` → `{ storage, observability, runtime }`;
 *   - `GET /api/agents` lists built-ins (`demo`) AND UI-registered custom
 *     agents with `builtIn` flags; `GET /api/models` lists `demo-model`;
 *   - `POST /api/agents/custom` validates (400 without name / endpoint / with a
 *     bad connectorType); `DELETE /api/agents/custom/:key` → 204 then the agent
 *     is gone from `/api/agents`; unknown → 404.
 */

import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BACKEND_PORT, BASE_URL, DEMO_MODEL, api, backendReady, caseInput, createTestCase, getReport, httpRequest, postSse,
  registerRestAgent, reportIdsOf, settleStorage, waitForReportsResolved, waitForTerminalRun,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 180_000;

describe('surface-matrix · API · reads: reports by case · traces · health/config · agents/models', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let tc: { id: string; name: string };
  let report: any;

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    tc = await createTestCase(caseInput('api-reads', 1));
    tracker.testCase(tc.id);
    // One real run to read back.
    const res = await postSse('/api/storage/evaluation-runs', {
      name: uniqueTestName('api-reads-run'),
      sources: [{ type: 'test-case-ids', ids: [tc.id] }],
      agentKey,
      judgeModelId: DEMO_MODEL,
    });
    const runId = res.events.find((e) => e.event === 'started')!.data.runId;
    tracker.evaluationRun(runId);
    const run = await waitForTerminalRun(runId);
    for (const id of reportIdsOf(run)) tracker.run(id);
    [report] = await waitForReportsResolved(reportIdsOf(run));
    await settleStorage(); // list/search views lag one refresh on OpenSearch
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    await tracker.cleanup();
  }, 60_000);

  it('reports are listed under their test case (by-test-case + search) and readable by id', async () => {
    if (!ready) return;
    const byCase = await api<{ runs: any[]; total: number }>('GET', `/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}`);
    expect(byCase.runs.map((r) => r.id)).toContain(report.id);
    expect(byCase.total).toBeGreaterThanOrEqual(1);
    const search = await api<{ runs: any[]; total: number }>('POST', '/api/storage/runs/search', { testCaseId: tc.id });
    expect(search.runs.map((r) => r.id)).toContain(report.id);

    const full = await getReport(report.id);
    expect(full).toMatchObject({ id: report.id, testCaseId: tc.id, agentKey, status: 'completed', metricsStatus: 'ready' });
    expect(['passed', 'failed']).toContain(full.passFailStatus);
    expect(Array.isArray(full.trajectory)).toBe(true);
    expect(agent.invocations.some((i) => i.conversationId === full.runId)).toBe(true);
    expect((await httpRequest('GET', `/api/storage/runs/${uniqueTestName('nope')}`)).status).toBe(404);
  });

  it('POST /api/traces returns the agent span tree for the report; GET /api/traces/health names the backend', async () => {
    if (!ready) return;
    const body: any = { runIds: [report.runId], size: 100 };
    if (report.traceId) body.traceId = report.traceId;
    const traces = await api<{ spans: any[]; backend: string; total: number }>('POST', '/api/traces', body);
    expect(['file', 'opensearch']).toContain(traces.backend);
    const names = traces.spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['invoke_agent retrieval-agent', 'chat fixture-model', 'execute_tool search_products']));
    expect(traces.total).toBe(traces.spans.length);
    // Every returned span belongs to this invocation's trace.
    const invocation = agent.invocations.find((i) => i.conversationId === report.runId)!;
    const agentSpans = traces.spans.filter((s) => /^(invoke_agent|chat|execute_tool) /.test(s.name));
    expect(agentSpans).toHaveLength(3);
    for (const s of agentSpans) expect(s.traceId).toBe(invocation.traceId);

    expect((await httpRequest('POST', '/api/traces', { size: 10 })).status).toBe(400);
    const health = await api<any>('GET', '/api/traces/health');
    expect(['file', 'opensearch']).toContain(health.backend);
    expect(typeof health.status).toBe('string');
  });

  it('health + storage health + config status describe the running server', async () => {
    if (!ready) return;
    const health = await api<any>('GET', '/health');
    expect(health).toMatchObject({ status: 'ok', service: 'agent-health' });
    expect(typeof health.version).toBe('string');
    expect(health.instance).toMatchObject({ port: Number(BACKEND_PORT) });
    expect(typeof health.instance.pid).toBe('number');
    expect(typeof health.instance.cwd).toBe('string');

    // File storage says so (`backend: 'file'`); OpenSearch storage returns the
    // cluster health (`cluster: { name, status }`).
    const storage = await api<any>('GET', '/api/storage/health');
    expect(storage.status).toBe('ok');
    expect(storage.backend === 'file' || typeof storage.cluster?.name === 'string').toBe(true);

    const status = await api<any>('GET', '/api/storage/config/status');
    expect(status).toHaveProperty('storage.configured');
    expect(status).toHaveProperty('observability.configured');
    expect(['file', 'opensearch']).toContain(status.runtime.storage.backend);
  });

  it('agents & models: built-ins + custom agents are listed; custom agent CRUD validates', async () => {
    if (!ready) return;
    const { agents } = await api<{ agents: any[] }>('GET', '/api/agents');
    const demo = agents.find((a) => a.key === 'demo');
    expect(demo).toMatchObject({ builtIn: true });
    const custom = agents.find((a) => a.key === agentKey);
    expect(custom).toMatchObject({ builtIn: false, connectorType: 'rest', useTraces: true, endpoint: agent.url });
    const onlyCustom = await api<{ agents: any[] }>('GET', '/api/agents?filter=custom');
    expect(onlyCustom.agents.every((a) => a.builtIn === false)).toBe(true);
    expect(onlyCustom.agents.map((a) => a.key)).toContain(agentKey);

    const { models } = await api<{ models: any[] }>('GET', '/api/models');
    expect(models.map((m) => m.key)).toContain(DEMO_MODEL);

    expect((await httpRequest('POST', '/api/agents/custom', { endpoint: agent.url })).status).toBe(400);
    expect((await httpRequest('POST', '/api/agents/custom', { name: 'x' })).status).toBe(400);
    expect((await httpRequest('POST', '/api/agents/custom', { name: 'x', endpoint: agent.url, connectorType: 'not-a-connector' })).status).toBe(400);

    const created = await httpRequest<{ agent: { key: string } }>('POST', '/api/agents/custom', { name: uniqueTestName('crud-agent'), endpoint: agent.url, connectorType: 'rest' });
    expect(created.status).toBe(201);
    const key = created.body.agent.key;
    expect((await httpRequest('DELETE', `/api/agents/custom/${encodeURIComponent(key)}`)).status).toBe(204);
    expect((await api<{ agents: any[] }>('GET', '/api/agents')).agents.map((a) => a.key)).not.toContain(key);
    expect((await httpRequest('DELETE', `/api/agents/custom/${encodeURIComponent(key)}`)).status).toBe(404);
  });
});
