/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: a REST agent's non-2xx reply keeps its status + response
 * headers on the stored report (#612, problem 6).
 *
 * Real path end-to-end — the real `/api/evaluate` router on a real listener,
 * the real RESTConnector making a real HTTP call to a local agent stub, the
 * real runner catch block, the real FileStorageModule. Only `loadConfigSync`
 * is mocked (to inject the REST agent; custom agents added via the API cannot
 * carry `connectorConfig` / hooks) and `debug` is silenced.
 *
 * The stub answers `503` with `x-request-id: req-123` (the service request id
 * an operator needs to look up exactly this failed call) plus a `set-cookie`,
 * a `www-authenticate` challenge, a signed `location` and a `server` banner
 * that must never be persisted (allowlist, not denylist). Pre-fix the connector threw before anything
 * about the reply was captured, so the report had no headers for exactly the
 * cases that most need one.
 *
 * The agent also declares an `afterResponse` hook that would crash on a
 * body-less reply: it must NOT run for a non-2xx response (the chosen design
 * records status + headers on the error instead of calling hooks with
 * `ok: false`), and the report must still carry the headers.
 *
 * Mounts individual routers rather than `createApp()` for the ts-jest
 * `import.meta.url` reason documented in
 * agentJudgeImprovementStrategies.integration.test.ts.
 *
 * Binds its own stub agent and its own router listener on EPHEMERAL ports
 * (never `AH_PORT` — in CI the shared integration server already holds that
 * port) and points `AH_PORT` at the listener for the judge's self-dial only
 * for the lifetime of this file; the original value is restored afterwards.
 *
 * Run:
 *   npm run test:integration -- --testPathPatterns=restNon2xxResponseMetadata
 */

import express from 'express';
import http from 'node:http';
import request from 'supertest';

// Filled in once the REST agent stub is listening (port is dynamic).
const agentState: { endpoint: string; hits: number; hookCalls: number } = { endpoint: '', hits: 0, hookCalls: 0 };

jest.mock('@/lib/config/index', () => {
  const actual = jest.requireActual('@/lib/config/index');
  return {
    ...actual,
    loadConfigSync: () => ({
      agents: [
        {
          key: 'rest-agent',
          name: 'REST agent',
          endpoint: agentState.endpoint,
          connectorType: 'rest',
          useTraces: false,
          headers: {},
          hooks: {
            // A hook written for success bodies: `data.answer` is undefined on
            // an error reply and this would throw. It must simply not run.
            afterResponse: async (ctx: any) => {
              agentState.hookCalls += 1;
              const data = ctx.rawEvents?.[0] ?? {};
              return { ...ctx, trajectory: [{ id: 'r', timestamp: Date.now(), type: 'response', content: data.answer.toUpperCase() }] };
            },
          },
        },
      ],
      models: {
        'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo Model', provider: 'demo', context_window: 200000, max_output_tokens: 4096 },
      },
      defaults: { retry_attempts: 0, retry_delay_ms: 0 },
    }),
  };
});

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const TEST_TIMEOUT = 30000;

function completedEvent(sseText: string): any {
  const line = sseText.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(6));
}

describe('REST agent non-2xx reply → report.agentError carries status + response headers (integration)', () => {
  let app: express.Express;
  let server: http.Server;
  let agentServer: http.Server;
  let originalAhPort: string | undefined;
  const createdReportIds: string[] = [];

  beforeAll(async () => {
    // A REST agent that is down: every call answers 503 with a request id.
    agentServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        agentState.hits += 1;
        res.statusCode = 503;
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('X-Request-Id', 'req-123');
        res.setHeader('X-Amzn-RequestId', 'amzn-req-456');
        res.setHeader('Set-Cookie', 'session=secret-cookie; HttpOnly');
        res.setHeader('WWW-Authenticate', 'Bearer realm="agent", error_description="secret-challenge"');
        res.setHeader('Location', 'https://bucket.example/obj?X-Amz-Signature=secret-signature');
        res.setHeader('Server', 'secret-internal-host-01');
        res.setHeader('Retry-After', '30');
        res.end('upstream unavailable');
      });
    });
    await new Promise<void>((resolve) => agentServer.listen(0, '127.0.0.1', () => resolve()));
    agentState.endpoint = `http://127.0.0.1:${(agentServer.address() as any).port}/ask`;

    const judgeRoutes = (await import('@/server/routes/judge')).default;
    const evaluationRoutes = (await import('@/server/routes/evaluation')).default;
    const runRoutes = (await import('@/server/routes/storage/runs')).default;

    app = express();
    app.use(express.json());
    app.use(judgeRoutes);
    app.use(evaluationRoutes);
    app.use(runRoutes);

    // Ephemeral port: AH_PORT may be held by a shared server (CI). The judge
    // route self-dials over AH_PORT, so point it at THIS listener meanwhile.
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('router listener did not bind a TCP port');
    originalAhPort = process.env.AH_PORT;
    process.env.AH_PORT = String(address.port);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of createdReportIds) {
      await request(app).delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    if (originalAhPort === undefined) delete process.env.AH_PORT; else process.env.AH_PORT = originalAhPort;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  });

  beforeEach(() => {
    agentState.hits = 0;
    agentState.hookCalls = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it(
    'a 503 from the REST agent is stored with httpStatus 503 + the diagnostic headers only (x-request-id kept, cookie/challenge/location dropped) — and the afterResponse hook never ran',
    async () => {
      const res = await request(app)
        .post('/api/evaluate')
        .send({
          agentKey: 'rest-agent',
          modelId: 'demo-model',
          testCase: {
            id: `inline-non2xx-${Date.now()}`, name: 'inline non-2xx case', description: '', labels: [], category: 'Custom', difficulty: 'Easy',
            currentVersion: 1, versions: [], isPromoted: false, createdAt: '2024-01-01', updatedAt: '2024-01-01',
            initialPrompt: 'what is the status of the index?', context: [], expectedOutcomes: ['names the alias'],
          },
        });
      expect(res.status).toBe(200);
      const completed = completedEvent(res.text);
      const reportId: string = completed.reportId;
      expect(reportId).toBeTruthy();
      createdReportIds.push(reportId);

      // The real HTTP call reached the stub exactly once; the hook never ran.
      expect(agentState.hits).toBe(1);
      expect(agentState.hookCalls).toBe(0);

      // What was PERSISTED (read back through the storage API, not the SSE frame).
      const stored = await request(app).get(`/api/storage/runs/${encodeURIComponent(reportId)}`);
      expect(stored.status).toBe(200);
      const report = stored.body.run ?? stored.body.report ?? stored.body;
      expect(report.status).toBe('failed');
      expect(report.failureStage).toBe('agent');
      expect(report.agentError).toMatchObject({
        kind: 'http_503',
        httpStatus: 503,
        endpoint: agentState.endpoint,
      });
      // Exactly the diagnostic allowlist — ids, retry hint, content type, date
      // — and nothing else the stub sent (cookie, auth challenge, signed
      // location, server banner, connection/keep-alive/content-length).
      expect(Object.keys(report.agentError.responseHeaders).sort()).toEqual(['content-type', 'date', 'retry-after', 'x-amzn-requestid', 'x-request-id']);
      expect(report.agentError.responseHeaders).toMatchObject({
        'x-request-id': 'req-123',
        'x-amzn-requestid': 'amzn-req-456',
        'retry-after': '30',
        'content-type': 'text/plain',
      });
      expect(report.agentError.message).toContain('REST request failed: 503 - upstream unavailable');
      // None of the sensitive values appears anywhere on the stored doc.
      expect(JSON.stringify(report)).not.toMatch(/secret-cookie|secret-challenge|secret-signature|secret-internal-host/);
      // eslint-disable-next-line no-console
      process.stdout.write(`[rest-non2xx] stored agentError: ${JSON.stringify(report.agentError)}\n`);
    },
    TEST_TIMEOUT,
  );
});
