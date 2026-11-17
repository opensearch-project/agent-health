/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: an agent authored in `agent-health.config.js` with
 * `auth: { type: 'aws-sigv4', … }` reaches its endpoint SIGNED.
 *
 * Real config loader (a temp dir with a real config file — the exact layer
 * that used to drop `auth`), the real `/api/evaluate` router on a real
 * listener, the real REST connector and the real SigV4 signer
 * (`@smithy/signature-v4`) with fake STATIC credentials, and an HTTP stub
 * standing in for the AWS-fronted agent. The stub asserts what the service
 * would check: an `Authorization: AWS4-HMAC-SHA256 Credential=<key>/<date>/
 * <region>/<service>/aws4_request, …` header and `x-amz-date`.
 *
 * On the pre-fix loader the same config produced an agent with no `auth`, so
 * the request arrived with no Authorization header at all (the stub answers
 * 403 "Missing Authentication Token" exactly like API Gateway does).
 *
 * Run:
 *   AH_PORT=<your port> npm run test:integration -- --testPathPattern=sigv4AgentAuth
 */

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const TEST_TIMEOUT = 30000;
const FAKE_ACCESS_KEY = 'AKIAFAKEFAKEFAKEFAKE';
const FAKE_SECRET = 'fakefakefakefakefakefakefakefakefakefake';

function completedEvent(sseText: string): any {
  const line = sseText.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(6));
}

describe('aws-sigv4 agent authored in agent-health.config.* — requests are signed (integration)', () => {
  let app: express.Express;
  let server: http.Server;
  let gateway: http.Server;
  let configDir: string;
  let originalCwd: string;
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    // The "AWS front door": 403 unless a SigV4 Authorization header is present.
    gateway = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        const authz = req.headers.authorization || '';
        res.setHeader('Content-Type', 'application/json');
        if (!authz.startsWith('AWS4-HMAC-SHA256 ')) {
          res.statusCode = 403;
          res.end(JSON.stringify({ message: 'Missing Authentication Token' }));
          return;
        }
        res.end(JSON.stringify({ response: 'The root cause is a misconfigured index alias.' }));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve()));
    const endpoint = `http://127.0.0.1:${(gateway.address() as any).port}/prod/invoke`;

    // Real config file → real loader. Static fake creds: the signer never
    // touches the AWS credential chain.
    configDir = mkdtempSync(join(tmpdir(), 'ah-sigv4-agent-'));
    writeFileSync(
      join(configDir, 'agent-health.config.js'),
      `module.exports = { agents: [{
        key: 'gateway-agent', name: 'Agent behind API Gateway', connectorType: 'rest',
        endpoint: ${JSON.stringify(endpoint)},
        auth: { type: 'aws-sigv4', awsRegion: 'us-east-1', awsService: 'execute-api',
                awsAccessKeyId: ${JSON.stringify(FAKE_ACCESS_KEY)}, awsSecretAccessKey: ${JSON.stringify(FAKE_SECRET)} },
      }] };\n`,
    );
    // `/api/evaluate` re-reads the config from process.cwd() before every run
    // (refreshRunEnvironment), so the temp dir becomes the cwd for this suite;
    // the file store lands under it too and is removed with it.
    originalCwd = process.cwd();
    process.chdir(configDir);
    const { loadConfig, clearConfigCache } = await import('@/lib/config/loader');
    clearConfigCache();
    await loadConfig(configDir, true);

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
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    process.env.AH_PORT = String((server.address() as any).port);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Reports live in the temp dir's own file store (cwd), deleted with it.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    const { clearConfigCache } = await import('@/lib/config/loader');
    clearConfigCache();
    process.chdir(originalCwd);
    rmSync(configDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    received.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('GET /api/agents shows the auth TYPE only — never the static secret', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    const agent = res.body.agents.find((a: any) => a.key === 'gateway-agent');
    expect(agent).toBeDefined();
    expect(agent.auth).toEqual({ type: 'aws-sigv4' });
    expect(JSON.stringify(res.body)).not.toContain(FAKE_SECRET);
  });

  it(
    'POST /api/evaluate → the gateway receives Authorization: AWS4-HMAC-SHA256 … and the run completes',
    async () => {
      const res = await request(app)
        .post('/api/evaluate')
        .send({
          testCase: { id: 'ahtest-sigv4-tc', name: 'ahtest-sigv4-tc', initialPrompt: 'Why is search slow?', expectedOutcomes: ['Names the alias'] },
          agentKey: 'gateway-agent',
          modelId: 'demo-model',
          judgeModelId: 'demo-model',
        });
      if (res.status !== 200) throw new Error(`POST /api/evaluate → ${res.status}: ${res.text.slice(0, 300)}`);
      const completed = completedEvent(res.text);

      expect(received).toHaveLength(1);
      const { headers, body } = received[0];
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      expect(headers.authorization).toMatch(
        new RegExp(`^AWS4-HMAC-SHA256 Credential=${FAKE_ACCESS_KEY}/${today}/us-east-1/execute-api/aws4_request, SignedHeaders=.*host.*x-amz-date.*, Signature=[0-9a-f]{64}$`),
      );
      expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
      // The signed body is the body that was sent (the connector's REST payload).
      expect(JSON.parse(body)).toMatchObject({ prompt: 'Why is search slow?' });

      const report = (await request(app).get(`/api/storage/runs/${encodeURIComponent(completed.reportId)}`)).body;
      expect(report.status).toBe('completed');
      expect(report.agentKey).toBe('gateway-agent');
    },
    TEST_TIMEOUT,
  );
});
