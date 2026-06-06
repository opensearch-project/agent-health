/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HookOrchestrator
 * ────────────────
 *
 * Owns the lifecycle of `beforeAll` / `afterAll` / `beforeEach` / `afterEach`
 * hooks registered by the SDK. The runner calls `beforeTest()` immediately
 * before each test body and `afterTest()` immediately after, regardless of
 * whether the body passed or threw.
 *
 * Concurrency model
 * -----------------
 * The runner dispatches up to `concurrency` test cases at once. Two
 * invariants must hold under that:
 *   1. `beforeAll` for a given scope runs **exactly once**, even when N
 *      tests in the scope start in parallel. Implemented as a once-latch:
 *      the first arrival creates the promise; everyone else awaits it.
 *   2. `afterAll` for a scope runs **exactly once**, after the last test
 *      in the scope completes (success or failure). Implemented as a
 *      remaining-tests counter, decremented on every test completion.
 *
 * Hook errors never crash the runner. They surface as `MatcherResult`
 * entries with `pass: false` so the existing per-matcher UI panel renders
 * them next to assertion failures. The test is marked failed when any
 * hook in its scope chain failed (mirrors Playwright/Jest).
 *
 * Scope chain
 * -----------
 * For a test in describe `A > B`, the scope chain (outermost-first) is
 * `[file, 'A', 'A > B']`. `beforeAll` and `beforeEach` run outer→inner;
 * `afterEach` and `afterAll` run inner→outer. This matches Playwright/Jest
 * and is what users are taught to expect.
 *
 * The orchestrator is intentionally pure — it takes hook arrays and a
 * fixtures factory, and exposes two methods. Callers wire it into their
 * own try/finally; the orchestrator does not perform any I/O of its own.
 */

import type {
  HookFn,
  RegisteredHook,
  TestFixtures,
} from '@/lib/testCases/types';
import type { MatcherResult } from '@/lib/matchers/types';

/**
 * Per-test description used to look up the right hooks.
 *
 * `sourceFile` is the absolute path the loader resolved (matches
 * `RegisteredHook.sourceFile`). `describePath` is the joined describe
 * stack (e.g. `'A > B'`) or `undefined` for tests at file top level.
 */
export interface TestDescriptor {
  testCaseId: string;
  name: string;
  sourceFile?: string;
  describePath?: string;
}

/**
 * Public surface of the orchestrator. The runner uses these two methods
 * around every test invocation.
 */
export interface IHookOrchestrator {
  /**
   * Run `beforeAll` (once-per-scope) and `beforeEach` (every-test) for
   * the given test. Returns the per-test fixtures the body should be
   * called with (the orchestrator stamps `testInfo` and `provisioned`)
   * plus a list of MatcherResults representing any hook outcomes that
   * the runner should fold into the test's matcher session.
   *
   * If `aborted` is true, the runner should skip the test body (a hook
   * threw) but must still call `afterTest` so teardown runs.
   */
  beforeTest(desc: TestDescriptor): Promise<{
    fixtures: TestFixtures;
    matcherResults: MatcherResult[];
    aborted: boolean;
  }>;

  /**
   * Run `afterEach` (every-test) and, when this is the last test in a
   * scope, `afterAll`. Always runs. Returns any teardown MatcherResults
   * to merge into the test's matcher session.
   */
  afterTest(
    desc: TestDescriptor,
    fixtures: TestFixtures
  ): Promise<MatcherResult[]>;
}

/**
 * Factory for the per-test fixtures object. The orchestrator decorates
 * what this returns with `testInfo`, `provisioned`, and (only for hooks
 * before the body) `provide`. Tests sharing a scope chain share their
 * `beforeAll`/`afterAll` — but each gets its own `provisioned` bag.
 */
export type FixturesFactory = (desc: TestDescriptor) => TestFixtures;

interface ScopeState {
  /** Hooks registered directly in this scope (not inherited). */
  beforeAll: RegisteredHook[];
  afterAll: RegisteredHook[];
  beforeEach: RegisteredHook[];
  afterEach: RegisteredHook[];
  /** Tests pending in this scope; decremented on each `afterTest`. */
  remaining: number;
  /** Once-latch promise. `null` until the first `beforeTest` arrives. */
  beforeAllRun: Promise<MatcherResult[]> | null;
  /** True when `beforeAll` failed; tests in this scope skip their bodies. */
  beforeAllFailed: boolean;
}

/**
 * Build a stable scope id from a `(sourceFile, describePath)` pair.
 *
 * `sourceFile` may be `undefined` for tests registered without a loader
 * (unit tests calling `test()` directly). We coalesce that to an empty
 * string so the scope id is always a string. The NUL separator avoids
 * collisions between paths and describe names.
 */
function scopeKey(sourceFile: string | undefined, describePath: string | undefined): string {
  return `${sourceFile ?? ''}\u0000${describePath ?? ''}`;
}

/**
 * Compute the scope chain for a test, outermost-first.
 *
 * For describe `A > B` in file `/x.eval.js`, the chain is
 *   [(file, undefined), (file, 'A'), (file, 'A > B')]
 *
 * The file-level scope (describePath=undefined) is always present so
 * file-top-level hooks always run for every test in the file.
 */
function chainFor(desc: TestDescriptor): Array<[string, string | undefined]> {
  const file = desc.sourceFile;
  const chain: Array<[string, string | undefined]> = [[scopeKey(file, undefined), undefined]];
  if (desc.describePath) {
    const parts = desc.describePath.split(' > ');
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join(' > ');
      chain.push([scopeKey(file, path), path]);
    }
  }
  return chain;
}

/**
 * Run a hook function with timing and capture errors as a MatcherResult.
 * Always resolves; never rethrows. The boolean return tells the caller
 * whether to short-circuit (used by `beforeAll`/`beforeEach`).
 */
async function runHook(
  kind: string,
  fn: HookFn,
  fixtures: TestFixtures,
  out: MatcherResult[]
): Promise<boolean> {
  const start = Date.now();
  try {
    await fn(fixtures);
    out.push({
      description: `${kind} hook`,
      pass: true,
      method: 'code-assertion',
      durationMs: Date.now() - start,
    });
    return true;
  } catch (err: any) {
    out.push({
      description: `${kind} hook`,
      pass: false,
      method: 'code-assertion',
      durationMs: Date.now() - start,
      errorMessage: err?.message || String(err),
    });
    return false;
  }
}

export class HookOrchestrator implements IHookOrchestrator {
  /**
   * Per-scope state. Built lazily on first arrival so a scope with zero
   * tests in this run incurs no setup. Keyed by `scopeKey()`.
   */
  private readonly scopes = new Map<string, ScopeState>();

  constructor(
    private readonly hooksByFile: Map<string, RegisteredHook[]>,
    private readonly testDescriptors: TestDescriptor[],
    private readonly fixturesFactory: FixturesFactory,
  ) {
    // Pre-compute remaining-test counts per scope. A test with describe
    // path 'A > B' counts toward (file), (file,'A'), and (file,'A > B').
    for (const desc of testDescriptors) {
      for (const [key, describePath] of chainFor(desc)) {
        let scope = this.scopes.get(key);
        if (!scope) {
          scope = this.makeScope(desc.sourceFile, describePath);
          this.scopes.set(key, scope);
        }
        scope.remaining++;
      }
    }
  }

  /**
   * Build an empty ScopeState pre-populated with every hook that was
   * registered directly in this scope (i.e. matches `(file, describePath)`
   * exactly — inheritance is handled by the chain walk in beforeTest).
   */
  private makeScope(
    sourceFile: string | undefined,
    describePath: string | undefined,
  ): ScopeState {
    const fileHooks = (sourceFile && this.hooksByFile.get(sourceFile)) || [];
    const matching = fileHooks.filter(h => (h.describePath ?? undefined) === describePath);
    return {
      beforeAll: matching.filter(h => h.kind === 'beforeAll'),
      afterAll: matching.filter(h => h.kind === 'afterAll'),
      beforeEach: matching.filter(h => h.kind === 'beforeEach'),
      afterEach: matching.filter(h => h.kind === 'afterEach'),
      remaining: 0,
      beforeAllRun: null,
      beforeAllFailed: false,
    };
  }

  /**
   * Lookup the per-test fixtures bag the runner should hand to the body.
   * Decorates the connector-built fixtures with `testInfo`, `provisioned`,
   * and (during `beforeEach` only) `provide`.
   */
  private buildPerTestFixtures(desc: TestDescriptor): {
    fixtures: TestFixtures;
    provisioned: Record<string, unknown>;
  } {
    const base = this.fixturesFactory(desc);
    const provisioned: Record<string, unknown> = {};
    const fixtures: TestFixtures = {
      ...base,
      testInfo: {
        name: desc.name,
        benchmarkPath: desc.describePath,
        sourceFile: desc.sourceFile,
        testCaseId: desc.testCaseId,
      },
      provisioned,
    };
    return { fixtures, provisioned };
  }

  async beforeTest(desc: TestDescriptor): Promise<{
    fixtures: TestFixtures;
    matcherResults: MatcherResult[];
    aborted: boolean;
  }> {
    const matcherResults: MatcherResult[] = [];
    const { fixtures, provisioned } = this.buildPerTestFixtures(desc);
    let aborted = false;

    const chain = chainFor(desc);

    // 1. beforeAll, outer→inner. Once-latched per scope.
    for (const [key] of chain) {
      const scope = this.scopes.get(key);
      if (!scope) continue;
      if (scope.beforeAll.length === 0) continue;

      if (!scope.beforeAllRun) {
        // First arrival creates the promise. Use a base fixtures object
        // (no `provide` — provisioning at the suite level isn't supported
        // in this PR; punted to a follow-up if there's demand).
        const suiteFixtures = this.buildPerTestFixtures(desc).fixtures;
        scope.beforeAllRun = (async () => {
          const out: MatcherResult[] = [];
          for (const h of scope.beforeAll) {
            const ok = await runHook('beforeAll', h.fn, suiteFixtures, out);
            if (!ok) { scope.beforeAllFailed = true; break; }
          }
          return out;
        })();
      }
      const results = await scope.beforeAllRun;
      // Replay the suite's beforeAll results onto every test in the scope
      // so the UI shows the failure on each affected test, not just the
      // first one to arrive. Pass-results are recorded once per test too
      // so the count stays consistent.
      matcherResults.push(...results);
      if (scope.beforeAllFailed) {
        aborted = true;
        return { fixtures, matcherResults, aborted };
      }
    }

    // 2. beforeEach, outer→inner. Each hook may call `provide()`.
    const provideFn = (key: string, value: unknown) => {
      provisioned[key] = value;
    };
    const beforeEachFixtures: TestFixtures = { ...fixtures, provide: provideFn };
    for (const [key] of chain) {
      const scope = this.scopes.get(key);
      if (!scope) continue;
      for (const h of scope.beforeEach) {
        const ok = await runHook('beforeEach', h.fn, beforeEachFixtures, matcherResults);
        if (!ok) {
          aborted = true;
          return { fixtures, matcherResults, aborted };
        }
      }
    }

    return { fixtures, matcherResults, aborted };
  }

  async afterTest(
    desc: TestDescriptor,
    fixtures: TestFixtures,
  ): Promise<MatcherResult[]> {
    const matcherResults: MatcherResult[] = [];
    const chain = chainFor(desc);

    // 1. afterEach, inner→outer. Always runs.
    for (const [key] of [...chain].reverse()) {
      const scope = this.scopes.get(key);
      if (!scope) continue;
      for (const h of scope.afterEach) {
        await runHook('afterEach', h.fn, fixtures, matcherResults);
      }
    }

    // 2. Decrement remaining count and run afterAll on scopes that drained.
    for (const [key] of [...chain].reverse()) {
      const scope = this.scopes.get(key);
      if (!scope) continue;
      scope.remaining--;
      if (scope.remaining === 0 && scope.afterAll.length > 0) {
        const suiteFixtures = this.buildPerTestFixtures(desc).fixtures;
        for (const h of scope.afterAll) {
          await runHook('afterAll', h.fn, suiteFixtures, matcherResults);
        }
      }
    }

    return matcherResults;
  }
}

/**
 * No-op orchestrator returned when no hooks are registered. Avoids paying
 * the bookkeeping cost on every existing test that doesn't use hooks, and
 * returns the bare fixtures the runner already builds.
 */
export class NoopHookOrchestrator implements IHookOrchestrator {
  constructor(private readonly fixturesFactory: FixturesFactory) {}

  async beforeTest(desc: TestDescriptor) {
    const base = this.fixturesFactory(desc);
    const fixtures: TestFixtures = {
      ...base,
      testInfo: {
        name: desc.name,
        benchmarkPath: desc.describePath,
        sourceFile: desc.sourceFile,
        testCaseId: desc.testCaseId,
      },
      provisioned: {},
    };
    return { fixtures, matcherResults: [], aborted: false };
  }

  async afterTest() { return []; }
}

/**
 * Convenience: build the right orchestrator for a run. Returns the no-op
 * variant when there are no hooks at all, so the hot path stays branchless.
 */
export function createHookOrchestrator(
  hooksByFile: Map<string, RegisteredHook[]> | undefined,
  testDescriptors: TestDescriptor[],
  fixturesFactory: FixturesFactory,
): IHookOrchestrator {
  if (!hooksByFile || hooksByFile.size === 0) {
    return new NoopHookOrchestrator(fixturesFactory);
  }
  let total = 0;
  for (const v of hooksByFile.values()) total += v.length;
  if (total === 0) {
    return new NoopHookOrchestrator(fixturesFactory);
  }
  return new HookOrchestrator(hooksByFile, testDescriptors, fixturesFactory);
}
