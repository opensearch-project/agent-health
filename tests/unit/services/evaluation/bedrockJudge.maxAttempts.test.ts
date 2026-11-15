/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** `AH_JUDGE_MAX_ATTEMPTS` — the transient-error retry budget of `callBedrockJudge`. */

import { resolveJudgeMaxAttempts, DEFAULT_JUDGE_MAX_ATTEMPTS, callBedrockJudge } from '@/services/evaluation/bedrockJudge';

describe('resolveJudgeMaxAttempts', () => {
  it('defaults to 10 and accepts any integer ≥ 1; garbage falls back to the default', () => {
    expect(DEFAULT_JUDGE_MAX_ATTEMPTS).toBe(10);
    expect(resolveJudgeMaxAttempts({})).toBe(10);
    expect(resolveJudgeMaxAttempts({ AH_JUDGE_MAX_ATTEMPTS: '1' })).toBe(1);
    expect(resolveJudgeMaxAttempts({ AH_JUDGE_MAX_ATTEMPTS: '3' })).toBe(3);
    expect(resolveJudgeMaxAttempts({ AH_JUDGE_MAX_ATTEMPTS: '0' })).toBe(10);
    expect(resolveJudgeMaxAttempts({ AH_JUDGE_MAX_ATTEMPTS: 'many' })).toBe(10);
  });

  it('callBedrockJudge honours it: with 1 attempt a transient 500 is not retried', async () => {
    const prev = process.env.AH_JUDGE_MAX_ATTEMPTS;
    process.env.AH_JUDGE_MAX_ATTEMPTS = '1';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const transport = jest.fn(async () => new Response(JSON.stringify({ error: 'Judge evaluation failed: no credentials' }), { status: 500 }));
    try {
      await expect(callBedrockJudge([{ id: 's', type: 'response', content: 'x', timestamp: 't' } as any], { expectedOutcomes: ['y'] }, [], undefined, 'm', undefined, undefined, undefined, { transport }))
        .rejects.toThrow('Bedrock Judge evaluation failed after 1 attempts: Judge evaluation failed: no credentials');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.AH_JUDGE_MAX_ATTEMPTS; else process.env.AH_JUDGE_MAX_ATTEMPTS = prev;
      jest.restoreAllMocks();
    }
  });
});
