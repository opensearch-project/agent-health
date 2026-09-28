/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge failure classification shared by every judge provider and by the
 * `/api/judge` route + the in-process retry loop that calls it
 * (`services/evaluation/bedrockJudge.ts`).
 *
 * Why this exists: the pi-based judges (`piJudgeService`, `piAgenticJudgeService`)
 * used to collapse EVERY failure — a Bedrock "Input is too long for requested
 * model" context overflow, an expired credential, a CLI crash, a real
 * malformed verdict — into the single message "Failed to parse Pi judge
 * response. The CLI may have returned invalid JSON." Operators then saw a run
 * where 10/62 cases "returned invalid JSON" when in fact the model was never
 * able to read the prompt. And because the retry loop treats every non-4xx
 * failure as transient, each dead case was re-sent 10 times with the identical
 * input (~8.5 min of exponential backoff per case) before giving up.
 *
 * A {@link JudgeError} carries an {@link JudgeErrorClass} plus a `retryable`
 * flag so:
 *   - the route can return the class + flag to the client
 *     (`{ error, details, errorClass, retryable }`),
 *   - the client retry loop can stop immediately on deterministic classes and
 *     only spend its retry budget on transient ones,
 *   - `report.judgeFailureSummary` / `llmJudgeReasoning` show the REAL cause.
 */

import {
  type JudgeErrorClass,
  isRetryableJudgeErrorClass,
  maxJudgeAttemptsFor,
} from '@/lib/judgeErrorPolicy';

export { type JudgeErrorClass, isRetryableJudgeErrorClass, maxJudgeAttemptsFor };

export interface JudgeErrorOptions {
  errorClass: JudgeErrorClass;
  /** Override the class default. */
  retryable?: boolean;
  /** Redacted tail of the CLI's stderr (see {@link redactStderrTail}). */
  stderrTail?: string;
  /** Underlying error, if any. */
  cause?: unknown;
}

/** A classified judge failure. `message` is operator-facing and already names the cause. */
export class JudgeError extends Error {
  readonly errorClass: JudgeErrorClass;
  readonly retryable: boolean;
  readonly stderrTail?: string;
  readonly cause?: unknown;

  constructor(message: string, options: JudgeErrorOptions) {
    super(message);
    this.name = 'JudgeError';
    this.errorClass = options.errorClass;
    this.retryable = options.retryable ?? isRetryableJudgeErrorClass(options.errorClass);
    if (options.stderrTail) this.stderrTail = options.stderrTail;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Wire shape returned by `/api/judge` on failure. */
  toResponseBody(): { error: string; details: string; errorClass: JudgeErrorClass; retryable: boolean; stderrTail?: string } {
    const body: { error: string; details: string; errorClass: JudgeErrorClass; retryable: boolean; stderrTail?: string } = {
      error: `Judge evaluation failed: ${redactSecrets(this.message)}`,
      details: redactSecrets(this.message),
      errorClass: this.errorClass,
      retryable: this.retryable,
    };
    if (this.stderrTail) body.stderrTail = this.stderrTail;
    return body;
  }
}

export function isJudgeError(err: unknown): err is JudgeError {
  return err instanceof JudgeError || (!!err && typeof err === 'object' && (err as any).name === 'JudgeError' && typeof (err as any).errorClass === 'string');
}

/**
 * Classify a raw provider / CLI / SDK error message. Patterns are the ones
 * Bedrock, Anthropic, OpenAI-compatible endpoints and the pi CLI actually
 * emit; order matters (overflow before generic validation, auth before the
 * generic 4xx words).
 */
export function classifyJudgeErrorMessage(message: string | undefined | null): JudgeErrorClass {
  const msg = (message ?? '').toLowerCase();
  if (!msg) return 'unknown';
  if (
    /input is too long|too long for requested model|prompt is too long|context window|context[_ ]length|maximum context|exceeds the (model'?s? )?(maximum )?(context|token)|input length and `?max_tokens`?|too many (input )?tokens|token limit|request too large|payload too large/.test(msg)
  ) {
    return 'context_overflow';
  }
  if (/throttl|rate limit|too many requests|\b429\b|quota exceeded|slow down/.test(msg)) return 'throttling';
  if (/timed? ?out|etimedout|deadline exceeded|sigterm|sigkill|\baborted\b/.test(msg)) return 'timeout';
  if (/expiredtoken|expired token|credential|unrecognizedclient|invalid signature|security token|access ?denied|unauthori[sz]ed|forbidden|\b401\b|\b403\b|api key|authentication/.test(msg)) return 'auth';
  if (/not found\. install|enoent|command not found|pi cli not found|no such file/.test(msg)) return 'not_found';
  if (/econnrefused|econnreset|enotfound|eai_again|network ?error|failed to fetch|socket hang up|fetch failed|epipe/.test(msg)) return 'network';
  if (/\b50[0-4]\b|\b529\b|service ?unavailable|internal server error|overloaded|bad gateway|model is currently|temporarily unavailable/.test(msg)) return 'provider_error';
  if (/did not contain a json object|failed to parse judge json|invalid json|unexpected token|json parse|not valid json/.test(msg)) return 'invalid_json';
  if (/no (final|verdict) text|printed nothing|empty (stdout|response|output)|produced no (text|output)/.test(msg)) return 'empty_response';
  if (/validation ?error|validationexception|invalid request|malformed|bad request|\b400\b|\b422\b/.test(msg)) return 'validation';
  return 'unknown';
}

/**
 * Coerce any thrown value into a {@link JudgeError}. Already-classified errors
 * pass through; everything else is classified from its message.
 */
export function toJudgeError(err: unknown): JudgeError {
  if (isJudgeError(err)) return err;
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error occurred');
  return new JudgeError(message || 'Unknown error occurred', {
    errorClass: classifyJudgeErrorMessage(message),
    cause: err,
  });
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // AWS access key ids / secret keys / session tokens
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '<aws-access-key-id>'],
  [/(aws_secret_access_key|secretaccesskey|secret_key)\s*[=:]\s*\S+/gi, '$1=<redacted>'],
  [/(aws_session_token|sessiontoken|x-amz-security-token)\s*[=:]\s*\S+/gi, '$1=<redacted>'],
  // Bearer / API tokens
  [/bearer\s+[a-z0-9\-_.=]+/gi, 'Bearer <redacted>'],
  [/\b(sk|ghp|gho|xox[abp])-[a-z0-9\-_]{8,}/gi, '<token>'],
  [/(api[_-]?key|authorization|token|password|secret)(["']?\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1$2<redacted>'],
];

/** Mask obvious credentials in free text (no truncation). */
export function redactSecrets(text: string | undefined | null): string {
  if (!text) return '';
  let s = text;
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

/**
 * Keep the LAST `maxChars` of a CLI's stderr (where the actual failure
 * usually is) with obvious secrets masked so it can be surfaced in an error
 * message / persisted on the report without leaking credentials.
 */
export function redactStderrTail(stderr: string | undefined | null, maxChars = 600): string {
  if (!stderr) return '';
  let s = redactSecrets(stderr.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')); // strip ANSI, mask secrets
  s = s.trim();
  if (s.length > maxChars) s = '…' + s.slice(-maxChars);
  return s;
}
