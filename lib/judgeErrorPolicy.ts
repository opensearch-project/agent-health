/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge failure classes + the retry policy keyed on them.
 *
 * Lives in `lib/` (no server imports) because BOTH sides need it: the
 * `/api/judge` route stamps `errorClass` / `retryable` on its error body
 * (`server/services/judgeErrors.ts`), and the in-process retry loop that
 * calls the route (`services/evaluation/bedrockJudge.ts`, shared with the
 * browser bundle) reads them to decide whether re-sending the identical
 * request is worth another attempt.
 */

/**
 * Failure classes. `retryable` semantics per class are in
 * {@link isRetryableJudgeErrorClass}.
 */
export type JudgeErrorClass =
  /** Prompt (+ tool results) exceeded the model's context window. Deterministic. */
  | 'context_overflow'
  /** Missing / expired / rejected credentials. Deterministic until refreshed. */
  | 'auth'
  /** Provider throttling / rate limiting. Transient. */
  | 'throttling'
  /** Judge call or CLI exceeded its time budget. Transient. */
  | 'timeout'
  /** Could not reach the provider / backend. Transient. */
  | 'network'
  /** Provider-side 5xx / "service unavailable" / model overloaded. Transient. */
  | 'provider_error'
  /** CLI binary missing. Deterministic. */
  | 'not_found'
  /** CLI exited non-zero for a reason we could not classify further. */
  | 'cli_crash'
  /** Judge finished without emitting any verdict text at all. */
  | 'empty_response'
  /** Judge emitted text but it did not contain a parseable JSON verdict. */
  | 'invalid_json'
  /** Request rejected by the provider as invalid (not a context overflow). Deterministic. */
  | 'validation'
  /** Anything else. Treated as transient so a one-off glitch is still retried. */
  | 'unknown';

/**
 * Whether the retry loop should re-send the identical request for a class.
 * Deterministic input problems (overflow, auth, validation, missing CLI,
 * empty/invalid verdicts) are NOT retryable — retrying the same prompt yields
 * the same answer. `invalid_json` / `empty_response` are model-output
 * failures; they are also marked non-retryable here but the client grants
 * them a *small* extra budget (see {@link maxJudgeAttemptsFor}) because LLM
 * output is stochastic enough that one re-roll is worth a few seconds.
 */
export function isRetryableJudgeErrorClass(cls: JudgeErrorClass): boolean {
  switch (cls) {
    case 'throttling':
    case 'timeout':
    case 'network':
    case 'provider_error':
    case 'cli_crash':
    case 'unknown':
      return true;
    default:
      return false;
  }
}

/**
 * Attempt budget the client retry loop grants per class. `defaultMax` is
 * the loop's configured ceiling (historically 10).
 *   - known-transient classes (throttling/timeout/network/provider_error): full budget
 *   - `unknown` / `cli_crash`: 3 (retryable, but usually a deterministic bug)
 *   - `invalid_json` / `empty_response`: 2 (one re-roll)
 *   - other deterministic classes: 1 (no retry)
 */
export function maxJudgeAttemptsFor(cls: JudgeErrorClass | undefined, defaultMax: number): number {
  if (!cls) return defaultMax;
  // Unclassified failures and CLI crashes are retryable in principle, but
  // most of them are deterministic bugs — a bounded budget (3) catches a
  // one-off blip without the 10× stall.
  if (cls === 'unknown' || cls === 'cli_crash') return Math.min(3, defaultMax);
  if (isRetryableJudgeErrorClass(cls)) return defaultMax;
  if (cls === 'invalid_json' || cls === 'empty_response') return Math.min(2, defaultMax);
  return 1;
}

