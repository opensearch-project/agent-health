/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * spawnPi / evaluateWithPi against a stubbed `pi` CLI
 * (tests/helpers/stubPiCli.cjs) — the CLI failure shapes the judge must
 * report distinctly instead of the blanket "The CLI may have returned
 * invalid JSON":
 *   (i)   prints nothing and exits 0          → empty_response
 *   (ii)  exits non-zero with stderr          → cli_crash + redacted stderr tail
 *   (ii') exits non-zero with an overflow msg → context_overflow
 *   (iii) prose preamble then a JSON verdict  → parses fine
 *   (iv)  oversized prompt                    → truncated to budget before spawn
 *   (v)   killed by the judge timeout         → timeout
 */

import path from 'node:path';
import type { TrajectoryStep } from '@/types';

const STUB = path.join(process.cwd(), 'tests', 'helpers', 'stubPiCli.cjs');

jest.mock('@/server/services/piBinary', () => ({
  resolvePiCommand: () => ({ command: process.execPath, prefixArgs: [STUB], bundled: true }),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const trajectory: TrajectoryStep[] = [
  { id: 's1', timestamp: 1, type: 'action', content: '{}', toolName: 'search_products', toolArgs: {} } as TrajectoryStep,
  { id: 's2', timestamp: 2, type: 'response', content: 'Ranked results (1):\n1. id 7 — Trail Bike (score 9.1)' } as TrajectoryStep,
];

describe('piJudgeService against a stubbed CLI', () => {
  const savedMode = process.env.STUB_PI_MODE;
  const savedBudget = process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.STUB_PI_MODE;
    else process.env.STUB_PI_MODE = savedMode;
    if (savedBudget === undefined) delete process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS;
    else process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = savedBudget;
  });

  it('(i) exit 0 with empty stdout → empty_response (not "invalid JSON")', async () => {
    process.env.STUB_PI_MODE = 'empty';
    const { evaluateWithPi, parsePiError } = require('@/server/services/piJudgeService');
    let caught: any;
    try {
      await evaluateWithPi({ trajectory, expectedOutcomes: ['ranks the trail bike first'] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.errorClass).toBe('empty_response');
    expect(caught.retryable).toBe(false);
    expect(caught.message).toMatch(/printed nothing to stdout/);
    expect(parsePiError(caught)).not.toMatch(/may have returned invalid JSON/);
  });

  it('(ii) non-zero exit → cli_crash with the stderr tail, credentials redacted', async () => {
    process.env.STUB_PI_MODE = 'crash';
    const { evaluateWithPi, parsePiError } = require('@/server/services/piJudgeService');
    let caught: any;
    try {
      await evaluateWithPi({ trajectory, expectedOutcomes: ['x'] });
    } catch (e) {
      caught = e;
    }
    expect(caught.errorClass).toBe('cli_crash');
    expect(caught.retryable).toBe(true);
    expect(caught.message).toMatch(/exited with code 2/);
    expect(caught.stderrTail).toContain('something exploded');
    expect(caught.stderrTail).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(caught.stderrTail).not.toContain('s3cr3t/value+here');
    expect(parsePiError(caught)).toContain('something exploded');
  });

  it("(ii') non-zero exit whose stderr is a provider overflow → context_overflow, not retryable", async () => {
    process.env.STUB_PI_MODE = 'overflow';
    const { evaluateWithPi } = require('@/server/services/piJudgeService');
    await expect(evaluateWithPi({ trajectory, expectedOutcomes: ['x'] })).rejects.toMatchObject({
      errorClass: 'context_overflow',
      retryable: false,
      message: expect.stringContaining('Input is too long'),
    });
  });

  it('(iii) prose preamble followed by a fenced JSON verdict parses', async () => {
    process.env.STUB_PI_MODE = 'preamble';
    const { evaluateWithPi } = require('@/server/services/piJudgeService');
    const res = await evaluateWithPi({ trajectory, expectedOutcomes: ['x'] });
    expect(res.passFailStatus).toBe('passed');
    expect(res.metrics.accuracy).toBe(88);
    expect(res.metrics.faithfulness).toBe(80);
  });

  it('(iv) an oversized trajectory is truncated to the budget before the CLI sees it; the ranked-list response step survives', async () => {
    process.env.STUB_PI_MODE = 'echo';
    process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '20000'; // 50k chars
    const big = JSON.stringify({ hits: Array.from({ length: 900 }, (_, i) => ({ id: i, body: 'y'.repeat(100) })) });
    const ranked = 'Ranked results (20, results_source=return_results):\n' + Array.from({ length: 20 }, (_, i) => `${i + 1}. id ${i} — item ${i} (score ${20 - i})`).join('\n');
    const bigTrajectory: TrajectoryStep[] = [
      { id: 'u', timestamp: 1, type: 'user', content: 'search products' } as TrajectoryStep,
      { id: 't', timestamp: 2, type: 'tool_result', toolName: 'search', content: '[see toolOutput]', toolOutput: big } as TrajectoryStep,
      { id: 'r', timestamp: 3, type: 'response', content: ranked } as TrajectoryStep,
    ];
    const { evaluateWithPi } = require('@/server/services/piJudgeService');
    const res = await evaluateWithPi({ trajectory: bigTrajectory, expectedOutcomes: ['x'] });
    expect(res.passFailStatus).toBe('passed');
    const m = /promptChars=(\d+) marker=(true|false)/.exec(res.llmJudgeReasoning);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(50_000);
    expect(m![2]).toBe('true');
  });

  it('(iv\') a trajectory that cannot fit the budget fails fast as context_overflow WITHOUT spawning', async () => {
    process.env.STUB_PI_MODE = 'echo';
    process.env.AH_JUDGE_PROMPT_BUDGET_TOKENS = '800'; // 2k chars
    const many: TrajectoryStep[] = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, timestamp: i, type: 'tool_result', toolName: 't', content: 'c'.repeat(600) })) as TrajectoryStep[];
    const { evaluateWithPi } = require('@/server/services/piJudgeService');
    await expect(evaluateWithPi({ trajectory: many, expectedOutcomes: ['x'] })).rejects.toMatchObject({
      errorClass: 'context_overflow',
      retryable: false,
      message: expect.stringContaining('even after truncating'),
    });
  });

  it('(v) a CLI that never exits is killed at the judge timeout → timeout (retryable)', async () => {
    process.env.STUB_PI_MODE = 'hang';
    process.env.AH_PI_JUDGE_TIMEOUT_MS = '1500';
    jest.resetModules();
    jest.doMock('@/server/services/piBinary', () => ({
      resolvePiCommand: () => ({ command: process.execPath, prefixArgs: [STUB], bundled: true }),
    }));
    jest.doMock('@/lib/debug', () => ({ debug: jest.fn() }));
    try {
      const { evaluateWithPi } = require('@/server/services/piJudgeService');
      await expect(evaluateWithPi({ trajectory, expectedOutcomes: ['x'] })).rejects.toMatchObject({
        errorClass: 'timeout',
        retryable: true,
        message: expect.stringMatching(/killed by SIGTERM after 2s \(judge timeout\)/),
      });
    } finally {
      delete process.env.AH_PI_JUDGE_TIMEOUT_MS;
    }
  }, 15_000);

  it('parsePiError keeps the invalid-JSON wording ONLY for a genuinely unparseable verdict, and still maps legacy plain errors', () => {
    const { parsePiError } = require('@/server/services/piJudgeService');
    const { JudgeError } = require('@/server/services/judgeErrors');
    expect(parsePiError(new JudgeError('PiJudge: judge response did not contain a JSON object. First 200 chars: hello', { errorClass: 'invalid_json' })))
      .toMatch(/^Failed to parse Pi judge response — the judge answered but not with a JSON verdict/);
    expect(parsePiError(new JudgeError('Judge context overflow — x', { errorClass: 'context_overflow' }))).toBe('Judge context overflow — x');
    expect(parsePiError(new Error('ExpiredToken'))).toMatch(/credentials expired/);
    expect(parsePiError(new Error('spawn pi ENOENT'))).toMatch(/not found/);
    expect(parsePiError(new Error('SIGTERM'))).toMatch(/timed out/);
  });
});
