/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Executor leases end to end (#612 step 2) on REAL server processes (FILE
 * storage, temp project, OS-assigned ports), a real REST agent stub and the
 * real UI route. Lease TTL is scaled down via `AH_RUN_LEASE_TTL_MS` so each
 * scenario fits a test; the heartbeat period scales with it
 * (lib/runLease.ts), so the ratios are the production ones.
 *
 *   1. An out-of-process executor stops heartbeating → the sweeper marks the
 *      run `failed` ("executor lost…") within the TTL, with `cancelled`
 *      markers; the executor's late finalize is refused with 409 lease-lost.
 *   2. UI cancel of a lease-only run → `cancelRequestedAt` (Cancelling…) →
 *      the executor sees it on its next heartbeat → `cancelled` with markers.
 *   3. A SERVER-executed run (UI route) whose server is SIGKILLed mid-run:
 *      after a restart the new server fails it within the TTL. Red on main:
 *      the run stayed `running` forever.
 *   4. Drain: new runs / leases 503, in-flight lists what is still running.
 *   5. Acceptance-matrix row "blocked event loop → run NOT marked lost": a
 *      sync `execSync('sleep …')` hook blocks the server for 30 % of the
 *      TTL (the 90 s-of-5 min ratio, scaled to 9 s of 30 s) and the run
 *      still completes.
 *
 * Run:
 *   npm run test:integration -- --testPathPatterns=runLeases
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { tmpdir } from 'os';
import * as path from 'path';
import { HttpRunSink } from '@/services/httpRunSink';
import { mintReportId } from '@/services/runSink';
import { LeaseLostError } from '@/lib/runLease';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER_BUNDLE = path.join(REPO_ROOT, 'server', 'dist', 'index.js');
const TEST_TIMEOUT = 180_000;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve((server.address() as { port: number }).port); });
  });
}
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}
function httpJson<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<{ status: number; body: T; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, timeout: timeoutMs,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      const finish = () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = undefined; }
        resolve({ status: res.statusCode || 0, body: parsed, text });
      };
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', finish);
      // A server killed mid-stream (SSE) drops the socket: settle with what arrived.
      res.on('aborted', finish);
      res.on('error', finish);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try { if ((await httpJson('GET', `${baseUrl}/health`, undefined, {}, 3000)).status === 200) return; } catch (e: any) { last = e?.message; }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server at ${baseUrl} not healthy in ${timeoutMs}ms (${last})`);
}
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
/** Poll `GET /evaluation-runs/:id` until `pred` holds (or time out with the last doc in the message). */
async function waitForRun(baseUrl: string, runId: string, pred: (run: any) => boolean, timeoutMs: number, label: string): Promise<any> {
  const start = Date.now();
  let last: any;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
      last = res.body?.evaluationRun ?? res.body;
      if (res.status === 200 && pred(last)) return last;
    } catch { /* server may be restarting */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`${label}: condition not met within ${timeoutMs}ms; last doc: ${JSON.stringify(last)?.slice(0, 600)}`);
}
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return Object.assign(env, {
    AH_HEADLESS: '1', AGENT_HEALTH_STORAGE: 'file', BENCHMARK_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1', AH_QUIET_DEPRECATIONS: '1', NO_COLOR: '1', NODE_ENV: 'test',
    TRACE_POLL_MAX_ATTEMPTS: '1', TRACE_POLL_INTERVAL_MS: '100',
  }, extra);
}
function ensureBuilt(): void {
  if (existsSync(SERVER_BUNDLE)) return;
  const b = spawnSync('npm', ['run', 'build:server'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  if (b.status !== 0) throw new Error(`build:server failed: ${b.stderr}`);
}

interface Spawned { child: ChildProcess; log: () => string }
function spawnServer(project: string, port: number, env: Record<string, string>): Spawned {
  let log = '';
  const child = spawn(process.execPath, [SERVER_BUNDLE], { cwd: project, env: cleanEnv({ AH_PORT: String(port), PORT: String(port), ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', c => { log += c; });
  child.stderr!.on('data', c => { log += c; });
  return { child, log: () => log };
}
async function stopServer(s: Spawned | undefined): Promise<void> {
  if (!s?.child.pid) return;
  try { s.child.kill('SIGTERM'); } catch { /* gone */ }
  if (!(await waitForExit(s.child.pid, 8000))) { try { s.child.kill('SIGKILL'); } catch { /* noop */ } }
}

/** REST agent stub: answers after `delayMs`; the hook on the agent config may block the SERVER before calling it. */
function startAgentStub(delayMs: number): Promise<{ server: Server; endpoint: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: `answer ${calls}` }));
      }, delayMs);
    });
  });
  return listen(server).then(port => ({ server, endpoint: `http://127.0.0.1:${port}/ask`, calls: () => calls }));
}
function configModule(agentEndpoint: string, blockSeconds = 0): string {
  return `import { execSync } from 'child_process';
export default {
  agents: [{
    key: 'lease-agent', name: 'Lease Agent', connectorType: 'rest', endpoint: ${JSON.stringify(agentEndpoint)}, useTraces: false,
    hooks: {
      // A SYNC hook: blocks this server's event loop (no heartbeat can fire) for ${blockSeconds}s before every request.
      beforeRequest: (ctx) => { ${blockSeconds > 0 ? `execSync('sleep ${blockSeconds}');` : ''} return ctx; },
    },
  }],
};
`;
}
async function createCases(baseUrl: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const tc = await httpJson('POST', `${baseUrl}/api/storage/test-cases`, { name: `lease-case-${i}-${Date.now()}`, category: 'general', difficulty: 'easy', initialPrompt: `q${i}`, expectedOutcomes: ['answers'] });
    expect(tc.status).toBe(201);
    ids.push(tc.body.testCase?.id ?? tc.body.id);
  }
  return ids;
}
const runDoc = (id: string, caseIds: string[]) => ({
  id, docType: 'evaluation-run', name: `Lease run ${id}`, createdAt: new Date().toISOString(), status: 'running',
  agentKey: 'external-agent', modelId: 'external-model', judgeModelId: 'demo-model',
  sources: [{ type: 'test-case-ids', ids: caseIds }], trigger: 'cli',
  testCaseSnapshots: caseIds.map((cid, i) => ({ id: cid, version: 1, name: `case ${i}` })), results: {},
});

// Scaled lease: 6 s TTL → 400 ms heartbeat; the sweeper runs every second.
const TTL_MS = 6000;
const LEASE_ENV = { AH_RUN_LEASE_TTL_MS: String(TTL_MS), AH_RUN_LEASE_SWEEP_INTERVAL_MS: '1000' };

describe('executor leases on a real FILE-storage server (#612)', () => {
  let project: string;
  let port: number;
  let baseUrl: string;
  let server: Spawned | undefined;
  let agent: Awaited<ReturnType<typeof startAgentStub>>;

  beforeAll(async () => {
    ensureBuilt();
    agent = await startAgentStub(1500);
    project = mkdtempSync(path.join(tmpdir(), 'ah-run-leases-'));
    writeFileSync(path.join(project, '.env'), '');
    writeFileSync(path.join(project, 'agent-health.config.mjs'), configModule(agent.endpoint));
    const reservation = createServer();
    port = await listen(reservation);
    await closeServer(reservation);
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawnServer(project, port, LEASE_ENV);
    try { await waitForHealth(baseUrl, 60_000); } catch (e) { throw new Error(`${(e as Error).message}\n${server.log()}`); }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await stopServer(server);
    if (agent) await closeServer(agent.server);
    if (project) rmSync(project, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  it('1. an executor that stops heartbeating is swept: failed "executor lost", cancelled markers, and its late finalize is 409 lease-lost', async () => {
    const sink = new HttpRunSink(baseUrl, { executorVersion: '0.0.0-cli-test' });
    const runId = `eval-run-lease-dead-${Date.now()}`;
    const created = await sink.createRun(runDoc(runId, ['c1', 'c2', 'c3']) as any);
    expect(created.lease).toEqual({ generation: 1, heartbeatAt: expect.any(String), ttlMs: TTL_MS });

    const reportId = mintReportId();
    await sink.upsertCaseReport({ runId, testCaseId: 'c1', attempt: 1, reportId, report: { status: 'completed', passFailStatus: 'passed', testCaseId: 'c1', experimentRunId: runId, trajectory: [], metrics: {} } as any });
    await sink.setCaseResult(runId, 'c1', { reportId, status: 'completed', passFailStatus: 'passed' });
    await sink.setCaseResult(runId, 'c2', { reportId: 'r-c2', status: 'running' });
    expect(await sink.heartbeat(runId, { startedCount: 2, completedCount: 1, totalTestCases: 3 })).toEqual({ generation: 1 });

    // It is in flight right now, as a CLI-kind lease.
    const inFlight = await httpJson('GET', `${baseUrl}/api/runs/in-flight`);
    expect(inFlight.body.runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: runId, source: 'lease', executor: { kind: 'cli', version: '0.0.0-cli-test' }, lease: expect.objectContaining({ live: true }) })]));
    expect(inFlight.text).not.toContain(created.executorToken);

    // …then the executor dies (no more heartbeats). Within TTL + one sweep it is failed.
    const t0 = Date.now();
    const swept = await waitForRun(baseUrl, runId, r => r.status !== 'running', TTL_MS + 5000, 'sweep of a dead executor');
    const tookMs = Date.now() - t0;
    expect(swept).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^executor lost \(no heartbeat since .*; lease TTL 6s\)$/),
      executor: { id: null, kind: 'cli', version: '0.0.0-cli-test' },
      lease: { generation: 2, ttlMs: TTL_MS },
      results: { c1: { reportId, status: 'completed', passFailStatus: 'passed' }, c2: { reportId: 'r-c2', status: 'running' }, c3: { reportId: '', status: 'cancelled' } },
      stats: { passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 },
    });
    expect(tookMs).toBeLessThan(TTL_MS + 5000);

    // The old executor comes back: every write is refused and nothing changes.
    await expect(sink.heartbeat(runId, { startedCount: 3, completedCount: 3, totalTestCases: 3 })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(sink.finalize(runId, { status: 'completed', completedRun: { results: { c1: { reportId, status: 'completed', passFailStatus: 'passed' }, c2: { reportId: 'r-c2', status: 'completed', passFailStatus: 'passed' }, c3: { reportId: 'r-c3', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: [] } }))
      .rejects.toMatchObject({ name: 'LeaseLostError', info: { error: 'lease-lost', runId, generation: 2, status: 'failed', at: swept.completedAt } });
    const after = (await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${runId}`)).body;
    expect(after.evaluationRun ?? after).toMatchObject({ status: 'failed', results: swept.results });
    expect((await httpJson('GET', `${baseUrl}/api/runs/in-flight`)).body.runs.map((r: any) => r.id)).not.toContain(runId);

    await httpJson('DELETE', `${baseUrl}/api/storage/runs/${reportId}`);
    await httpJson('DELETE', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
  }, TEST_TIMEOUT);

  it('2. UI cancel of a lease-only run: Cancelling… (cancelRequestedAt) → executor sees it on its next beat → cancelled with markers', async () => {
    const sink = new HttpRunSink(baseUrl);
    const runId = `eval-run-lease-cancel-${Date.now()}`;
    await sink.createRun(runDoc(runId, ['c1', 'c2', 'c3', 'c4']) as any);
    await sink.setCaseResult(runId, 'c1', { reportId: 'r-c1', status: 'completed', passFailStatus: 'passed' });

    // The executor's heartbeat loop, as the runner does it.
    let echoed: string | undefined;
    const beats: Promise<void>[] = [];
    const timer = setInterval(() => {
      beats.push(sink.heartbeat(runId, { startedCount: 1, completedCount: 1, totalTestCases: 4 }).then(e => { if (e.cancelRequestedAt) echoed = e.cancelRequestedAt; }).catch(() => {}));
    }, 400);
    try {
      // No in-memory token on the server for this run (it executes "elsewhere"), a live lease → cancel by lease.
      const cancel = await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs/${runId}/cancel`);
      expect(cancel.status).toBe(200);
      expect(cancel.body).toEqual({ success: true, draining: true, viaLease: true, cancelRequestedAt: expect.any(String) });

      // What the UI shows meanwhile: still `running`, with cancelRequestedAt ("Cancelling…").
      const cancelling = await waitForRun(baseUrl, runId, r => !!r.cancelRequestedAt, 5000, 'cancelRequestedAt stamped');
      expect(cancelling).toMatchObject({ status: 'running', cancelRequestedAt: cancel.body.cancelRequestedAt });

      // The executor learns of it within one heartbeat period.
      const t0 = Date.now();
      while (!echoed && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
      expect(echoed).toBe(cancel.body.cancelRequestedAt);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      clearInterval(timer);
      await Promise.all(beats);
    }

    // …and finalizes `cancelled`: the in-flight case lands, never-started cases get markers.
    const finalized = await sink.finalize(runId, { status: 'cancelled', completedRun: { results: { c1: { reportId: 'r-c1', status: 'completed', passFailStatus: 'passed' }, c2: { reportId: 'r-c2', status: 'failed', passFailStatus: 'failed' } }, testCaseSnapshots: runDoc(runId, ['c1', 'c2', 'c3', 'c4']).testCaseSnapshots as any } });
    expect(finalized.status).toBe('cancelled');
    expect(finalized.stats).toEqual({ passed: 1, failed: 1, errored: 0, pending: 0, notRun: 2, total: 4 });
    const doc = (await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${runId}`)).body;
    expect((doc.evaluationRun ?? doc).results).toEqual({
      c1: { reportId: 'r-c1', status: 'completed', passFailStatus: 'passed' }, c2: { reportId: 'r-c2', status: 'failed', passFailStatus: 'failed' },
      c3: { reportId: '', status: 'cancelled' }, c4: { reportId: '', status: 'cancelled' },
    });
    // A second cancel on a terminal run is a plain 400, not a fallback write.
    expect((await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs/${runId}/cancel`)).status).toBe(400);
    await httpJson('DELETE', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
  }, TEST_TIMEOUT);

  it('3. a SERVER-executed (UI route) run whose server is killed mid-run is failed by the restarted server within the TTL', async () => {
    const caseIds = await createCases(baseUrl, 4);
    // Kick off a UI run (SSE, held open); the stub answers each case after 1.5 s.
    let runId: string | undefined;
    const sse = httpJson('POST', `${baseUrl}/api/storage/evaluation-runs`, { sources: [{ type: 'test-case-ids', ids: caseIds }], agentKey: 'lease-agent', judgeModelId: 'demo-model', name: `lease-kill-${Date.now()}`, concurrency: 1 }, {}, 120_000)
      .catch(() => undefined);
    const t0 = Date.now();
    while (!runId && Date.now() - t0 < 15_000) {
      const list = await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs?status=running&size=20`);
      const items: any[] = list.body?.evaluationRuns ?? list.body?.items ?? [];
      runId = items.find(r => r.agentKey === 'lease-agent' && r.status === 'running')?.id;
      if (!runId) await new Promise(r => setTimeout(r, 200));
    }
    expect(runId).toBeDefined();

    // In flight as a SERVER-kind lease that is being heartbeated in-process.
    const first = await waitForRun(baseUrl, runId!, r => Object.values(r.results ?? {}).some((e: any) => e.status === 'completed'), 30_000, 'first case completes');
    expect(first).toMatchObject({ status: 'running', executor: { kind: 'server', id: expect.stringMatching(/^[0-9a-f]{32}$/) }, lease: { generation: 1, ttlMs: TTL_MS } });
    expect(Date.parse(first.lease.heartbeatAt)).toBeGreaterThan(Date.parse(first.createdAt));
    const inFlight = await httpJson('GET', `${baseUrl}/api/runs/in-flight`);
    expect(inFlight.body.runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: runId, source: 'lease', executor: expect.objectContaining({ kind: 'server' }) })]));

    // SIGKILL: no shutdown handler, no terminal write — the pre-lease zombie scenario.
    const killedAt = Date.now();
    server!.child.kill('SIGKILL');
    expect(await waitForExit(server!.child.pid!, 5000)).toBe(true);
    await sse;

    // Same project, same port, new process.
    server = spawnServer(project, port, LEASE_ENV);
    try { await waitForHealth(baseUrl, 60_000); } catch (e) { throw new Error(`${(e as Error).message}\n${server.log()}`); }
    const stillRunning = (await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${runId}`)).body;
    expect((stillRunning.evaluationRun ?? stillRunning).status).toBe('running'); // zombie right after boot: lease not expired yet

    const swept = await waitForRun(baseUrl, runId!, r => r.status !== 'running', TTL_MS + 10_000, 'restarted server sweeps the orphan');
    expect(Date.now() - killedAt).toBeLessThan(TTL_MS + 15_000);
    expect(swept).toMatchObject({ status: 'failed', error: expect.stringContaining('executor lost (no heartbeat since'), executor: { id: null, kind: 'server' }, lease: { generation: 2 } });
    // Finished case kept; never-started cases carry explicit cancelled markers; stats reflect it.
    const statuses = Object.values(swept.results as Record<string, any>).map(e => e.status);
    expect(statuses).toContain('completed');
    expect(statuses).toContain('cancelled');
    expect(swept.stats.total).toBe(4);
    expect(swept.stats.notRun).toBeGreaterThanOrEqual(2);
    expect(server.log()).toContain(`[runLeaseSweeper] run ${runId} marked failed`);
    expect((await httpJson('GET', `${baseUrl}/api/runs/in-flight`)).body.count).toBe(0);

    for (const entry of Object.values(swept.results as Record<string, any>)) if (entry.reportId) await httpJson('DELETE', `${baseUrl}/api/storage/runs/${entry.reportId}`);
    await httpJson('DELETE', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
    for (const id of caseIds) await httpJson('DELETE', `${baseUrl}/api/storage/test-cases/${id}`);
  }, TEST_TIMEOUT);

  it('4. drain: new server-executed runs and new leases are refused with 503 listing what is in flight; in-flight reports draining', async () => {
    const sink = new HttpRunSink(baseUrl);
    const runId = `eval-run-lease-drain-${Date.now()}`;
    await sink.createRun(runDoc(runId, ['c1']) as any);

    const drained = await httpJson('POST', `${baseUrl}/api/server/drain`);
    expect(drained.status).toBe(200);
    expect(drained.body).toMatchObject({ draining: true, since: expect.any(String), inFlight: { count: 1, runs: [expect.objectContaining({ id: runId })] } });

    const uiRun = await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs`, { sources: [{ type: 'test-case-ids', ids: ['x'] }], agentKey: 'lease-agent', name: 'refused' });
    expect(uiRun.status).toBe(503);
    expect(uiRun.body).toMatchObject({ error: 'draining', inFlight: { count: 1, runs: [expect.objectContaining({ id: runId })] } });
    const newLease = new HttpRunSink(baseUrl);
    await expect(newLease.createRun(runDoc(`${runId}-2`, ['c1']) as any)).rejects.toMatchObject({ status: 503, message: 'draining' });
    const evaluate = await httpJson('POST', `${baseUrl}/api/evaluate`, { testCaseId: 'x', agentKey: 'lease-agent' });
    expect(evaluate.status).toBe(503);

    const inFlight = await httpJson('GET', `${baseUrl}/api/runs/in-flight`);
    expect(inFlight.body).toMatchObject({ draining: true, since: drained.body.since, count: 1 });

    // The run already in flight keeps going and finishes normally.
    expect(await sink.heartbeat(runId, { startedCount: 1, completedCount: 0, totalTestCases: 1 })).toEqual({ generation: 1 });
    const done = await sink.finalize(runId, { status: 'completed', completedRun: { results: { c1: { reportId: 'r', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: [] } });
    expect(done.status).toBe('completed');
    expect((await httpJson('GET', `${baseUrl}/api/runs/in-flight`)).body.count).toBe(0);
    await httpJson('DELETE', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
  }, TEST_TIMEOUT);
});

describe('acceptance matrix: blocked event loop → run NOT marked lost (#612 design §7)', () => {
  // Scaled 1:10 — TTL 30 s (heartbeat 2 s), sync hook blocks 9 s per request
  // (the matrix row is 90 s of the 5 min default: the same 30 % ratio).
  const BLOCK_TTL_MS = 30_000;
  const BLOCK_SECONDS = 9;
  let project: string;
  let baseUrl: string;
  let server: Spawned | undefined;
  let agent: Awaited<ReturnType<typeof startAgentStub>>;

  beforeAll(async () => {
    ensureBuilt();
    agent = await startAgentStub(200);
    project = mkdtempSync(path.join(tmpdir(), 'ah-run-leases-block-'));
    writeFileSync(path.join(project, '.env'), '');
    writeFileSync(path.join(project, 'agent-health.config.mjs'), configModule(agent.endpoint, BLOCK_SECONDS));
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawnServer(project, port, { AH_RUN_LEASE_TTL_MS: String(BLOCK_TTL_MS), AH_RUN_LEASE_SWEEP_INTERVAL_MS: '1000' });
    try { await waitForHealth(baseUrl, 60_000); } catch (e) { throw new Error(`${(e as Error).message}\n${server.log()}`); }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await stopServer(server);
    if (agent) await closeServer(agent.server);
    if (project) rmSync(project, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  it(`a sync beforeRequest hook blocking the server for ${BLOCK_SECONDS}s (30% of a ${BLOCK_TTL_MS / 1000}s TTL) delays heartbeats but the run completes, never "executor lost"`, async () => {
    const caseIds = await createCases(baseUrl, 2);
    const t0 = Date.now();
    const sse = await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs`, { sources: [{ type: 'test-case-ids', ids: caseIds }], agentKey: 'lease-agent', judgeModelId: 'demo-model', name: `lease-block-${Date.now()}`, concurrency: 1 }, {}, 150_000);
    expect(sse.status).toBe(200);
    const completedLine = sse.text.split('\n').find(l => l.startsWith('data: ') && l.includes('"status":"completed"') && l.includes('"stats"'));
    expect(completedLine).toBeDefined();
    const run = JSON.parse(completedLine!.slice(6));
    // The hook really blocked: two cases × 9 s.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2 * BLOCK_SECONDS * 1000);
    expect(run).toMatchObject({ status: 'completed', lease: { generation: 1 }, executor: { kind: 'server' } });
    expect(run.error).toBeUndefined();
    expect(run.stats.total).toBe(2);
    expect(run.stats.notRun).toBe(0);
    expect(server!.log()).not.toContain('marked failed');

    const doc = (await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${run.id}`)).body;
    expect((doc.evaluationRun ?? doc).status).toBe('completed');
    for (const entry of Object.values(run.results as Record<string, any>)) if (entry.reportId) await httpJson('DELETE', `${baseUrl}/api/storage/runs/${entry.reportId}`);
    await httpJson('DELETE', `${baseUrl}/api/storage/evaluation-runs/${run.id}`);
    for (const id of caseIds) await httpJson('DELETE', `${baseUrl}/api/storage/test-cases/${id}`);
  }, TEST_TIMEOUT);
});
