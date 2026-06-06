/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  startSession,
  endSession,
  isSessionActive,
  recordVerdict,
  recordWithTiming,
} from '@/lib/matchers/session';
import { expect as ahExpect } from '@/lib/matchers/expect';

describe('matcher session', () => {
  afterEach(() => endSession());

  it('starts inactive', () => {
    expect(isSessionActive()).toBe(false);
  });

  it('isSessionActive flips after startSession', () => {
    startSession();
    expect(isSessionActive()).toBe(true);
  });

  it('endSession returns recorded results and clears state', () => {
    startSession();
    recordVerdict({ description: 'foo', pass: true, method: 'code-assertion' });
    const out = endSession();
    expect(out).toEqual([{ description: 'foo', pass: true, method: 'code-assertion' }]);
    expect(isSessionActive()).toBe(false);
  });

  it('recordVerdict is a no-op when no session is active', () => {
    expect(() => recordVerdict({ description: 'x', pass: true, method: 'code-assertion' })).not.toThrow();
    expect(endSession()).toEqual([]);
  });

  it('recordWithTiming records pass on success and rethrows on failure', async () => {
    startSession();
    await recordWithTiming('passes', 'traces', () => 1);
    await expect(recordWithTiming('throws', 'traces', () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    const out = endSession();
    expect(out).toHaveLength(2);
    expect(out[0].pass).toBe(true);
    expect(out[1].pass).toBe(false);
    expect(out[1].errorMessage).toBe('boom');
  });
});

describe('expect (chai recording plugin)', () => {
  beforeEach(() => startSession());
  afterEach(() => endSession());

  it('records a passing equality assertion', () => {
    ahExpect(1 + 1).to.equal(2);
    const out = endSession();
    startSession();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some(r => r.pass && r.method === 'code-assertion')).toBe(true);
  });

  it('records a failing assertion with errorMessage and rethrows', () => {
    expect(() => ahExpect('foo').to.equal('bar')).toThrow();
    const out = endSession();
    startSession();
    const failed = out.find(r => !r.pass);
    expect(failed).toBeDefined();
    expect(failed!.method).toBe('code-assertion');
    expect(failed!.errorMessage).toContain('expected');
  });

  it('captures actual / expected for diff display', () => {
    ahExpect(42).to.equal(42);
    const out = endSession();
    startSession();
    const last = out[out.length - 1];
    expect(last.actual).toBe(42);
    expect(last.expected).toBe(42);
  });
});

describe('custom matchers', () => {
  beforeEach(() => startSession());
  afterEach(() => endSession());

  it('haveCalledTool — passes when tool was invoked', () => {
    const trajectory = [
      { type: 'thinking' },
      { type: 'action', toolName: 'search_logs', toolArgs: { query: 'errors' } },
    ];
    ahExpect(trajectory as any).to.haveCalledTool('search_logs');
    const out = endSession();
    startSession();
    expect(out.some(r => r.pass)).toBe(true);
  });

  it('haveCalledTool — fails with informative message when tool missing', () => {
    const trajectory = [{ type: 'thinking' }];
    expect(() => ahExpect(trajectory as any).to.haveCalledTool('search_logs')).toThrow(/search_logs/);
    const out = endSession();
    startSession();
    expect(out.some(r => !r.pass)).toBe(true);
  });

  it('haveCalledTool with argsPartial — superset match', () => {
    const trajectory = [
      { type: 'action', toolName: 'http_probe', toolArgs: { url: 'https://x', method: 'POST' } },
    ];
    ahExpect(trajectory as any).to.haveCalledTool('http_probe', { method: 'POST' });
    expect(() =>
      ahExpect(trajectory as any).to.haveCalledTool('http_probe', { method: 'GET' })
    ).toThrow();
  });

  it('haveStepsOfType — counts step types', () => {
    const trajectory = [
      { type: 'thinking' },
      { type: 'action' },
      { type: 'response' },
    ];
    ahExpect(trajectory as any).to.haveStepsOfType('action');
    expect(() => ahExpect(trajectory as any).to.haveStepsOfType('tool_result')).toThrow();
  });

  it('haveOutputMatching — regex and string forms', () => {
    ahExpect('the root cause is X').to.haveOutputMatching(/root cause/);
    ahExpect('hello world').to.haveOutputMatching('hello');
    expect(() => ahExpect('nope').to.haveOutputMatching(/yes/)).toThrow();
  });

  it('haveCompletedWithin — durationMs threshold', () => {
    ahExpect({ durationMs: 1000 } as any).to.haveCompletedWithin(2000);
    expect(() => ahExpect({ durationMs: 5000 } as any).to.haveCompletedWithin(2000)).toThrow();
  });

  it('toPass — asserts a judge Verdict passed', () => {
    ahExpect({ pass: true } as any).to.toPass();
    expect(() =>
      ahExpect({ pass: false, reasoning: 'missed the root cause' } as any).to.toPass()
    ).toThrow(/missed the root cause/);
  });
});
