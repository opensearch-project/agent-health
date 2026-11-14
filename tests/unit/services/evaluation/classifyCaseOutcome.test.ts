/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Truth table for the ONE verdict classifier both runners share
 * (services/evaluation/classifyCaseOutcome.ts).
 *
 * Pre-fix each runner had its own inline copy and they disagreed on the
 * headline row below (caught agent error + failed gate): evaluationRunner said
 * `failed`, benchmarkRunner said `agent_failed`.
 */

import { classifyCaseOutcome } from '@/services/evaluation/classifyCaseOutcome';
import type { MatcherResult } from '@/lib/matchers/types';

const failedGate = (over: Partial<MatcherResult> = {}): MatcherResult => ({
  description: "'' to equal 'REST request failed: 500'", pass: false, method: 'code-assertion',
  errorMessage: "expected 'REST request failed: 500 - …' to equal ''", ...over,
});
const passedGate = (over: Partial<MatcherResult> = {}): MatcherResult => ({
  description: 'true to equal true', pass: true, method: 'code-assertion', ...over,
});
const erroredJudge = (): MatcherResult => ({
  description: 'judge: coherent', pass: false, method: 'llm-judge', errored: true, errorMessage: 'judge unreachable',
});
const assertionError = Object.assign(new Error("expected 'REST request failed: 500 - …' to equal ''"), { name: 'AssertionError' });
const connectorError = new Error('REST request failed: 500 - {"message":"Search is temporarily unavailable. Please retry."}');
const timeoutError = new Error('Agent request timed out after 600123ms (timeout 600000ms)');

describe('classifyCaseOutcome', () => {
  it.each<[string, ReturnType<typeof classifyCaseOutcome>['kind'], Parameters<typeof classifyCaseOutcome>[0]]>([
    // ── the bug: the body caught agent.run()'s rejection and asserted on it ──
    ['caught agent error + failing expect (records AND throws), no agent result',
      'failed', { matcherResults: [failedGate()], evalError: assertionError, agentResultCaptured: false }],
    ['caught agent error + failing expect.soft (records, body returns normally)',
      'failed', { matcherResults: [failedGate()], evalError: undefined, agentResultCaptured: false }],
    // ── #496 / #335: genuine agent failures, no gate ever reached a verdict ──
    ['uncaught non-2xx: agent.run() rejected out of the body, no matcher recorded',
      'agent_failed', { matcherResults: [], evalError: connectorError, agentResultCaptured: false }],
    ['uncaught timeout, no matcher recorded',
      'agent_failed', { matcherResults: [], evalError: timeoutError, agentResultCaptured: false }],
    ['uncaught agent error after an earlier PASSING gate (no gate failed)',
      'agent_failed', { matcherResults: [passedGate()], evalError: timeoutError, agentResultCaptured: false }],
    ['uncaught agent error with only an observe-role failure recorded (observe never gates)',
      'agent_failed', { matcherResults: [failedGate({ role: 'observe' })], evalError: timeoutError, agentResultCaptured: false }],
    // ── an earlier recorded gate failure wins over a later uncaught agent error:
    //    the test reached a verdict (expect.soft / a hook assertion) before the
    //    agent crashed, so it is FAILED with the agent error as assertionError +
    //    notReached marker — not an agent error that hides the failed gate.
    //    (Same as evaluationRunner since #339.)
    ['expect.soft failed, THEN agent.run() rejected uncaught',
      'failed', { matcherResults: [failedGate()], evalError: connectorError, agentResultCaptured: false }],
    // ── the body decided after a caught error ──
    ['caught agent error + passing expect',
      'passed', { matcherResults: [passedGate()], evalError: undefined, agentResultCaptured: false }],
    ['caught agent error, body made no assertion at all',
      'passed', { matcherResults: [], evalError: undefined, agentResultCaptured: false }],
    // ── agent answered ──
    ['agent answered, all gates pass', 'passed', { matcherResults: [passedGate()], evalError: undefined, agentResultCaptured: true }],
    ['agent answered, a gate fails', 'failed', { matcherResults: [failedGate()], evalError: assertionError, agentResultCaptured: true }],
    ['agent answered, body threw a non-assertion error (bug in the test body)',
      'failed', { matcherResults: [passedGate()], evalError: new TypeError('x is not a function'), agentResultCaptured: true }],
    ['agent answered, only an observe-role matcher failed', 'passed', { matcherResults: [failedGate({ role: 'observe' })], evalError: undefined, agentResultCaptured: true }],
    // ── judge/evaluator could not run wins over everything ──
    ['errored judge matcher + failing gate', 'judge_failed', { matcherResults: [failedGate(), erroredJudge()], evalError: assertionError, agentResultCaptured: true }],
    ['errored judge matcher + uncaught agent error', 'judge_failed', { matcherResults: [erroredJudge()], evalError: timeoutError, agentResultCaptured: false }],
  ])('%s → %s', (_label, kind, input) => {
    expect(classifyCaseOutcome(input).kind).toBe(kind);
  });

  it('exposes the errored matchers so the runner can name the judge_failed cause', () => {
    const out = classifyCaseOutcome({ matcherResults: [failedGate(), erroredJudge()], evalError: assertionError, agentResultCaptured: true });
    expect(out.erroredMatchers).toHaveLength(1);
    expect(out.erroredMatchers[0].errorMessage).toBe('judge unreachable');
  });

  it('the synthetic notReached marker never gates (same answer before and after appendNotReachedMarker)', () => {
    const marker = failedGate({ notReached: true });
    expect(classifyCaseOutcome({ matcherResults: [marker], evalError: timeoutError, agentResultCaptured: false }).kind).toBe('agent_failed');
    expect(classifyCaseOutcome({ matcherResults: [failedGate(), marker], evalError: assertionError, agentResultCaptured: false }).kind).toBe('failed');
  });
});
