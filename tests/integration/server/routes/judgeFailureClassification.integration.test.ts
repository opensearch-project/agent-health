/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: POST /api/judge failure classification, over real HTTP
 * (supertest against the real judge router).
 *
 * Provider 'pi' runs the REAL piJudgeService.spawnPi against a stubbed `pi`
 * CLI (tests/helpers/stubPiCli.cjs; only `resolvePiCommand` is mocked to
 * point at it) so the route's error body is produced by the real
 * spawn → classify → respond chain:
 *   (i)   CLI prints nothing, exits 0      → 500 empty_response, retryable:false
 *   (ii)  CLI exits non-zero with stderr   → 500 cli_crash, retryable:true, redacted stderrTail
 *   (iii) CLI prints prose then JSON       → 200 verdict
 *   (iv)  prompt exceeds the size cap      → truncated (marker reaches the CLI), 200 verdict;
 *         an un-fittable prompt            → 500 context_overflow WITHOUT spawning
 *
 * Provider 'agent' is mocked at its module boundary (it needs the pi SDK +
 * Bedrock credentials) to throw the classified JudgeError the real service
 * now produces for a Bedrock "Input is too long" overflow — asserting the
 * route turns it into errorClass/retryable, the contract the client
 * retry loop (services/evaluation/bedrockJudge.ts) relies on.
 *
 * Run:
 *   AH_PORT=<port> npm run test:integration -- --testPathPatterns=judgeFailureClassification
 */

import express from 'express';
import path from 'node:path';
import request from 'supertest';

const STUB = path.join(process.cwd(), 'tests', 'helpers', 'stubPiCli.cjs');

jest.mock('@/server/services/piBinary', () => ({
  resolvePiCommand: () => ({ command: process.execPath, prefixArgs: [STUB], bundled: true }),
}));

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
import { JudgeError } from '@/server/services/judgeErrors';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(judgeRoutes);
  return app;
}

const piEvaluator = { id: 'pi-eval', name: 'Pi CLI judge', inferenceConfig: { provider: 'pi' } };
const agentEvaluator = { id: 'agent-eval', name: 'Agent trace judge', inferenceConfig: { provider: 'agent' } };

const rankedList =
  'Ranked results (20, results_source=return_results):\n' +
  Array.from({ length: 20 }, (_, i) => `${i + 1}. id ${5000 + i} — Product ${i} (score ${(20 - i).toFixed(2)})`).join('\n');

const trajectory = [
  { type: 'user', content: 'search products for a red trail bike' },
  { type: 'action', toolName: 'search', toolArgs: { q: 'red trail bike' } },
  { type: 'tool_result', toolName: 'search', content: '{"hits": 20}', status: 'SUCCESS' },
  { type: 'response', content: rankedList },
];

describe('POST /api/judge — failure classification (integration)', () => {
  const savedMode = process.env.STUB_PI_MODE;
  const savedBudget = process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedMode === undefined) delete process.env.STUB_PI_MODE;
    else process.env.STUB_PI_MODE = savedMode;
    if (savedBudget === undefined) delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
    else process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = savedBudget;
  });

  describe("provider 'pi' — real spawn against the stubbed CLI", () => {
    beforeEach(() => mockGetEvaluatorById.mockResolvedValue(piEvaluator));

    it('(i) CLI prints nothing and exits 0 → 500 empty_response, not retryable, no "invalid JSON" wording', async () => {
      process.env.STUB_PI_MODE = 'empty';
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['ranks 5000 first'], evaluatorId: 'pi-eval' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'empty_response', retryable: false });
      expect(res.body.error).toMatch(/printed nothing to stdout/);
      expect(res.body.error).not.toMatch(/may have returned invalid JSON/);
    });

    it('(ii) CLI exits non-zero with stderr → 500 cli_crash, retryable, redacted stderr tail in the body', async () => {
      process.env.STUB_PI_MODE = 'crash';
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'pi-eval' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'cli_crash', retryable: true });
      expect(res.body.stderrTail).toContain('something exploded');
      expect(res.body.stderrTail).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(res.body.stderrTail).not.toContain('s3cr3t/value+here');
      expect(res.body.error).toContain('exited with code 2');
    });

    it("(ii') CLI exits non-zero with a provider overflow on stderr → 500 context_overflow", async () => {
      process.env.STUB_PI_MODE = 'overflow';
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'pi-eval' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'context_overflow', retryable: false });
      expect(res.body.error).toContain('Input is too long');
    });

    it('(iii) CLI prints a prose preamble then a fenced JSON verdict → 200 with the parsed verdict', async () => {
      process.env.STUB_PI_MODE = 'preamble';
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'pi-eval' });
      expect(res.status).toBe(200);
      expect(res.body.passFailStatus).toBe('passed');
      expect(res.body.metrics.accuracy).toBe(88);
      expect(res.body.errorClass).toBeUndefined();
    });

    it('(iv) REGRESSION: an oversized trajectory with a long ranked-list response is truncated to the budget and judges → 200', async () => {
      process.env.STUB_PI_MODE = 'echo';
      process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '30000'; // 75k chars
      const big = JSON.stringify({ hits: Array.from({ length: 1500 }, (_, i) => ({ id: i, title: `item ${i}`, body: 'z'.repeat(100) })) });
      const bigTrajectory = [
        trajectory[0],
        trajectory[1],
        { type: 'tool_result', toolName: 'search', content: '[see toolOutput]', toolOutput: big, status: 'SUCCESS' },
        { type: 'tool_result', toolName: 'search', content: '[see toolOutput]', toolOutput: big.slice(0, 60_000), status: 'SUCCESS' },
        trajectory[3],
      ];
      const res = await request(buildApp()).post('/api/judge').send({ trajectory: bigTrajectory, expectedOutcomes: ['ranks 5000 first'], evaluatorId: 'pi-eval' });
      expect(res.status).toBe(200);
      expect(res.body.passFailStatus).toBe('passed');
      const m = /promptChars=(\d+) marker=(true|false)/.exec(res.body.llmJudgeReasoning);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeLessThanOrEqual(75_000);
      expect(m![2]).toBe('true'); // the CLI saw the truncation marker
    });

    it("(iv') a trajectory that cannot fit the budget → 500 context_overflow, and the CLI is never spawned", async () => {
      process.env.STUB_PI_MODE = 'echo';
      process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '800'; // 2k chars
      const many = Array.from({ length: 25 }, () => ({ type: 'tool_result', toolName: 't', content: 'c'.repeat(600), status: 'SUCCESS' }));
      const res = await request(buildApp()).post('/api/judge').send({ trajectory: many, expectedOutcomes: ['x'], evaluatorId: 'pi-eval' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'context_overflow', retryable: false });
      expect(res.body.error).toMatch(/even after truncating/);
      // The 'echo' stub would have produced a 200 verdict had it been spawned.
    });
  });

  describe("provider 'agent' — classified JudgeError → wire contract", () => {
    beforeEach(() => mockGetEvaluatorById.mockResolvedValue(agentEvaluator));

    it('a Bedrock context overflow surfaces as context_overflow with the provider message, not "invalid JSON"', async () => {
      mockEvaluateWithPiAgenticTrace.mockRejectedValue(
        new JudgeError(
          "Judge context overflow — the evaluation prompt (plus any trace-tool results) exceeds the judge model's context window: Validation error: The model returned the following errors: Input is too long for requested model.",
          { errorClass: 'context_overflow' },
        ),
      );
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'agent-eval', runId: 'run-1' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'context_overflow', retryable: false });
      expect(res.body.error).toContain('Input is too long for requested model');
      expect(res.body.error).not.toMatch(/invalid JSON/);
    });

    it('a throttling failure surfaces as 500 throttling, retryable', async () => {
      mockEvaluateWithPiAgenticTrace.mockRejectedValue(
        new JudgeError('Judge model call failed: ThrottlingException: Too many requests', { errorClass: 'throttling' }),
      );
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'agent-eval', runId: 'run-1' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'throttling', retryable: true });
    });

    it('a genuinely unparseable verdict is the one case still reported as invalid JSON (invalid_json)', async () => {
      mockEvaluateWithPiAgenticTrace.mockRejectedValue(
        new JudgeError('AgentJudge: judge response did not contain a JSON object. First 200 chars: I think it passed', { errorClass: 'invalid_json' }),
      );
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'agent-eval', runId: 'run-1' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'invalid_json', retryable: false });
      expect(res.body.error).toMatch(/Failed to parse Pi judge response — the judge answered but not with a JSON verdict/);
    });

    it('an unclassified plain Error is classified from its message (back-compat: 500 + unknown/retryable when nothing matches)', async () => {
      mockEvaluateWithPiAgenticTrace.mockRejectedValue(new Error('weird one-off failure'));
      const res = await request(buildApp()).post('/api/judge').send({ trajectory, expectedOutcomes: ['x'], evaluatorId: 'agent-eval', runId: 'run-1' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ errorClass: 'unknown', retryable: true });
    });
  });
});
