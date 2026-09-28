/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for services/evaluation/agentReachability.ts — transport-failure
 * classification, the per-run endpoint circuit breaker, threshold resolution,
 * endpoint redaction and the agent-failed report finalizer.
 */

import {
  AgentTransportError,
  AgentUnreachableError,
  DEFAULT_UNREACHABLE_THRESHOLD,
  EndpointCircuitBreaker,
  classifyTransportFailure,
  describeEndpointHost,
  endpointKeyFor,
  finalizeAgentFailedReport,
  isAgentReachabilityError,
  resolveUnreachableThreshold,
} from '@/services/evaluation/agentReachability';

function errWithCode(code: string, message = code): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** What Node's fetch throws for a closed port: opaque TypeError, code on `cause`. */
function undiciFetchFailed(code: string): TypeError {
  const e = new TypeError('fetch failed');
  (e as any).cause = errWithCode(code, `connect ${code} 127.0.0.1:4949`);
  return e;
}

describe('classifyTransportFailure', () => {
  it.each([
    ['ECONNREFUSED', 'connection refused'],
    ['ENOTFOUND', 'DNS lookup failed'],
    ['EAI_AGAIN', 'DNS lookup failed (temporary)'],
    ['ECONNRESET', 'connection reset'],
    ['EHOSTUNREACH', 'host unreachable'],
    ['CERT_HAS_EXPIRED', 'TLS certificate expired'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS self-signed certificate'],
    ['UND_ERR_SOCKET', 'socket error'],
  ])('classifies undici `fetch failed` with cause.code=%s', (code, description) => {
    expect(classifyTransportFailure(undiciFetchFailed(code))).toEqual({ code, description, breakerEligible: true });
  });

  it('classifies a bare error carrying the code directly', () => {
    expect(classifyTransportFailure(errWithCode('ECONNREFUSED'))?.code).toBe('ECONNREFUSED');
  });

  it("falls back to Node's own syscall wording at the START of a message when no hop carries `code`", () => {
    expect(classifyTransportFailure(new Error('connect ECONNREFUSED 127.0.0.1:4949'))?.code).toBe('ECONNREFUSED');
    expect(classifyTransportFailure(new Error('getaddrinfo ENOTFOUND agent.internal'))?.code).toBe('ENOTFOUND');
    expect(classifyTransportFailure(new Error('read ECONNRESET'))?.code).toBe('ECONNRESET');
    expect(classifyTransportFailure(new Error('spawn my-agent-cli ENOENT'))?.code).toBe('ENOENT');
    // A bare code as the whole message (e.g. `cause: 'ECONNREFUSED'`).
    const bare = new Error('Connection refused') as any; bare.cause = 'ECONNREFUSED';
    expect(classifyTransportFailure(bare)?.code).toBe('ECONNREFUSED');
    expect(classifyTransportFailure(new Error('ECONNREFUSED is a common error'))).toBeUndefined();
  });

  it('never classifies on a code quoted INSIDE an agent response body (transport succeeded)', () => {
    // The agent is UP and answered 500 with a body that mentions its own upstream failure.
    const r = classifyTransportFailure(new Error('REST request failed: 500 - {"error":"connect ECONNREFUSED 10.0.0.9:5432 (database)"}'));
    expect(r?.code).toBe('HTTP_500');
    expect(r?.breakerEligible).toBe(false);
    expect(classifyTransportFailure(new Error('agent said: ECONNREFUSED is a common error'))).toBeUndefined();
    expect(classifyTransportFailure(new Error('Unexpected token; got HTTP 503 in body text'))).toBeUndefined();
  });

  it('classifies subprocess spawn failures (ENOENT / EACCES) as transport failures', () => {
    const spawn = new Error("Command 'my-agent-cli' not found. Is it installed and in PATH?") as Error & { code?: string };
    spawn.code = 'ENOENT';
    expect(classifyTransportFailure(spawn)).toEqual({ code: 'ENOENT', description: 'command not found', breakerEligible: true });
    expect(classifyTransportFailure(errWithCode('EACCES'))?.code).toBe('EACCES');
  });

  it.each([
    ['REST request failed: 503 - upstream down', 503, true],
    ['REST request failed: 502 - bad gateway', 502, true],
    ['LangGraph request failed: 504 - gateway timeout', 504, true],
    ['OpenAI-compatible request failed: 401 - unauthorized', 401, false],
    ['LangGraph request failed: 404 - not found', 404, false],
    ['REST request failed: 500 - internal error on this prompt', 500, false],
  ])('classifies a rejected status from the connector prefix (%s); only gateway statuses are breaker-eligible', (message, status, eligible) => {
    expect(classifyTransportFailure(new Error(message))).toEqual({
      code: `HTTP_${status}`,
      description: `endpoint rejected the request with HTTP ${status}`,
      httpStatus: status,
      breakerEligible: eligible,
    });
  });

  it('classifies an error object carrying a numeric status', () => {
    const e = new Error('rejected') as Error & { status: number };
    e.status = 503;
    expect(classifyTransportFailure(e)).toMatchObject({ code: 'HTTP_503', breakerEligible: true });
  });

  it.each([408, 429])('does NOT treat transient HTTP %s as a transport failure', status => {
    expect(classifyTransportFailure(new Error(`REST request failed: ${status} - slow down`))).toBeUndefined();
  });

  it('does NOT classify timeouts, parse errors, hook errors, non-zero exits or plain strings', () => {
    expect(classifyTransportFailure(new Error('Subprocess timed out after 600000ms'))).toBeUndefined();
    const abort = new Error('This operation was aborted'); abort.name = 'AbortError';
    expect(classifyTransportFailure(abort)).toBeUndefined();
    expect(classifyTransportFailure(errWithCode('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'))).toBeUndefined();
    expect(classifyTransportFailure(new Error('Unexpected token < in JSON'))).toBeUndefined();
    expect(classifyTransportFailure(new Error('Subprocess exited with code 1'))).toBeUndefined();
    expect(classifyTransportFailure('string error')).toBeUndefined();
    expect(classifyTransportFailure(undefined)).toBeUndefined();
    expect(classifyTransportFailure(null)).toBeUndefined();
  });

  it('survives a cyclic cause chain', () => {
    const a = new Error('a') as any; const b = new Error('b') as any;
    a.cause = b; b.cause = a;
    expect(classifyTransportFailure(a)).toBeUndefined();
  });
});

describe('describeEndpointHost / endpointKeyFor', () => {
  it('reduces a URL to host[:port] — no scheme, userinfo, path or query', () => {
    expect(describeEndpointHost('https://user:secret@agent.example.com:8443/v1/run?token=abc')).toBe('agent.example.com:8443');
    expect(describeEndpointHost('http://127.0.0.1:4949/agent')).toBe('127.0.0.1:4949');
    expect(describeEndpointHost('http://agent.internal/run')).toBe('agent.internal');
  });

  it('keeps only the executable for a command line and tolerates missing input', () => {
    expect(describeEndpointHost('claude --print --output-format stream-json')).toBe('claude');
    expect(describeEndpointHost(undefined)).toBe('unknown endpoint');
    expect(describeEndpointHost('')).toBe('unknown endpoint');
  });

  it('keys HTTP agents by host + path (no query/credentials; hook-resolved endpoint wins) and subprocess agents by binary', () => {
    expect(endpointKeyFor({ endpoint: 'http://a.example.com:9000/x' })).toBe('a.example.com:9000/x');
    expect(endpointKeyFor({ endpoint: 'https://u:p@a.example.com/v1/run/?token=abc' })).toBe('a.example.com/v1/run');
    expect(endpointKeyFor({ endpoint: 'http://a.example.com/' })).toBe('a.example.com');
    expect(endpointKeyFor({ endpoint: 'http://a.example.com/x' }, 'http://override.example.com/y')).toBe('override.example.com/y');
    // Two routes on one host are independent circuits.
    expect(endpointKeyFor({ endpoint: 'http://a.example.com/v1/a' })).not.toBe(endpointKeyFor({ endpoint: 'http://a.example.com/v1/b' }));
    expect(endpointKeyFor({ endpoint: 'subprocess://local', connectorConfig: { command: 'my-agent-cli --print' } })).toBe('command:my-agent-cli');
    expect(endpointKeyFor({ endpoint: 'subprocess://local' })).toBe('local');
    expect(endpointKeyFor({})).toBe('unknown endpoint');
  });
});

describe('resolveUnreachableThreshold', () => {
  it('defaults to 3', () => {
    expect(resolveUnreachableThreshold(undefined, {})).toBe(DEFAULT_UNREACHABLE_THRESHOLD);
    expect(resolveUnreachableThreshold({}, {})).toBe(3);
  });

  it('connectorConfig.unreachableThreshold wins over env, env wins over default', () => {
    expect(resolveUnreachableThreshold({ unreachableThreshold: 5 }, { AGENT_UNREACHABLE_THRESHOLD: '7' })).toBe(5);
    expect(resolveUnreachableThreshold({ unreachableThreshold: '4' }, {})).toBe(4);
    expect(resolveUnreachableThreshold({}, { AGENT_UNREACHABLE_THRESHOLD: '7' })).toBe(7);
  });

  it('0 or negative disables (Infinity); garbage is warned about and ignored', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveUnreachableThreshold({ unreachableThreshold: 0 }, {})).toBe(Infinity);
      expect(resolveUnreachableThreshold({}, { AGENT_UNREACHABLE_THRESHOLD: '-1' })).toBe(Infinity);
      expect(resolveUnreachableThreshold({ unreachableThreshold: 'lots' }, { AGENT_UNREACHABLE_THRESHOLD: 'abc' })).toBe(3);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0][0]).toContain('connectorConfig.unreachableThreshold="lots"');
      expect(warn.mock.calls[1][0]).toContain('AGENT_UNREACHABLE_THRESHOLD="abc"');
      expect(resolveUnreachableThreshold({ unreachableThreshold: 2.9 }, {})).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('EndpointCircuitBreaker', () => {
  const KEY = 'agent.example.com:9000';

  it('opens after N consecutive transport failures and refuses further calls', () => {
    const b = new EndpointCircuitBreaker(3);
    expect(b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'))?.code).toBe('ECONNREFUSED');
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    expect(b.isOpen(KEY)).toBe(false);
    expect(() => b.assertClosed(KEY)).not.toThrow();
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    expect(b.isOpen(KEY)).toBe(true);

    let thrown: unknown;
    try { b.assertClosed(KEY); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(AgentUnreachableError);
    const err = thrown as AgentUnreachableError;
    expect(err.message).toBe('agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, agent.example.com:9000); this case was not attempted');
    expect(err.endpoint).toBe(KEY);
    expect(err.consecutiveFailures).toBe(3);
    expect(err.lastFailureCode).toBe('ECONNREFUSED');
    expect(err.code).toBe('AGENT_ENDPOINT_UNREACHABLE');
    expect(isAgentReachabilityError(err)).toBe(true);
  });

  it('a success resets the consecutive count (a flapping endpoint does not trip it)', () => {
    const b = new EndpointCircuitBreaker(3);
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    b.recordSuccess(KEY);
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    expect(b.isOpen(KEY)).toBe(false);
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    expect(b.isOpen(KEY)).toBe(true);
  });

  it('is monotonic within a run: an in-flight straggler success never re-arms an open circuit', () => {
    const b = new EndpointCircuitBreaker(2);
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    expect(b.isOpen(KEY)).toBe(true);
    b.recordSuccess(KEY);
    expect(b.isOpen(KEY)).toBe(true);
    expect(() => b.assertClosed(KEY)).toThrow(AgentUnreachableError);
    expect(b.summary()).toContain('2 consecutive connection failures');
  });

  it('rejected statuses that are not gateway errors are classified but never counted (a prompt-specific 500 ×3 does not open it)', () => {
    const b = new EndpointCircuitBreaker(3);
    for (let i = 0; i < 5; i++) {
      expect(b.recordFailure(KEY, new Error('REST request failed: 500 - boom'))).toMatchObject({ code: 'HTTP_500', breakerEligible: false });
    }
    expect(b.isOpen(KEY)).toBe(false);
    for (let i = 0; i < 3; i++) b.recordFailure(KEY, new Error('REST request failed: 503 - upstream down'));
    expect(b.isOpen(KEY)).toBe(true);
    expect(b.summary()).toContain('(HTTP_503, agent.example.com:9000)');
  });

  it('non-transport errors neither count nor reset', () => {
    const b = new EndpointCircuitBreaker(2);
    b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    expect(b.recordFailure(KEY, new Error('Subprocess timed out after 1000ms'))).toBeUndefined();
    expect(b.isOpen(KEY)).toBe(false);
    b.recordFailure(KEY, undiciFetchFailed('ECONNRESET'));
    expect(b.isOpen(KEY)).toBe(true);
    expect(b.openCircuits()[0]).toMatchObject({ key: KEY, consecutiveFailures: 2, lastFailureCode: 'ECONNRESET', rejected: 0 });
  });

  it('circuits are independent per key', () => {
    const b = new EndpointCircuitBreaker(1);
    b.recordFailure('a:1', undiciFetchFailed('ECONNREFUSED'));
    expect(b.isOpen('a:1')).toBe(true);
    expect(b.isOpen('b:2')).toBe(false);
    expect(() => b.assertClosed('b:2')).not.toThrow();
  });

  it('threshold 0 / Infinity disables opening but still classifies', () => {
    const b = new EndpointCircuitBreaker(Infinity);
    expect(b.enabled).toBe(false);
    for (let i = 0; i < 10; i++) expect(b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'))?.code).toBe('ECONNREFUSED');
    expect(b.isOpen(KEY)).toBe(false);
    expect(b.summary()).toBeUndefined();
  });

  it('summary() names the failure class, the HOST only (path dropped) and how many cases were not attempted', () => {
    const b = new EndpointCircuitBreaker(3);
    for (let i = 0; i < 3; i++) b.recordFailure('agent.example.com:9000/v1/run', undiciFetchFailed('ECONNREFUSED'));
    expect(b.summary()).toBe('Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, agent.example.com:9000)');
    try { b.assertClosed('agent.example.com:9000/v1/run'); } catch (e) { expect((e as Error).message).toContain('(ECONNREFUSED, agent.example.com:9000); this case'); }
  });

  it('summary() counts refusals', () => {
    const b = new EndpointCircuitBreaker(3);
    for (let i = 0; i < 3; i++) b.recordFailure(KEY, undiciFetchFailed('ECONNREFUSED'));
    for (let i = 0; i < 2; i++) { try { b.assertClosed(KEY); } catch { /* expected */ } }
    expect(b.summary()).toBe('Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, agent.example.com:9000); 2 further cases were not attempted');
    try { b.assertClosed(KEY); } catch { /* expected */ }
    expect(b.summary()).toContain('3 further cases were not attempted');
  });

  it('summary() shows the bare command for subprocess keys (singular wording)', () => {
    const b = new EndpointCircuitBreaker(1);
    b.recordFailure('command:my-agent-cli', errWithCode('ENOENT'));
    try { b.assertClosed('command:my-agent-cli'); } catch { /* expected */ }
    expect(b.summary()).toBe('Agent endpoint unreachable — 1 consecutive connection failure (ENOENT, my-agent-cli); 1 further case was not attempted');
  });
});

describe('AgentTransportError', () => {
  it('names the failure class and host, keeps the original error as cause', () => {
    const original = undiciFetchFailed('ECONNREFUSED');
    const e = new AgentTransportError({ code: 'ECONNREFUSED', description: 'connection refused', breakerEligible: true }, '127.0.0.1:4949', original);
    expect(e.message).toBe('ECONNREFUSED — connection refused while calling agent endpoint 127.0.0.1:4949: fetch failed');
    expect(e.name).toBe('AgentTransportError');
    expect(e.code).toBe('ECONNREFUSED');
    expect(e.endpoint).toBe('127.0.0.1:4949');
    expect((e as any).cause).toBe(original);
    expect(isAgentReachabilityError(e)).toBe(true);
    expect(isAgentReachabilityError(original)).toBe(false);
    // Still classifiable through the wrapper (cause chain).
    expect(classifyTransportFailure(e)?.code).toBe('ECONNREFUSED');
  });

  it('carries httpStatus for rejected responses and stringifies non-Error causes', () => {
    const e = new AgentTransportError({ code: 'HTTP_503', description: 'endpoint rejected the request with HTTP 503', httpStatus: 503, breakerEligible: true }, 'h:1', 'raw');
    expect(e.httpStatus).toBe(503);
    expect(e.message).toContain(': raw');
  });

  it('bounds the upstream message (connector errors embed the response body)', () => {
    const long = new Error(`REST request failed: 503 - ${'x'.repeat(5000)}\nmore\nlines`);
    const e = new AgentTransportError({ code: 'HTTP_503', description: 'd', httpStatus: 503, breakerEligible: true }, 'h:1', long);
    expect(e.message.length).toBeLessThan(300);
    expect(e.message.endsWith('…')).toBe(true);
    expect(e.message).not.toContain('\n');
  });
});

describe('finalizeAgentFailedReport', () => {
  it('turns the connector-failure report into a final agent_failed report (no polling, no judge)', () => {
    const report: any = {
      status: 'failed',
      llmJudgeReasoning: 'Evaluation failed: ECONNREFUSED — connection refused while calling agent endpoint 127.0.0.1:4949: fetch failed',
      trajectory: [],
    };
    expect(finalizeAgentFailedReport(report)).toBe(true);
    expect(report.metricsStatus).toBe('error');
    expect(report.passFailStatus).toBeNull();
    expect(report.skipJudge).toBe(true);
    expect(report.traceError).toBe('Agent run did not complete (kind=agent_failed): ECONNREFUSED — connection refused while calling agent endpoint 127.0.0.1:4949: fetch failed');
    expect(report.llmJudgeReasoning).toContain('**Agent run did not complete.**');
    expect(report.llmJudgeReasoning).toContain('ECONNREFUSED');
    expect(report.status).toBe('failed');
  });

  it('is a no-op when the report already carries a metricsStatus or the agent succeeded', () => {
    const pending: any = { status: 'completed', metricsStatus: 'pending' };
    expect(finalizeAgentFailedReport(pending)).toBe(false);
    expect(pending).toEqual({ status: 'completed', metricsStatus: 'pending' });

    const alreadyErrored: any = { status: 'failed', metricsStatus: 'error', traceError: 'x' };
    expect(finalizeAgentFailedReport(alreadyErrored)).toBe(false);
    expect(alreadyErrored.traceError).toBe('x');

    const ok: any = { status: 'completed', passFailStatus: 'passed' };
    expect(finalizeAgentFailedReport(ok)).toBe(false);
    expect(ok.metricsStatus).toBeUndefined();
  });

  it('falls back to a generic reason when the legacy reasoning is empty', () => {
    const report: any = { status: 'failed', llmJudgeReasoning: '' };
    finalizeAgentFailedReport(report);
    expect(report.traceError).toBe('Agent run did not complete (kind=agent_failed): agent request failed');
  });
});
