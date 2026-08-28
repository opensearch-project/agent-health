/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryStep } from '@/types';
import type { TracesAccessor } from '../matchers/index.js';

/**
 * Options for a code-based test case.
 *
 * All fields are optional. Only the test name (the first argument to
 * `test()`) is required. When `prompt` is omitted, the runner skips agent
 * invocation entirely and the test body runs against an empty EvalResult —
 * useful for purely deterministic / data-driven tests.
 *
 * Categories and difficulty levels live in `labels` as prefixed strings
 * (e.g. `'category:RCA'`, `'difficulty:Medium'`). The legacy top-level
 * `category` / `difficulty` keys were removed in favor of this single
 * unified tagging system.
 */
export interface TestOptions {
  /**
   * Initial prompt sent to the agent. When omitted, the runner does not
   * invoke the agent and the test body receives an empty EvalResult.
   */
  prompt?: string;
  /** Free-form description shown in the UI. */
  description?: string;
  /** Additional context items passed to the agent alongside the prompt. */
  context?: { description: string; value: string; disposition?: 'prompt' | 'connector' | 'documentation' }[];
  /**
   * Labels for filtering and grouping. Use prefixed strings for what was
   * previously `category` and `difficulty`:
   * `['category:RCA', 'difficulty:Medium', 'team:platform']`.
   */
  labels?: string[];
  /** Per-test timeout override in milliseconds. */
  timeout?: number;
  /**
   * Plain-text descriptions of expected agent behaviour, used by the
   * server-side LLM judge and by importers/exporters that round-trip
   * test cases through JSON. Forwarded to the persisted test case so
   * server evaluators (`-e <evaluator>`) can grade against the same
   * criteria a human reviewer would write into the JSON form.
   *
   * Inline `judge(result, criteria)` from a test body does NOT need this
   * field — the body passes the claim directly to /api/judge. Set this
   * when you want the criteria to (a) live with the test definition for
   * non-code consumers, or (b) be available to a server-side evaluator
   * that runs alongside or instead of the body.
   */
  expectedOutcomes?: string[];
  /**
   * Optional reference trajectory for trajectory-alignment evaluators and
   * Golden Path comparison. Leave undefined when the test only cares about
   * outcome quality, not the specific path the agent took.
   *
   * Shape mirrors `TestCase.expectedTrajectory` in `@/types` so the
   * upsert path can forward without coercion.
   */
  expectedTrajectory?: {
    step: number;
    description: string;
    requiredTools: string[];
  }[];
}

/**
 * The trajectory accessor namespace exposed via EvalResult.trajectory in
 * the new SDK. It IS the same array returned by the runner so users can
 * iterate freely; the helpers are added as non-enumerable methods so
 * `for/of` and JSON.stringify behave naturally.
 */
export interface TrajectoryAccessor extends Array<TrajectoryStep> {
  /** Steps of the given type, in order of occurrence. */
  stepsOfType(type: string): TrajectoryStep[];
  /** All `action` steps, optionally filtered by toolName and partial args. */
  toolCalls(name?: string, argsPartial?: Record<string, unknown>): TrajectoryStep[];
  /** First action-step matching, with `.index` annotated for ordering checks, or null. */
  firstToolCall(
    name?: string,
    argsPartial?: Record<string, unknown>
  ): (TrajectoryStep & { index: number }) | null;
}

export interface CodeTestCase {
  name: string;
  options: TestOptions;
  evaluate: TestBodyFn | LegacyEvaluateFn;
  /** Resolved file the test was registered from — set by the loader. */
  sourceFile?: string;
  /**
   * Benchmark group path — the joined `describe('...', ...)` names that
   * wrapped this `test()` call, joined with ' > ' for nested describes.
   * `undefined` when the test was registered outside any describe; the
   * loader/CLI then puts the test into the file-default benchmark.
   */
  benchmarkPath?: string;
}

/**
 * The Playwright-style test body signature: receives a fixtures object
 * with `result`, `judge`, `traces`, and `expect`.
 */
export type TestBodyFn = (fixtures: TestFixtures) => Promise<void> | void;

/**
 * Legacy single-arg signature kept for backward compatibility. Old code
 * that did `test(name, opts, async (result) => { ... })` keeps working.
 */
export type LegacyEvaluateFn = (result: EvalResult) => Promise<void> | void;

export interface TestFixtures {
  result: EvalResult;
  judge: typeof import('./judge.js').judge;
  traces: TracesAccessor;
  expect: typeof import('../matchers/expect.js').expect;
  /**
   * The `agent` fixture (RFC 004 control inversion). The test body calls
   * `await agent.run(prompt)` to drive the agent itself, instead of the
   * framework invoking eagerly before the body. Optional during the
   * transition: present when the runner provides it; `result` remains for
   * the legacy eager path. Enforces one invocation per test.
   */
  agent?: import('./agentFixture.js').AgentFixture;
  /**
   * The `evaluate` fixture (RFC 004 §4.4): run a custom programmatic
   * evaluator registered via `defineEvaluator()`. Gates by default;
   * `.observe()` feeds score/insights only.
   */
  evaluate?: import('./evaluators.js').EvaluateFn;
  /**
   * Static, read-only metadata about the currently-executing test. Useful
   * for naming temp dirs, logging, and routing — never mutate.
   */
  testInfo: TestInfo;
  /**
   * Values made available by `beforeEach` hooks via `provide(key, value)`.
   * Always present (empty when no hooks ran). Read-only from the test body.
   */
  provisioned: Readonly<Record<string, unknown>>;
  /**
   * Only present inside `beforeEach` hooks. Stores a value into the
   * provisioned bag for this test. The orchestrator handed to the test
   * body and `afterEach` does NOT include `provide` (it's `undefined`),
   * so referencing `fixtures.provide` outside `beforeEach` is a runtime
   * error — not a no-op. Read provisioned values via
   * `fixtures.provisioned[key]` instead.
   */
  provide?: (key: string, value: unknown) => void;
}

/**
 * Static metadata about a test execution, exposed via `fixtures.testInfo`
 * and `hookContext.testInfo`. Frozen at the start of the test so hooks and
 * body see the same values.
 */
export interface TestInfo {
  /** Test name as registered with `test(name, ...)`. */
  name: string;
  /**
   * Joined describe path, e.g. `'A > B'`. `undefined` when the test was
   * registered outside any describe block.
   */
  benchmarkPath?: string;
  /**
   * The eval source file the test was loaded from (the absolute path the
   * loader resolved). `undefined` for tests registered outside the loader
   * (e.g. unit tests that call `test()` directly).
   */
  sourceFile?: string;
  /**
   * Storage id of the test case for this run. `undefined` when the
   * orchestrator runs without a backing storage layer (unit tests).
   */
  testCaseId?: string;
}

/**
 * Lifecycle hook kinds, modelled after Playwright. `beforeAll`/`afterAll`
 * run once per scope (file or describe); `beforeEach`/`afterEach` run
 * around every matching test in the scope.
 */
export type HookKind = 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach';

/**
 * The function signature accepted by every hook. Receives the same
 * fixtures object the test body sees. `beforeEach` may call
 * `fixtures.provide(key, value)` to expose values to the body / `afterEach`.
 */
export type HookFn = (fixtures: TestFixtures) => Promise<void> | void;

/**
 * One registered hook, captured at registration time. The scope chain is
 * the joined describe path (`undefined` at file top level), exactly
 * matching how `test()` records `benchmarkPath`.
 */
export interface RegisteredHook {
  kind: HookKind;
  fn: HookFn;
  /** File path the hook was registered from (set by the loader). */
  sourceFile?: string;
  /**
   * Joined describe path the hook lives in, e.g. `'A > B'`. `undefined`
   * means the hook is file-scoped (outside any describe).
   */
  describePath?: string;
}

export interface EvalResult {
  /** All trajectory steps with sugar accessors (toolCalls, firstToolCall, etc.). */
  trajectory: TrajectoryAccessor;
  /** Concatenated final response text from the agent's `assistant`/`response` steps. */
  agentOutput: string;
  /** Convenience: same as agentOutput. Returns the last assistant text. */
  finalResponse(): string;
  /** Try-parse `agentOutput` as JSON. Returns undefined when not parseable. */
  parsedOutput(): unknown;
  /** Raw AG-UI events as received from the agent. */
  rawEvents: any[];
  /** Agent-supplied run id (for log/trace correlation). */
  runId?: string;
  /** Wall-clock duration of the agent invocation in ms (0 when no prompt). */
  durationMs: number;
  /** Token usage when reported by the agent. */
  tokenUsage?: { prompt: number; completion: number; total: number };
  /**
   * OTel traces for this run, available after `agent.run()` resolves
   * (RFC 004 §4.6). Mirrors the standalone `traces` fixture but scoped to
   * the result, so `result.traces.totalTokens` reads the same data. Present
   * only on results returned by `agent.run()`; reading it on the empty
   * placeholder (before `agent.run()`) yields the loud-failure accessor.
   */
  traces?: import('../matchers/traces.js').TracesAccessor;

  /**
   * Strategy-C trace-correlation hints (`{ serviceName, startedAt, endedAt }[]`)
   * the runner computed for this run's agent. Forwarded by `judge()` as
   * `JudgeRequest.agents` so the agent (trace) judge can find the run's spans
   * in OpenSearch by service-name + window — the SAME hints the classic
   * `waitForTracesAndJudge` path builds via `buildJudgeAgentsHints`. This is
   * what brings SDK `judge()` to parity with the UI/runner trace-judge path
   * (without it the SDK judge only sends `runId`, which misses subprocess
   * agents' spans). Present only when the runner could derive a service name.
   */
  judgeAgents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
}
