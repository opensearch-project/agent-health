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

const registries = new Map<string, CodeTestCase[]>();
// Hooks live in a parallel registry keyed by file path, exactly matching
// the test() registry. The HookOrchestrator filters by describePath at
// run time. Cross-file hooks never leak — the loader resets per file.
const hookRegistries = new Map<string, RegisteredHook[]>();
let activeFile: string | null = null;
const DEFAULT_KEY = '__default__';

// Active describe stack (synchronous push/pop). Each entry is a describe
// name; nested describes accumulate. When test() runs, it captures the
// current stack and joins with ' > ' to derive the test's benchmarkPath.
const describeStack: string[] = [];

// Emit a one-time experimental-status warning the first time the SDK is
// touched, unless the user opts out. This is intentionally noisy enough to be
// noticed but only fires once per process so it doesn't pollute test output.
let experimentalWarningEmitted = false;
function emitExperimentalWarningOnce(): void {
  if (experimentalWarningEmitted) return;
  experimentalWarningEmitted = true;
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
  experimentalWarningEmitted = false;
}

export function setActiveFile(filePath: string): void {
  activeFile = filePath;
  if (!registries.has(filePath)) {
    registries.set(filePath, []);
  }
  if (!hookRegistries.has(filePath)) {
    hookRegistries.set(filePath, []);
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

  const key = activeFile ?? DEFAULT_KEY;
  if (!registries.has(key)) {
    registries.set(key, []);
  }
  const registry = registries.get(key)!;

  // Within-file uniqueness guard: a name+benchmarkPath pair must be unique.
  // The same name in two different describe blocks is allowed because they
  // map to different benchmarks.
  const benchmarkPath = describeStack.length > 0 ? describeStack.join(' > ') : undefined;
  if (registry.some(t => t.name === name && t.benchmarkPath === benchmarkPath)) {
    const fileLabel = activeFile ? ` in ${activeFile}` : '';
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
    sourceFile: activeFile ?? undefined,
    benchmarkPath,
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
  describeStack.push(name);
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
    describeStack.pop();
  }
}

export function getRegisteredTests(filePath?: string): CodeTestCase[] {
  if (filePath) return [...(registries.get(filePath) ?? [])];
  return [...registries.values()].flatMap(r => [...r]);
}

/**
 * Return all hooks registered for the given file (or every file when no
 * argument is given). Returns a snapshot — mutating the result has no
 * effect on the registry.
 */
export function getRegisteredHooks(filePath?: string): RegisteredHook[] {
  if (filePath) return [...(hookRegistries.get(filePath) ?? [])];
  return [...hookRegistries.values()].flatMap(r => [...r]);
}

export function clearRegistry(filePath?: string): void {
  if (filePath) {
    registries.delete(filePath);
    hookRegistries.delete(filePath);
  } else {
    registries.clear();
    hookRegistries.clear();
  }
  activeFile = null;
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
  const key = activeFile ?? DEFAULT_KEY;
  if (!hookRegistries.has(key)) {
    hookRegistries.set(key, []);
  }
  const describePath = describeStack.length > 0 ? describeStack.join(' > ') : undefined;
  hookRegistries.get(key)!.push({
    kind,
    fn,
    sourceFile: activeFile ?? undefined,
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
