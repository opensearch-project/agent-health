/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  defineEvaluator,
  evaluate,
  getEvaluator,
  clearEvaluators,
} from '@/lib/testCases/evaluators';
import { startSession, endSession } from '@/lib/matchers/session';
import type { EvalResult } from '@/lib/testCases/types';

const stubResult = (output = 'ok'): EvalResult =>
  ({ trajectory: [] as any, agentOutput: output, finalResponse: () => output,
     parsedOutput: () => undefined, rawEvents: [], durationMs: 0 } as EvalResult);

describe('defineEvaluator / evaluate — custom programmatic evaluators (#244)', () => {
  beforeEach(() => { startSession(); clearEvaluators(); });
  afterEach(() => { endSession(); });

  it('registers and looks up an evaluator by id', () => {
    const fn = () => ({ pass: true });
    defineEvaluator('my-eval', fn);
    expect(getEvaluator('my-eval')).toBe(fn);
  });

  it('rejects bad arguments', () => {
    expect(() => defineEvaluator('', (() => ({ pass: true })) as any)).toThrow(/non-empty string/);
    expect(() => defineEvaluator('x', undefined as any)).toThrow(/must be a function/);
  });

  it('re-registering the SAME function under an id is a no-op (watched-file reload)', () => {
    const fn = () => ({ pass: true });
    defineEvaluator('dup-eval', fn);
    expect(() => defineEvaluator('dup-eval', fn)).not.toThrow();
    expect(getEvaluator('dup-eval')).toBe(fn);
  });

  it('throws when a DIFFERENT function is registered under an existing id (#5 collision)', () => {
    // Two .eval files defining the same id with different bodies would silently
    // shadow by load order; fail loudly instead.
    defineEvaluator('len-check', () => ({ pass: true }));
    expect(() => defineEvaluator('len-check', () => ({ pass: false }))).toThrow(
      /already.*registered with a different function/
    );
  });

  it('runs the evaluator and records a passing gate MatcherResult', async () => {
    defineEvaluator('always-pass', ({ result }) => ({
      pass: result.agentOutput === 'ok', score: 1, reasoning: 'matched',
    }));
    const verdict = await evaluate(stubResult('ok'), 'always-pass');
    expect(verdict.pass).toBe(true);
    expect(verdict.score).toBe(1);
    expect(verdict.role).toBe('gate');

    const results = endSession();
    const entry = results.find(r => r.method === 'evaluator');
    expect(entry).toBeDefined();
    expect(entry!.pass).toBe(true);
    expect(entry!.role).toBe('gate');
  });

  it('records a failing verdict (non-throwing) when the evaluator returns pass:false', async () => {
    defineEvaluator('always-fail', () => ({ pass: false, reasoning: 'nope' }));
    const verdict = await evaluate(stubResult(), 'always-fail');
    expect(verdict.pass).toBe(false);
    expect(verdict.accuracy).toBe(0);
    expect(() => verdict.orThrow()).toThrow(/FAILED/);
  });

  it('evaluate.observe() records an observe-role result', async () => {
    defineEvaluator('obs', () => ({ pass: false }));
    const verdict = await evaluate.observe(stubResult(), 'obs');
    expect(verdict.role).toBe('observe');
    const entry = endSession().find(r => r.method === 'evaluator');
    expect(entry!.role).toBe('observe');
  });

  it('unknown evaluator id produces an errored verdict', async () => {
    const verdict = await evaluate(stubResult(), 'does-not-exist');
    expect(verdict.errored).toBe(true);
    expect(verdict.pass).toBe(false);
    const entry = endSession().find(r => r.method === 'evaluator');
    expect(entry!.errored).toBe(true);
  });

  it('an evaluator that throws produces an errored verdict (not a crash)', async () => {
    defineEvaluator('boom', () => { throw new Error('kaboom'); });
    const verdict = await evaluate(stubResult(), 'boom');
    expect(verdict.errored).toBe(true);
    expect(verdict.errorMessage).toMatch(/kaboom/);
  });

  it('passes criteria + traces through to the evaluator', async () => {
    let seen: any;
    defineEvaluator('capture', (ctx) => { seen = ctx; return { pass: true }; });
    const result = stubResult();
    (result as any).traces = { totalTokens: 42 } as any;
    await evaluate(result, 'capture', 'the criteria');
    expect(seen.criteria).toBe('the criteria');
    expect(seen.traces.totalTokens).toBe(42);
  });
});
