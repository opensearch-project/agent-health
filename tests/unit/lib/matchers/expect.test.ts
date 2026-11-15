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

describe('negated chains keep the negation in the recorded description (#617)', () => {
  beforeEach(() => startSession());
  afterEach(() => endSession());

  const descriptions = () => {
    const out = endSession();
    startSession();
    return out.map(r => [r.description, r.pass] as const);
  };

  it('a passing `.to.not.match(re)` is described as "not to match", not as the opposite check', () => {
    ahExpect('top 3: a; b; c').to.not.match(/^none — /);
    expect(descriptions()).toEqual([["'top 3: a; b; c' not to match /^none — /", true]]);
  });

  it('a failing `.to.not.match(re)` with a custom message: description negated, errorMessage is chai\'s', () => {
    expect(() =>
      ahExpect('none — top 3: a; b; c', 'no expected item in the top 3').to.not.match(/^none — /)
    ).toThrow("no expected item in the top 3: expected 'none — top 3: a; b; c' not to match /^none — /");
    const out = endSession();
    startSession();
    expect(out).toHaveLength(1);
    expect(out[0].pass).toBe(false);
    expect(out[0].description).toBe("'none — top 3: a; b; c' not to match /^none — /");
    expect(out[0].errorMessage).toBe("no expected item in the top 3: expected 'none — top 3: a; b; c' not to match /^none — /");
  });

  it('every built-in `.not` form is reflected: include, be.empty, equal, be.a', () => {
    ahExpect(['a', 'b']).to.not.include('z');
    ahExpect(['a']).to.not.be.empty;
    ahExpect(1).to.not.equal(2);
    ahExpect('abc').to.not.be.a('number');
    expect(descriptions().map(([d]) => d)).toEqual([
      "[ 'a', 'b' ] to not include 'z'",
      "[ 'a' ] not to be empty",
      '1 to not equal 2',
      "'abc' not to be a number",
    ]);
  });

  it('custom matchers follow the same rule — `.not.haveCalledTool` uses the matcher\'s negated text', () => {
    const trajectory = [{ type: 'action', toolName: 'search_logs', toolArgs: {} }];
    ahExpect(trajectory as any).to.not.haveCalledTool('delete_index');
    expect(() => ahExpect(trajectory as any).to.not.haveCalledTool('search_logs')).toThrow();
    expect(descriptions()).toEqual([
      ["trajectory to NOT have called tool 'delete_index'", true],
      ["trajectory to NOT have called tool 'search_logs'", false],
    ]);
  });

  it('uses chai\'s own negated wording even when it is not a literal complement (`.not.be.true` → "to be false")', () => {
    expect(() => ahExpect(true).to.not.be.true).toThrow('expected true to be false');
    expect(descriptions()).toEqual([['true to be false', false]]);
  });

  it('a custom assertion with no negated template gets a visible NOT instead of the inverted claim', () => {
    // Our own haveCalledTool guard passes '' as negateMsg; under `.not` the
    // description must not read as the positive claim.
    ahExpect('not-an-array' as any).to.not.haveCalledTool('x');
    expect(descriptions().map(([d]) => d)).toEqual(['NOT an array of TrajectoryStep']);
  });

  it('an assertion with no message template at all is not recorded, negated or not (unchanged)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chai = require('chai');
    chai.Assertion.addMethod('saysNothing', function (this: any) { this.assert(true, '', '', undefined, undefined); });
    ahExpect(1).to.saysNothing();
    expect(() => ahExpect(1).to.not.saysNothing()).toThrow(); // negate flips the verdict; still nothing to describe
    expect(descriptions()).toEqual([]);
  });

  it('positive chains are unchanged', () => {
    ahExpect('top 3: a; b; c').to.match(/^top/);
    ahExpect(['a']).to.include('a');
    expect(descriptions().map(([d]) => d)).toEqual(["'top 3: a; b; c' to match /^top/", "[ 'a' ] to include 'a'"]);
  });

  it('soft negated chains record the negated description too', () => {
    ahExpect.soft('none — x', 'should not start with none').to.not.match(/^none/);
    const [[description, pass]] = descriptions();
    expect(pass).toBe(false);
    expect(description).toBe("'none — x' not to match /^none/");
  });
});

describe('expect.soft (RFC 004 roadmap — non-throwing assertions)', () => {
  beforeEach(() => startSession());
  afterEach(() => endSession());

  it('records a failing soft assertion but does NOT throw', () => {
    expect(() => ahExpect.soft(1).to.equal(2)).not.toThrow();
    const out = endSession();
    startSession();
    expect(out).toHaveLength(1);
    expect(out[0].pass).toBe(false);
    expect(out[0].method).toBe('code-assertion');
    expect(out[0].errorMessage).toBeTruthy();
  });

  it('records a passing soft assertion normally', () => {
    ahExpect.soft(2).to.equal(2);
    const out = endSession();
    startSession();
    expect(out).toHaveLength(1);
    expect(out[0].pass).toBe(true);
  });

  it('the test body keeps running after a soft failure — later matchers still record', () => {
    // This is the exact bug the mode exists to fix: with hard expect(), the
    // second line below would never execute.
    ahExpect.soft(1).to.equal(2); // fails — recorded, does NOT throw
    ahExpect(2).to.equal(2);       // still reached, passes
    const out = endSession();
    startSession();
    expect(out).toHaveLength(2);
    expect(out[0].pass).toBe(false);
    expect(out[1].pass).toBe(true);
  });

  it('a hard expect() after a soft failure still bails on its OWN failure', () => {
    ahExpect.soft(1).to.equal(2);                       // soft fail, continues
    expect(() => ahExpect(3).to.equal(4)).toThrow();     // hard fail, throws
    const out = endSession();
    startSession();
    expect(out).toHaveLength(2);
    expect(out.every(r => !r.pass)).toBe(true);
  });

  it('custom matchers work in soft mode too — every assertion funnels through the same override', () => {
    const trajectory = [{ type: 'action', toolName: 'search_logs' }];
    ahExpect.soft(trajectory as any).to.haveCalledTool('missing-tool');
    ahExpect.soft(trajectory as any).to.haveCalledTool('search_logs');
    const out = endSession();
    startSession();
    expect(out).toHaveLength(2);
    expect(out[0].pass).toBe(false);
    expect(out[1].pass).toBe(true);
  });

  it('a fresh expect.soft(...) call is independently flagged — no cross-call leakage', () => {
    ahExpect.soft(1).to.equal(2); // soft, swallowed
    // A brand-new expect() call (not .soft) must NOT inherit the flag from
    // the previous statement — each call creates its own Assertion instance.
    expect(() => ahExpect(3).to.equal(4)).toThrow();
  });

  it('KNOWN LIMITATION: a multi-step property chain records a derivative second failure when the first link fails (see docs/SDK.md)', () => {
    // With a hard expect(), a missing property throws and `.that.equals()`
    // never runs — only ONE failure would ever be recorded. In soft mode
    // nothing throws, so the chain continues past the missing-property
    // check and `.that.equals(5)` runs against `undefined`, recording its
    // own "expected undefined to equal 5" failure. This test pins that
    // documented, real behavior (not asserting it's desirable — see the
    // "Known limitation" callout in docs/SDK.md) so a future change to the
    // patched assert() override doesn't silently alter it either way
    // without a deliberate update here.
    ahExpect.soft({ a: 1 } as any).to.have.property('nonexistent').that.equals(5);
    const out = endSession();
    startSession();
    expect(out).toHaveLength(2);
    expect(out[0].pass).toBe(false);
    expect(out[0].errorMessage).toContain('nonexistent');
    expect(out[1].pass).toBe(false);
    expect(out[1].errorMessage).toContain('undefined');
  });
});
