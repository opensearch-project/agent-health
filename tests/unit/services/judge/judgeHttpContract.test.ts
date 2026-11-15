/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `runJudgeAsHttp` / `createInProcessJudgeTransport` (#612): the in-process
 * judge presents EXACTLY the `/api/judge` HTTP contract `callBedrockJudge`
 * keys its retry policy on — 2xx verdict, 400 request refusals, 422
 * unparseable, 400 provider rejection, 500 transient — so a CLI-executed run
 * retries (or does not) exactly like a server-executed one.
 */

import { runJudgeAsHttp, createInProcessJudgeTransport } from '@/services/judge/judgeHttpContract';
import { JudgeParseError } from '@/server/services/judgeResponseParser';
import type { RunJudgeDeps } from '@/services/judge/runJudge';

jest.mock('@/server/services/bedrockService', () => ({
  ...jest.requireActual('@/server/services/bedrockService'),
  evaluateTrajectory: jest.fn(),
}));
import { evaluateTrajectory } from '@/server/services/bedrockService';
const mockEvaluateTrajectory = evaluateTrajectory as jest.MockedFunction<typeof evaluateTrajectory>;

const deps = (models: Record<string, any>): RunJudgeDeps => ({ getEvaluator: async () => null, config: { models } });
const DEMO = { 'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo', provider: 'demo', context_window: 1, max_output_tokens: 1 } };
const BEDROCK = { judge: { model_id: 'us.anthropic.claude-x', display_name: 'J', provider: 'bedrock', context_window: 1, max_output_tokens: 1 } };
const trajectory = [{ id: 's1', type: 'response', content: 'The answer is 42.', timestamp: 'now' }];

describe('runJudgeAsHttp', () => {
  afterEach(() => { mockEvaluateTrajectory.mockReset(); jest.restoreAllMocks(); });

  it('200 with the verdict for a provider that runs (demo)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await runJudgeAsHttp({ trajectory, expectedOutcomes: ['answers 42'], modelId: 'demo-model' }, deps(DEMO));
    expect(out.status).toBe(200);
    expect(out.error).toBeUndefined();
    expect(out.body).toMatchObject({ passFailStatus: expect.stringMatching(/^(passed|failed)$/), metrics: expect.any(Object) });
  });

  it('400 for a request the judge refuses (no trajectory), typed so the route need not log it', async () => {
    const out = await runJudgeAsHttp({ trajectory: [], expectedOutcomes: ['x'] }, deps(DEMO));
    expect(out).toMatchObject({ status: 400, body: { error: 'Trajectory is required and must be a non-empty array' } });
    expect((out.error as Error).name).toBe('JudgeRequestError');
  });

  it('422 JUDGE_UNPARSEABLE with the raw text when the model replied without a verdict', async () => {
    mockEvaluateTrajectory.mockRejectedValue(new JudgeParseError('no JSON in reply', 'I refuse to answer'));
    const out = await runJudgeAsHttp({ trajectory, expectedOutcomes: ['x'], modelId: 'judge' }, deps(BEDROCK));
    expect(out).toMatchObject({ status: 422, body: { code: 'JUDGE_UNPARSEABLE', rawResponse: 'I refuse to answer', error: 'Judge evaluation failed: no JSON in reply' } });
  });

  it('400 JUDGE_REQUEST_REJECTED when the provider rejected the request (AWS ValidationException)', async () => {
    mockEvaluateTrajectory.mockRejectedValue(Object.assign(new Error('blank system prompt'), { name: 'ValidationException' }));
    const out = await runJudgeAsHttp({ trajectory, expectedOutcomes: ['x'], modelId: 'judge' }, deps(BEDROCK));
    expect(out).toMatchObject({ status: 400, body: { code: 'JUDGE_REQUEST_REJECTED', details: 'blank system prompt' } });
    expect(out.body).toMatchObject({ error: expect.stringContaining('(ValidationException): blank system prompt') });
  });

  it('500 with the provider-specific description for anything else (credentials missing → retryable like the route)', async () => {
    mockEvaluateTrajectory.mockRejectedValue(Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }));
    const out = await runJudgeAsHttp({ trajectory, expectedOutcomes: ['x'], modelId: 'judge' }, deps(BEDROCK));
    expect(out).toMatchObject({ status: 500, body: { error: 'Judge evaluation failed: Could not load credentials from any providers', details: 'Could not load credentials from any providers' } });
  });
});

describe('createInProcessJudgeTransport', () => {
  afterEach(() => { mockEvaluateTrajectory.mockReset(); });

  it('returns a Response-like object (ok / status / json / text) with the same body the route would send', async () => {
    mockEvaluateTrajectory.mockRejectedValue(new Error('ThrottlingException: slow down'));
    const log = jest.fn();
    const transport = createInProcessJudgeTransport(deps(BEDROCK), log);
    const res = await transport({ trajectory, expectedOutcomes: ['x'], modelId: 'judge' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Judge evaluation failed: Bedrock API rate limit exceeded. Please try again in a moment.' });
    expect(JSON.parse(await res.text())).toMatchObject({ details: 'ThrottlingException: slow down' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ThrottlingException: slow down'));
  });

  it('a 200 verdict is ok:true and parses twice (json() and text() are independent)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = createInProcessJudgeTransport(deps(DEMO), () => {});
    const res = await transport({ trajectory, expectedOutcomes: ['answers'], modelId: 'demo-model' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const a = await res.json();
    const b = JSON.parse(await res.text());
    expect(a).toEqual(b);
    expect(a.passFailStatus).toMatch(/^(passed|failed)$/);
  });
});
