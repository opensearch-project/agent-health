/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ---- All jest.mock calls must be before imports (Jest hoists them) ----

// Mock bedrockService helpers reused by litellmJudgeService
jest.mock('@/server/services/bedrockService', () => ({
  buildEvaluationPrompt: jest.fn().mockReturnValue('mock evaluation prompt'),
}));

// Mock judgePrompt
jest.mock('@/server/prompts/judgePrompt', () => ({
  JUDGE_SYSTEM_PROMPT: 'You are an expert evaluator.',
}));

// Mock debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

// Server config mock — uses a global flag so individual tests can
// temporarily clear LITELLM_API_KEY without module re-loading.
jest.mock('@/server/config', () => {
  // Return a proxy-like object that reads from the outer mutable variable.
  // jest.mock is hoisted, but since we use a factory function the outer
  // variable will be in scope at runtime (not at hoist time).
  const obj = {
    get LITELLM_API_KEY() { return (global as any).__mockLiteLLMApiKey ?? 'sk-test-key'; },
    get LITELLM_ENDPOINT() { return 'http://localhost:4000/v1/chat/completions'; },
  };
  return { __esModule: true, default: obj };
});

import { evaluateWithLiteLLM, parseLiteLLMError } from '@/server/services/litellmJudgeService';
import { TrajectoryStep } from '@/types';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const mockJudgeResult = {
  pass_fail_status: 'passed',
  accuracy: 85,
  reasoning: 'The agent correctly identified the root cause.',
  improvement_strategies: [],
};

function makeFetchSuccess(body: object) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(body) } }],
    }),
    text: jest.fn().mockResolvedValue(''),
  };
}

function makeFetchError(status: number, text: string) {
  return {
    ok: false,
    status,
    json: jest.fn().mockResolvedValue({}),
    text: jest.fn().mockResolvedValue(text),
  };
}

const baseRequest = {
  trajectory: [{ type: 'response' as const, content: 'Root cause: memory leak' } as TrajectoryStep],
  expectedOutcomes: ['Agent identifies root cause'],
};

describe('evaluateWithLiteLLM', () => {
  beforeEach(() => {
    (global as any).__mockLiteLLMApiKey = 'sk-test-key';
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).__mockLiteLLMApiKey;
  });

  it('sends POST to litellmEndpoint with correct model, messages, temperature, and max_tokens', async () => {
    mockFetch.mockResolvedValue(makeFetchSuccess(mockJudgeResult));

    await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.model).toBe('gpt-4o');
    expect(callBody.messages).toHaveLength(2);
    expect(callBody.messages[0].role).toBe('system');
    expect(callBody.messages[0].content).toBe('You are an expert evaluator.');
    expect(callBody.messages[1].role).toBe('user');
    expect(callBody.messages[1].content).toBe('mock evaluation prompt');
    expect(callBody.temperature).toBe(0.1);
    expect(callBody.max_tokens).toBe(4096);
  });

  it('sets Authorization: Bearer header when litellmApiKey is set', async () => {
    mockFetch.mockResolvedValue(makeFetchSuccess(mockJudgeResult));

    await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['Authorization']).toBe('Bearer sk-test-key');
    expect(callHeaders['Content-Type']).toBe('application/json');
  });

  it('omits Authorization header when litellmApiKey is empty', async () => {
    (global as any).__mockLiteLLMApiKey = '';
    mockFetch.mockResolvedValue(makeFetchSuccess(mockJudgeResult));

    await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['Authorization']).toBeUndefined();
  });

  it('parses clean JSON response and returns correct JudgeResponse shape', async () => {
    mockFetch.mockResolvedValue(makeFetchSuccess(mockJudgeResult));

    const result = await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    expect(result.passFailStatus).toBe('passed');
    expect(result.metrics.accuracy).toBe(85);
    expect(result.llmJudgeReasoning).toBe('The agent correctly identified the root cause.');
    expect(result.improvementStrategies).toEqual([]);
    expect(typeof result.duration).toBe('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('parses JSON wrapped in markdown code block', async () => {
    const wrappedContent = '```json\n' + JSON.stringify(mockJudgeResult) + '\n```';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: wrappedContent } }],
      }),
      text: jest.fn().mockResolvedValue(''),
    });

    const result = await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    expect(result.passFailStatus).toBe('passed');
    expect(result.metrics.accuracy).toBe(85);
  });

  it('parses bare JSON without markdown wrapper', async () => {
    const bareContent = 'Here is my evaluation:\n' + JSON.stringify(mockJudgeResult);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: bareContent } }],
      }),
      text: jest.fn().mockResolvedValue(''),
    });

    const result = await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    expect(result.passFailStatus).toBe('passed');
    expect(result.metrics.accuracy).toBe(85);
  });

  it('throws when HTTP response is not ok (401)', async () => {
    mockFetch.mockResolvedValue(makeFetchError(401, 'Unauthorized'));

    await expect(evaluateWithLiteLLM(baseRequest, 'gpt-4o')).rejects.toThrow(
      'LiteLLM responded 401: Unauthorized'
    );
  });

  it('throws when HTTP response is not ok (500)', async () => {
    mockFetch.mockResolvedValue(makeFetchError(500, 'Internal Server Error'));

    await expect(evaluateWithLiteLLM(baseRequest, 'gpt-4o')).rejects.toThrow(
      'LiteLLM responded 500: Internal Server Error'
    );
  });

  it('handles improvement_strategies in response', async () => {
    const resultWithStrategies = {
      ...mockJudgeResult,
      improvement_strategies: [
        { category: 'Tool Usage', issue: 'Missing tool call', recommendation: 'Use search tool', priority: 'high' },
      ],
    };
    mockFetch.mockResolvedValue(makeFetchSuccess(resultWithStrategies));

    const result = await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    expect(result.improvementStrategies).toHaveLength(1);
    expect(result.improvementStrategies[0].category).toBe('Tool Usage');
  });

  it('handles legacy metrics format (accuracy inside metrics object)', async () => {
    const legacyResult = {
      pass_fail_status: 'failed',
      metrics: { accuracy: 42, faithfulness: 55 },
      reasoning: 'Incomplete analysis.',
      improvement_strategies: [],
    };
    mockFetch.mockResolvedValue(makeFetchSuccess(legacyResult));

    const result = await evaluateWithLiteLLM(baseRequest, 'gpt-4o');

    expect(result.passFailStatus).toBe('failed');
    expect(result.metrics.accuracy).toBe(42);
    expect(result.metrics.faithfulness).toBe(55);
  });
});

describe('parseLiteLLMError', () => {
  it('maps 401 error to credential message', () => {
    const msg = parseLiteLLMError(new Error('LiteLLM responded 401: Unauthorized'));
    expect(msg).toContain('LITELLM_API_KEY');
  });

  it('maps "unauthorized" keyword to credential message', () => {
    const msg = parseLiteLLMError(new Error('unauthorized access'));
    expect(msg).toContain('LITELLM_API_KEY');
  });

  it('maps "authentication" keyword to credential message', () => {
    const msg = parseLiteLLMError(new Error('Authentication failed'));
    expect(msg).toContain('LITELLM_API_KEY');
  });

  it('maps 429 error to rate limit message', () => {
    const msg = parseLiteLLMError(new Error('LiteLLM responded 429: Too Many Requests'));
    expect(msg).toContain('rate limit');
  });

  it('maps "rate limit" keyword to rate limit message', () => {
    const msg = parseLiteLLMError(new Error('Rate limit exceeded'));
    expect(msg).toContain('rate limit');
  });

  it('maps JSON parse failure to parse error message', () => {
    const msg = parseLiteLLMError(new Error('Failed to parse JSON response'));
    expect(msg).toContain('parse');
  });

  it('maps ECONNREFUSED to connection error message', () => {
    const msg = parseLiteLLMError(new Error('connect ECONNREFUSED 127.0.0.1:4000'));
    expect(msg).toContain('connect');
  });

  it('maps ENOTFOUND to connection error message', () => {
    const msg = parseLiteLLMError(new Error('getaddrinfo ENOTFOUND api.openai.com'));
    expect(msg).toContain('connect');
  });

  it('returns raw message for unknown errors', () => {
    const msg = parseLiteLLMError(new Error('Something completely unexpected'));
    expect(msg).toBe('Something completely unexpected');
  });
});
