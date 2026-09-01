/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the in-memory deep-dive job store (iteration 5: async job
 * pattern, see server/routes/comparison.ts module doc comment for the
 * "why" — the public tunnel proxy's gateway timeout is shorter than the
 * deep-dive's real generation time).
 */

import {
  DeepDiveJobStore,
  DeepDiveJobCapacityError,
  computeDeepDiveDedupeKey,
} from '@/server/services/comparisonDeepDiveJobStore';

/** Resolves/rejects on demand — lets a test control exactly when a job "finishes". */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('DeepDiveJobStore — lifecycle', () => {
  it('starts a job in the running state, and get() reflects it', () => {
    const store = new DeepDiveJobStore<string>();
    const d = deferred<string>();
    const { jobId, deduped } = store.start('key-1', () => d.promise);

    expect(deduped).toBe(false);
    const job = store.get(jobId);
    expect(job?.status).toBe('running');
    expect(job?.result).toBeUndefined();
    expect(job?.error).toBeUndefined();
  });

  it('transitions to done with the resolved result once the generator settles', async () => {
    const store = new DeepDiveJobStore<{ markdown: string }>();
    const d = deferred<{ markdown: string }>();
    const { jobId } = store.start('key-1', () => d.promise);

    d.resolve({ markdown: 'the deep-dive text' });
    // Let the .then() microtask run.
    await Promise.resolve();
    await Promise.resolve();

    const job = store.get(jobId);
    expect(job?.status).toBe('done');
    expect(job?.result).toEqual({ markdown: 'the deep-dive text' });
    expect(job?.completedAt).toBeGreaterThanOrEqual(job!.startedAt);
  });

  it('transitions to error with the rejection message once the generator rejects', async () => {
    const store = new DeepDiveJobStore<string>();
    const d = deferred<string>();
    const { jobId } = store.start('key-1', () => d.promise);

    d.reject(new Error('agent session crashed'));
    await Promise.resolve();
    await Promise.resolve();

    const job = store.get(jobId);
    expect(job?.status).toBe('error');
    expect(job?.error).toBe('agent session crashed');
  });

  it('stringifies a non-Error rejection reason', async () => {
    const store = new DeepDiveJobStore<string>();
    const d = deferred<string>();
    const { jobId } = store.start('key-1', () => d.promise);

    d.reject('a plain string reason');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get(jobId)?.error).toBe('a plain string reason');
  });

  it('get() returns undefined for an unknown jobId', () => {
    const store = new DeepDiveJobStore<string>();
    expect(store.get('never-existed')).toBeUndefined();
  });

  it('size() and runningCount() reflect the store contents', async () => {
    const store = new DeepDiveJobStore<string>();
    expect(store.size()).toBe(0);
    expect(store.runningCount()).toBe(0);

    const d1 = deferred<string>();
    store.start('key-1', () => d1.promise);
    const d2 = deferred<string>();
    store.start('key-2', () => d2.promise);

    expect(store.size()).toBe(2);
    expect(store.runningCount()).toBe(2);

    d1.resolve('done');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.size()).toBe(2); // still tracked, just not running any more
    expect(store.runningCount()).toBe(1);
  });
});

describe('DeepDiveJobStore — de-dupe', () => {
  it('a second start() for the SAME key while the first is still running returns the SAME jobId, without invoking the generator again', () => {
    const store = new DeepDiveJobStore<string>();
    const run = jest.fn(() => deferred<string>().promise);

    const first = store.start('same-key', run);
    const second = store.start('same-key', run);

    expect(second.jobId).toBe(first.jobId);
    expect(second.deduped).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT key always starts its own job', () => {
    const store = new DeepDiveJobStore<string>();
    const first = store.start('key-a', () => deferred<string>().promise);
    const second = store.start('key-b', () => deferred<string>().promise);

    expect(second.jobId).not.toBe(first.jobId);
    expect(second.deduped).toBe(false);
  });

  it('once the running job for a key finishes, a NEW start() for that key starts a fresh job (not deduped)', async () => {
    const store = new DeepDiveJobStore<string>();
    const d1 = deferred<string>();
    const first = store.start('same-key', () => d1.promise);
    d1.resolve('first result');
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get(first.jobId)?.status).toBe('done');

    const run2 = jest.fn(() => deferred<string>().promise);
    const second = store.start('same-key', run2);

    expect(second.jobId).not.toBe(first.jobId);
    expect(second.deduped).toBe(false);
    expect(run2).toHaveBeenCalledTimes(1);
  });
});

describe('DeepDiveJobStore — concurrency cap', () => {
  it('throws DeepDiveJobCapacityError once at the cap, for a genuinely NEW key', () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 2);
    store.start('key-1', () => deferred<string>().promise);
    store.start('key-2', () => deferred<string>().promise);

    expect(() => store.start('key-3', () => deferred<string>().promise)).toThrow(DeepDiveJobCapacityError);
  });

  it('the capacity error names the configured max', () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 3);
    store.start('key-1', () => deferred<string>().promise);
    store.start('key-2', () => deferred<string>().promise);
    store.start('key-3', () => deferred<string>().promise);

    try {
      store.start('key-4', () => deferred<string>().promise);
      throw new Error('expected DeepDiveJobCapacityError to be thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeepDiveJobCapacityError);
      expect((e as DeepDiveJobCapacityError).maxConcurrent).toBe(3);
      expect((e as Error).message).toMatch(/max 3/);
    }
  });

  it('does NOT throw when at the cap but the request dedupes onto an existing running job', () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 1);
    const first = store.start('same-key', () => deferred<string>().promise);

    const second = store.start('same-key', () => deferred<string>().promise);
    expect(second.jobId).toBe(first.jobId);
    expect(second.deduped).toBe(true);
  });

  it('freeing up a slot (a running job completing) allows a new job to start again', async () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 1);
    const d1 = deferred<string>();
    store.start('key-1', () => d1.promise);

    expect(() => store.start('key-2', () => deferred<string>().promise)).toThrow(DeepDiveJobCapacityError);

    d1.resolve('done');
    await Promise.resolve();
    await Promise.resolve();

    expect(() => store.start('key-2', () => deferred<string>().promise)).not.toThrow();
  });
});

describe('DeepDiveJobStore — TTL eviction', () => {
  it('evicts a job (any terminal or running state) once its anchor time exceeds the TTL', async () => {
    jest.useFakeTimers();
    try {
      const store = new DeepDiveJobStore<string>(1000, 5); // 1s TTL for the test
      const d = deferred<string>();
      const { jobId } = store.start('key-1', () => d.promise);
      expect(store.get(jobId)).toBeDefined();

      jest.advanceTimersByTime(1500);
      expect(store.get(jobId)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a TTL-evicted key can be reused for a brand new (non-deduped) job', async () => {
    jest.useFakeTimers();
    try {
      const store = new DeepDiveJobStore<string>(1000, 5);
      const d1 = deferred<string>();
      const first = store.start('same-key', () => d1.promise);

      jest.advanceTimersByTime(1500); // TTL-evict the first job
      expect(store.get(first.jobId)).toBeUndefined();

      const run2 = jest.fn(() => deferred<string>().promise);
      const second = store.start('same-key', run2);
      expect(second.jobId).not.toBe(first.jobId);
      expect(second.deduped).toBe(false);
      expect(run2).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a completed job is evicted TTL after its completion time, not its start time', async () => {
    jest.useFakeTimers();
    try {
      const store = new DeepDiveJobStore<string>(1000, 5);
      const d = deferred<string>();
      const { jobId } = store.start('key-1', () => d.promise);

      // Job takes a while to actually finish...
      jest.advanceTimersByTime(800);
      d.resolve('done');
      await Promise.resolve();
      await Promise.resolve();
      expect(store.get(jobId)?.status).toBe('done');

      // ...800ms after start (still within the 1000ms TTL measured from
      // completion, not start) it must still be there.
      jest.advanceTimersByTime(800);
      expect(store.get(jobId)).toBeDefined();

      // But TTL past completion, it's gone.
      jest.advanceTimersByTime(500);
      expect(store.get(jobId)).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('computeDeepDiveDedupeKey', () => {
  it('is order-independent over reportIds', () => {
    expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'])).toBe(computeDeepDiveDedupeKey(['rep-b', 'rep-a']));
  });

  it('differs when systemPrompt differs', () => {
    expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], 'prompt one')).not.toBe(
      computeDeepDiveDedupeKey(['rep-a', 'rep-b'], 'prompt two')
    );
  });

  it('an omitted systemPrompt and an explicit falsy one hash the same (both normalize to null)', () => {
    expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'])).toBe(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], ''));
  });

  it('differs when the rows table differs', () => {
    const rowsA = [{ testCaseId: 'tc-1', testCaseName: 'Case 1' }];
    const rowsB = [{ testCaseId: 'tc-2', testCaseName: 'Case 2' }];
    expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, rowsA)).not.toBe(
      computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, rowsB)
    );
  });

  it('is a stable, deterministic hex string for the same inputs', () => {
    const k1 = computeDeepDiveDedupeKey(['rep-a', 'rep-b'], 'p');
    const k2 = computeDeepDiveDedupeKey(['rep-a', 'rep-b'], 'p');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different report PAIR (not just order) produces a different key', () => {
    expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'])).not.toBe(computeDeepDiveDedupeKey(['rep-a', 'rep-c']));
  });

  // Hardening round (codex review of PR #460): the SAME report pair + prompt
  // but a DIFFERENT rows table must never collapse onto the same dedupe key
  // -- a second caller would otherwise silently get the FIRST caller's
  // unrelated result. The single "differs when the rows table differs" test
  // above already covers the basic case; these are the sharper edge cases a
  // naive JSON.stringify-based hash could still get wrong.
  describe('rows discrimination + canonicalization (hardening round)', () => {
    it('discriminates when only ONE row differs among many identical ones', () => {
      const base = Array.from({ length: 20 }, (_, i) => ({ testCaseId: `tc-${i}`, testCaseName: `Case ${i}` }));
      const changed = base.map((r, i) => (i === 10 ? { ...r, testCaseId: 'tc-DIFFERENT' } : r));
      expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, base)).not.toBe(
        computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, changed)
      );
    });

    it('discriminates on a per-side score/passFailStatus/reportId difference even when testCaseId/testCaseName are identical', () => {
      const rowsA = [{ testCaseId: 'tc-1', testCaseName: 'Case 1', a: { passFailStatus: 'passed', score: 92, reportId: 'rep-x' } }];
      const rowsB = [{ testCaseId: 'tc-1', testCaseName: 'Case 1', a: { passFailStatus: 'passed', score: 41, reportId: 'rep-x' } }];
      expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, rowsA)).not.toBe(
        computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, rowsB)
      );
    });

    it('discriminates between an empty rows array and rows omitted entirely', () => {
      expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, [])).not.toBe(
        computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, undefined)
      );
    });

    it('is CANONICAL: the same rows re-sent in a different order hash identically (no needless duplicate generation)', () => {
      const row1 = { testCaseId: 'tc-1', testCaseName: 'Case 1', a: { passFailStatus: 'passed', score: 92 } };
      const row2 = { testCaseId: 'tc-2', testCaseName: 'Case 2', a: { passFailStatus: 'failed', score: 10 } };
      expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, [row1, row2])).toBe(
        computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, [row2, row1])
      );
    });

    it('does not throw on a malformed/non-array rows payload (defensive -- this runs before route-level validation)', () => {
      expect(() => computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, 'not-an-array' as any)).not.toThrow();
      expect(() => computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, [null, 'not-an-object', 42] as any)).not.toThrow();
      // Different malformed payloads still discriminate from each other.
      expect(computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, 'a' as any)).not.toBe(
        computeDeepDiveDedupeKey(['rep-a', 'rep-b'], undefined, 'b' as any)
      );
    });
  });
});

describe('DeepDiveJobStore — retained-jobs cap (hardening round, codex review of PR #460)', () => {
  it('evicts the OLDEST terminal (done) job once the retained-jobs cap is exceeded', async () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 10, 2); // maxRetained = 2

    const d1 = deferred<string>();
    const first = store.start('key-1', () => d1.promise);
    d1.resolve('first done');
    await Promise.resolve();
    await Promise.resolve();

    const d2 = deferred<string>();
    const second = store.start('key-2', () => d2.promise);
    d2.resolve('second done');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.size()).toBe(2);

    // A third job pushes the store over the cap -- the OLDEST terminal job
    // (first) must be evicted, not the second.
    const d3 = deferred<string>();
    const third = store.start('key-3', () => d3.promise);

    expect(store.get(first.jobId)).toBeUndefined();
    expect(store.get(second.jobId)?.result).toBe('second done');
    expect(store.get(third.jobId)?.status).toBe('running');
    expect(store.size()).toBeLessThanOrEqual(2);
  });

  it('NEVER evicts a running job to make room, even when every other job is also running', () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 10, 2); // maxRetained = 2

    const first = store.start('key-1', () => deferred<string>().promise);
    const second = store.start('key-2', () => deferred<string>().promise);
    const third = store.start('key-3', () => deferred<string>().promise);

    // All three are still running -- none evicted, even though 3 > maxRetained (2).
    expect(store.get(first.jobId)?.status).toBe('running');
    expect(store.get(second.jobId)?.status).toBe('running');
    expect(store.get(third.jobId)?.status).toBe('running');
    expect(store.size()).toBe(3);
  });

  it('a job evicted for capacity is genuinely gone (get() returns undefined, matching TTL-eviction semantics)', async () => {
    const store = new DeepDiveJobStore<string>(30 * 60 * 1000, 10, 1); // maxRetained = 1

    const d1 = deferred<string>();
    const first = store.start('key-1', () => d1.promise);
    d1.resolve('done');
    await Promise.resolve();
    await Promise.resolve();

    store.start('key-2', () => deferred<string>().promise);

    expect(store.get(first.jobId)).toBeUndefined();
  });

  it('defaults maxRetained to DEFAULT_MAX_RETAINED_JOBS when not specified', () => {
    const store = new DeepDiveJobStore<string>();
    // Not directly introspectable, but constructing with defaults must not throw
    // and must behave sanely for a small number of jobs well under the cap.
    const { jobId } = store.start('key-1', () => deferred<string>().promise);
    expect(store.get(jobId)).toBeDefined();
  });
});
