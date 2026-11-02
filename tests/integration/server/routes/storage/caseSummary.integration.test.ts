/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: `POST /api/storage/runs/:id/summary` (case TL;DR).
 *
 * Mounts the REAL runs + test-cases routers on the REAL FileStorageModule
 * (isolated data dir) and drives the REAL AWS SDK + REAL refreshing credential
 * provider: `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` (a standard SDK setting) points
 * the Bedrock Runtime client at a local verifying HTTP/2 server, and fake env
 * credentials are what the provider chain must resolve. Nothing on the
 * summary path is mocked — the local endpoint asserts that each request is
 * SigV4-signed with the credential the provider resolved, which is the
 * wiring the repo's #569 rule is about.
 *
 * Scenario (one report, in order):
 *   1. first view     → model called once, `source: 'llm'`, persisted on the report
 *   2. second view    → `cached: true`, no model call
 *   3. re-judge (PATCH verdict + reasoning) → hash mismatch → model called again, new text persisted
 *   3b. re-judge DURING generation → the finished summary is NOT persisted (stale-write guard)
 *   4. model 500s     → `source: 'fallback'` + error text; the persisted LLM summary is left untouched
 *   5. model hangs    → timeout → fallback says so
 *   6. unknown report → 404
 *
 * The verdict sentence's label is always composed server-side from the
 * report (the model supplies only the "why"), which 1) and 3) assert.
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=caseSummary.integration
 */

import express from 'express';
import request from 'supertest';
import { apiKeyAuth } from '@/server/middleware/apiKeyAuth';
import http2 from 'node:http2';
import { rmSync } from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const DATA_DIR = path.join(process.cwd(), '.agent-health-test-data', `caseSummary-${process.pid}`);
const FAKE_KEY_ID = 'AKIACASESUMMARYTEST1';

type FakeMode = 'ok' | 'error' | 'hang' | 'hold';

interface FakeBedrock {
  server: http2.Http2Server;
  url: string;
  mode: FakeMode;
  calls: Array<{ authorization: string; modelPath: string; body: any }>;
  nextParts: { why: string };
  /** 'hold' mode: responders parked until release() is called. */
  held: Array<() => void>;
  release: () => void;
}

function startFakeBedrock(): Promise<FakeBedrock> {
  const fake: FakeBedrock = {
    server: undefined as any,
    url: '',
    mode: 'ok',
    calls: [],
    nextParts: { why: 'c' },
    held: [],
    release: () => { const h = fake.held; fake.held = []; h.forEach(fn => fn()); },
  };
  // The Bedrock Runtime client's default request handler is HTTP/2
  // (NodeHttp2Handler) — a plain-h2c http2 server is what it will dial.
  fake.server = http2.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      fake.calls.push({ authorization: String(req.headers.authorization || ''), modelPath: req.headers[':path'] as string || req.url || '', body });
      if (fake.mode === 'hang') return; // never answer; the service's abort must fire
      if (fake.mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'fake bedrock is down' }));
        return;
      }
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          output: { message: { role: 'assistant', content: [{ text: JSON.stringify(fake.nextParts) }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          metrics: { latencyMs: 5 },
        }));
      };
      if (fake.mode === 'hold') { fake.held.push(answer); return; }
      answer();
    });
  });
  return new Promise((resolve) => {
    fake.server.listen(0, '127.0.0.1', () => {
      const port = (fake.server.address() as any).port;
      fake.url = `http://127.0.0.1:${port}`;
      resolve(fake);
    });
  });
}

describe('POST /api/storage/runs/:id/summary — case TL;DR (integration, real SDK + credential provider)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let app: express.Express;
  let fake: FakeBedrock;
  let tcId: string;
  let reportId: string;

  beforeAll(async () => {
    fake = await startFakeBedrock();
    process.env.AGENT_HEALTH_DATA_DIR = DATA_DIR;
    // Real SDK config: custom endpoint + static env credentials (the
    // refreshing provider resolves these through fromNodeProviderChain).
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = fake.url;
    process.env.AWS_ACCESS_KEY_ID = FAKE_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = 'case-summary-test-secret';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    process.env.AWS_REGION = 'us-west-2';
    process.env.CASE_SUMMARY_TIMEOUT_MS = '1500';
    // Keep the SDK from spending its retry budget on the 500 / hang cases.
    process.env.AWS_MAX_ATTEMPTS = '1';

    const runRoutes = (await import('@/server/routes/storage/runs')).default;
    const testCaseRoutes = (await import('@/server/routes/storage/testCases')).default;
    app = express();
    app.use(express.json({ limit: '5mb' }));
    // The server's only auth middleware, mounted exactly as server/middleware/index.ts does.
    app.use(apiKeyAuth);
    app.use(runRoutes);
    app.use(testCaseRoutes);

    const tc = await request(app).post('/api/storage/test-cases').send({
      name: `ahtest-case-summary-${Date.now()}`,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: 'Why does the nightly report job fail after the 02:00 rotation?',
      expectedOutcomes: ['Finds the expired token in the scheduler config', 'Suggests rotating the token automatically'],
    });
    expect([200, 201]).toContain(tc.status);
    tcId = tc.body.id || tc.body.testCase?.id;
    expect(tcId).toBeTruthy();

    const rep = await request(app).post('/api/storage/runs').send({
      testCaseId: tcId,
      agentName: 'Example ops agent',
      modelName: 'demo-model',
      status: 'completed',
      metricsStatus: 'ready',
      passFailStatus: 'passed',
      score: 0.85,
      trajectory: [
        { id: 's1', type: 'action', toolName: 'read_config', toolArgs: { path: 'scheduler.yaml' }, timestamp: 1 },
        { id: 's2', type: 'tool_result', content: 'token_expires_at: 02:00', timestamp: 2 },
        { id: 's3', type: 'response', content: 'The scheduler token expires at 02:00; rotate it automatically before the job.', timestamp: 3 },
      ],
      llmJudgeReasoning: 'The agent found the expired scheduler token and proposed automatic rotation; both outcomes met.',
      metrics: { accuracy: 90, faithfulness: 88, latency_score: 80, trajectory_alignment_score: 85 },
    });
    expect(rep.status).toBe(201);
    reportId = rep.body.id;
  }, 30000);

  afterAll(async () => {
    try {
      if (reportId) await request(app).delete(`/api/storage/runs/${reportId}`);
      if (tcId) await request(app).delete(`/api/storage/test-cases/${tcId}`);
    } catch { /* best-effort */ }
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    rmSync(DATA_DIR, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it('1) first view: calls the model once through a SigV4-signed request and persists the LLM summary', async () => {
    fake.mode = 'ok';
    fake.nextParts = { why: 'both expected outcomes were met' };
    const res = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({});
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.summary.source).toBe('llm');
    // Asked / Agent are deterministic (never model text); only the verdict's reason came from the model.
    expect(res.body.summary.parts).toEqual({
      asked: 'The test asks: “Why does the nightly report job fail after the 02:00 rotation?” It has 2 expected outcomes, e.g. “Finds the expired token in the scheduler config”.',
      agent: 'Example ops agent used the tool read_config and answered: “The scheduler token expires at 02:00; rotate it automatically before the job.”',
      verdict: 'Judge verdict: PASSED (score 85%) — both expected outcomes were met.',
    });
    expect(res.body.summary.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(res.body.summary.model).toMatch(/anthropic\.claude/);

    // The REAL SDK signed the request with the credential the REAL provider resolved.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${FAKE_KEY_ID}/\\d{8}/us-west-2/bedrock/aws4_request`));
    expect(fake.calls[0].modelPath).toMatch(/^\/model\/.+\/converse$/);
    // The prompt the model saw carried the bounded fields, not the whole report.
    const userText: string = fake.calls[0].body.messages[0].content[0].text;
    expect(userText).toContain('"prompt": "Why does the nightly report job fail');
    expect(userText).toContain('"read_config"');
    expect(userText).toContain('"verdict": "passed"');

    const stored = await request(app).get(`/api/storage/runs/${reportId}`);
    expect(stored.body.caseSummary).toEqual(res.body.summary);
  });

  it('1b) two concurrent first views of a fresh report share ONE model call', async () => {
    const rep = await request(app).post('/api/storage/runs').send({
      testCaseId: tcId, agentName: 'Example ops agent', modelName: 'demo-model',
      status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed',
      trajectory: [{ id: 's1', type: 'response', content: 'Rotate the token.', timestamp: 1 }],
      llmJudgeReasoning: 'Fine.', metrics: { accuracy: 90, faithfulness: 90, latency_score: 90, trajectory_alignment_score: 90 },
    });
    expect(rep.status).toBe(201);
    const id = rep.body.id as string;
    try {
      const before = fake.calls.length;
      const [a, b] = await Promise.all([
        request(app).post(`/api/storage/runs/${id}/summary`).send({}),
        request(app).post(`/api/storage/runs/${id}/summary`).send({}),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.summary).toEqual(b.body.summary);
      expect(a.body.summary.parts.verdict).toBe(`Judge verdict: PASSED — ${fake.nextParts.why}.`);
      expect(a.body.summary.source).toBe('llm');
      expect(fake.calls).toHaveLength(before + 1);
    } finally {
      await request(app).delete(`/api/storage/runs/${id}`);
    }
  });

  it('2) second view: served from the report cache, no model call', async () => {
    const before = fake.calls.length;
    const res = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({});
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.summary.parts.verdict).toContain('both expected outcomes were met');
    expect(fake.calls).toHaveLength(before);
  });

  it('3) after a re-judge the cached summary is stale → regenerated with the new verdict and re-persisted', async () => {
    const before = fake.calls.length;
    const prev = (await request(app).get(`/api/storage/runs/${reportId}`)).body.caseSummary;

    const patch = await request(app).patch(`/api/storage/runs/${reportId}`).send({
      passFailStatus: 'failed',
      llmJudgeReasoning: 'The agent found the token but its rotation suggestion would run after the job starts.',
      judgementRetriedAt: new Date().toISOString(),
      judgementRetryCount: 1,
    });
    expect(patch.status).toBe(200);

    fake.nextParts = { why: 'the proposed rotation would run after the job starts' };
    const res = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({});
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.summary.source).toBe('llm');
    const expectedVerdict = 'Judge verdict: FAILED (score 85%) — the proposed rotation would run after the job starts.';
    expect(res.body.summary.parts.verdict).toBe(expectedVerdict);
    expect(res.body.summary.inputsHash).not.toBe(prev.inputsHash);
    expect(fake.calls).toHaveLength(before + 1);
    expect(fake.calls[before].body.messages[0].content[0].text).toContain('"verdict": "failed"');

    const stored = await request(app).get(`/api/storage/runs/${reportId}`);
    expect(stored.body.caseSummary.inputsHash).toBe(res.body.summary.inputsHash);
    expect(stored.body.caseSummary.parts.verdict).toBe(expectedVerdict);
  });

  it('3b) a re-judge that lands WHILE the model is writing: the finished summary is returned but NOT cached (stale-write guard)', async () => {
    // Make the cache stale so the route must ask the model, then hold the
    // model's reply until a PATCH has changed the judgement underneath it.
    await request(app).patch(`/api/storage/runs/${reportId}`).send({ llmJudgeReasoning: 'Reasoning v3 — about to be re-judged again.' });
    const stored = (await request(app).get(`/api/storage/runs/${reportId}`)).body.caseSummary;
    fake.mode = 'hold';
    // supertest requests are lazy — `.then` is what actually sends it.
    const pending = request(app).post(`/api/storage/runs/${reportId}/summary`).send({}).then(r => r);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const t = setInterval(() => {
        if (fake.held.length) { clearInterval(t); resolve(); }
        else if (Date.now() - started > 5000) { clearInterval(t); reject(new Error('model request never reached the fake endpoint')); }
      }, 10);
    });
    await request(app).patch(`/api/storage/runs/${reportId}`).send({ llmJudgeReasoning: 'Reasoning v4 — landed during generation.' });
    fake.nextParts = { why: 'written against v3' };
    fake.release();
    fake.mode = 'ok';
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.summary.source).toBe('llm');
    expect(res.body.summary.parts.verdict).toContain('written against v3');
    // Not persisted: the stored summary is the pre-existing one, and the next
    // view regenerates against v4.
    const after = (await request(app).get(`/api/storage/runs/${reportId}`)).body.caseSummary;
    expect(after).toEqual(stored);
    const before = fake.calls.length;
    fake.nextParts = { why: 'written against v4' };
    const next = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({});
    expect(next.body.cached).toBe(false);
    expect(next.body.summary.parts.verdict).toContain('written against v4');
    expect(fake.calls).toHaveLength(before + 1);
    expect((await request(app).get(`/api/storage/runs/${reportId}`)).body.caseSummary.parts.verdict).toContain('written against v4');
  });

  it('4) model error → honest field-based fallback with the error; the stored LLM summary is untouched', async () => {
    // Make the cache stale again so the route has to ask the model.
    await request(app).patch(`/api/storage/runs/${reportId}`).send({ llmJudgeReasoning: 'Rotation timing is wrong; the fix would not prevent the failure.' });
    const stored = (await request(app).get(`/api/storage/runs/${reportId}`)).body.caseSummary;

    fake.mode = 'error';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({});
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.summary.source).toBe('fallback');
    expect(res.body.summary.error).toBeTruthy();
    expect(res.body.summary.parts.asked).toMatch(/^The test asks: “Why does the nightly report job fail/);
    expect(res.body.summary.parts.agent).toMatch(/^Example ops agent used the tool read_config and answered: “The scheduler token expires/);
    expect(res.body.summary.parts.verdict).toMatch(/^Judge verdict: FAILED \(score 85%\) — Rotation timing is wrong/);

    const after = (await request(app).get(`/api/storage/runs/${reportId}`)).body.caseSummary;
    expect(after).toEqual(stored); // fallbacks are never persisted
  });

  it('5) model hangs → the request is aborted at the timeout and the fallback says so', async () => {
    fake.mode = 'hang';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const res = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({ force: true });
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.summary.source).toBe('fallback');
    expect(res.body.summary.error).toMatch(/did not answer within 2 s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15000);

  it('7) CASE_SUMMARY_ENABLED=false: the route never calls the model and says so (opt-out for sending case data)', async () => {
    fake.mode = 'ok';
    process.env.CASE_SUMMARY_ENABLED = 'false';
    try {
      await request(app).patch(`/api/storage/runs/${reportId}`).send({ llmJudgeReasoning: 'Reasoning v5 — model disabled.' });
      const before = fake.calls.length;
      const res = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({ force: true });
      expect(res.status).toBe(200);
      expect(res.body.summary.source).toBe('fallback');
      expect(res.body.summary.error).toMatch(/disabled \(CASE_SUMMARY_ENABLED=false\)/);
      expect(res.body.summary.parts.verdict).toMatch(/^Judge verdict: FAILED \(score 85%\) — Reasoning v5/);
      expect(fake.calls).toHaveLength(before);
    } finally {
      delete process.env.CASE_SUMMARY_ENABLED;
    }
  });

  it('8) auth coverage: AH_API_KEY protects only /api/coding-agents — /api/storage/runs/:id/summary stays open like every other storage route (documented exposure)', async () => {
    process.env.AH_API_KEY = 'secret-for-test';
    try {
      // Control: the middleware IS active on the routes it was written for.
      const guarded = await request(app).post('/api/coding-agents/anything').send({});
      expect(guarded.status).toBe(401);
      // The summary route: no Bearer token, still answered (same as GET /api/storage/runs/:id).
      const open = await request(app).post(`/api/storage/runs/${reportId}/summary`).send({});
      expect(open.status).toBe(200);
      const sibling = await request(app).get(`/api/storage/runs/${reportId}`);
      expect(sibling.status).toBe(200);
    } finally {
      delete process.env.AH_API_KEY;
    }
  });

  it('6) unknown report → 404', async () => {
    const res = await request(app).post('/api/storage/runs/report-does-not-exist/summary').send({});
    expect(res.status).toBe(404);
  });
});
