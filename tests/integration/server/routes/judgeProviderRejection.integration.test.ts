/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the judge fails FAST when the model provider rejects the
 * request, and a deterministic evaluator never reaches the provider at all.
 *
 * Exercises the REAL stack end to end — `callBedrockJudge` (client retry
 * loop) → the REAL `/api/judge` express route → the REAL
 * `@aws-sdk/client-bedrock-runtime` `BedrockRuntimeClient` (HTTP/2) → an
 * in-process plaintext-HTTP/2 stand-in for the Bedrock Runtime endpoint
 * (`AWS_ENDPOINT_URL_BEDROCK_RUNTIME`). Nothing in the SDK is mocked: the
 * stand-in answers the way Bedrock answers a blank `system` block (HTTP 400,
 * `x-amzn-ErrorType: ValidationException`), so the error the route sees is
 * the SDK's own modelled `ValidationException` (`$fault: 'client'`,
 * `$metadata.httpStatusCode: 400`).
 *
 * Owner incident (0.9.0 release prep): a new run with a deterministic
 * evaluator produced exactly this — `system: [{ text: '' }]` → 400 → the
 * client's 10-attempt exponential back-off ≈ 8.5 min per case.
 *
 *   A. LLM evaluator, provider answers 400 ValidationException:
 *        → the route answers 400 `JUDGE_REQUEST_REJECTED` with the provider's
 *          message, the client makes ONE attempt (not 10) and the error says
 *          "not retryable". Pre-fix: 10 Bedrock requests, ~8.5 min.
 *   B. Deterministic evaluator:
 *        → the route answers 400 `DETERMINISTIC_EVALUATOR`; the provider is
 *          never contacted; one client attempt. Pre-fix: 10 blank-prompt
 *          Bedrock requests.
 *   C. Control — provider answers a normal verdict: the same stack returns a
 *          parsed judgement (proves the stand-in is wired, not just failing).
 *
 * Boots its own express app on an ephemeral port — does NOT need AH_PORT.
 */

import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import express from 'express';
import http from 'node:http';

const mockGetEvaluatorById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ evaluators: { getById: mockGetEvaluatorById } }),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

interface BedrockHit { systemText: string | undefined; userText: string | undefined }

const LLM_EVALUATOR = {
  id: 'eval-llm-fixture', name: 'LLM fixture', systemPrompt: 'You are a strict judge. Reply with JSON.',
  scoringConfig: { metrics: [{ name: 'accuracy', weight: 1 }], passThreshold: 0.7 },
};
const DETERMINISTIC_EVALUATOR = {
  id: 'eval-det-fixture', name: 'Ranked retrieval fixture', kind: 'deterministic', systemPrompt: '',
  metrics: [{ name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true }],
  passPolicy: { kind: 'threshold', min: 1 },
  inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' }, prediction: { source: 'tool-hits-ordered' } },
};

const TRAJECTORY = [
  { id: 's1', type: 'action', toolName: 'search', toolArgs: { q: 'x' }, timestamp: 1 },
  { id: 's2', type: 'tool_result', toolName: 'search', content: '{"hits":[{"id":"doc-1"}]}', status: 'SUCCESS', timestamp: 2 },
  { id: 's3', type: 'response', content: 'doc-1 is the answer', timestamp: 3 },
];

describe('judge request rejection + deterministic evaluators — real SDK, real route, real client (integration)', () => {
  let bedrock: http2.Http2Server;
  let judgeApp: http.Server;
  const hits: BedrockHit[] = [];
  let mode: 'reject' | 'verdict' = 'reject';
  let callBedrockJudge: typeof import('@/services/evaluation/bedrockJudge').callBedrockJudge;

  beforeAll(async () => {
    // Plaintext HTTP/2 (the Bedrock Runtime client speaks h2 with prior knowledge).
    bedrock = http2.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        let body: any = {};
        try { body = JSON.parse(raw); } catch { /* keep {} */ }
        hits.push({ systemText: body?.system?.[0]?.text, userText: body?.messages?.[0]?.content?.[0]?.text });
        res.setHeader('content-type', 'application/json');
        if (mode === 'reject') {
          res.statusCode = 400;
          res.setHeader('x-amzn-errortype', 'ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/');
          res.end(JSON.stringify({ message: 'The text field in the SystemContentBlock object at system.0 is blank. Add text to the text field, and try again.' }));
          return;
        }
        const verdict = JSON.stringify({ pass_fail_status: 'passed', accuracy: 95, reasoning: 'stand-in verdict', improvement_strategies: [] });
        res.end(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: verdict }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }));
      });
    });
    await new Promise<void>(r => bedrock.listen(0, '127.0.0.1', r));
    const bedrockPort = (bedrock.address() as AddressInfo).port;

    // The SDK reads these when the client is constructed (module load) —
    // set them BEFORE importing anything that pulls in bedrockService.
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = `http://127.0.0.1:${bedrockPort}`;
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIAINTEGRATIONFAKE0';
    process.env.AWS_SECRET_ACCESS_KEY = 'integration-fake-secret-key-not-real-0000000';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;

    const { default: judgeRoutes } = await import('@/server/routes/judge');
    ({ callBedrockJudge } = await import('@/services/evaluation/bedrockJudge'));
    const { ENV_CONFIG } = await import('@/lib/config');

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(judgeRoutes);
    judgeApp = http.createServer(app);
    await new Promise<void>(r => judgeApp.listen(0, '127.0.0.1', r));
    (ENV_CONFIG as any).judgeApiUrl = `http://127.0.0.1:${(judgeApp.address() as AddressInfo).port}/api/judge`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>(r => judgeApp.close(() => r()));
    await new Promise<void>(r => bedrock.close(() => r()));
    delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
  });

  beforeEach(() => {
    hits.length = 0;
    mockGetEvaluatorById.mockReset();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('A. provider ValidationException → one attempt, 400 JUDGE_REQUEST_REJECTED, provider message kept', async () => {
    mode = 'reject';
    mockGetEvaluatorById.mockResolvedValue(LLM_EVALUATOR);
    const t0 = Date.now();
    await expect(
      callBedrockJudge(TRAJECTORY as any, { expectedOutcomes: ['finds doc-1'] }, undefined, undefined, 'anthropic.claude-fixture-v1', LLM_EVALUATOR.id)
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringMatching(/not retryable.*ValidationException.*SystemContentBlock/s),
    });
    // ONE request reached the provider — the real SDK saw a real 400 and the
    // route turned it into a client-side fail-fast. Pre-fix: 10 requests over
    // 1+2+4+…+256 s.
    expect(hits).toHaveLength(1);
    expect(hits[0].systemText).toBe(LLM_EVALUATOR.systemPrompt);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 20_000);

  it('B. deterministic evaluator → 400 DETERMINISTIC_EVALUATOR, provider never contacted, one attempt', async () => {
    mode = 'reject';
    mockGetEvaluatorById.mockResolvedValue(DETERMINISTIC_EVALUATOR);
    const t0 = Date.now();
    await expect(
      callBedrockJudge(TRAJECTORY as any, { expectedOutcomes: ['Gold id(s): doc-1'] }, undefined, undefined, 'anthropic.claude-fixture-v1', DETERMINISTIC_EVALUATOR.id)
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringMatching(/not retryable.*"Ranked retrieval fixture" is deterministic.*scored in code/s),
    });
    expect(hits).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 20_000);

  it('C. control: the same stack returns a parsed verdict when the provider answers normally', async () => {
    mode = 'verdict';
    mockGetEvaluatorById.mockResolvedValue(LLM_EVALUATOR);
    const judgment = await callBedrockJudge(TRAJECTORY as any, { expectedOutcomes: ['finds doc-1'] }, undefined, undefined, 'anthropic.claude-fixture-v1', LLM_EVALUATOR.id);
    expect(judgment.passFailStatus).toBe('passed');
    expect(judgment.judgeAttempts).toBe(1);
    expect(judgment.judgeProvider).toBe('bedrock');
    expect(hits).toHaveLength(1);
    expect(hits[0].userText).toContain('doc-1 is the answer');
  }, 20_000);
});
