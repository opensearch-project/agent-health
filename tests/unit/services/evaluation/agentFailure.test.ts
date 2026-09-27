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
