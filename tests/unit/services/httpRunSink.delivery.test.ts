/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `HttpRunSink` delivery guarantees (#612 step 3, design §3): retry until
 * confirmed on transport failures / 5xx with exponential backoff up to the
 * lease TTL, spool-before-send on disk, re-discovery on connection refused,
 * never a retry on 4xx. Against a REAL `http` server (no fetch mocks), a fake
 * clock + sleep, and real spool files in a temp directory.
 */

import { createServer, type Server } from 'http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { HttpRunSink, RunDeliveryError, HttpRunSinkError, classifyTransportError } from '@/services/httpRunSink';
import { LeaseLostError } from '@/lib/runLease';

interface Scripted { status: number; body: unknown }
interface Stub { server: Server; url: string; port: number; calls: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: any }>; script: Scripted[]; fallback: (req: { method: string; path: string; body: any }) => Scripted }

async function startStub(fallback: Stub['fallback']): Promise<Stub> {
  const stub: Stub = { server: undefined as any, url: '', port: 0, calls: [], script: [], fallback };
  stub.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      stub.calls.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const answer = stub.script.shift() ?? stub.fallback({ method: req.method!, path: req.url!, body });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', () => resolve()));
  stub.port = (stub.server.address() as { port: number }).port;
  stub.url = `http://127.0.0.1:${stub.port}`;
  return stub;
}
function stopStub(stub: Stub | undefined): Promise<void> {
  if (!stub) return Promise.resolve();
  stub.server.closeAllConnections?.();
  return new Promise((resolve) => stub.server.close(() => resolve()));
}
/** A port nothing listens on (bind + release). */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const CREATED = (runId: string) => ({ status: 201, body: { runId, executorToken: 'tok-1', lease: { generation: 1, heartbeatAt: '2026-01-01T00:00:00.000Z', ttlMs: 60_000 } } });
const okFallback: Stub['fallback'] = ({ path: p }) => {
  if (p === '/api/runs/ingest') return CREATED('run-1');
  if (p.endsWith('/finalize')) return { status: 200, body: { id: 'run-1', status: 'completed' } };
  if (p.endsWith('/report')) return { status: 200, body: { reportId: 'rep-1', report: { id: 'rep-1' } } };
  return { status: 200, body: { generation: 1 } };
};

function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    sleeps,
    advance: (ms: number) => { now += ms; },
  };
}

const run = (id = 'run-1'): any => ({ id, name: 'r', status: 'running', results: {}, testCaseSnapshots: [], sources: [], agentKey: 'a', modelId: 'm', createdAt: 'now', trigger: 'cli' });

describe('HttpRunSink delivery — retry until confirmed, spool, re-discovery', () => {
  let stub: Stub;
  let spoolDir: string;

  beforeEach(async () => {
    stub = await startStub(okFallback);
    spoolDir = mkdtempSync(path.join(tmpdir(), 'ah-sink-spool-'));
  });
  afterEach(async () => {
    await stopStub(stub);
    rmSync(spoolDir, { recursive: true, force: true });
  });

  it('retries a 5xx with exponential backoff (1 s, 2 s, 4 s …) and confirms once the server answers 2xx', async () => {
    const clock = fakeClock();
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const sink = new HttpRunSink(stub.url, { delivery: { spoolDir, now: clock.now, sleep: clock.sleep, onRetry: (i) => retries.push({ attempt: i.attempt, delayMs: i.delayMs }) } });
    await sink.createRun(run());
    stub.script.push({ status: 500, body: { error: 'boom' } }, { status: 503, body: { error: 'draining' } }, { status: 502, body: {} });
    const echo = await sink.setCaseResult('run-1', 'tc-1', { reportId: 'rep-1', status: 'completed' } as any);
    expect(echo).toEqual({ generation: 1 });
    expect(retries).toEqual([{ attempt: 1, delayMs: 1000 }, { attempt: 2, delayMs: 2000 }, { attempt: 3, delayMs: 4000 }]);
    expect(stub.calls.filter((c) => c.path.endsWith('/result'))).toHaveLength(4);
    // Every retry carried the executor token + generation.
    for (const c of stub.calls.filter((c) => c.path.endsWith('/result'))) {
      expect(c.headers['x-ah-executor']).toBe('tok-1');
      expect(c.headers['x-ah-lease-generation']).toBe('1');
    }
  });

  it('caps the backoff at 30 s and gives up with RunDeliveryError (naming the spool) once the lease TTL would be exceeded; the spool file stays', async () => {
    const clock = fakeClock();
    const sink = new HttpRunSink(stub.url, { delivery: { spoolDir, now: clock.now, sleep: clock.sleep } });
    await sink.createRun(run()); // lease TTL 60 s → deadline 60 s
    stub.fallback = () => ({ status: 500, body: { error: 'still broken' } });
    let caught: unknown;
    try {
      await sink.finalize('run-1', { status: 'failed', error: 'x' });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RunDeliveryError);
    const err = caught as RunDeliveryError;
    // 1+2+4+8+16 = 31 s slept, the next delay (30 s cap) would pass 60 s → stop after 6 attempts.
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(err.attempts).toBe(6);
    expect(err.lastError).toBe('still broken');
    expect(err.spoolPath).toBe(path.join(spoolDir, 'run-1.ndjson'));
    expect(err.message).toContain('spooled at');
    expect(existsSync(err.spoolPath!)).toBe(true);
    const lines = readFileSync(err.spoolPath!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.op)).toEqual(['createRun', 'finalize']);
  });

  it('spools every result-bearing mutation BEFORE sending (createRun, report, patch, result, finalize — never heartbeats) and removes the spool on a confirmed finalize', async () => {
    const sink = new HttpRunSink(stub.url, { delivery: { spoolDir } });
    await sink.createRun(run());
    const spool = sink.spoolFile!;
    expect(spool).toBe(path.join(spoolDir, 'run-1.ndjson'));
    await sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId: 'rep-1', report: { status: 'running' } as any });
    await sink.patchCaseReport('run-1', 'rep-1', { metricsStatus: 'ready' } as any);
    await sink.setCaseResult('run-1', 'tc-1', { reportId: 'rep-1', status: 'completed' } as any);
    await sink.heartbeat('run-1', { startedCount: 1, completedCount: 1, totalTestCases: 1 });
    const ops = readFileSync(spool, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ops.map((o) => o.op)).toEqual(['createRun', 'upsertCaseReport', 'patchCaseReport', 'setCaseResult']);
    expect(ops[1]).toMatchObject({ testCaseId: 'tc-1', reportId: 'rep-1', report: { status: 'running' } });
    expect(ops[3]).toMatchObject({ testCaseId: 'tc-1', result: { status: 'completed' } });
    await sink.finalize('run-1', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } });
    expect(existsSync(spool)).toBe(false);
  });

  it('on connection refused asks rediscover() where the server is now and delivers there (a restarted server)', async () => {
    const clock = fakeClock();
    const dead = await closedPort();
    const rediscover = jest.fn(async () => stub.url);
    const sink = new HttpRunSink(`http://127.0.0.1:${dead}`, { delivery: { spoolDir, now: clock.now, sleep: clock.sleep, rediscover } });
    const created = await sink.createRun(run());
    expect(created.executorToken).toBe('tok-1');
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(sink.currentServerUrl).toBe(stub.url);
    expect(clock.sleeps).toEqual([1000]);
    // Later calls go straight to the rediscovered server.
    await sink.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 0 });
    expect(stub.calls.map((c) => c.path)).toEqual(['/api/runs/ingest', '/api/runs/ingest/run-1/heartbeat']);
  });

  it('keeps the current URL when rediscover() finds nothing yet and keeps retrying on the same port (today: re-probe)', async () => {
    const clock = fakeClock();
    const rediscover = jest.fn(async () => undefined);
    await stopStub(stub); // the server is down for the first two attempts …
    const port = stub.port;
    const sleep = async (ms: number) => {
      clock.sleeps.push(ms);
      clock.advance(ms);
      // … then comes back on the same port.
      if (clock.sleeps.length === 2) stub = await restartOn(port);
    };
    const sink = new HttpRunSink(`http://127.0.0.1:${port}`, { delivery: { spoolDir, now: clock.now, sleep, rediscover } });
    await sink.createRun(run());
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(rediscover).toHaveBeenCalledTimes(2);
    expect(sink.currentServerUrl).toBe(`http://127.0.0.1:${port}`);
    expect(stub.calls.map((c) => c.path)).toEqual(['/api/runs/ingest']);
  });

  it('never retries a 4xx: 409 lease-lost is a LeaseLostError, other 4xx an HttpRunSinkError — one request each, no sleep', async () => {
    const clock = fakeClock();
    const sink = new HttpRunSink(stub.url, { delivery: { spoolDir, now: clock.now, sleep: clock.sleep } });
    await sink.createRun(run());
    stub.script.push({ status: 409, body: { error: 'lease-lost', runId: 'run-1', generation: 2, at: 't', status: 'failed' } });
    await expect(sink.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 0 })).rejects.toBeInstanceOf(LeaseLostError);
    stub.script.push({ status: 400, body: { error: 'bad body' } });
    await expect(sink.setCaseResult('run-1', 'tc-1', { reportId: 'r', status: 'completed' } as any)).rejects.toMatchObject({ name: 'HttpRunSinkError', status: 400, message: 'bad body' });
    expect(clock.sleeps).toEqual([]);
    expect(stub.calls).toHaveLength(3);
  });

  it('heartbeats are one attempt, never spooled: a 5xx surfaces immediately so the runner just beats again', async () => {
    const clock = fakeClock();
    const sink = new HttpRunSink(stub.url, { delivery: { spoolDir, now: clock.now, sleep: clock.sleep } });
    await sink.createRun(run());
    stub.script.push({ status: 500, body: { error: 'storage hiccup' } });
    await expect(sink.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 0 })).rejects.toBeInstanceOf(HttpRunSinkError);
    expect(clock.sleeps).toEqual([]);
    const ops = readFileSync(sink.spoolFile!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).op);
    expect(ops).toEqual(['createRun']);
  });

  it('without a delivery policy (contract tests, legacy callers) it is a single attempt with no spool', async () => {
    const sink = new HttpRunSink(stub.url);
    await sink.createRun(run());
    stub.script.push({ status: 500, body: { error: 'boom' } });
    await expect(sink.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 0 })).rejects.toBeInstanceOf(HttpRunSinkError);
    expect(sink.spoolFile).toBeUndefined();
    expect(stub.calls).toHaveLength(2);
  });
});

async function restartOn(port: number): Promise<Stub> {
  const stub: Stub = { server: undefined as any, url: `http://127.0.0.1:${port}`, port, calls: [], script: [], fallback: okFallback };
  stub.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      stub.calls.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const answer = stub.fallback({ method: req.method!, path: req.url!, body });
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(port, '127.0.0.1', () => resolve()));
  return stub;
}

describe('classifyTransportError', () => {
  it('recognises connection refused (nested cause, AggregateError) as transient + refused', () => {
    const refused = new TypeError('fetch failed');
    (refused as any).cause = new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })], 'x');
    expect(classifyTransportError(refused)).toEqual({ transient: true, refused: true });
  });
  it('recognises resets / undici socket errors as transient, not refused', () => {
    const reset = new TypeError('fetch failed');
    (reset as any).cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    expect(classifyTransportError(reset)).toEqual({ transient: true, refused: false });
    expect(classifyTransportError(new Error('socket hang up'))).toEqual({ transient: true, refused: false });
  });
  it('treats anything else (programming errors, JSON errors) as not retryable', () => {
    expect(classifyTransportError(new SyntaxError('Unexpected token'))).toEqual({ transient: false, refused: false });
    expect(classifyTransportError('string error')).toEqual({ transient: false, refused: false });
  });
});
