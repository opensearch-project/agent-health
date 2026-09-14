/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CodeTestCase,
  TestOptions,
  EvalResult,
  HookFn,
  HookKind,
  RegisteredHook,
} from './types.js';
import { readEnv } from '../envCompat.js';

const DEFAULT_KEY = '__default__';

/**
 * Registration state lives behind a `globalThis`-keyed symbol instead of
 * plain module-level variables. Why: `.eval.js` files are `eval()`'d in a
 * synthetic CJS context where `require('@opensearch-project/agent-health')`
 * is intercepted by the loader and handed this same module's exports
 * directly — but `.eval.ts` / `.eval.mjs` files are loaded via a plain
 * native `import()`, which resolves `@opensearch-project/agent-health`
 * through Node's normal module resolution (the package's `exports` map,
 * e.g. `./lib/dist/lib/index.js`). When the host process itself runs from
 * TypeScript *source* (dev CLI under tsx, or a project-local `node_modules`
 * symlink pointing at this repo — both real setups), that resolution lands
 * on a PHYSICALLY DIFFERENT file on disk than the one this module's own
 * code imports internally. Two different files means two different ES
 * module instances, each with its own module-level `Map` — so a `.eval.ts`
 * file's `test()` calls landed in an orphaned registry the loader never
 * read from, and `getRegisteredTests()` came back empty ("Module ... has no
 * test cases").
 *
 * `Symbol.for(key)` returns the SAME symbol from the process-wide global
 * symbol registry no matter which module instance asks for it (dist vs
 * source, CJS vs ESM, symlinked vs installed) — so keying the shared state
 * off `globalThis[Symbol.for(...)]` makes every instance of this module
 * read and write the same underlying `Map`s, regardless of how many times /
 * from where it gets loaded. This fixes the module-instance mismatch at the
 * root instead of special-casing each way it can occur.
 */
const REGISTRY_KEY = Symbol.for('agent-health.test-registry.v1');

interface SharedRegistryState {
  registries: Map<string, CodeTestCase[]>;
  hookRegistries: Map<string, RegisteredHook[]>;
  activeFile: string | null;
  describeStack: string[];
  experimentalWarningEmitted: boolean;
}

function getSharedState(): SharedRegistryState {
  // Invariant this design relies on: eval files are loaded SEQUENTIALLY
  // (setActiveFile -> synchronously evaluate one file's top-level test()/
  // describe() calls -> move to the next), never concurrently, within a
  // process. `activeFile` and `describeStack` are shared state now (not
  // just per-module-instance as before this fix), so two files loading in
  // parallel would race on them. Verified true for both real callers as of
  // this fix: services/sourceResolver.ts's two loops and
  // cli/commands/benchmark.ts's file-mode loader all `await
  // loadTestCasesFromModule(...)` inside a plain `for` loop, never
  // `Promise.all`. If a future caller parallelizes file loading, this
  // invariant breaks and registration could scramble across files.
  const g = globalThis as unknown as Record<symbol, SharedRegistryState>;
  let state = g[REGISTRY_KEY];
  if (!state) {
    state = {
      registries: new Map<string, CodeTestCase[]>(),
      hookRegistries: new Map<string, RegisteredHook[]>(),
      activeFile: null,
      describeStack: [],
      experimentalWarningEmitted: false,
    };
    g[REGISTRY_KEY] = state;
  }
  return state;
}

function emitExperimentalWarningOnce(): void {
  const state = getSharedState();
  if (state.experimentalWarningEmitted) return;
  state.experimentalWarningEmitted = true;
  if (readEnv('AH_SUPPRESS_EXPERIMENTAL', 'AGENT_HEALTH_SUPPRESS_EXPERIMENTAL') === '1') return;
  // eslint-disable-next-line no-console
  console.warn(
    '[agent-health] The code-based test SDK (test()/judge()/expect()) is ' +
    'experimental. The API may change in a minor release without a ' +
    'deprecation cycle. Pin your @opensearch-project/agent-health version, ' +
    'or set AH_SUPPRESS_EXPERIMENTAL=1 to silence this notice.'
  );
}

/** @internal */
export function _resetExperimentalWarning(): void {
  getSharedState().experimentalWarningEmitted = false;
}

export function setActiveFile(filePath: string): void {
  const state = getSharedState();
  state.activeFile = filePath;
  if (!state.registries.has(filePath)) {
    state.registries.set(filePath, []);
  }
  if (!state.hookRegistries.has(filePath)) {
    state.hookRegistries.set(filePath, []);
  }
}

/**
 * Register a code-based test case.
 *
 * Two valid signatures (Playwright-style):
 * - `test(name, body)` — no options at all
 * - `test(name, options, body)` — with options
 *
 * Only `name` is required. All TestOptions fields are optional. When
 * `options.prompt` is absent, the runner skips agent invocation and the
 * body receives an empty EvalResult.
 *
 * Throws if a test with the same name is already registered in the same
 * source file. Cross-file duplicates are allowed (storage identity is
 * `name + sourceFile`).
 *
 * @experimental The SDK shape (signature, options, body fixtures) may change
 * in a minor release without a deprecation cycle. See `lib/index.ts`.
 */
export function test(
  name: string,
  body: (result: EvalResult) => Promise<void> | void
): void;
export function test(
  name: string,
  options: TestOptions,
  body: (result: EvalResult) => Promise<void> | void
): void;
export function test(
  name: string,
  optionsOrBody: TestOptions | ((result: EvalResult) => Promise<void> | void),
  maybeBody?: (result: EvalResult) => Promise<void> | void
): void {
  emitExperimentalWarningOnce();

  // Resolve the two-arg / three-arg overload
  let options: TestOptions;
  let evaluate: (result: EvalResult) => Promise<void> | void;
  if (typeof optionsOrBody === 'function') {
    options = {};
    evaluate = optionsOrBody;
  } else {
    options = optionsOrBody ?? {};
    evaluate = maybeBody as (result: EvalResult) => Promise<void> | void;
  }

  if (!name || typeof name !== 'string') {
    throw new Error('test() requires a name (the first argument)');
  }
  if (typeof evaluate !== 'function') {
    throw new Error(`test("${name}") requires a body function`);
  }

  const state = getSharedState();
  const key = state.activeFile ?? DEFAULT_KEY;
  if (!state.registries.has(key)) {
    state.registries.set(key, []);
  }
  const registry = state.registries.get(key)!;

  // Within-file uniqueness guard: a name+benchmarkPath pair must be unique.
  // The same name in two different describe blocks is allowed because they
  // map to different benchmarks.
  const benchmarkPath = state.describeStack.length > 0 ? state.describeStack.join(' > ') : undefined;
  if (registry.some(t => t.name === name && t.benchmarkPath === benchmarkPath)) {
    const fileLabel = state.activeFile ? ` in ${state.activeFile}` : '';
    const groupLabel = benchmarkPath ? ` (in describe "${benchmarkPath}")` : '';
    throw new Error(
      `Duplicate test name "${name}"${groupLabel}${fileLabel}. ` +
      `Test names must be unique within their describe block. ` +
      `Move one of the tests to a different describe() or rename it.`
    );
  }

  registry.push({
    name,
    options,
    evaluate,
    sourceFile: state.activeFile ?? undefined,
    benchmarkPath,
    describePath: [...state.describeStack],
  });
}

/**
 * Group tests under a benchmark name. Equivalent to Playwright's
 * `describe()` — the wrapped `test()` calls inherit the describe's name as
 * their benchmark group. Nested describes flatten with ' > '.
 *
 * @example
 *   describe('RCA Suite', () => {
 *     test('payment-service is the root cause', { prompt: ... }, async ({ result, judge }) => {
 *       expect(result.trajectory).to.haveCalledTool('search_logs');
 *       await judge(result, 'identifies the failing dependency');
 *     });
 *   });
 *
 * The describe body MUST be synchronous (no `await`/dynamic content), like
 * Playwright. The function is invoked once at registration time.
 */
export function describe(name: string, fn: () => void): void {
  emitExperimentalWarningOnce();
  if (!name || typeof name !== 'string') {
    throw new Error('describe() requires a name (the first argument)');
  }
  if (typeof fn !== 'function') {
    throw new Error(`describe("${name}") requires a body function`);
  }
  const state = getSharedState();
  state.describeStack.push(name);
  try {
    const result = fn() as unknown;
    if (result && typeof (result as any).then === 'function') {
      // Mirror Playwright — describe bodies must be synchronous because
      // they run during registration, well before any test executes.
      throw new Error(
        `describe("${name}") body returned a Promise. ` +
        `describe blocks must be synchronous — use test() inside, not await.`
      );
    }
  } finally {
    state.describeStack.pop();
  }
}

export function getRegisteredTests(filePath?: string): CodeTestCase[] {
  const state = getSharedState();
  if (filePath) return [...(state.registries.get(filePath) ?? [])];
  return [...state.registries.values()].flatMap(r => [...r]);
}

/**
 * Return all hooks registered for the given file (or every file when no
 * argument is given). Returns a snapshot — mutating the result has no
 * effect on the registry.
 */
export function getRegisteredHooks(filePath?: string): RegisteredHook[] {
  const state = getSharedState();
  if (filePath) return [...(state.hookRegistries.get(filePath) ?? [])];
  return [...state.hookRegistries.values()].flatMap(r => [...r]);
}

export function clearRegistry(filePath?: string): void {
  const state = getSharedState();
  if (filePath) {
    state.registries.delete(filePath);
    state.hookRegistries.delete(filePath);
  } else {
    state.registries.clear();
    state.hookRegistries.clear();
  }
  state.activeFile = null;
}

/**
 * Internal helper used by the four public hook registrars below.
 *
 * Captures the live `(activeFile, [...describeStack])` so the orchestrator
 * can filter hooks by scope at run time. Multiple hooks of the same kind
 * in the same scope are allowed and run in registration order (reversed
 * for `afterEach`/`afterAll`, mirroring Playwright/Jest).
 */
function registerHook(kind: HookKind, fn: HookFn): void {
  emitExperimentalWarningOnce();
  if (typeof fn !== 'function') {
    throw new Error(`${kind}() requires a function as its first argument`);
  }
  const state = getSharedState();
  const key = state.activeFile ?? DEFAULT_KEY;
  if (!state.hookRegistries.has(key)) {
    state.hookRegistries.set(key, []);
  }
  const describePath = state.describeStack.length > 0 ? state.describeStack.join(' > ') : undefined;
  state.hookRegistries.get(key)!.push({
    kind,
    fn,
    sourceFile: state.activeFile ?? undefined,
    describePath,
  });
}

/**
 * Register a hook that runs **once** before the first test in its scope.
 *
 * Scope is the surrounding `describe(...)` block, or the whole file when
 * called at the top level. With parallel test execution (the runner
 * dispatches up to `concurrency` tests at once), the orchestrator uses a
 * once-latch so all parallel arrivals await the same `beforeAll` promise.
 *
 * @example
 *   beforeAll(async () => {
 *     await fs.mkdir('/tmp/agent-health-fixtures', { recursive: true });
 *   });
 */
export function beforeAll(fn: HookFn): void { registerHook('beforeAll', fn); }

/**
 * Register a hook that runs **once** after the last test in its scope.
 *
 * Always runs, even when every test in the scope failed. The orchestrator
 * uses a remaining-test counter (decremented on each test completion,
 * regardless of pass/fail) and triggers `afterAll` when it hits zero.
 *
 * @example
 *   afterAll(async () => {
 *     await fs.rm('/tmp/agent-health-fixtures', { recursive: true });
 *   });
 */
export function afterAll(fn: HookFn): void { registerHook('afterAll', fn); }

/**
 * Register a hook that runs **before each test** in its scope.
 *
 * Receives the same fixtures object the body will see, plus a
 * `provide(key, value)` function for stashing values that the test body
 * (and `afterEach`) can read via `fixtures.provisioned[key]`. Each test
 * gets its own provisioned bag, so concurrent tests are isolated.
 *
 * @example
 *   beforeEach(async ({ provide, testInfo }) => {
 *     const dir = await fs.mkdtemp(`/tmp/${testInfo.name}-`);
 *     provide('workspaceDir', dir);
 *   });
 */
export function beforeEach(fn: HookFn): void { registerHook('beforeEach', fn); }

/**
 * Register a hook that runs **after each test** in its scope.
 *
 * Always runs, even when the test body or a `beforeEach` threw. Reads
 * provisioned values via `fixtures.provisioned[key]` for cleanup. Errors
 * thrown from `afterEach` are captured as MatcherResult entries on the
 * test — they don't crash the runner.
 *
 * @example
 *   afterEach(async ({ provisioned }) => {
 *     if (provisioned.workspaceDir) {
 *       await fs.rm(provisioned.workspaceDir as string, { recursive: true, force: true });
 *     }
 *   });
 */
export function afterEach(fn: HookFn): void { registerHook('afterEach', fn); }

// Playwright-style sugar: `test.beforeEach(fn)` etc.
//
// Declaration merging here gives TypeScript users typed access to the four
// hook registrars *and* installs them as properties on the runtime `test`
// function value. Both `import { beforeEach }` and `test.beforeEach` route
// to the same internal registerHook() call.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace test {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  export const beforeAll: (fn: HookFn) => void = (fn) => registerHook('beforeAll', fn);
  // eslint-disable-next-line @typescript-eslint/no-shadow
  export const afterAll: (fn: HookFn) => void = (fn) => registerHook('afterAll', fn);
  // eslint-disable-next-line @typescript-eslint/no-shadow
  export const beforeEach: (fn: HookFn) => void = (fn) => registerHook('beforeEach', fn);
  // eslint-disable-next-line @typescript-eslint/no-shadow
  export const afterEach: (fn: HookFn) => void = (fn) => registerHook('afterEach', fn);
}
