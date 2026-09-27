/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: agent-error surfacing end-to-end through the REAL service code.
 *
 * Owner incident (a 62-case run against a REST agent, 5 cases "errored" with
 * an EMPTY Test Case Output tab): the agent's HTTP call never returned inside
 * undici's silent 300 s headersTimeout → `TypeError: fetch failed`; the
 * runner persisted an empty report and STILL invoked the judge; the judge
 * model returned an empty turn → parse error → mis-mapped to "Failed to
 * parse Pi judge response. The CLI may have returned invalid JSON." → retried
 * 10× (~8.5 min/case). The UI said "evaluator could not run".
 *
 * Scenario A — REAL `RESTConnector` (+ real fetchWithTimeout) against a real
 *   local HTTP server that accepts the POST and never answers, with
 *   `connectorConfig.timeoutMs` small, driven through the REAL
 *   `runEvaluationWithConnector`:
 *     • the report has failureStage 'agent', status 'failed',
 *       metricsStatus 'error', no verdict;
 *     • `error` / `agentError.message` carry the REAL cause (timeout +
 *       endpoint + the timeout in force) — never the bare `fetch failed`;
 *     • the judge endpoint is NEVER called.
 *
 * Scenario B — the REAL `/api/judge` express route + the REAL
 *   `callBedrockJudge` client against it, with only the LLM-driving service
 *   (`evaluateWithPiAgenticTrace`) mocked to run the REAL `parseJudgeResponse`
 *   over an EMPTY model reply:
 *     • the route answers 422 `JUDGE_UNPARSEABLE` with the raw text;
 *     • the client stops after PARSE_FAILURE_MAX_ATTEMPTS (2), not 10;
 *     • the resulting report is judge_failed with `judgeError.rawResponse ''`
 *       and `attempts 2`, and the message says "no parseable verdict" (not
 *       "Pi CLI … invalid JSON").
 *
 * Boots its own express app on an ephemeral port — does NOT need AH_PORT.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Scenario B mocks the model layer only; the parser + route + client are real.
const mockEvaluateWithPiAgenticTrace = jest.fn();
jest.mock('@/server/services/piAgenticJudgeService', () => ({
  evaluateWithPiAgenticTrace: (...args: any[]) => mockEvaluateWithPiAgenticTrace(...args),
}));
const mockGetEvaluatorById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ evaluators: { getById: mockGetEvaluatorById } }),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import judgeRoutes from '@/server/routes/judge';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { runEvaluationWithConnector } from '@/services/evaluation';
import { PARSE_FAILURE_MAX_ATTEMPTS } from '@/services/evaluation/bedrockJudge';
import { RESTConnector } from '@/services/connectors/rest/RESTConnector';
import { isJudgeFailedCase } from '@/services/evaluation/retryJudgement';
import { ENV_CONFIG } from '@/lib/config';
import type { AgentConfig, TestCase } from '@/types';
import type { ConnectorRegistry } from '@/services/connectors/types';

function buildTestCase(): TestCase {
  const now = new Date().toISOString();
  return {
    id: 'tc-agent-timeout', name: 'agent timeout case', description: '', labels: [], currentVersion: 1,
    versions: [{ version: 1, createdAt: now, initialPrompt: 'What is the answer?', context: [], expectedOutcomes: ['Answers'] }],
    isPromoted: false, createdAt: now, updatedAt: now,
    initialPrompt: 'What is the answer?', context: [], expectedOutcomes: ['Answers'],
  } as unknown as TestCase;
}

function restRegistry(): ConnectorRegistry {
  const connector = new RESTConnector();
  return { getForAgent: () => connector } as unknown as ConnectorRegistry;
}

describe('agent-error surfacing (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  describe('Scenario A — REST agent never answers within connectorConfig.timeoutMs', () => {
    let agentServer: http.Server;
    let agentUrl: string;
    let judgeServer: http.Server;
    let judgeHits = 0;
    const sockets = new Set<import('node:net').Socket>();

    beforeAll(async () => {
      // The "agent": reads the body and never responds (what a slow agent
      // looks like from agent-health's side until undici gives up).
      agentServer = http.createServer((req) => { req.on('data', () => {}); });
      agentServer.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
      agentUrl = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/ask`;
      // A judge endpoint that counts hits — it must stay at 0.
      judgeServer = http.createServer((_req, res) => { judgeHits++; res.end('{}'); });
      await new Promise<void>(r => judgeServer.listen(0, '127.0.0.1', r));
      (ENV_CONFIG as any).judgeApiUrl = `http://127.0.0.1:${(judgeServer.address() as AddressInfo).port}/api/judge`;
    });
    afterAll(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>(r => agentServer.close(() => r()));
      await new Promise<void>(r => judgeServer.close(() => r()));
      (ENV_CONFIG as any).judgeApiUrl = undefined;
    });

    it('persists an agent-stage failure with the real cause and never calls the judge', async () => {
      const agent = {
        key: 'example-rest-agent', name: 'A REST agent', endpoint: agentUrl, connectorType: 'rest', useTraces: false,
        connectorConfig: { timeoutMs: 600 },
      } as unknown as AgentConfig;

      const t0 = Date.now();
      const report = await runEvaluationWithConnector(agent, 'test-model', buildTestCase(), () => {}, {
        registry: restRegistry(), judgeModelId: 'agent-trace-judge',
      }) as any;
      const elapsed = Date.now() - t0;

      // Did not wait for undici's 300 s default.
      expect(elapsed).toBeLessThan(10_000);

      // Stage + shape.
      expect(report.failureStage).toBe('agent');
      expect(report.status).toBe('failed');
      expect(report.metricsStatus).toBe('error');
      expect(report.passFailStatus).toBeNull();
      expect(report.trajectory).toEqual([]);
      expect(report.skipJudge).toBe(true);

      // The REAL cause — timeout, endpoint, the timeout in force — not `fetch failed`.
      expect(report.error).toMatch(/timed out after \d+ms \(timeout 600ms\)/);
      expect(report.error).toMatch(/ask/);
      expect(report.error).not.toBe('fetch failed');
      expect(report.agentError).toEqual(expect.objectContaining({
        kind: 'timeout', endpoint: agentUrl, timeoutMs: 600,
      }));
      expect(report.agentError.elapsedMs).toBeGreaterThanOrEqual(500);
      expect(report.traceError).toMatch(/^Agent request failed \(kind=agent_failed\)/);
      expect(report.llmJudgeReasoning).toMatch(/Agent request failed — not judged/);
      expect(report.llmJudgeReasoning).not.toMatch(/Evaluator could not run/);

      // The judge was never invoked for an agent that produced nothing.
      expect(judgeHits).toBe(0);

      // Retry-judgement must not offer it.
      expect(isJudgeFailedCase(report, { reportId: 'r', status: 'completed' })).toBe(false);
    }, 20_000);

    it('a non-2xx agent reply is an agent-stage http_<status> failure (judge not called)', async () => {
      const srv = http.createServer((_req, res) => { res.statusCode = 503; res.end('Service Unavailable'); });
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/ask`;
      try {
        const hitsBefore = judgeHits;
        const agent = { key: 'a', name: 'A REST agent', endpoint: url, connectorType: 'rest', useTraces: false } as unknown as AgentConfig;
        const report = await runEvaluationWithConnector(agent, 'm', buildTestCase(), () => {}, { registry: restRegistry() }) as any;
        expect(report.failureStage).toBe('agent');
        expect(report.agentError.kind).toBe('http_503');
        expect(report.agentError.httpStatus).toBe(503);
        expect(report.error).toMatch(/REST request failed: 503 - Service Unavailable/);
        expect(judgeHits).toBe(hitsBefore);
      } finally {
        await new Promise<void>(r => srv.close(() => r()));
      }
    });
  });

  describe('Scenario B — judge model returns an empty reply', () => {
    let judgeHttp: http.Server;
    let routeHits = 0;

    beforeAll(async () => {
      const app = express();
      app.use(express.json({ limit: '10mb' }));
      app.use((_req, _res, next) => { routeHits++; next(); });
      app.use(judgeRoutes);
      judgeHttp = http.createServer(app);
      await new Promise<void>(r => judgeHttp.listen(0, '127.0.0.1', r));
      (ENV_CONFIG as any).judgeApiUrl = `http://127.0.0.1:${(judgeHttp.address() as AddressInfo).port}/api/judge`;
    });
    afterAll(async () => {
      await new Promise<void>(r => judgeHttp.close(() => r()));
      (ENV_CONFIG as any).judgeApiUrl = undefined;
    });

    beforeEach(() => {
      routeHits = 0;
      mockGetEvaluatorById.mockResolvedValue({ id: 'ev-agent', name: 'Trace judge', inferenceConfig: { provider: 'agent' } });
      // The model layer, running the REAL parser over an EMPTY final turn —
      // exactly what happened in the incident.
      mockEvaluateWithPiAgenticTrace.mockImplementation(async () => parseJudgeResponse('', { source: 'AgentJudge' }));
    });

    it(`route answers 422 JUDGE_UNPARSEABLE; client stops after ${PARSE_FAILURE_MAX_ATTEMPTS} attempts; report keeps raw text + attempts + provider-neutral message`, async () => {
      const connector = {
        type: 'rest', name: 'REST (mock)', supportsStreaming: false, buildPayload: () => ({}), parseResponse: () => [],
        execute: async () => ({
          trajectory: [{ id: 's1', type: 'response', content: 'The answer is 42.', timestamp: Date.now() }],
          runId: null, rawEvents: [{ response: 'The answer is 42.' }], metadata: {},
        }),
      };
      const registry = { getForAgent: () => connector } as unknown as ConnectorRegistry;
      const agent = { key: 'a', name: 'A REST agent', endpoint: 'http://agent.example/ask', connectorType: 'rest', useTraces: false } as unknown as AgentConfig;

      const report = await runEvaluationWithConnector(agent, 'm', buildTestCase(), () => {}, {
        registry, judgeModelId: 'agent-trace-judge', evaluatorId: 'ev-agent',
      }) as any;

      // Route was hit exactly PARSE_FAILURE_MAX_ATTEMPTS times (not 10).
      expect(routeHits).toBe(PARSE_FAILURE_MAX_ATTEMPTS);
      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledTimes(PARSE_FAILURE_MAX_ATTEMPTS);

      // The agent completed → judge-stage failure, salvageable by retry-judgement.
      expect(report.status).toBe('completed');
      expect(report.failureStage).toBe('judge');
      expect(report.metricsStatus).toBe('error');
      expect(report.trajectory.length).toBe(1);
      expect(isJudgeFailedCase(report, { reportId: 'r', status: 'completed' })).toBe(true);

      // Raw text retained + attempt count, and honest wording.
      expect(report.judgeError).toEqual(expect.objectContaining({ rawResponse: '', attempts: PARSE_FAILURE_MAX_ATTEMPTS }));
      expect(report.error).toMatch(/no parseable verdict/);
      expect(report.error).toMatch(/model returned an empty response/);
      expect(report.error).not.toMatch(/Pi judge response/);
      expect(report.error).not.toMatch(/CLI may have returned invalid JSON/);
      expect(report.traceError).toMatch(/kind=judge_failed/);
    }, 30_000);
  });
});
