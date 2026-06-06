/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `defineEvaluator()` + `evaluate()` — custom programmatic evaluators
 * (RFC 004 §4.4, closes #244).
 *
 * Not every check is an LLM judge or a chai assertion. Sometimes the
 * ground truth lives in code: a SQL result must match a golden row set, a
 * generated diff must apply cleanly, a JSON answer must validate against a
 * schema. A custom evaluator is a plain function that inspects the run and
 * returns a verdict — deterministic, free, and fully under the author's
 * control.
 *
 * ```js
 * const { defineEvaluator, test } = require('@opensearch-project/agent-health');
 *
 * defineEvaluator('sql-matches-golden', ({ result }) => {
 *   const rows = JSON.parse(result.agentOutput);
 *   return { pass: deepEqual(rows, GOLDEN), reasoning: 'row set comparison' };
 * });
 *
 * test('answers the revenue query', { prompt: '...' }, async ({ agent, evaluate }) => {
 *   const result = await agent.run();
 *   await evaluate(result, 'sql-matches-golden');
 * });
 * ```
 *
 * Evaluators are registered into a process-global registry by id (like a
 * shared helper library), and run **in-process** when the body calls
 * `evaluate()`. They record a `MatcherResult` with `method: 'evaluator'`,
 * gate the test by default, and support an `.observe()` variant that feeds
 * score/insights only — mirroring the `judge` fixture.
 */

import type { EvalResult } from './types.js';
import type { TracesAccessor } from '../matchers/traces.js';
import type { JudgeRole, Verdict } from './judge.js';
import { recordVerdict } from '../matchers/session.js';

/** Context handed to a custom evaluator. */
export interface EvaluatorContext {
  /** The agent run under evaluation. */
  result: EvalResult;
  /** Optional free-form criteria string passed at the call site. */
  criteria?: string;
  /** Run-scoped OTel traces, when available (same as `result.traces`). */
  traces?: TracesAccessor;
}

/** What a custom evaluator returns. */
export interface EvaluatorResult {
  /** Whether the check passed. */
  pass: boolean;
  /** Optional normalised score on the [0, 1] interval. */
  score?: number;
  /** Human-readable explanation (shown in the per-matcher breakdown). */
  reasoning?: string;
}

export type EvaluatorFn = (
  ctx: EvaluatorContext
) => EvaluatorResult | Promise<EvaluatorResult>;

const evaluatorRegistry = new Map<string, EvaluatorFn>();

/**
 * Register a custom evaluator under `id`.
 *
 * Registering the **same function** under an id again is a no-op (a watched
 * file re-loading the identical module is fine). Registering a *different*
 * function under an id that's already taken throws: the registry is
 * process-global (shared like a helper library), so two `.eval.{js,ts}` files
 * defining `defineEvaluator('len-check', …)` with different bodies would
 * otherwise silently shadow each other based on load order. Fail loudly so the
 * collision is visible at authoring time. Use distinct ids (or a shared helper
 * module) when you need different implementations.
 */
export function defineEvaluator(id: string, fn: EvaluatorFn): void {
  if (!id || typeof id !== 'string') {
    throw new Error('defineEvaluator(id, fn): id must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new Error(`defineEvaluator('${id}', fn): fn must be a function`);
  }
  const existing = evaluatorRegistry.get(id);
  if (existing && existing !== fn) {
    throw new Error(
      `defineEvaluator('${id}', ...): an evaluator with id '${id}' is already ` +
        `registered with a different function. Evaluator ids are global — use a ` +
        `unique id per evaluator (or share one function) to avoid silent shadowing.`
    );
  }
  evaluatorRegistry.set(id, fn);
}

/** Look up a registered evaluator by id. @internal */
export function getEvaluator(id: string): EvaluatorFn | undefined {
  return evaluatorRegistry.get(id);
}

/** Clear all registered evaluators (test isolation / per-load reset). @internal */
export function clearEvaluators(): void {
  evaluatorRegistry.clear();
}

/** Build a {@link Verdict} from a custom-evaluator result. */
function evaluatorVerdict(
  r: EvaluatorResult,
  role: JudgeRole,
  errored: boolean,
  errorMessage?: string
): Verdict {
  const verdict: Verdict = {
    passFailStatus: r.pass ? 'passed' : 'failed',
    accuracy: typeof r.score === 'number' ? r.score * 100 : (r.pass ? 100 : 0),
    score: typeof r.score === 'number' ? r.score : (r.pass ? 1 : 0),
    reasoning: r.reasoning ?? '',
    pass: r.pass,
    role,
    skipped: false,
    errored,
    errorMessage,
    orThrow() {
      if (this.pass || this.skipped) return this;
      const label = this.errored ? 'errored' : 'FAILED';
      throw new Error(
        `Evaluator: ${label}\n${this.errorMessage ?? this.reasoning}`
      );
    },
  };
  return verdict;
}

async function runEvaluator(
  result: EvalResult,
  evaluatorId: string,
  criteria: string | undefined,
  role: JudgeRole
): Promise<Verdict> {
  const fn = getEvaluator(evaluatorId);
  const description = `evaluate: ${evaluatorId}${criteria ? ` — ${criteria}` : ''}`;

  if (!fn) {
    // Unknown evaluator id — this is an authoring error the run can't
    // recover from. Record it as errored (excluded from pass-rate).
    const msg = `No evaluator registered with id '${evaluatorId}'. Did you call defineEvaluator('${evaluatorId}', ...)?`;
    recordVerdict({
      description, pass: false, method: 'evaluator', role, errored: true,
      durationMs: 0, errorMessage: msg, reasoning: '',
    });
    return evaluatorVerdict({ pass: false }, role, true, msg);
  }

  const startedAt = Date.now();
  let out: EvaluatorResult;
  try {
    out = await fn({ result, criteria, traces: result.traces });
  } catch (err: any) {
    const msg = err?.message || String(err);
    recordVerdict({
      description, pass: false, method: 'evaluator', role, errored: true,
      durationMs: Date.now() - startedAt, errorMessage: `Evaluator threw: ${msg}`, reasoning: '',
    });
    return evaluatorVerdict({ pass: false }, role, true, `Evaluator threw: ${msg}`);
  }

  const verdict = evaluatorVerdict(out, role, false);
  recordVerdict({
    description,
    pass: verdict.pass,
    method: 'evaluator',
    role,
    durationMs: Date.now() - startedAt,
    score: verdict.score,
    reasoning: verdict.reasoning,
    errorMessage: verdict.pass ? undefined : (verdict.reasoning || 'evaluator failed'),
  });
  return verdict;
}

/**
 * The `evaluate` fixture: run a registered custom evaluator against a
 * result. Gate role by default; `.observe()` records score/insights only.
 */
export interface EvaluateFn {
  (result: EvalResult, evaluatorId: string, criteria?: string): Promise<Verdict>;
  observe(result: EvalResult, evaluatorId: string, criteria?: string): Promise<Verdict>;
}

export const evaluate: EvaluateFn = Object.assign(
  (result: EvalResult, evaluatorId: string, criteria?: string) =>
    runEvaluator(result, evaluatorId, criteria, 'gate'),
  {
    observe: (result: EvalResult, evaluatorId: string, criteria?: string) =>
      runEvaluator(result, evaluatorId, criteria, 'observe'),
  }
);
