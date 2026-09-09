/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * services/connectors/base/fetchWithTimeout.ts — explicit per-request HTTP
 * timeout for connectors, against a REAL local http server (so the undici
 * dispatcher override path is exercised, not a mocked fetch).
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  fetchWithTimeout,
  resolveConnectorTimeoutMs,
  DEFAULT_HTTP_CONNECTOR_TIMEOUT_MS,
} from '@/services/connectors/base/fetchWithTimeout';
import { AgentRequestError, describeAgentError } from '@/services/evaluation/agentFailure';

describe('resolveConnectorTimeoutMs', () => {
  it('defaults to 300 000 ms (undici\'s silent default) when unset', () => {
    expect(DEFAULT_HTTP_CONNECTOR_TIMEOUT_MS).toBe(300_000);
    expect(resolveConnectorTimeoutMs(undefined)).toBe(300_000);
    expect(resolveConnectorTimeoutMs({})).toBe(300_000);
  });
  it('honours connectorConfig.timeoutMs (number or numeric string) and legacy `timeout`', () => {
    expect(resolveConnectorTimeoutMs({ timeoutMs: 900_000 })).toBe(900_000);
    expect(resolveConnectorTimeoutMs({ timeoutMs: '12000' })).toBe(12_000);
    expect(resolveConnectorTimeoutMs({ timeout: 45_000 })).toBe(45_000);
  });
  it('rejects non-positive / non-finite values', () => {
    expect(resolveConnectorTimeoutMs({ timeoutMs: 0 })).toBe(300_000);
    expect(resolveConnectorTimeoutMs({ timeoutMs: -5 })).toBe(300_000);
    expect(resolveConnectorTimeoutMs({ timeoutMs: 'abc' })).toBe(300_000);
  });
});

describe('fetchWithTimeout (real http server)', () => {
  let server: http.Server;
  let baseUrl: string;
  let mode: 'hang' | 'slow-ok' | 'error-500' = 'hang';
  const openSockets = new Set<import('node:net').Socket>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (mode === 'hang') return; // never respond
        if (mode === 'error-500') { res.statusCode = 500; res.end('upstream exploded'); return; }
        setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ response: 'late but fine' })); }, 150);
      });
    });
    server.on('connection', (s) => { openSockets.add(s); s.on('close', () => openSockets.delete(s)); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of openSockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
  });

  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('fires the explicit timeout when the agent never answers, with a clear AgentRequestError naming the timeout + endpoint', async () => {
    mode = 'hang';
    const t0 = Date.now();
    let caught: unknown;
    try {
      await fetchWithTimeout(`${baseUrl}/ask`, { method: 'POST', body: '{}', timeoutMs: 400, connectorType: 'rest' });
    } catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    expect(caught).toBeInstanceOf(AgentRequestError);
    const err = caught as AgentRequestError;
    expect(err.message).toMatch(/timed out after \d+ms \(timeout 400ms\)/);
    expect(err.message).toMatch(/POST http:\/\/127\.0\.0\.1:\d+\/ask/);
    expect(err.endpoint).toBe(`${baseUrl}/ask`);
    expect(err.timeoutMs).toBe(400);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(5_000); // did NOT wait for undici's 300 s default
    // The original undici/abort error is retained as `cause` for classification.
    expect((err as any).cause).toBeDefined();
    expect(describeAgentError(err).kind).toBe('timeout');
    // One clear log line naming the remedy.
    expect((console.error as jest.Mock).mock.calls.some(c => /timed out.*connectorConfig\.timeoutMs/.test(String(c[0])))).toBe(true);
  }, 15_000);

  it('returns a response normally when the agent answers within the timeout', async () => {
    mode = 'slow-ok';
    const res = await fetchWithTimeout(`${baseUrl}/ask`, { method: 'POST', body: '{}', timeoutMs: 5_000, connectorType: 'rest' });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ response: 'late but fine' });
  });

  it('returns non-2xx responses as-is (callers decide)', async () => {
    mode = 'error-500';
    const res = await fetchWithTimeout(`${baseUrl}/ask`, { method: 'POST', body: '{}', timeoutMs: 5_000 });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('upstream exploded');
  });

  it('wraps a connection failure (ECONNREFUSED) in AgentRequestError with the code in the message', async () => {
    // Bind an ephemeral port, close it, then connect to it: guaranteed refused.
    const probe = http.createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    let caught: unknown;
    try { await fetchWithTimeout(`http://127.0.0.1:${closedPort}/x`, { method: 'POST', body: '{}', timeoutMs: 5_000, connectorType: 'rest' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AgentRequestError);
    expect((caught as Error).message).toMatch(/ECONNREFUSED/);
    expect(describeAgentError(caught).kind).toBe('connection');
  });

  it('cleans up its timer and caller-abort listener on every settle path (codex review: no handle/listener leaks under retry loops)', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const removeSpy = jest.spyOn(AbortSignal.prototype, 'removeEventListener');
    const addSpy = jest.spyOn(AbortSignal.prototype, 'addEventListener');
    // success path
    mode = 'slow-ok';
    const ac1 = new AbortController();
    await fetchWithTimeout(`${baseUrl}/ok`, { method: 'POST', body: '{}', timeoutMs: 5_000, signal: ac1.signal });
    // timeout path
    mode = 'hang';
    const ac2 = new AbortController();
    await fetchWithTimeout(`${baseUrl}/hang`, { method: 'POST', body: '{}', timeoutMs: 200, signal: ac2.signal }).catch(() => {});
    // connection-failure path (no caller signal)
    const probe = http.createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    await fetchWithTimeout(`http://127.0.0.1:${closedPort}/x`, { method: 'POST', body: '{}', timeoutMs: 5_000 }).catch(() => {});

    // One clearTimeout per call (3 calls), and every listener registered on
    // the CALLER's signals was removed again (undici registers its own
    // listeners on the internal controller's signal — count only ours).
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    const callerSignals = new Set<any>([ac1.signal, ac2.signal]);
    const added = addSpy.mock.contexts.filter((ctx, i) => callerSignals.has(ctx) && addSpy.mock.calls[i][0] === 'abort').length;
    const removed = removeSpy.mock.contexts.filter((ctx, i) => callerSignals.has(ctx) && removeSpy.mock.calls[i][0] === 'abort').length;
    expect(added).toBe(2);
    expect(removed).toBe(added);
    clearSpy.mockRestore(); removeSpy.mockRestore(); addSpy.mockRestore();
  }, 15_000);

  it('honours a caller-supplied AbortSignal', async () => {
    mode = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('caller cancelled')), 50);
    let caught: unknown;
    try { await fetchWithTimeout(`${baseUrl}/x`, { method: 'POST', body: '{}', timeoutMs: 10_000, signal: ac.signal }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AgentRequestError);
  });
});
