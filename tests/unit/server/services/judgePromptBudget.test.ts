/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_PROMPT_BUDGET_FRACTION,
  describeFit,
  estimateTokens,
  fitTrajectoryToBudget,
  resolvePromptBudgetChars,
} from '@/server/services/judgePromptBudget';
import { buildEvaluationPrompt } from '@/server/services/bedrockService';

const render = (steps: TrajectoryStep[]) => buildEvaluationPrompt(steps, ['finds the answer']);

function step(partial: Partial<TrajectoryStep> & { id: string }): TrajectoryStep {
  return { timestamp: 1, type: 'tool_result', content: '', ...partial } as TrajectoryStep;
}

describe('resolvePromptBudgetChars', () => {
  const saved = process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
  afterEach(() => {
    if (saved === undefined) delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
    else process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = saved;
  });

  it('defaults to a fraction of the model window (or the Claude-class default window)', () => {
    delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
    expect(resolvePromptBudgetChars(200_000)).toBe(Math.floor(200_000 * DEFAULT_PROMPT_BUDGET_FRACTION * CHARS_PER_TOKEN_ESTIMATE));
    expect(resolvePromptBudgetChars(undefined)).toBe(
      Math.floor(DEFAULT_CONTEXT_WINDOW_TOKENS * DEFAULT_PROMPT_BUDGET_FRACTION * CHARS_PER_TOKEN_ESTIMATE),
    );
    expect(resolvePromptBudgetChars(1_000_000)).toBeGreaterThan(resolvePromptBudgetChars(200_000));
  });

  it('honours AH_JUDGE_PROMPT_BUDGET_TOKENS and ignores junk values', () => {
    process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '4000';
    expect(resolvePromptBudgetChars(200_000)).toBe(Math.floor(4000 * CHARS_PER_TOKEN_ESTIMATE));
    process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = 'lots';
    expect(resolvePromptBudgetChars(200_000)).toBe(Math.floor(200_000 * DEFAULT_PROMPT_BUDGET_FRACTION * CHARS_PER_TOKEN_ESTIMATE));
  });

  it('estimateTokens rounds up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(250)).toBe(100);
  });
});

describe('fitTrajectoryToBudget', () => {
  it('returns the trajectory untouched when the prompt already fits', () => {
    const trajectory = [step({ id: 'a', content: 'small' }), step({ id: 'b', type: 'response', content: 'done' })];
    const fit = fitTrajectoryToBudget(trajectory, render, 100_000);
    expect(fit.truncated).toEqual([]);
    expect(fit.exceedsBudget).toBe(false);
    expect(fit.prompt).toBe(render(trajectory));
    expect(fit.trajectory).toEqual(trajectory);
    expect(describeFit(fit, 100_000)).toMatch(/within budget/);
  });

  it('truncates the LARGEST step field first, leaves an explicit marker, and never mutates the input', () => {
    const big = 'B'.repeat(30_000);
    const medium = 'M'.repeat(5_000);
    const trajectory = [
      step({ id: 'prompt', type: 'user', content: 'search products for a red bike' }),
      step({ id: 'tool', toolName: 'search', toolOutput: big, content: '[see toolOutput]' }),
      step({ id: 'reason', type: 'assistant', content: medium }),
      step({ id: 'resp', type: 'response', content: 'Ranked results (3):\n1. id 1\n2. id 2\n3. id 3' }),
    ];
    const before = JSON.stringify(trajectory);
    const fit = fitTrajectoryToBudget(trajectory, render, 20_000);

    expect(JSON.stringify(trajectory)).toBe(before);
    expect(fit.exceedsBudget).toBe(false);
    expect(fit.prompt.length).toBeLessThanOrEqual(20_000);
    expect(fit.truncated[0]).toMatchObject({ id: 'tool', field: 'toolOutput', fromChars: 30_000 });
    expect(fit.truncated[0].toChars).toBeLessThan(30_000);
    const out = fit.trajectory[1].toolOutput as string;
    expect(out).toMatch(/…\[truncated \d+ chars to fit the judge's context budget\]$/);
    // small steps untouched
    expect(fit.trajectory[0].content).toBe('search products for a red bike');
    expect(fit.trajectory[3].content).toContain('Ranked results (3)');
    expect(describeFit(fit, 20_000)).toMatch(/after truncating \d+ field\(s\)/);
  });

  it('cuts a `content` twin of `toolOutput` together so the rendered size actually shrinks', () => {
    const big = 'X'.repeat(40_000);
    const trajectory = [step({ id: 'tool', toolName: 'search', toolOutput: big, content: big })];
    const fit = fitTrajectoryToBudget(trajectory, render, 15_000);
    expect(fit.exceedsBudget).toBe(false);
    expect(fit.trajectory[0].toolOutput).toBe(fit.trajectory[0].content);
    expect(fit.truncated.length).toBeGreaterThan(0);
  });

  it('handles object toolOutput by serializing it', () => {
    const trajectory = [step({ id: 't', toolOutput: { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: `item ${i}` })) } as any })];
    const fit = fitTrajectoryToBudget(trajectory, render, 5_000);
    expect(fit.exceedsBudget).toBe(false);
    expect(typeof fit.trajectory[0].toolOutput).toBe('string');
    expect(fit.trajectory[0].toolOutput as string).toContain('…[truncated');
  });

  it('reports exceedsBudget when every field is already at the floor and the prompt still does not fit', () => {
    // 60 steps × 500-char content: the floor (400 chars) × 60 plus JSON
    // framing cannot fit into 3_000 chars no matter how much is cut.
    const trajectory = Array.from({ length: 60 }, (_, i) => step({ id: `s${i}`, content: 'c'.repeat(500) }));
    const fit = fitTrajectoryToBudget(trajectory, render, 3_000);
    expect(fit.exceedsBudget).toBe(true);
    expect(fit.truncated.length).toBe(60);
    expect(describeFit(fit, 3_000)).toMatch(/STILL over budget/);
  });
});
