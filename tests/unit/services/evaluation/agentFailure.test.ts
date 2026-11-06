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
  selectDiagnosticResponseHeaders,
  isDiagnosticResponseHeader,
  MAX_DIAGNOSTIC_HEADERS,
  MAX_DIAGNOSTIC_HEADER_VALUE_LENGTH,
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

describe('agentFailure — diagnostic response headers of a non-2xx reply (#612 problem 6)', () => {
  it('keeps request / correlation / trace ids, the service error type, retry-after, date and content-type (lower-cased)', () => {
    expect(selectDiagnosticResponseHeaders({
      'X-Request-Id': 'req-123',
      'x-amzn-RequestId': 'amzn-1',
      'x-amz-request-id': 'amz-2',
      'x-amz-id-2': 'id2',
      'X-Amz-Cf-Id': 'cf-1',
      'X-Amzn-Trace-Id': 'Root=1-abc',
      'x-correlation-id': 'corr-1',
      'X-Trace-Id': 'tr-1',
      'CF-RAY': 'ray-1',
      traceparent: '00-abc-def-01',
      'x-cloud-trace-context': 'ctx',
      'x-b3-traceid': 'b3',
      'x-amzn-ErrorType': 'ThrottlingException',
      'Retry-After': '30',
      Date: 'Fri, 06 Nov 2026 08:18:12 GMT',
      'Content-Type': 'application/json',
    })).toEqual({
      'x-request-id': 'req-123',
      'x-amzn-requestid': 'amzn-1',
      'x-amz-request-id': 'amz-2',
      'x-amz-id-2': 'id2',
      'x-amz-cf-id': 'cf-1',
      'x-amzn-trace-id': 'Root=1-abc',
      'x-correlation-id': 'corr-1',
      'x-trace-id': 'tr-1',
      'cf-ray': 'ray-1',
      traceparent: '00-abc-def-01',
      'x-cloud-trace-context': 'ctx',
      'x-b3-traceid': 'b3',
      'x-amzn-errortype': 'ThrottlingException',
      'retry-after': '30',
      date: 'Fri, 06 Nov 2026 08:18:12 GMT',
      'content-type': 'application/json',
    });
  });

  it('drops everything else — credentials, auth challenges, signed locations, cookies, custom/session/vendor headers', () => {
    const dropped = {
      'Set-Cookie': 'session=abc; HttpOnly',
      Authorization: 'Bearer xyz',
      'Proxy-Authorization': 'Basic abc',
      'WWW-Authenticate': 'Bearer realm="x", error_description="token abc expired"',
      'Proxy-Authenticate': 'Basic',
      'Authentication-Info': 'nextnonce="abc"',
      Location: 'https://bucket.example/obj?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA',
      Link: '<https://x.example/next?sig=abc>; rel="next"',
      'X-Api-Key': 'k',
      'x_api_key': 'k2',
      'x-amz-security-token': 't',
      'X-Session-Id': 'sess-1',
      'session-id': 'sess-2',
      'X-Signature': 'sig',
      'X-RateLimit-Tokens': '99',
      Server: 'nginx/1.25 (internal-host-01)',
      Via: '1.1 edge-proxy-7',
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      'Content-Length': '20',
      'X-Vendor-Diagnostic': 'user=alice@example.com',
    };
    expect(selectDiagnosticResponseHeaders(dropped)).toBeUndefined();
    for (const name of Object.keys(dropped)) expect(isDiagnosticResponseHeader(name.toLowerCase())).toBe(false);
    // Mixed: only the id survives.
    expect(selectDiagnosticResponseHeaders({ ...dropped, 'X-Request-Id': 'req-9' })).toEqual({ 'x-request-id': 'req-9' });
  });

  it('bounds what one report may carry: value length and entry count', () => {
    const long = 'a'.repeat(MAX_DIAGNOSTIC_HEADER_VALUE_LENGTH + 500);
    expect(selectDiagnosticResponseHeaders({ 'x-request-id': long })).toEqual({ 'x-request-id': 'a'.repeat(MAX_DIAGNOSTIC_HEADER_VALUE_LENGTH) });
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_DIAGNOSTIC_HEADERS + 15; i++) many[`x-vendor-${i}-request-id`] = String(i);
    const kept = selectDiagnosticResponseHeaders(many)!;
    expect(Object.keys(kept)).toHaveLength(MAX_DIAGNOSTIC_HEADERS);
  });

  it('accepts a fetch Headers object (what the connector passes) and returns undefined for nothing', () => {
    expect(selectDiagnosticResponseHeaders(new Headers({ 'X-Request-Id': 'r1', Cookie: 'c', 'Set-Cookie': 's' }))).toEqual({ 'x-request-id': 'r1' });
    expect(selectDiagnosticResponseHeaders(undefined)).toBeUndefined();
    expect(selectDiagnosticResponseHeaders(null)).toBeUndefined();
    expect(selectDiagnosticResponseHeaders({})).toBeUndefined();
    expect(selectDiagnosticResponseHeaders(new Headers())).toBeUndefined();
  });

  it('describeAgentError persists the diagnostic headers the AgentRequestError of a REST 503 carries', () => {
    const err = new AgentRequestError('REST request failed: 503 - upstream unavailable', {
      endpoint: 'http://a/b', elapsedMs: 120, timeoutMs: 300_000, httpStatus: 503,
      responseHeaders: { 'x-request-id': 'req-123', 'retry-after': '30', 'content-type': 'text/plain' },
    });
    const info = describeAgentError(err, agentErrorContextFrom(err));
    expect(info).toEqual({
      kind: 'http_503',
      httpStatus: 503,
      message: 'REST request failed: 503 - upstream unavailable (http://a/b)',
      endpoint: 'http://a/b',
      elapsedMs: 120,
      timeoutMs: 300_000,
      responseHeaders: { 'x-request-id': 'req-123', 'retry-after': '30', 'content-type': 'text/plain' },
    });
  });

  it('describeAgentError re-applies the allowlist (a hand-built context or a raw error cannot persist a cookie)', () => {
    const raw = { 'x-request-id': 'req-1', 'set-cookie': 'session=secret' };
    expect(describeAgentError(new Error('REST request failed: 502 - x'), { responseHeaders: raw }).responseHeaders).toEqual({ 'x-request-id': 'req-1' });
    // Caller forgot agentErrorContextFrom: the headers are still read off the error itself, filtered.
    const err = new AgentRequestError('REST request failed: 502 - x', { httpStatus: 502, responseHeaders: raw });
    expect(describeAgentError(err).responseHeaders).toEqual({ 'x-request-id': 'req-1' });
  });

  it('describeAgentError leaves responseHeaders absent when the error carried none (timeouts, connection errors)', () => {
    const info = describeAgentError(new AgentRequestError('x', { endpoint: 'http://a', elapsedMs: 1 }), agentErrorContextFrom(new Error('plain')));
    expect(info).not.toHaveProperty('responseHeaders');
  });
});
