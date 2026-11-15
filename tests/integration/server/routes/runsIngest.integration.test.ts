/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/api/runs/ingest/*` on a REAL server process (FILE storage, temp project):
 * an out-of-process executor drives a whole run through `HttpRunSink` and the
 * result is indistinguishable — through the public storage API — from a run
 * the server executed itself: run doc with stats, per-case report, benchmark
 * `runs[]` projection.
 *
 * Run:
 *   npm run test:integration -- --testPathPatterns=runsIngest
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { tmpdir } from 'os';
import * as path from 'path';
import { HttpRunSink } from '@/services/httpRunSink';
import { mintReportId, EXECUTOR_TOKEN_HEADER } from '@/services/runSink';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER_BUNDLE = path.join(REPO_ROOT, 'server', 'dist', 'index.js');
const TEST_TIMEOUT = 120_000;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve((server.address() as { port: number }).port); });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}
function httpJson<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname, method, agent: false, timeout: 15_000,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
        resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers });
      });
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
    try { if ((await httpJson('GET', `${baseUrl}/health`)).status === 200) return; } catch (e: any) { last = e?.message; }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server at ${baseUrl} not healthy in ${timeoutMs}ms (${last})`);
}
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return Object.assign(env, {
    AH_HEADLESS: '1', AGENT_HEALTH_STORAGE: 'file', BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1', AH_QUIET_DEPRECATIONS: '1', NO_COLOR: '1', NODE_ENV: 'test',
  }, extra);
}

describe('run ingestion API on a real FILE-storage server (#612)', () => {
  let project: string;
  let server: ChildProcess | undefined;
  let baseUrl: string;
  let log = '';

  beforeAll(async () => {
    if (!existsSync(SERVER_BUNDLE)) {
      const b = spawnSync('npm', ['run', 'build:server'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:server failed: ${b.stderr}`);
    }
    project = mkdtempSync(path.join(tmpdir(), 'ah-runs-ingest-'));
    writeFileSync(path.join(project, '.env'), '');
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [SERVER_BUNDLE], { cwd: project, env: cleanEnv({ AH_PORT: String(port), PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', c => { log += c; });
    server.stderr!.on('data', c => { log += c; });
    try { await waitForHealth(baseUrl, 60_000); } catch (e) { throw new Error(`${(e as Error).message}\n${log}`); }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (server?.pid) {
      try { server.kill('SIGTERM'); } catch { /* gone */ }
      if (!(await waitForExit(server.pid, 8000))) { try { server.kill('SIGKILL'); } catch { /* noop */ } }
    }
    if (project) rmSync(project, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  it('createRun → report upsert ×2 → case result → finalize: visible through the public storage API like a server-executed run', async () => {
    const bench = await httpJson('POST', `${baseUrl}/api/storage/benchmarks`, { name: `ingest-bench-${Date.now()}`, description: '', testCaseIds: ['tc-ingest-1'] });
    expect(bench.status).toBe(201);
    const benchmarkId: string = bench.body.id ?? bench.body.benchmark?.id;

    const sink = new HttpRunSink(baseUrl);
    const runId = `eval-run-ingest-${Date.now()}`;
    const run: any = {
      id: runId, docType: 'evaluation-run', name: 'Ingested run', createdAt: new Date().toISOString(), status: 'running',
      agentKey: 'external-agent', modelId: 'external-model', judgeModelId: 'demo-model', benchmarkId,
      sources: [{ type: 'test-case-ids', ids: ['tc-ingest-1'] }], trigger: 'api',
      testCaseSnapshots: [{ id: 'tc-ingest-1', version: 1, name: 'ingest one' }], results: {},
    };
    const created = await sink.createRun(run);
    expect(created).toEqual({ runId, executorToken: expect.stringMatching(/^[0-9a-f]{32}$/) });

    // The run is visible (and `running`) as soon as it is created.
    const running = await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
    expect(running.status).toBe(200);
    expect((running.body.evaluationRun ?? running.body).status).toBe('running');

    const reportId = mintReportId();
    const placeholder = await sink.upsertCaseReport({
      runId, testCaseId: 'tc-ingest-1', attempt: 1, reportId,
      report: { status: 'running', metricsStatus: 'pending', testCaseId: 'tc-ingest-1', testCaseVersion: 1, agentKey: 'external-agent', agentName: 'External', modelId: 'external-model', experimentRunId: runId, experimentId: benchmarkId, trajectory: [], metrics: {}, llmJudgeReasoning: '', timestamp: new Date().toISOString() } as any,
    });
    expect(placeholder.report).toMatchObject({ id: reportId, status: 'running' });

    const final = await sink.upsertCaseReport({
      runId, testCaseId: 'tc-ingest-1', attempt: 1, reportId,
      report: { status: 'completed', metricsStatus: 'completed', passFailStatus: 'passed', trajectory: [{ id: 's1', timestamp: Date.now(), type: 'response', content: 'done' }], metrics: { accuracy: 100 }, llmJudgeReasoning: 'ok' } as any,
    });
    expect(final.report).toMatchObject({ id: reportId, status: 'completed', passFailStatus: 'passed', agentKey: 'external-agent' });

    expect(await sink.setCaseResult(runId, 'tc-ingest-1', { reportId, status: 'completed', passFailStatus: 'passed' })).toEqual({ generation: 0 });
    expect(await sink.heartbeat(runId, { startedCount: 1, completedCount: 1, totalTestCases: 1 })).toEqual({ generation: 0 });

    const finalized = await sink.finalize(runId, {
      status: 'completed', benchmarkId,
      completedRun: { results: { 'tc-ingest-1': { reportId, status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: run.testCaseSnapshots, judgeModel: 'mock://demo-model', judgeProvider: 'demo' },
    });
    expect(finalized.status).toBe('completed');
    expect(finalized.stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 0, total: 1 });

    // Public read side: run doc, report doc, benchmark projection.
    const runDoc = await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
    expect((runDoc.body.evaluationRun ?? runDoc.body)).toMatchObject({ status: 'completed', judgeModel: 'mock://demo-model', results: { 'tc-ingest-1': { reportId, status: 'completed', passFailStatus: 'passed' } } });
    const reportDoc = await httpJson('GET', `${baseUrl}/api/storage/runs/${reportId}`);
    expect(reportDoc.status).toBe(200);
    expect(reportDoc.body.run ?? reportDoc.body).toMatchObject({ id: reportId, passFailStatus: 'passed', experimentRunId: runId });
    const benchDoc = await httpJson('GET', `${baseUrl}/api/storage/benchmarks/${benchmarkId}`);
    const projection = (benchDoc.body.benchmark ?? benchDoc.body).runs?.find((r: any) => r.id === runId);
    expect(projection).toMatchObject({ id: runId, name: 'Ingested run', status: 'completed', agentKey: 'external-agent', judgeModel: 'mock://demo-model', stats: finalized.stats });

    // A retried finalize (lost response) is a no-op: same terminal state, no duplicate projection.
    const again = await sink.finalize(runId, { status: 'completed', benchmarkId, completedRun: { results: {}, testCaseSnapshots: run.testCaseSnapshots } });
    expect(again.stats).toEqual(finalized.stats);
    const benchAgain = await httpJson('GET', `${baseUrl}/api/storage/benchmarks/${benchmarkId}`);
    expect((benchAgain.body.benchmark ?? benchAgain.body).runs.filter((r: any) => r.id === runId)).toHaveLength(1);

    // Cleanup what this test created (by id).
    await httpJson('DELETE', `${baseUrl}/api/storage/runs/${reportId}`);
    await httpJson('DELETE', `${baseUrl}/api/storage/evaluation-runs/${runId}`);
    await httpJson('DELETE', `${baseUrl}/api/storage/benchmarks/${benchmarkId}`);
  }, TEST_TIMEOUT);

  it('mutations without the executor token are refused (400) and unknown runs finalize as 404', async () => {
    const noToken = await httpJson('POST', `${baseUrl}/api/runs/ingest/run-x/heartbeat`, {});
    expect(noToken.status).toBe(400);
    expect(noToken.body.error).toMatch(/x-ah-executor/i);

    const unknown = await httpJson('POST', `${baseUrl}/api/runs/ingest/run-missing/finalize`, { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } }, { [EXECUTOR_TOKEN_HEADER]: 'deadbeef' });
    expect(unknown.status).toBe(404);
    expect(unknown.headers[EXECUTOR_TOKEN_HEADER]).toBe('deadbeef');

    const badCreate = await httpJson('POST', `${baseUrl}/api/runs/ingest`, { run: { name: 'no id' } });
    expect(badCreate.status).toBe(400);
  }, TEST_TIMEOUT);
});
