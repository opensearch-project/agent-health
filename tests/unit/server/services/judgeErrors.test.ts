/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  JudgeError,
  classifyJudgeErrorMessage,
  isJudgeError,
  isRetryableJudgeErrorClass,
  maxJudgeAttemptsFor,
  redactSecrets,
  redactStderrTail,
  toJudgeError,
} from '@/server/services/judgeErrors';

describe('judgeErrors — classification', () => {
  it.each([
    ['Validation error: The model returned the following errors: Input is too long for requested model.', 'context_overflow'],
    ['prompt is too long: 214000 tokens > 200000 maximum', 'context_overflow'],
    ['ThrottlingException: Too many requests, please wait before trying again.', 'throttling'],
    ['HTTP 429 rate limit exceeded', 'throttling'],
    ['Pi CLI killed by SIGTERM after 300s', 'timeout'],
    ['ETIMEDOUT connecting to bedrock-runtime', 'timeout'],
    ['ExpiredTokenException: The security token included in the request is expired', 'auth'],
    ['CredentialsProviderError: Could not load credentials from any providers', 'auth'],
    ['Pi CLI not found. Install it from https://pi.dev', 'not_found'],
    ['fetch failed: ECONNREFUSED 127.0.0.1:4001', 'network'],
    ['ServiceUnavailableException: Bedrock is unable to process your request (503)', 'provider_error'],
    ['AgentJudge: judge response did not contain a JSON object. First 200 chars: ', 'invalid_json'],
    ['PiJudge: failed to parse judge JSON (Unexpected token } in JSON at position 4)', 'invalid_json'],
    ['Pi CLI exited 0 but printed nothing to stdout (no judge verdict)', 'empty_response'],
    ['ValidationException: 1 validation error detected: messages.0.content is required', 'validation'],
    ['something completely unexpected happened', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('classifies %p as %s', (msg, expected) => {
    expect(classifyJudgeErrorMessage(msg as any)).toBe(expected);
  });

  it('context overflow wins over the generic "validation" words in the same message', () => {
    expect(classifyJudgeErrorMessage('ValidationException: Input is too long for requested model')).toBe('context_overflow');
  });
});

describe('judgeErrors — retry policy', () => {
  it('only transient classes are retryable', () => {
    const retryable = ['throttling', 'timeout', 'network', 'provider_error', 'cli_crash', 'unknown'] as const;
    const deterministic = ['context_overflow', 'auth', 'not_found', 'empty_response', 'invalid_json', 'validation'] as const;
    for (const c of retryable) expect(isRetryableJudgeErrorClass(c)).toBe(true);
    for (const c of deterministic) expect(isRetryableJudgeErrorClass(c)).toBe(false);
  });

  it('grants the full budget to known-transient classes, 3 to unknown/cli_crash, 2 to model-output failures, 1 to deterministic ones', () => {
    expect(maxJudgeAttemptsFor('throttling', 10)).toBe(10);
    expect(maxJudgeAttemptsFor('timeout', 10)).toBe(10);
    // retryable in principle, but usually a deterministic bug → bounded
    expect(maxJudgeAttemptsFor('unknown', 10)).toBe(3);
    expect(maxJudgeAttemptsFor('cli_crash', 10)).toBe(3);
    expect(maxJudgeAttemptsFor('invalid_json', 10)).toBe(2);
    expect(maxJudgeAttemptsFor('empty_response', 10)).toBe(2);
    expect(maxJudgeAttemptsFor('context_overflow', 10)).toBe(1);
    expect(maxJudgeAttemptsFor('auth', 10)).toBe(1);
    expect(maxJudgeAttemptsFor(undefined, 10)).toBe(10);
    // never exceeds the configured ceiling
    expect(maxJudgeAttemptsFor('invalid_json', 1)).toBe(1);
  });
});

describe('JudgeError', () => {
  it('derives retryable from the class unless overridden and serializes the wire body', () => {
    const e = new JudgeError('Input is too long for requested model', { errorClass: 'context_overflow' });
    expect(e.retryable).toBe(false);
    expect(isJudgeError(e)).toBe(true);
    expect(e.toResponseBody()).toEqual({
      error: 'Judge evaluation failed: Input is too long for requested model',
      details: 'Input is too long for requested model',
      errorClass: 'context_overflow',
      retryable: false,
    });
    const t = new JudgeError('boom', { errorClass: 'cli_crash', stderrTail: 'Error: boom', retryable: false });
    expect(t.retryable).toBe(false);
    expect(t.toResponseBody().stderrTail).toBe('Error: boom');
  });

  it('toJudgeError passes classified errors through and classifies plain ones', () => {
    const je = new JudgeError('x', { errorClass: 'auth' });
    expect(toJudgeError(je)).toBe(je);
    const plain = toJudgeError(new Error('ThrottlingException: Too many requests'));
    expect(plain.errorClass).toBe('throttling');
    expect(plain.retryable).toBe(true);
    expect(plain.cause).toBeInstanceOf(Error);
    expect(toJudgeError('string error').message).toBe('string error');
    expect(toJudgeError(undefined).errorClass).toBe('unknown');
  });
});

describe('redactStderrTail', () => {
  it('keeps the tail, strips ANSI and masks credentials', () => {
    const stderr =
      'x'.repeat(1000) +
      '\u001b[31mError\u001b[0m: request failed AKIAABCDEFGHIJKLMNOP aws_secret_access_key=abc/123+xyz ' +
      'Authorization: Bearer eyJhbGciOi.abc.def api_key=sk-livexxxxxxxxxxxxxxxx';
    const tail = redactStderrTail(stderr, 200);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(201);
    expect(tail).not.toContain('\u001b');
    expect(tail).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(tail).not.toContain('abc/123+xyz');
    expect(tail).not.toContain('eyJhbGciOi');
    expect(tail).toContain('<redacted>');
  });

  it('returns empty for empty input', () => {
    expect(redactStderrTail('')).toBe('');
    expect(redactStderrTail(undefined)).toBe('');
  });

  it('redactSecrets masks without truncating, and JudgeError.toResponseBody applies it', () => {
    const msg = 'x'.repeat(2000) + ' Authorization: Bearer abc.def.ghi failed';
    const out = redactSecrets(msg);
    expect(out.length).toBeGreaterThan(2000);
    expect(out).not.toContain('abc.def.ghi');
    expect(redactSecrets(undefined)).toBe('');
    const body = new JudgeError('provider said: api_key=sk-secretsecretsecret rejected', { errorClass: 'auth' }).toResponseBody();
    expect(body.error).not.toContain('sk-secretsecretsecret');
    expect(body.details).not.toContain('sk-secretsecretsecret');
  });
});
