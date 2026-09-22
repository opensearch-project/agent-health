/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests: `POST /api/evaluate` with an optional `modelId`, and
 * `GET /api/storage/runs` filters — the real routers mounted on a real
 * listener, real FileStorageModule (isolated data dir), a real REST agent
 * stub over HTTP, and the demo judge (no Bedrock).
 *
 * Regression for "Run Test silently does nothing": for a `rest` agent whose
 * model is declared in its own connector config (a provider-native id that
 * is never a catalog key) the route rejected every run with
 * `400 Model not found` before anything was logged or stored; sending an
 * unrelated catalog key instead made it succeed but recorded a model the
 * agent never used.
 *
 * Only `loadConfigSync` is mocked (to inject the REST agent — custom agents
 * added via the API cannot carry `connectorConfig`); everything else is real.
 * Mounts individual routers rather than `createApp()` for the same ts-jest
 * `import.meta.url` reason documented in
 * agentJudgeImprovementStrategies.integration.test.ts.
 *
 * Run:
 *   AH_PORT=<your port> npm run test:integration -- --testPathPattern=evaluateModelOptional
 */

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { rmSync } from 'node:fs';
import path from 'node:path';

const DECLARED_MODEL = 'provider.retrieval-deployment-v2';

const CATALOG = {
  'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo Model', provider: 'demo', context_window: 200000, max_output_tokens: 4096 },
  'claude-sonnet-4.5': { model_id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', display_name: 'Claude Sonnet 4.5', provider: 'bedrock', context_window: 200000, max_output_tokens: 4096 },
};

// Filled in once the REST agent stub is listening (port is dynamic).
const agentState: { endpoint: string; received: any[] } = { endpoint: '', received: [] };

jest.mock('@/lib/config/index', () => {
  const actual = jest.requireActual('@/lib/config/index');
  return {
    ...actual,
    loadConfigSync: () => ({
      agents: [
        {
          key: 'retrieval-agent',
          name: 'Retrieval agent (REST)',
          endpoint: agentState.endpoint,
          connectorType: 'rest',
          connectorConfig: { model: DECLARED_MODEL },
          headers: {},
        },
        { key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo', connectorType: 'mock', headers: {} },
      ],
      models: CATALOG,
      defaults: { retry_attempts: 0, retry_delay_ms: 0 },
    }),
  };
});

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const TEST_TIMEOUT = 30000;
const DATA_DIR = path.join(process.cwd(), '.agent-health-test-data', 'evaluateModelOptional');

function completedEvent(sseText: string): any {
  const line = sseText.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(6));
}

describe('POST /api/evaluate — modelId optional (integration)', () => {
  let app: express.Express;
  let server: http.Server;
  let agentServer: http.Server;
  let infoSpy: jest.SpyInstance;
  const createdReportIds: string[] = [];

  beforeAll(async () => {
    process.env.AGENT_HEALTH_DATA_DIR = DATA_DIR;

    // A minimal REST agent: records the payload it was sent and answers.
    agentServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        agentState.received.push(JSON.parse(body || '{}'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: 'The root cause is a misconfigured index alias.', runId: `agent-run-${Date.now()}` }));
      });
    });
    await new Promise<void>((resolve) => agentServer.listen(0, '127.0.0.1', () => resolve()));
    agentState.endpoint = `http://127.0.0.1:${(agentServer.address() as any).port}/ask`;

    const judgeRoutes = (await import('@/server/routes/judge')).default;
    const evaluationRoutes = (await import('@/server/routes/evaluation')).default;
    const runRoutes = (await import('@/server/routes/storage/runs')).default;
    const configRoutes = (await import('@/server/routes/config')).default;

    app = express();
    app.use(express.json());
    app.use(judgeRoutes);
    app.use(evaluationRoutes);
    app.use(runRoutes);
    app.use(configRoutes);

    // callBedrockJudge self-dials /api/judge over AH_PORT → point it here.
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    process.env.AH_PORT = String((server.address() as any).port);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of createdReportIds) {
      await request(app).delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => agentServer.close(() => resolve()));
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    agentState.received.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('GET /api/agents reports the REST agent as owning its (declared) model', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.agents.map((a: any) => [a.key, a.modelOwnership]));
    expect(byKey['retrieval-agent']).toEqual({ ownsModel: true, declaredModelId: DECLARED_MODEL });
    expect(byKey.demo).toEqual({ ownsModel: false });
  });

  it(
    'rest agent WITHOUT modelId → 200, runs, and the report records the agent model with modelSource agent',
    async () => {
      const res = await request(app)
        .post('/api/evaluate')
        .send({
          testCase: { id: 'ahtest-rest-tc', name: 'ahtest-rest-tc', initialPrompt: 'Why is search slow?', expectedOutcomes: ['Names the alias'] },
          agentKey: 'retrieval-agent',
          judgeModelId: 'demo-model',
        });
      expect(res.status).toBe(200);
      const completed = completedEvent(res.text);
      createdReportIds.push(completed.reportId);

      // The agent was invoked with ITS model — not a catalog key.
      expect(agentState.received).toHaveLength(1);
      expect(agentState.received[0].model).toBe(DECLARED_MODEL);

      const report = (await request(app).get(`/api/storage/runs/${encodeURIComponent(completed.reportId)}`)).body;
      expect(report).toMatchObject({
        agentKey: 'retrieval-agent',
        modelId: DECLARED_MODEL,
        modelName: DECLARED_MODEL,
        modelSource: 'agent',
        status: 'completed',
      });
      expect(report.trajectory.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'rest agent WITH an unrelated catalog modelId → ignored; the report still records the agent model',
    async () => {
      const res = await request(app)
        .post('/api/evaluate')
        .send({
          testCase: { id: 'ahtest-rest-tc-2', name: 'ahtest-rest-tc-2', initialPrompt: 'Why is search slow?', expectedOutcomes: ['Names the alias'] },
          agentKey: 'retrieval-agent',
          modelId: 'claude-sonnet-4.5',
          judgeModelId: 'demo-model',
        });
      expect(res.status).toBe(200);
      const completed = completedEvent(res.text);
      createdReportIds.push(completed.reportId);

      expect(agentState.received[0].model).toBe(DECLARED_MODEL);
      const report = (await request(app).get(`/api/storage/runs/${encodeURIComponent(completed.reportId)}`)).body;
      expect(report).toMatchObject({ modelId: DECLARED_MODEL, modelSource: 'agent' });
    },
    TEST_TIMEOUT,
  );

  it('catalog-only agent + non-catalog modelId → 400 with code MODEL_NOT_FOUND, logged, nothing stored', async () => {
    const before = (await request(app).get('/api/storage/runs?testCaseId=ahtest-never-created')).body.runs.length;

    const res = await request(app)
      .post('/api/evaluate')
      .send({
        testCase: { id: 'ahtest-never-created', name: 'ahtest-never-created', initialPrompt: 'x', expectedOutcomes: ['y'] },
        agentKey: 'demo',
        modelId: DECLARED_MODEL,
      });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: expect.stringContaining(`Model not found: ${DECLARED_MODEL}`), code: 'MODEL_NOT_FOUND' });

    const logLine = infoSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[EvaluationAPI] Rejected 400 MODEL_NOT_FOUND'));
    expect(logLine).toContain('agentKey=demo');
    expect(logLine).toContain('testCaseId=inline');

    const after = (await request(app).get('/api/storage/runs?testCaseId=ahtest-never-created')).body.runs.length;
    expect(after).toBe(before);
  });

  it('unknown agent → 400 AGENT_NOT_FOUND; unknown test case → 404 TEST_CASE_NOT_FOUND', async () => {
    const a = await request(app).post('/api/evaluate').send({ testCaseId: 'whatever', agentKey: 'no-such-agent' });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe('AGENT_NOT_FOUND');

    const t = await request(app).post('/api/evaluate').send({ testCaseId: 'ahtest-does-not-exist-000', agentKey: 'demo', modelId: 'demo-model' });
    expect(t.status).toBe(404);
    expect(t.body.code).toBe('TEST_CASE_NOT_FOUND');
  });

  describe('GET /api/storage/runs filters', () => {
    it('?testCaseId= returns only that test case\'s runs (was: silently unfiltered)', async () => {
      const list = await request(app).get('/api/storage/runs?testCaseId=ahtest-rest-tc');
      expect(list.status).toBe(200);
      expect(list.body.runs.length).toBeGreaterThan(0);
      expect(new Set(list.body.runs.map((r: any) => r.testCaseId))).toEqual(new Set(['ahtest-rest-tc']));
      // Bundled demo runs (other test cases) are filtered out as well.
      expect(list.body.runs.some((r: any) => String(r.id).startsWith('demo-'))).toBe(false);

      const other = await request(app).get('/api/storage/runs?testCaseId=ahtest-rest-tc-2');
      expect(other.body.runs.map((r: any) => r.testCaseId)).toEqual(['ahtest-rest-tc-2']);
    });

    it('?agentKey= filters and combines with ?fields=', async () => {
      const list = await request(app).get('/api/storage/runs?agentKey=retrieval-agent&fields=id,agentKey,modelSource');
      expect(list.status).toBe(200);
      expect(list.body.runs.length).toBeGreaterThanOrEqual(2);
      for (const r of list.body.runs) {
        expect(r.agentKey).toBe('retrieval-agent');
        expect(r.modelSource).toBe('agent');
      }
    });

    it('unknown query param → 400 UNKNOWN_QUERY_PARAM', async () => {
      const res = await request(app).get('/api/storage/runs?testcase=ahtest-rest-tc');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining("Unknown query parameter 'testcase'"), code: 'UNKNOWN_QUERY_PARAM' });
    });
  });
});
