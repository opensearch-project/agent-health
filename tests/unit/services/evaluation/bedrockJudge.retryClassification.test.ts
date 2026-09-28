/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * callBedrockJudge — retry classification.
 *
 * Before: every non-4xx failure from /api/judge was retried 10× with
 * exponential backoff (1s…256s ≈ 8.5 min) regardless of cause. A judge
 * context overflow or an expired credential is deterministic — the identical
 * request fails identically — so a dead case burned ~9 minutes per attempt
 * series and then reported "invalid JSON". Now the route stamps
 * `errorClass` + `retryable` on its error body and the loop honours them.
 */

import { callBedrockJudge } from '@/services/evaluation/bedrockJudge';
import type { TrajectoryStep } from '@/types';

const mockFetch = jest.fn();
global.fetch = mockFetch;

const trajectory: TrajectoryStep[] = [
  { id: '1', timestamp: 1, type: 'response', content: 'Ranked results (1):\n1. id 7 — item' } as TrajectoryStep,
];
const expected = { expectedOutcomes: ['ranks item 7 first'] };

const okBody = {
  passFailStatus: 'passed',
  metrics: { accuracy: 90 },
  llmJudgeReasoning: 'fine',
  improvementStrategies: [],
};

function failure(status: number, body: Record<string, unknown>) {
  return { ok: false, status, json: () => Promise.resolve(body) };
}

describe('callBedrockJudge — retry classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('stops after ONE attempt on a server-classified deterministic failure (context_overflow), naming the class', async () => {
    mockFetch.mockResolvedValue(
      failure(500, {
        error: 'Judge evaluation failed: Judge context overflow — Input is too long for requested model.',
        details: 'Input is too long for requested model.',
        errorClass: 'context_overflow',
        retryable: false,
      }),
    );
    await expect(callBedrockJudge(trajectory, expected)).rejects.toThrow(
      /^Judge failed \(context_overflow, not retryable\): Judge evaluation failed: Judge context overflow/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('appends the redacted stderr tail when the route provides one', async () => {
    mockFetch.mockResolvedValue(
      failure(500, { error: 'Judge evaluation failed: Pi CLI exited 0 but printed nothing to stdout', errorClass: 'empty_response', retryable: false, stderrTail: 'warn: no model configured' }),
    );
    // empty_response gets a budget of 2: one re-roll, then stop.
    await expect(callBedrockJudge(trajectory, expected)).rejects.toThrow(/\[stderr: warn: no model configured\]$/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('gives invalid_json exactly one re-roll (2 attempts) — LLM output is stochastic, but not 10× worth', async () => {
    mockFetch.mockResolvedValue(
      failure(500, { error: 'Judge evaluation failed: judge response did not contain a JSON object', errorClass: 'invalid_json', retryable: false }),
    );
    await expect(callBedrockJudge(trajectory, expected)).rejects.toThrow(/\(invalid_json, not retryable\)/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('a re-roll that succeeds returns normally with judgeAttempts=2', async () => {
    mockFetch
      .mockResolvedValueOnce(failure(500, { error: 'no JSON', errorClass: 'invalid_json', retryable: false }))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(okBody) });
    const res = await callBedrockJudge(trajectory, expected);
    expect(res.passFailStatus).toBe('passed');
    expect(res.judgeAttempts).toBe(2);
  }, 10_000);

  it('keeps retrying a server-classified TRANSIENT failure (throttling, HTTP 500) and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(failure(500, { error: 'ThrottlingException', errorClass: 'throttling', retryable: true }))
      .mockResolvedValueOnce(failure(500, { error: 'ThrottlingException', errorClass: 'throttling', retryable: true }))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(okBody) });
    const res = await callBedrockJudge(trajectory, expected);
    expect(res.judgeAttempts).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('a 4xx WITH retryable:true from a newer server is still retried (class beats status code)', async () => {
    mockFetch
      .mockResolvedValueOnce(failure(429, { error: 'rate limited', errorClass: 'throttling', retryable: true }))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(okBody) });
    const res = await callBedrockJudge(trajectory, expected);
    expect(res.judgeAttempts).toBe(2);
  }, 10_000);

  it('back-compat: an unclassified 4xx is still a non-retryable validation error; an unclassified 500 is retried', async () => {
    mockFetch.mockResolvedValueOnce(failure(400, { error: 'Trajectory is required' }));
    await expect(callBedrockJudge(trajectory, expected)).rejects.toThrow(/validation error \(not retryable\)/);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(failure(500, { error: 'boom' }))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(okBody) });
    const res = await callBedrockJudge(trajectory, expected);
    expect(res.judgeAttempts).toBe(2);
  }, 10_000);

  it('bounds an `unknown` server-classified failure at 3 attempts instead of 10', async () => {
    mockFetch.mockResolvedValue(failure(500, { error: 'weird', errorClass: 'unknown', retryable: true }));
    await expect(callBedrockJudge(trajectory, expected)).rejects.toThrow(/failed after 3 attempts \(unknown\)/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('tolerates a non-JSON error body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.reject(new Error('not json')) });
    await expect(callBedrockJudge(trajectory, expected)).rejects.toThrow(/API request failed with status 400/);
  });
});
