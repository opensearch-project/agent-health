/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HookOrchestrator,
  NoopHookOrchestrator,
  createHookOrchestrator,
  type TestDescriptor,
} from '@/services/hookOrchestrator';
import type { RegisteredHook, TestFixtures, HookFn } from '@/lib/testCases/types';

// Minimal fixtures factory for tests. We don't exercise judge/expect/traces
// here — only the orchestrator's shape and ordering. Real runners merge the
// orchestrator's `testInfo`/`provisioned` into the runner-built fixtures.
const makeFactory = () => (_desc: TestDescriptor): TestFixtures => ({
  result: {} as any,
  judge: (() => {}) as any,
  traces: {} as any,
  expect: (() => {}) as any,
  testInfo: { name: '' },        // overwritten by orchestrator
  provisioned: {},               // overwritten by orchestrator
});

const hook = (kind: RegisteredHook['kind'], fn: HookFn, sourceFile = '/f.eval.js', describePath?: string): RegisteredHook =>
  ({ kind, fn, sourceFile, describePath });

const desc = (id: string, name = id, sourceFile: string | undefined = '/f.eval.js', describePath?: string): TestDescriptor =>
  ({ testCaseId: id, name, sourceFile, describePath });

describe('NoopHookOrchestrator', () => {
  it('returns bare fixtures with empty provisioned and stamped testInfo', async () => {
    const o = new NoopHookOrchestrator(makeFactory());
    const { fixtures, matcherResults, aborted } = await o.beforeTest(desc('t1', 'My Test'));
    expect(aborted).toBe(false);
    expect(matcherResults).toEqual([]);
    expect(fixtures.testInfo).toEqual({ name: 'My Test', benchmarkPath: undefined, sourceFile: '/f.eval.js', testCaseId: 't1' });
    expect(fixtures.provisioned).toEqual({});
    expect(await o.afterTest()).toEqual([]);
  });
});

describe('createHookOrchestrator', () => {
  it('returns a noop when hooksByFile is undefined', async () => {
    const o = createHookOrchestrator(undefined, [desc('t')], makeFactory());
    expect(o).toBeInstanceOf(NoopHookOrchestrator);
  });

  it('returns a noop when hooksByFile is empty (no scopes)', async () => {
    const o = createHookOrchestrator(new Map(), [desc('t')], makeFactory());
    expect(o).toBeInstanceOf(NoopHookOrchestrator);
  });

  it('returns a noop when scopes exist but contain zero hooks', async () => {
    const o = createHookOrchestrator(new Map([['/f.eval.js', []]]), [desc('t')], makeFactory());
    expect(o).toBeInstanceOf(NoopHookOrchestrator);
  });

  it('returns a real orchestrator when at least one hook exists', async () => {
    const o = createHookOrchestrator(
      new Map([['/f.eval.js', [hook('beforeEach', () => {})]]]),
      [desc('t')],
      makeFactory(),
    );
    expect(o).toBeInstanceOf(HookOrchestrator);
  });
});

describe('HookOrchestrator — beforeAll once-latch', () => {
  it('runs beforeAll exactly once for parallel tests in the same scope', async () => {
    let count = 0;
    const hooks = new Map([['/f.eval.js', [hook('beforeAll', async () => { count++; })]]]);
    const tests = [desc('a'), desc('b'), desc('c')];
    const o = new HookOrchestrator(hooks, tests, makeFactory());

    // Three concurrent arrivals
    await Promise.all(tests.map(t => o.beforeTest(t)));
    expect(count).toBe(1);
    // And drain so afterAll bookkeeping doesn't leak
    for (const t of tests) await o.afterTest(t, (await o.beforeTest(t)).fixtures);
  });

  it('replays beforeAll matcher results onto every test in the scope', async () => {
    const hooks = new Map([['/f.eval.js', [hook('beforeAll', () => {})]]]);
    const tests = [desc('a'), desc('b')];
    const o = new HookOrchestrator(hooks, tests, makeFactory());

    const r1 = await o.beforeTest(tests[0]);
    const r2 = await o.beforeTest(tests[1]);
    expect(r1.matcherResults.filter(m => m.description === 'beforeAll hook')).toHaveLength(1);
    expect(r2.matcherResults.filter(m => m.description === 'beforeAll hook')).toHaveLength(1);
  });

  it('aborts subsequent tests when beforeAll throws', async () => {
    const err = new Error('boom');
    const hooks = new Map([['/f.eval.js', [hook('beforeAll', () => { throw err; })]]]);
    const tests = [desc('a'), desc('b')];
    const o = new HookOrchestrator(hooks, tests, makeFactory());

    const r1 = await o.beforeTest(tests[0]);
    const r2 = await o.beforeTest(tests[1]);
    expect(r1.aborted).toBe(true);
    expect(r2.aborted).toBe(true);
    expect(r1.matcherResults[0].pass).toBe(false);
    expect(r1.matcherResults[0].errorMessage).toBe('boom');
  });
});

describe('HookOrchestrator — afterAll drain counter', () => {
  it('runs afterAll once after the last test completes', async () => {
    let after = 0;
    const hooks = new Map([['/f.eval.js', [hook('afterAll', () => { after++; })]]]);
    const tests = [desc('a'), desc('b'), desc('c')];
    const o = new HookOrchestrator(hooks, tests, makeFactory());

    for (const t of tests.slice(0, 2)) {
      const { fixtures } = await o.beforeTest(t);
      await o.afterTest(t, fixtures);
      expect(after).toBe(0); // not yet
    }
    const { fixtures } = await o.beforeTest(tests[2]);
    await o.afterTest(tests[2], fixtures);
    expect(after).toBe(1);
  });

  it('runs afterAll even when every test in the scope fails', async () => {
    let after = 0;
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', () => { throw new Error('per-test fail'); }),
      hook('afterAll', () => { after++; }),
    ]]]);
    const tests = [desc('a'), desc('b')];
    const o = new HookOrchestrator(hooks, tests, makeFactory());
    for (const t of tests) {
      const { fixtures } = await o.beforeTest(t);
      await o.afterTest(t, fixtures);
    }
    expect(after).toBe(1);
  });
});

describe('HookOrchestrator — beforeEach / afterEach', () => {
  it('runs beforeEach outer→inner and afterEach inner→outer', async () => {
    const order: string[] = [];
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', () => { order.push('be:file'); }),
      hook('beforeEach', () => { order.push('be:A'); }, '/f.eval.js', 'A'),
      hook('beforeEach', () => { order.push('be:A>B'); }, '/f.eval.js', 'A > B'),
      hook('afterEach', () => { order.push('ae:file'); }),
      hook('afterEach', () => { order.push('ae:A'); }, '/f.eval.js', 'A'),
      hook('afterEach', () => { order.push('ae:A>B'); }, '/f.eval.js', 'A > B'),
    ]]]);
    const t = desc('t', 't', '/f.eval.js', 'A > B');
    const o = new HookOrchestrator(hooks, [t], makeFactory());

    const { fixtures } = await o.beforeTest(t);
    await o.afterTest(t, fixtures);

    expect(order).toEqual(['be:file', 'be:A', 'be:A>B', 'ae:A>B', 'ae:A', 'ae:file']);
  });

  it('afterEach runs even when the body would throw (orchestrator does not see body errors directly, but tests must verify it always returns matcher results)', async () => {
    let afterCount = 0;
    const hooks = new Map([['/f.eval.js', [
      hook('afterEach', () => { afterCount++; }),
    ]]]);
    const t = desc('t');
    const o = new HookOrchestrator(hooks, [t], makeFactory());
    const { fixtures } = await o.beforeTest(t);
    // Caller (runner) calls afterTest in finally regardless of body outcome.
    await o.afterTest(t, fixtures);
    expect(afterCount).toBe(1);
  });

  it('afterEach runs even when beforeEach threw', async () => {
    let afterCount = 0;
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', () => { throw new Error('be fail'); }),
      hook('afterEach', () => { afterCount++; }),
    ]]]);
    const t = desc('t');
    const o = new HookOrchestrator(hooks, [t], makeFactory());

    const { aborted, fixtures } = await o.beforeTest(t);
    expect(aborted).toBe(true);
    await o.afterTest(t, fixtures);
    expect(afterCount).toBe(1);
  });

  it('captures hook errors as matcher results without throwing', async () => {
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', () => { throw new Error('be fail'); }),
      hook('afterEach', () => { throw new Error('ae fail'); }),
    ]]]);
    const t = desc('t');
    const o = new HookOrchestrator(hooks, [t], makeFactory());

    const { matcherResults: before, fixtures } = await o.beforeTest(t);
    const after = await o.afterTest(t, fixtures);
    expect(before[0]).toMatchObject({ description: 'beforeEach hook', pass: false, errorMessage: 'be fail' });
    expect(after[0]).toMatchObject({ description: 'afterEach hook', pass: false, errorMessage: 'ae fail' });
  });
});

describe('HookOrchestrator — provide() / provisioned', () => {
  it('exposes values provided in beforeEach to the body via fixtures.provisioned', async () => {
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', ({ provide }) => { provide!('workspace', '/tmp/x'); }),
    ]]]);
    const t = desc('t');
    const o = new HookOrchestrator(hooks, [t], makeFactory());
    const { fixtures } = await o.beforeTest(t);
    expect(fixtures.provisioned.workspace).toBe('/tmp/x');
  });

  it('isolates provisioned bags across concurrent tests in the same scope', async () => {
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', ({ provide, testInfo }) => { provide!('id', testInfo.name); }),
    ]]]);
    const tests = [desc('t1', 'NameA'), desc('t2', 'NameB')];
    const o = new HookOrchestrator(hooks, tests, makeFactory());

    const [r1, r2] = await Promise.all(tests.map(t => o.beforeTest(t)));
    expect(r1.fixtures.provisioned.id).toBe('NameA');
    expect(r2.fixtures.provisioned.id).toBe('NameB');
    // And the two bags are not the same object reference.
    expect(r1.fixtures.provisioned).not.toBe(r2.fixtures.provisioned);
  });

  it('afterEach can read provisioned values to clean up', async () => {
    let cleaned: string | undefined;
    const hooks = new Map([['/f.eval.js', [
      hook('beforeEach', ({ provide }) => { provide!('dir', '/tmp/abc'); }),
      hook('afterEach', ({ provisioned }) => { cleaned = provisioned.dir as string; }),
    ]]]);
    const t = desc('t');
    const o = new HookOrchestrator(hooks, [t], makeFactory());
    const { fixtures } = await o.beforeTest(t);
    await o.afterTest(t, fixtures);
    expect(cleaned).toBe('/tmp/abc');
  });

  it('provide is undefined inside the body (only beforeEach gets it)', async () => {
    const hooks = new Map([['/f.eval.js', [hook('beforeEach', () => {})]]]);
    const t = desc('t');
    const o = new HookOrchestrator(hooks, [t], makeFactory());
    const { fixtures } = await o.beforeTest(t);
    // The orchestrator hands the runner a fixtures object without `provide`;
    // a copy with `provide` was used internally only for beforeEach.
    expect(fixtures.provide).toBeUndefined();
  });
});

describe('HookOrchestrator — testInfo stamping', () => {
  it('stamps name, benchmarkPath, sourceFile, testCaseId on fixtures', async () => {
    const hooks = new Map([['/f.eval.js', [hook('beforeEach', () => {}, '/f.eval.js', 'A')]]]);
    const t = desc('the-id', 'the-name', '/f.eval.js', 'A');
    const o = new HookOrchestrator(hooks, [t], makeFactory());
    const { fixtures } = await o.beforeTest(t);
    expect(fixtures.testInfo).toEqual({
      name: 'the-name',
      benchmarkPath: 'A',
      sourceFile: '/f.eval.js',
      testCaseId: 'the-id',
    });
  });
});
