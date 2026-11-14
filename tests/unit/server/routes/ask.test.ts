/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Route guards of the built-in assistant: `assistant.enabled: false` → 404,
 * per-client rate limit → 429 with Retry-After, concurrency cap → 429 before
 * the stream opens, status endpoint shape. The service is mocked here; the
 * SDK wiring has its own test.
 */

const mockSettings = jest.fn();
const mockInFlight = jest.fn(() => 0);
const mockStreamAsk = jest.fn();
const mockPrepare = jest.fn();
const mockStore = jest.fn();

jest.mock('@/server/services/ask/askService', () => ({
  resolveAskSettings: (...a: any[]) => mockSettings(...a),
  askInFlight: () => mockInFlight(),
  streamAsk: (...a: any[]) => mockStreamAsk(...a),
  prepareAsk: (...a: any[]) => mockPrepare(...a),
  getAskSessionStore: (...a: any[]) => mockStore(...a),
  AskBusyError: class AskBusyError extends Error { constructor(max: number) { super(`busy ${max}`); } },
  ASK_AGENT: { key: 'agent-health-assistant', name: 'Agent Health assistant' },
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import express, { Application } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
const request = require('supertest');
import askRouter, { checkRateLimit, resetRateLimit, ASK_RATE_LIMIT } from '@/server/routes/ask';

const enabled = { enabled: true, model: undefined, sessionsDir: '/tmp/ask', maxConcurrent: 4 };

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(askRouter);
  return app;
}

describe('ask routes — guards', () => {
  let app: Application;
  beforeEach(() => {
    jest.clearAllMocks();
    resetRateLimit();
    mockSettings.mockReturnValue(enabled);
    mockInFlight.mockReturnValue(0);
    mockStreamAsk.mockImplementation((_req: any, cb: any) => { setTimeout(() => cb.onDone({ answer: 'ok', durationMs: 1, toolCalls: [] }), 0); return { abort: jest.fn() }; });
    mockPrepare.mockResolvedValue({ sessionId: 'ask-1', refs: {}, loaded: [], model: 'm' });
    mockStore.mockResolvedValue({ dir: '/tmp/ask', list: jest.fn(() => []), get: jest.fn(() => null) });
    app = makeApp();
  });

  it('GET /api/ask/status reports the effective settings and that history is local', async () => {
    mockSettings.mockReturnValue({ ...enabled, model: 'amazon-bedrock/x' });
    mockInFlight.mockReturnValue(2);
    const res = await request(app).get('/api/ask/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true, agent: { key: 'agent-health-assistant', name: 'Agent Health assistant' },
      model: 'amazon-bedrock/x', sessionsDir: '/tmp/ask', maxConcurrent: 4, inFlight: 2, local: true,
    });
  });

  it('assistant.enabled: false → every route but /status answers 404 and never touches the service', async () => {
    mockSettings.mockReturnValue({ ...enabled, enabled: false });
    expect((await request(app).get('/api/ask/status')).body.enabled).toBe(false);
    for (const [method, path] of [['post', '/api/ask'], ['post', '/api/ask/prepare'], ['get', '/api/ask/sessions'], ['get', '/api/ask/sessions/x']] as const) {
      const res = await (request(app) as any)[method](path).send({ question: 'q', pageContext: { route: '/' } });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/assistant is disabled/);
    }
    expect(mockStreamAsk).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('streams when enabled, and 429s with Retry-After once the concurrency cap is reached', async () => {
    const ok = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/event-stream/);
    expect(ok.text).toContain('"type":"done"');

    mockInFlight.mockReturnValue(4);
    const busy = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('15');
    expect(busy.body.error).toMatch(/busy 4/);
    expect(mockStreamAsk).toHaveBeenCalledTimes(1);
  });

  it('rate-limits asks and prepares per client in separate buckets', async () => {
    for (let i = 0; i < ASK_RATE_LIMIT.asks; i++) {
      expect((await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } })).status).toBe(200);
    }
    const limited = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.error).toMatch(/Too many assistant requests/);
    // prepares are a separate, larger bucket
    expect((await request(app).post('/api/ask/prepare').send({ pageContext: { route: '/' } })).status).toBe(200);
    expect(mockStreamAsk).toHaveBeenCalledTimes(ASK_RATE_LIMIT.asks);
    // history reads (synchronous JSONL parsing) have their own bucket too
    for (let i = 0; i < ASK_RATE_LIMIT.reads; i++) expect((await request(app).get('/api/ask/sessions')).status).toBe(200);
    expect((await request(app).get('/api/ask/sessions')).status).toBe(429);
    expect((await request(app).get('/api/ask/sessions/ask-1')).status).toBe(429);
  });

  it('never logs the question text (it can carry pasted secrets): the debug line has ids, route and sizes only', async () => {
    const { debug } = require('@/lib/debug');
    (debug as jest.Mock).mockClear();
    await request(app).post('/api/ask').send({ question: 'my password is hunter2', pageContext: { route: '/runs/r1' }, selections: [{ text: 'hl' }] });
    const lines = (debug as jest.Mock).mock.calls.map((c: any[]) => c.map(String).join(' '));
    expect(lines.some((l: string) => l.includes('/runs/r1'))).toBe(true);
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('checkRateLimit: fixed window per client; the window resets after windowMs', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < ASK_RATE_LIMIT.prepares; i++) expect(checkRateLimit('a', 'prepares', t0).ok).toBe(true);
    const denied = checkRateLimit('a', 'prepares', t0 + 10_000);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBe(50);
    expect(checkRateLimit('b', 'prepares', t0).ok).toBe(true); // other client unaffected
    expect(checkRateLimit('a', 'asks', t0).ok).toBe(true); // other bucket unaffected
    expect(checkRateLimit('a', 'prepares', t0 + ASK_RATE_LIMIT.windowMs).ok).toBe(true);
  });

  it('validates bodies before anything else', async () => {
    expect((await request(app).post('/api/ask').send({ pageContext: { route: '/' } })).body.error).toMatch(/question is required/);
    expect((await request(app).post('/api/ask').send({ question: 'q', pageContext: {} })).status).toBe(400);
    expect((await request(app).post('/api/ask/prepare').send({})).status).toBe(400);
    expect((await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' }, selections: new Array(21).fill({ text: 'x' }) })).body.error).toMatch(/max 20/);
  });

  it('validates every selection and the sessionId type', async () => {
    const base = { question: 'q', pageContext: { route: '/' } };
    expect((await request(app).post('/api/ask').send({ ...base, selections: 'nope' })).body.error).toMatch(/selections must be an array/);
    expect((await request(app).post('/api/ask').send({ ...base, selections: [{ nearbyText: 'x' }] })).body.error).toMatch(/needs a text string/);
    expect((await request(app).post('/api/ask').send({ ...base, selections: [{ text: 'x'.repeat(20_001) }] })).body.error).toMatch(/max 20000/);
    expect((await request(app).post('/api/ask').send({ ...base, sessionId: 42 })).body.error).toMatch(/sessionId must be a string/);
    expect((await request(app).post('/api/ask').send({ ...base, question: 'x'.repeat(8_001) })).body.error).toMatch(/max 8000/);
    expect((await request(app).post('/api/ask').send({ ...base, question: '   ' })).body.error).toMatch(/question is required/);
    expect((await request(app).post('/api/ask/prepare').set('Content-Type', 'text/plain').send('not json')).body.error).toMatch(/must be an object/);
    expect(mockStreamAsk).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('POST /api/ask streams meta → delta* / tool* → done as SSE data lines and passes the full request to the service', async () => {
    mockStreamAsk.mockImplementation((_req: any, cb: any) => {
      setTimeout(() => {
        cb.onMeta({ sessionId: 'ask-9', model: 'amazon-bedrock/x', loaded: ['report'] });
        cb.onDelta('Hel');
        cb.onTool({ name: 'get_report', status: 'start' });
        cb.onTool({ name: 'get_report', status: 'end', ms: 12 });
        cb.onDelta('lo');
        cb.onDone({ answer: 'Hello', durationMs: 40, firstTokenMs: 5, toolCalls: ['get_report'], sessionId: 'ask-9' });
        cb.onDelta('late'); // after done → never written
      }, 0);
      return { abort: jest.fn() };
    });
    const body = { question: 'why?', pageContext: { route: '/evaluations/runs/r1', title: 'Run' }, selections: [{ text: 'sel' }], sessionId: 'ask-9' };
    const res = await request(app).post('/api/ask').send(body);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(mockStreamAsk).toHaveBeenCalledWith(body, expect.objectContaining({ onMeta: expect.any(Function), onDelta: expect.any(Function), onTool: expect.any(Function), onDone: expect.any(Function), onError: expect.any(Function) }));
    const events = res.text.split('\n\n').filter((l: string) => l.startsWith('data: ')).map((l: string) => JSON.parse(l.slice(6)));
    expect(events.map((e: any) => e.type)).toEqual(['meta', 'delta', 'tool', 'tool', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'meta', sessionId: 'ask-9', model: 'amazon-bedrock/x', loaded: ['report'] });
    expect(events[2]).toEqual({ type: 'tool', name: 'get_report', status: 'start' });
    expect(events[5]).toMatchObject({ type: 'done', answer: 'Hello', toolCalls: ['get_report'] });
    expect(res.text).not.toContain('late');
  });

  it('POST /api/ask: a service failure is delivered as an SSE error event on an open 200 stream, then the stream ends', async () => {
    mockStreamAsk.mockImplementation((_req: any, cb: any) => { setTimeout(() => { cb.onDelta('partial'); cb.onError('model unavailable'); cb.onDone({ answer: 'x' }); }, 0); return { abort: jest.fn() }; });
    const res = await request(app).post('/api/ask').send({ question: 'q', pageContext: { route: '/' } });
    expect(res.status).toBe(200);
    const events = res.text.split('\n\n').filter((l: string) => l.startsWith('data: ')).map((l: string) => JSON.parse(l.slice(6)));
    expect(events).toEqual([{ type: 'delta', content: 'partial' }, { type: 'error', error: 'model unavailable' }]);
  });

  it('POST /api/ask: the client closing the connection mid-answer aborts the pi turn exactly once', async () => {
    const abort = jest.fn();
    let callbacks: any;
    mockStreamAsk.mockImplementation((_req: any, cb: any) => { callbacks = cb; cb.onMeta({ sessionId: 's' }); return { abort }; });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/ask', headers: { 'content-type': 'application/json' } }, (res) => {
          expect(res.statusCode).toBe(200);
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => { /* destroyed on purpose */ });
        req.on('timeout', () => reject(new Error('no response')));
        req.setTimeout(5000);
        req.end(JSON.stringify({ question: 'q', pageContext: { route: '/' } }));
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(abort).toHaveBeenCalledTimes(1);
      // a late callback after the client left is dropped, not written to a closed socket
      expect(() => { callbacks.onDelta('late'); callbacks.onDone({ answer: 'x' }); }).not.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('POST /api/ask/prepare forwards pageContext / selections only (a client cannot pick the model: the operator pin decides) and maps a service failure to 500', async () => {
    const body = { pageContext: { route: '/compare/b?runs=x,y' }, selections: [{ text: 'cell' }], modelId: 'amazon-bedrock/m' };
    const ok = await request(app).post('/api/ask/prepare').send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ sessionId: 'ask-1', refs: {}, loaded: [], model: 'm' });
    expect(mockPrepare).toHaveBeenCalledWith({ pageContext: body.pageContext, selections: body.selections });
    mockPrepare.mockRejectedValueOnce(new Error('snapshot failed'));
    const bad = await request(app).post('/api/ask/prepare').send(body);
    expect(bad.status).toBe(500);
    expect(bad.body.error).toBe('snapshot failed');
  });

  it('GET /api/ask/sessions lists from the store (route filter, limit clamped 1..500, non-numeric → default), says the list is local', async () => {
    const list = jest.fn(() => [{ id: 'ask-1', firstQuestion: 'q' }]);
    mockStore.mockResolvedValue({ dir: '/srv/.agent-health/ask-sessions', list, get: jest.fn() });
    const res = await request(app).get('/api/ask/sessions?route=%2Fevaluations%2Fruns%2Fr1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [{ id: 'ask-1', firstQuestion: 'q' }], dir: '/srv/.agent-health/ask-sessions', local: true });
    expect(list).toHaveBeenLastCalledWith({ route: '/evaluations/runs/r1', limit: 5 });
    await request(app).get('/api/ask/sessions?limit=9999');
    expect(list).toHaveBeenLastCalledWith({ route: undefined, limit: 500 });
    await request(app).get('/api/ask/sessions?limit=-3');
    expect(list).toHaveBeenLastCalledWith({ route: undefined, limit: 1 });
    await request(app).get('/api/ask/sessions?limit=0'); // 0 is "unset" → default
    expect(list).toHaveBeenLastCalledWith({ route: undefined, limit: 200 });
    await request(app).get('/api/ask/sessions?limit=abc');
    expect(list).toHaveBeenLastCalledWith({ route: undefined, limit: 200 });
    await request(app).get('/api/ask/sessions');
    expect(list).toHaveBeenLastCalledWith({ route: undefined, limit: undefined });
    mockStore.mockRejectedValueOnce(new Error('pi SDK not installed'));
    const bad = await request(app).get('/api/ask/sessions');
    expect(bad.status).toBe(500);
    expect(bad.body.error).toBe('pi SDK not installed');
  });

  it('GET /api/ask/sessions/:id returns the session, 404 when unknown, 500 when the store fails', async () => {
    const get = jest.fn((id: string) => (id === 'ask-1' ? { id: 'ask-1', turns: [] } : null));
    mockStore.mockResolvedValue({ dir: '/tmp/ask', list: jest.fn(), get });
    const ok = await request(app).get('/api/ask/sessions/ask-1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ session: { id: 'ask-1', turns: [] } });
    const missing = await request(app).get('/api/ask/sessions/ask-2');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/not found/);
    mockStore.mockRejectedValueOnce(new Error('disk gone'));
    expect((await request(app).get('/api/ask/sessions/ask-1')).status).toBe(500);
  });
});
