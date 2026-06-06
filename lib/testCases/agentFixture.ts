/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `agent` fixture — RFC 004 control inversion (#256, §4.1).
 *
 * Instead of the framework eagerly invoking the agent before the test body
 * runs, the body drives invocation itself, exactly the way a Playwright test
 * calls `await page.goto(...)`:
 *
 * ```js
 * test('payment RCA', async ({ agent, expect, judge }) => {
 *   const id = await seedTicket();                 // setup BEFORE the agent
 *   const result = await agent.run(`Triage ${id}`);
 *   expect(result).toHaveCalledTool('search_logs');
 *   await judge(result, 'identifies the DB outage');
 * });
 * ```
 *
 * **Exactly one invocation per test (enforced).** The goal is to *benchmark*
 * an agent: one test ⇒ one invocation ⇒ one comparable trajectory. A second
 * `agent.run()` throws. Multi-turn conversations, if a connector models them,
 * happen inside that single run — they are not multiple harness invocations.
 *
 * This module owns only the **contract** and the one-run guard. The actual
 * connector invocation + RunResult construction (trajectory accessor, lazy
 * traces, runId correlation) is supplied by the runner via the `invoke`
 * callback, since that requires server-side connector/trace machinery.
 */

import type { EvalResult } from './types.js';

/** Options accepted by `agent.run(prompt, options)`. */
export interface AgentRunOptions {
  /** Context items passed to the agent alongside the prompt. */
  context?: { description: string; value: string }[];
  /**
   * Structured values forwarded to the connector's payload builder (e.g. a
   * provisioned workspace dir). Stringly-typed env is the lowest common
   * denominator every subprocess connector inherits automatically.
   */
  env?: Record<string, string>;
}

/**
 * The single capability the framework hands the test body. `run()` is the
 * agent equivalent of Playwright's `page.goto()`.
 */
export interface AgentFixture {
  /**
   * Invoke the agent once and return a fully-captured result (trajectory,
   * output, runId, traces). Throws if called more than once in a test, or if
   * no prompt is available (none passed and no `defaultPrompt` configured).
   */
  run(prompt?: string, options?: AgentRunOptions): Promise<EvalResult>;
  /** True once `run()` has been called (read-only introspection). */
  readonly invoked: boolean;
}

/** The runner-supplied invocation implementation. */
export type AgentInvokeFn = (
  prompt: string,
  options?: AgentRunOptions
) => Promise<EvalResult>;

export interface CreateAgentFixtureOptions {
  /**
   * Prompt used when `agent.run()` is called with no argument. Mirrors the
   * test's `defaultPrompt` (discovery/UI display). When neither is present,
   * `run()` throws rather than invoking with an empty prompt.
   */
  defaultPrompt?: string;
  /** Default context merged under any per-call context. */
  defaultContext?: { description: string; value: string }[];
}

/**
 * Build an {@link AgentFixture} around a runner-supplied {@link AgentInvokeFn}.
 *
 * Enforces the one-invocation-per-test rule and resolves the effective
 * prompt/context (per-call argument wins over the test's `defaultPrompt` /
 * `defaultContext`). The `invoke` callback does the real work (connector +
 * RunResult wrapping) and is only ever called at most once.
 */
export function createAgentFixture(
  invoke: AgentInvokeFn,
  options: CreateAgentFixtureOptions = {}
): AgentFixture {
  let invoked = false;

  return {
    get invoked() {
      return invoked;
    },
    async run(prompt?: string, runOptions?: AgentRunOptions): Promise<EvalResult> {
      if (invoked) {
        throw new Error(
          'agent.run() may be called at most once per test. Benchmarking ' +
          'requires exactly one agent invocation per test so trajectories ' +
          'stay comparable across runs. For multi-turn conversations, model ' +
          'the turns inside a single run via your connector.'
        );
      }
      const effectivePrompt = prompt ?? options.defaultPrompt;
      if (effectivePrompt == null || effectivePrompt === '') {
        throw new Error(
          'agent.run() requires a prompt — none was passed and the test has ' +
          'no `defaultPrompt`. Pass a prompt: `await agent.run("...")`.'
        );
      }
      // Mark invoked BEFORE awaiting so a concurrent/re-entrant second call
      // (e.g. forgetting to await) still trips the guard deterministically.
      invoked = true;

      const mergedContext = [
        ...(options.defaultContext ?? []),
        ...(runOptions?.context ?? []),
      ];
      const context = mergedContext.length > 0 ? mergedContext : undefined;

      return invoke(effectivePrompt, { ...runOptions, context });
    },
  };
}
