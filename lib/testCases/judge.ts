/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `judge()` — LLM-judge matcher, callable from inside a test body.
 *
 * Two ergonomic forms:
 *
 *   await judge(result, 'identifies the failing dependency');         // single claim
 *   await judge(result.trajectory, ['claim 1', 'claim 2']);            // legacy form
 *
 * Per-call options:
 *
 *   await judge(result, claim, { evaluatorId: 'system:cp-oncall' });
 *   await judge(result, claim, { model: 'claude-sonnet' });
 *
 * On pass: returns a JudgeVerdict and records a MatcherResult.
 * On fail: throws (so the test body bails out) and records a failed
 * MatcherResult before throwing.
 *
 * Calls the Agent Health server's /api/judge endpoint with the same
 * payload shape (`{ trajectory, expectedOutcomes, modelId, evaluatorId }`)
 * the UI "Run Test" path uses, so SDK and UI runs are scored by the same
 * judge prompt and provider routing.
 *
 * Run-level evaluator default: the runner injects a bound version of
 * `judge` into `TestFixtures` via `bindJudge(run.evaluatorId)`. Code
 * that destructures `judge` from the fixture (`async ({ judge }) => ...`)
 * automatically picks up the run's evaluator with no per-call argument.
 * Code that imports `judge` from the package gets the unbound version
 * and must pass `evaluatorId` explicitly.
 */

import type { TrajectoryStep } from '@/types';
import { recordVerdict } from '../matchers/session.js';

export interface JudgeVerdict {
  passFailStatus: 'passed' | 'failed';
  accuracy: number;
  reasoning: string;
}

/**
 * Per-call options for the SDK `judge()` matcher. Mirrors the relevant
 * fields of the `/api/judge` request body so SDK runs and UI runs use
 * the same judge prompt + evaluator + provider routing.
 */
export interface JudgeOptions {
  /**
   * Override the agent-health server URL. Defaults to
   * `http://localhost:${AGENT_HEALTH_PORT ?? 4001}`.
   */
  serverUrl?: string;
  /**
   * Override the judge model. Forwarded as `modelId` on the request body;
   * the server resolves it through `config.models[modelId]` exactly as it
   * does for UI runs.
   */
  model?: string;
  /**
   * Stored evaluator id (system or user). Forwarded as `evaluatorId` on
   * the request body. The server resolves system evaluators via
   * `getSystemEvaluatorById(...)` and user evaluators via
   * `storage.evaluators.getById(...)` — identical to the UI path. Falls
   * back to the default evaluator when omitted on both call and bind.
   */
  evaluatorId?: string;
}

let judgeCalledInCurrentEval = false;

export function wasJudgeCalled(): boolean {
  return judgeCalledInCurrentEval;
}

export function resetJudgeFlag(): void {
  judgeCalledInCurrentEval = false;
}

interface ResultLike {
  trajectory?: TrajectoryStep[];
  finalResponse?: () => string;
  agentOutput?: string;
}

function isTrajectory(x: unknown): x is TrajectoryStep[] {
  return Array.isArray(x);
}

function isResultLike(x: unknown): x is ResultLike {
  return typeof x === 'object' && x !== null && 'trajectory' in (x as object);
}

/**
 * Single-claim ergonomic form.
 * @example
 *   await judge(result, 'identifies the failing dependency');
 *   await judge(result, claim, { evaluatorId: 'system:cp-oncall' });
 */
export async function judge(
  resultOrTrajectory: ResultLike | TrajectoryStep[],
  claimOrClaims: string | string[],
  options?: JudgeOptions
): Promise<JudgeVerdict> {
  judgeCalledInCurrentEval = true;

  const trajectory = isTrajectory(resultOrTrajectory)
    ? resultOrTrajectory
    : (isResultLike(resultOrTrajectory) ? resultOrTrajectory.trajectory ?? [] : []);
  const claims = Array.isArray(claimOrClaims) ? claimOrClaims : [claimOrClaims];

  const serverUrl =
    options?.serverUrl ?? `http://localhost:${process.env.AGENT_HEALTH_PORT ?? '4001'}`;

  const description =
    claims.length === 1 ? `judge: ${claims[0]}` : `judge: ${claims.length} claims`;

  // Body shape matches the UI's /api/judge POST exactly: trajectory,
  // expectedOutcomes, expectedTrajectory, optional modelId, optional
  // evaluatorId. The server applies the same evaluator-resolution and
  // provider-routing logic regardless of caller, so SDK and UI runs
  // produce comparable verdicts.
  const requestBody: Record<string, unknown> = {
    trajectory,
    expectedOutcomes: claims,
    expectedTrajectory: [],
  };
  if (options?.model) requestBody.modelId = options.model;
  if (options?.evaluatorId) requestBody.evaluatorId = options.evaluatorId;

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    recordVerdict({
      description,
      pass: false,
      method: 'llm-judge',
      durationMs: Date.now() - startedAt,
      errorMessage: `Judge request failed: ${errMsg}`,
      reasoning: '',
    });
    throw new Error(`Judge request failed: ${errMsg}`);
  }

  if (!response.ok) {
    const text = await response.text();
    recordVerdict({
      description,
      pass: false,
      method: 'llm-judge',
      durationMs: Date.now() - startedAt,
      errorMessage: `Judge HTTP ${response.status}: ${text}`,
      reasoning: '',
    });
    throw new Error(`Judge request failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as any;
  const verdict: JudgeVerdict = {
    passFailStatus: result.passFailStatus ?? 'failed',
    accuracy: result.metrics?.accuracy ?? 0,
    reasoning: result.llmJudgeReasoning ?? '',
  };

  // Record once for the overall judge call.
  recordVerdict({
    description,
    pass: verdict.passFailStatus === 'passed',
    method: 'llm-judge',
    durationMs: Date.now() - startedAt,
    score: typeof verdict.accuracy === 'number' ? verdict.accuracy / 100 : undefined,
    reasoning: verdict.reasoning,
    model: options?.model,
    errorMessage: verdict.passFailStatus === 'failed' ? verdict.reasoning : undefined,
  });

  if (verdict.passFailStatus === 'failed') {
    throw new Error(`LLM Judge: FAILED (accuracy: ${verdict.accuracy})\n${verdict.reasoning}`);
  }

  return verdict;
}

/**
 * Bind run-level defaults to `judge` and return a callable with the same
 * signature. Used by the SDK runner to inject `run.evaluatorId` (and
 * optionally a default judge model) into the `TestFixtures.judge` slot,
 * so test bodies that destructure `({ judge })` automatically inherit
 * the run's evaluator selection — matching the UI's behaviour where the
 * evaluator picked on the run config applies to every judged test case.
 *
 * Per-call options always win over the bound defaults; pass an empty
 * object (or omit the field) to fall through to the bound value.
 *
 *   const boundJudge = bindJudge({ evaluatorId: run.evaluatorId });
 *   await boundJudge(result, claim);                                  // uses run.evaluatorId
 *   await boundJudge(result, claim, { evaluatorId: 'other' });        // overrides
 *   await boundJudge(result, claim, { evaluatorId: undefined });      // still uses bound default
 */
export function bindJudge(defaults?: {
  evaluatorId?: string;
  model?: string;
  serverUrl?: string;
}): typeof judge {
  // No defaults set → return the unbound function unchanged. Keeps zero
  // overhead for tests that don't use a run-level evaluator.
  if (!defaults || (!defaults.evaluatorId && !defaults.model && !defaults.serverUrl)) {
    return judge;
  }
  const bound: typeof judge = (resultOrTrajectory, claimOrClaims, options) => {
    // Per-call options win on every field that's actually set. We treat
    // an explicit `undefined` the same as a missing field — callers who
    // want to *clear* a bound default should pass an empty string or
    // call the unbound `judge` directly. Empirically this is what users
    // expect: `judge(r, c, { model: 'foo' })` should NOT wipe out the
    // run-level evaluatorId just because the user didn't repeat it.
    const merged: JudgeOptions = {
      serverUrl: options?.serverUrl ?? defaults.serverUrl,
      model: options?.model ?? defaults.model,
      evaluatorId: options?.evaluatorId ?? defaults.evaluatorId,
    };
    return judge(resultOrTrajectory, claimOrClaims, merged);
  };
  return bound;
}
