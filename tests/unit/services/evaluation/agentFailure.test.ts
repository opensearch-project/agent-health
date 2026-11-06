/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * services/evaluation/agentFailure.ts — unwrapping + classifying agent-step
 * errors. Regression coverage for the owner incident: undici's opaque
 * `TypeError: fetch failed` must never be the recorded cause; the
 * `HeadersTimeoutError` on `error.cause` must be surfaced and classified as
 * a timeout.
 */

import {
  describeAgentError,
  classifyAgentError,
  unwrapErrorMessage,
  AgentRequestError,
  agentErrorContextFrom,
  redactResponseHeaders,
  REDACTED_HEADER_VALUE,
} from '@/services/evaluation/agentFailure';

/** Exactly what Node 20/22/24's fetch throws after the default 300 s headersTimeout. */
function undiciHeadersTimeout(): Error {
  const cause = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('agentFailure — unwrapErrorMessage', () => {
  it('unwraps undici "fetch failed" to the HeadersTimeoutError cause (never the bare wrapper)', () => {
    const msg = unwrapErrorMessage(undiciHeadersTimeout());
    expect(msg).toMatch(/HeadersTimeoutError/);
    expect(msg).toMatch(/UND_ERR_HEADERS_TIMEOUT/);
    expect(msg).toMatch(/via fetch failed/);
    expect(msg).not.toMatch(/^fetch failed$/);
  });

  it('unwraps ECONNREFUSED from the cause chain', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(unwrapErrorMessage(err)).toMatch(/ECONNREFUSED 127\.0\.0\.1:8000/);
  });

  it('returns the message as-is for a plain informative error', () => {
    expect(unwrapErrorMessage(new Error('REST request failed: 503 - upstream down'))).toBe('REST request failed: 503 - upstream down');
  });

  it('handles strings, nulls and cyclic causes', () => {
    expect(unwrapErrorMessage('boom')).toBe('boom');
    expect(unwrapErrorMessage(null)).toBe('Unknown error');
    const a: any = new Error('a'); const b: any = new Error('b'); a.cause = b; b.cause = a;
    expect(() => unwrapErrorMessage(a)).not.toThrow();
  });
});

describe('agentFailure — classifyAgentError', () => {
  it('classifies undici headers timeout as timeout', () => {
    expect(classifyAgentError(undiciHeadersTimeout()).kind).toBe('timeout');
  });
  it('classifies AbortError / "timed out" text as timeout', () => {
    expect(classifyAgentError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })).kind).toBe('timeout');
    expect(classifyAgentError(new Error('Subprocess timed out after 600000ms')).kind).toBe('timeout');
  });
  it('classifies ECONNREFUSED / ENOTFOUND / socket hang up as connection', () => {
    expect(classifyAgentError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).kind).toBe('connection');
    expect(classifyAgentError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND agent.internal'), { code: 'ENOTFOUND' }) })).kind).toBe('connection');
    expect(classifyAgentError(new Error('socket hang up')).kind).toBe('connection');
  });
  it('classifies the REST connector non-2xx wording as http_<status>', () => {
    const r = classifyAgentError(new Error('REST request failed: 503 - Service Unavailable'));
    expect(r.kind).toBe('http_503');
    expect(r.httpStatus).toBe(503);
  });
  it('classifies AgentRequestError.httpStatus as http_<status>', () => {
    const r = classifyAgentError(new AgentRequestError('REST request failed: 429 - slow down', { httpStatus: 429 }));
    expect(r.kind).toBe('http_429');
  });
  it('falls back to unknown', () => {
    expect(classifyAgentError(new Error('something odd')).kind).toBe('unknown');
  });
});

describe('agentFailure — describeAgentError', () => {
  it('produces a fully-populated AgentErrorInfo for the owner incident (timeout + endpoint + elapsed + timeoutMs)', () => {
    const info = describeAgentError(undiciHeadersTimeout(), {
      endpoint: 'http://localhost:8000/ask',
      elapsedMs: 300_728,
      timeoutMs: 300_000,
    });
    expect(info.kind).toBe('timeout');
    expect(info.message).toMatch(/HeadersTimeoutError/);
    expect(info.message).toMatch(/no response within 300000ms/);
    expect(info.message).toMatch(/http:\/\/localhost:8000\/ask/);
    expect(info.endpoint).toBe('http://localhost:8000/ask');
    expect(info.elapsedMs).toBe(300_728);
    expect(info.timeoutMs).toBe(300_000);
  });

  it('does not duplicate the endpoint or a ms figure already in the message', () => {
    const err = new AgentRequestError('Agent request timed out after 300012ms (timeout 300000ms) — no response headers/body from POST http://a/b', {
      endpoint: 'http://a/b', elapsedMs: 300_012, timeoutMs: 300_000,
    });
    const info = describeAgentError(err, agentErrorContextFrom(err));
    expect(info.message.match(/http:\/\/a\/b/g)?.length).toBe(1);
    expect(info.message).not.toMatch(/no response within/);
    expect(info.kind).toBe('timeout');
  });

  it('agentErrorContextFrom prefers the error\'s own context over the fallback', () => {
    const err = new AgentRequestError('x', { endpoint: 'http://err', elapsedMs: 5, timeoutMs: 10 });
    expect(agentErrorContextFrom(err, { endpoint: 'http://fallback', elapsedMs: 99 })).toEqual({ endpoint: 'http://err', elapsedMs: 5, timeoutMs: 10 });
    expect(agentErrorContextFrom(new Error('plain'), { endpoint: 'http://fallback', elapsedMs: 99 })).toEqual({ endpoint: 'http://fallback', elapsedMs: 99, timeoutMs: undefined });
  });
});

describe('agentFailure — response headers of a non-2xx reply (#612 problem 6)', () => {
  it('redactResponseHeaders lower-cases names and redacts credential-bearing values, keeping request ids', () => {
    expect(redactResponseHeaders({
      'X-Request-Id': 'req-123',
      'x-amzn-RequestId': 'amzn-1',
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=abc',
      Authorization: 'Bearer xyz',
      'Proxy-Authorization': 'Basic abc',
      'X-Api-Key': 'k',
      'x-amz-security-token': 't',
      'WWW-Authenticate': 'Bearer realm="x"',
      'X-Signature': 'sig',
    })).toEqual({
      'x-request-id': 'req-123',
      'x-amzn-requestid': 'amzn-1',
      'content-type': 'application/json',
      'set-cookie': REDACTED_HEADER_VALUE,
      authorization: REDACTED_HEADER_VALUE,
      'proxy-authorization': REDACTED_HEADER_VALUE,
      'x-api-key': REDACTED_HEADER_VALUE,
      'x-amz-security-token': REDACTED_HEADER_VALUE,
      // `www-authenticate` names a scheme, not a credential; it is kept.
      'www-authenticate': 'Bearer realm="x"',
      'x-signature': REDACTED_HEADER_VALUE,
    });
  });

  it('redactResponseHeaders accepts a Headers iterable and returns undefined for nothing', () => {
    expect(redactResponseHeaders(new Headers({ 'X-Request-Id': 'r1', Cookie: 'c' }))).toEqual({ 'x-request-id': 'r1', cookie: REDACTED_HEADER_VALUE });
    expect(redactResponseHeaders(undefined)).toBeUndefined();
    expect(redactResponseHeaders(null)).toBeUndefined();
    expect(redactResponseHeaders({})).toBeUndefined();
  });

  it('describeAgentError persists the (redacted) headers of the AgentRequestError a REST 503 throws', () => {
    const err = new AgentRequestError('REST request failed: 503 - upstream unavailable', {
      endpoint: 'http://a/b', elapsedMs: 120, timeoutMs: 300_000, httpStatus: 503,
      responseHeaders: { 'x-request-id': 'req-123', 'set-cookie': 'session=abc', 'content-type': 'text/plain' },
    });
    const info = describeAgentError(err, agentErrorContextFrom(err));
    expect(info).toEqual({
      kind: 'http_503',
      httpStatus: 503,
      message: 'REST request failed: 503 - upstream unavailable (http://a/b)',
      endpoint: 'http://a/b',
      elapsedMs: 120,
      timeoutMs: 300_000,
      responseHeaders: { 'x-request-id': 'req-123', 'set-cookie': REDACTED_HEADER_VALUE, 'content-type': 'text/plain' },
    });
  });

  it('describeAgentError leaves responseHeaders absent when the error carried none (timeouts, connection errors)', () => {
    const info = describeAgentError(new AgentRequestError('x', { endpoint: 'http://a', elapsedMs: 1 }), agentErrorContextFrom(new Error('plain')));
    expect(info).not.toHaveProperty('responseHeaders');
  });
});
