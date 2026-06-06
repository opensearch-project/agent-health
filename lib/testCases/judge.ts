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
 *   await judge(result, claim, { evaluatorId: 'system-rca-default' });
 *   await judge(result, claim, { model: 'claude-sonnet' });
 *
 * On evaluation, `judge()` records a MatcherResult and returns a
 * {@link Verdict} **without throwing** (RFC 004 §4.8). A failing
 * `gate`-role verdict still fails the test (the runner inspects the
 * recorded results), but the body keeps running so every signal is
 * collected. To hard-stop the body on a bad verdict, call
 * `(await judge(...)).orThrow()` or assert `expect(verdict).toPass()`.
 *
 * Two roles:
 *   - `judge(result, claim)`         — gate: a failing verdict fails the test.
 *   - `judge.observe(result, claim)` — observe: feeds score + insights only,
 *                                       never fails the test.
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
import { readEnv } from '../envCompat.js';

/** Whether a judge signal gates the test verdict or is observational only. */
export type JudgeRole = 'gate' | 'observe';

/**
 * The result of a `judge()` call. Carries the verdict data plus a few
 * convenience flags and an explicit hard-stop escape hatch. Returned
 * (never thrown) so the body can collect multiple verdicts; the recorded
 * MatcherResult is what actually gates the test.
 *
 * Backward-compatible with the old `JudgeVerdict` (same
 * `passFailStatus`/`accuracy`/`reasoning` fields).
 */
export interface Verdict {
  passFailStatus: 'passed' | 'failed';
  /** Headline accuracy on the [0, 100] interval. */
  accuracy: number;
  /** Normalised score on the [0, 1] interval (`accuracy / 100`). */
  score: number;
  /** Free-form judge reasoning. */
  reasoning: string;
  /** Convenience: `passFailStatus === 'passed'`. */
  pass: boolean;
  /** Role this verdict was produced with (`gate` or `observe`). */
  role: JudgeRole;
  /** True when the judge was skipped (no LLM call was made). */
  skipped: boolean;
  /** True when the judge could not run at all (endpoint error). */
  errored: boolean;
  /** Underlying error message when `errored` is true. */
  errorMessage?: string;
  /**
   * Hard-stop: throw if the verdict did not pass. A no-op for passing,
   * skipped verdicts. Returns the verdict so it can be chained:
   *   const v = (await judge(result, claim)).orThrow();
   */
  orThrow(): Verdict;
}

/** @deprecated Use {@link Verdict}. Retained as a structural alias. */
export type JudgeVerdict = Verdict;

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
  /**
   * Skip the LLM call entirely. The judge returns a non-gating `skipped`
   * verdict (pass: true, skipped: true). Useful for fast/offline iteration.
   * The global `AH_SKIP_JUDGE=1` env var forces this for every judge call.
   */
  skip?: boolean;
}

// ─── Content-addressed verdict cache ────────────────────────────────────
// Identical judge inputs (evaluator + model + claims + trajectory) yield the
// same verdict, so we memoise the raw judge response per process. This keeps
// repeated judge() calls on the same result cheap (RFC 004 §4.5) — e.g. a
// ret ried test, or several claims that re-judge the same trajectory.
interface RawJudgeResponse {
  passFailStatus?: 'passed' | 'failed';
  metrics?: { accuracy?: number; [k: string]: number | undefined };
  llmJudgeReasoning?: string;
  improvementStrategies?: unknown[];
}
const verdictCache = new Map<string, RawJudgeResponse>();

/** Clear the in-process judge verdict cache (test isolation / new run). */
export function clearJudgeCache(): void {
  verdictCache.clear();
}

/**
 * Stable, collision-resistant cache key over the judging inputs. Uses
 * `sha256` when Node's crypto is available, falling back to a fast JS hash
 * so the SDK stays bundler-safe.
 */
function judgeCacheKey(input: {
  evaluatorId?: string;
  model?: string;
  claims: string[];
  trajectory: unknown;
}): string {
  const canonical = JSON.stringify({
    evaluatorId: input.evaluatorId ?? '',
    model: input.model ?? '',
    claims: input.claims,
    trajectory: input.trajectory,
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto');
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    // FNV-1a fallback — non-cryptographic but fine for cache addressing.
    let h = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i++) {
      h ^= canonical.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }
}

/** Whether judging is globally skipped via env (CLI `--no-judge`). */
function judgeSkippedByEnv(): boolean {
  const v = readEnv('AH_SKIP_JUDGE', 'AGENT_HEALTH_SKIP_JUDGE');
  return v === '1' || v === 'true' || v === 'yes';
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
  runId?: string;
}

function isTrajectory(x: unknown): x is TrajectoryStep[] {
  return Array.isArray(x);
}

function isResultLike(x: unknown): x is ResultLike {
  return typeof x === 'object' && x !== null && 'trajectory' in (x as object);
}

/**
 * Build a {@link Verdict} object with the `orThrow()` escape hatch attached.
 */
function makeVerdict(v: Omit<Verdict, 'orThrow' | 'pass' | 'score'> & { score?: number }): Verdict {
  const verdict: Verdict = {
    ...v,
    pass: v.passFailStatus === 'passed',
    score: v.score ?? (typeof v.accuracy === 'number' ? v.accuracy / 100 : 0),
    orThrow() {
      // Passing or skipped verdicts never throw. Failed/errored ones do.
      if (this.pass || this.skipped) return this;
      const label = this.errored ? 'errored' : 'FAILED';
      throw new Error(
        `LLM Judge: ${label} (accuracy: ${this.accuracy})\n${this.errorMessage ?? this.reasoning}`
      );
    },
  };
  return verdict;
}

/**
 * The callable `judge` surface: a function (gate role) with an `.observe`
 * method (observe role).
 */
export interface JudgeFn {
  (
    resultOrTrajectory: ResultLike | TrajectoryStep[],
    claimOrClaims: string | string[],
    options?: JudgeOptions
  ): Promise<Verdict>;
  /**
   * Observational judge: records the verdict for score + insights but does
   * NOT gate the test (a failing observe verdict never fails the run).
   */
  observe(
    resultOrTrajectory: ResultLike | TrajectoryStep[],
    claimOrClaims: string | string[],
    options?: JudgeOptions
  ): Promise<Verdict>;
}

/**
 * Core judge implementation. Records exactly one MatcherResult (carrying
 * `role`) and returns a non-throwing {@link Verdict}.
 */
async function runJudge(
  resultOrTrajectory: ResultLike | TrajectoryStep[],
  claimOrClaims: string | string[],
  options: JudgeOptions | undefined,
  role: JudgeRole
): Promise<Verdict> {
  judgeCalledInCurrentEval = true;

  const trajectory = isTrajectory(resultOrTrajectory)
    ? resultOrTrajectory
    : (isResultLike(resultOrTrajectory) ? resultOrTrajectory.trajectory ?? [] : []);
  // Agent run id for trace/log correlation — lets the agentic trace judge
  // scope its read-only tools to this single run. Only present when the
  // caller passed a RunResult (not a bare trajectory array).
  const runId = !isTrajectory(resultOrTrajectory) && isResultLike(resultOrTrajectory)
    ? resultOrTrajectory.runId
    : undefined;
  const claims = Array.isArray(claimOrClaims) ? claimOrClaims : [claimOrClaims];

  const serverUrl =
    options?.serverUrl ?? `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;

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
  if (runId) requestBody.runId = runId;

  // Record the success path identically whether the verdict came fresh from
  // the endpoint or from the in-process cache.
  const finalize = (raw: RawJudgeResponse, durationMs: number): Verdict => {
    const accuracy = raw.metrics?.accuracy ?? 0;
    const verdict = makeVerdict({
      passFailStatus: raw.passFailStatus ?? 'failed',
      accuracy,
      reasoning: raw.llmJudgeReasoning ?? '',
      role,
      skipped: false,
      errored: false,
    });
    recordVerdict({
      description,
      pass: verdict.pass,
      method: 'llm-judge',
      role,
      durationMs,
      score: verdict.score,
      reasoning: verdict.reasoning,
      model: options?.model,
      errorMessage: verdict.passFailStatus === 'failed' ? verdict.reasoning : undefined,
      // Preserve the rest of the judge payload — these were silently
      // dropped before, which made SDK `judge()` calls strictly less
      // informative than the legacy auto-judge path. See MatcherResult.
      ...(Array.isArray(raw.improvementStrategies) && raw.improvementStrategies.length > 0
        ? { improvementStrategies: raw.improvementStrategies as any }
        : {}),
      ...(raw.metrics && typeof raw.metrics === 'object'
        ? { judgeMetrics: { ...raw.metrics } }
        : {}),
    });
    return verdict;
  };

  // SKIP: no LLM call. `skip` is tri-state and takes precedence over the env:
  //   skip === true   → always skip
  //   skip === false  → never skip (force the judge to run, even if AH_SKIP_JUDGE is set)
  //   skip undefined  → defer to AH_SKIP_JUDGE
  // This makes a per-call/bound `skip: false` a meaningful override rather than
  // having the env unconditionally win.
  const shouldSkip =
    options?.skip === true || (options?.skip !== false && judgeSkippedByEnv());
  if (shouldSkip) {
    recordVerdict({
      description: `${description} (skipped)`,
      pass: true,
      method: 'llm-judge',
      role: 'observe',
      durationMs: 0,
      reasoning: 'Judge skipped (AH_SKIP_JUDGE / skip option).',
    });
    return makeVerdict({
      passFailStatus: 'passed',
      accuracy: 0,
      reasoning: 'Judge skipped.',
      role,
      skipped: true,
      errored: false,
    });
  }

  // CACHE: identical (evaluator, model, claims, trajectory) → reuse verdict.
  const cacheKey = judgeCacheKey({
    evaluatorId: options?.evaluatorId,
    model: options?.model,
    claims,
    trajectory,
  });
  const cached = verdictCache.get(cacheKey);
  if (cached) {
    return finalize(cached, 0);
  }

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
    // Endpoint unreachable — the judge could not run. This is `errored`,
    // not a clean `pass: false`. The matcher is recorded with errored=true
    // so the run is bucketed as `errored` (excluded from pass-rate).
    recordVerdict({
      description,
      pass: false,
      method: 'llm-judge',
      role,
      errored: true,
      durationMs: Date.now() - startedAt,
      errorMessage: `Judge request failed: ${errMsg}`,
      reasoning: '',
    });
    return makeVerdict({
      passFailStatus: 'failed',
      accuracy: 0,
      reasoning: '',
      role,
      skipped: false,
      errored: true,
      errorMessage: `Judge request failed: ${errMsg}`,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    recordVerdict({
      description,
      pass: false,
      method: 'llm-judge',
      role,
      errored: true,
      durationMs: Date.now() - startedAt,
      errorMessage: `Judge HTTP ${response.status}: ${text}`,
      reasoning: '',
    });
    return makeVerdict({
      passFailStatus: 'failed',
      accuracy: 0,
      reasoning: '',
      role,
      skipped: false,
      errored: true,
      errorMessage: `Judge HTTP ${response.status}: ${text}`,
    });
  }

  const raw = (await response.json()) as RawJudgeResponse;
  // Only successful, non-errored verdicts are cached.
  verdictCache.set(cacheKey, raw);
  return finalize(raw, Date.now() - startedAt);
}

/**
 * Single-claim ergonomic form (gate role).
 * @example
 *   const v = await judge(result, 'identifies the failing dependency');
 *   if (!v.pass) { ... }                       // non-throwing
 *   (await judge(result, claim)).orThrow();      // explicit hard-stop
 *   await judge.observe(result, claim);          // score-only, never gates
 */
export const judge: JudgeFn = Object.assign(
  (
    resultOrTrajectory: ResultLike | TrajectoryStep[],
    claimOrClaims: string | string[],
    options?: JudgeOptions
  ): Promise<Verdict> => runJudge(resultOrTrajectory, claimOrClaims, options, 'gate'),
  {
    observe: (
      resultOrTrajectory: ResultLike | TrajectoryStep[],
      claimOrClaims: string | string[],
      options?: JudgeOptions
    ): Promise<Verdict> => runJudge(resultOrTrajectory, claimOrClaims, options, 'observe'),
  }
);

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
  skip?: boolean;
}): JudgeFn {
  // No defaults set → return the unbound function unchanged. Keeps zero
  // overhead for tests that don't use a run-level evaluator. Note `skip` is
  // compared against `undefined` (not falsiness) so a binding of
  // `{ skip: false }` — a meaningful "force the judge to run" — is preserved
  // rather than short-circuited to the unbound judge.
  if (
    !defaults ||
    (!defaults.evaluatorId && !defaults.model && !defaults.serverUrl && defaults.skip === undefined)
  ) {
    return judge;
  }
  const mergeOptions = (options?: JudgeOptions): JudgeOptions => ({
    // Per-call options win on every field that's actually set. We treat
    // an explicit `undefined` the same as a missing field — callers who
    // want to *clear* a bound default should pass an empty string or
    // call the unbound `judge` directly.
    serverUrl: options?.serverUrl ?? defaults.serverUrl,
    model: options?.model ?? defaults.model,
    evaluatorId: options?.evaluatorId ?? defaults.evaluatorId,
    skip: options?.skip ?? defaults.skip,
  });
  const bound: JudgeFn = Object.assign(
    (resultOrTrajectory: ResultLike | TrajectoryStep[], claimOrClaims: string | string[], options?: JudgeOptions) =>
      runJudge(resultOrTrajectory, claimOrClaims, mergeOptions(options), 'gate'),
    {
      observe: (resultOrTrajectory: ResultLike | TrajectoryStep[], claimOrClaims: string | string[], options?: JudgeOptions) =>
        runJudge(resultOrTrajectory, claimOrClaims, mergeOptions(options), 'observe'),
    }
  );
  return bound;
}
