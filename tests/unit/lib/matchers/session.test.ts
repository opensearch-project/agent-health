/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  runInSession,
  recordVerdict,
  isSessionActive,
  startSession,
  endSession,
} from '@/lib/matchers/session';
import type { MatcherResult } from '@/lib/matchers/types';

const v = (description: string): MatcherResult => ({
  description,
  pass: true,
  method: 'code-assertion',
});

describe('runInSession — concurrency-safe matcher sessions', () => {
  it('collects verdicts recorded synchronously inside the callback', async () => {
    const { results } = await runInSession(async () => {
      recordVerdict(v('a'));
      recordVerdict(v('b'));
    });
    expect(results.map(r => r.description)).toEqual(['a', 'b']);
  });

  it('returns the callback value', async () => {
    const { value, results } = await runInSession(async () => {
      recordVerdict(v('x'));
      return 42;
    });
    expect(value).toBe(42);
    expect(results).toHaveLength(1);
  });

  it('returns partial results AND the error when the callback throws', async () => {
    const boom = new Error('boom');
    const { results, error } = await runInSession(async () => {
      recordVerdict(v('before-throw'));
      throw boom;
    });
    expect(error).toBe(boom);
    expect(results.map(r => r.description)).toEqual(['before-throw']);
  });

  it('isolates verdicts across interleaved concurrent sessions', async () => {
    // This is the regression guard for the old module-global `activeSession`:
    // two bodies running concurrently, interleaving at await boundaries, must
    // each only see their own verdicts.
    const tick = () => new Promise(r => setImmediate(r));

    const sessionA = runInSession(async () => {
      recordVerdict(v('A1'));
      await tick();              // yield — B runs here under the old global model
      recordVerdict(v('A2'));
      await tick();
      recordVerdict(v('A3'));
    });

    const sessionB = runInSession(async () => {
      await tick();
      recordVerdict(v('B1'));
      await tick();
      recordVerdict(v('B2'));
    });

    const [a, b] = await Promise.all([sessionA, sessionB]);

    expect(a.results.map(r => r.description)).toEqual(['A1', 'A2', 'A3']);
    expect(b.results.map(r => r.description)).toEqual(['B1', 'B2']);
  });

  it('clears the active session after the callback resolves', async () => {
    await runInSession(async () => {
      expect(isSessionActive()).toBe(true);
    });
    expect(isSessionActive()).toBe(false);
  });

  it('does not leak into the legacy global session', async () => {
    await runInSession(async () => {
      recordVerdict(v('scoped'));
    });
    // Legacy global was never started, so it stays empty.
    expect(endSession()).toEqual([]);
  });

  it('ALS session takes precedence over an active legacy global', async () => {
    startSession();
    recordVerdict(v('global-1'));
    const { results } = await runInSession(async () => {
      recordVerdict(v('scoped-1'));
    });
    // The scoped call captured only its own verdict…
    expect(results.map(r => r.description)).toEqual(['scoped-1']);
    // …and the legacy global kept only what was recorded outside the scope.
    expect(endSession().map(r => r.description)).toEqual(['global-1']);
  });
});
