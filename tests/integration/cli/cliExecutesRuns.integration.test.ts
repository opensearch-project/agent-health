/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #612 step 3 — `benchmark` (unified modes) and `run` EXECUTE IN THE CLI
 * PROCESS and persist through the server's run-ingestion API.
 *
 * Real everything: the real CLI bundle (`cli/dist/index.js`) spawned the way a
 * user runs it, a real server process (FILE storage, temp project, OS-assigned
 * port) and a real REST agent stub. The agent's `beforeRequest` hook forwards
 * `process.env.AH_TEST_HOOK_VAR` to the stub, which echoes it as the agent's
 * answer, so every persisted report shows exactly which process's environment
 * the hook ran in.
 *
 *   1. Shell env of the CLI changes between two runs on ONE server → each
 *      report carries the CLI's value. Red on main: the server's own value.
 *   2. Two projects with conflicting `.env` values, concurrently, one server →
 *      each report carries its own. Red on main: both carry the server's.
 *   3. A code-SDK eval file given by a path RELATIVE to a project the server
 *      never saw → the body runs (matcher results persisted). Red on main:
 *      "Code file not found" (resolved against the server's cwd).
 *   4. Judge credentials absent in the CLI → the case is `metricsStatus:
 *      'error'` with the provider's message, exit 1, and the server's judge
 *      route was never called (positive control proves the log marker).
 *   5. SIGKILL the CLI mid-run → the sweeper fails the run "executor lost"
 *      within the (scaled) lease TTL, never-started cases `cancelled`.
 *   6. UI cancel (`POST …/cancel`) reaches the CLI through the lease echo →
 *      the CLI exits reporting the cancellation, the doc is `cancelled` with
 *      explicit markers for the never-started cases.
 *   7. The server is SIGKILLed and restarted on the same port while the CLI is
 *      delivering the last case → the sink retries, the run completes, exactly
 *      one run document exists.
 *
 * Lease TTL is scaled down via `AH_RUN_LEASE_TTL_MS` (heartbeat scales with it,
 * lib/runLease.ts). Build first: `npm run build:server && npm run build:cli`
 * (the suite builds whatever is missing).
 *
 * Run:
 *   npm run test:integration -- --testPathPatterns=cliExecutesRuns
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { tmpdir } from 'os';
import * as path from 'path';
import { withCliCoverage } from '../../helpers/cliCoverage';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const SERVER_BUNDLE = path.join(REPO_ROOT, 'server', 'dist', 'index.js');
const TEST_TIMEOUT = 180_000;

// Scaled lease: 15 s TTL → 1 s heartbeat; the sweeper runs every second. Long
// enough that a 6–8 s server outage (scenario 7) never expires a live run.
const TTL_MS = 15_000;
const SWEEP_MS = 1000;

/* ───────────────────────── helpers ───────────────────────── */

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
/** Plain `http` (not undici) — see the Jest 30 + undici loopback note in benchmarkCodeSdk. */
function httpJson<T = any>(method: string, url: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; body: T; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, timeout: timeoutMs,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: any; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = undefined; }
        resolve({ status: res.statusCode || 0, body: parsed, text });
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
    try { if ((await httpJson('GET', `${baseUrl}/health`, undefined, 3000)).status === 200) return; } catch (e: any) { last = e?.message; }
    await new Promise(r => setTimeout(r, 250));
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
async function until(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${label}: not satisfied within ${timeoutMs}ms`);
}

/** Minimal env for a child: no inherited AH_PORT / NODE_OPTIONS / AWS_* / OPENSEARCH_* → FILE storage, no cloud creds. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return Object.assign(env, {
    AH_HEADLESS: '1', AGENT_HEALTH_STORAGE: 'file', BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1', AH_QUIET_DEPRECATIONS: '1', NO_COLOR: '1', NODE_ENV: 'test',
    TRACE_POLL_MAX_ATTEMPTS: '1', TRACE_POLL_INTERVAL_MS: '100',
    // No AWS credentials anywhere, and never wait on the EC2 metadata probe.
    AWS_EC2_METADATA_DISABLED: 'true', AWS_PROFILE: 'ah-test-profile-that-does-not-exist', AWS_REGION: 'us-east-1',
    AH_RUN_LEASE_TTL_MS: String(TTL_MS), AH_RUN_LEASE_SWEEP_INTERVAL_MS: String(SWEEP_MS),
  }, extra);
}
function ensureBuilt(): void {
  const scripts: Array<[string, string]> = [[CLI_BUNDLE, 'build:cli'], [SERVER_BUNDLE, 'build:server']];
  for (const [file, script] of scripts) {
    if (existsSync(file)) continue;
    const b = spawnSync('npm', ['run', script], { cwd: REPO_ROOT, encoding: 'utf-8' });
    if (b.status !== 0) throw new Error(`${script} failed: ${b.stderr}`);
  }
}

interface Spawned { child: ChildProcess; log: () => string; pid: number }
function spawnServer(project: string, port: number, env: Record<string, string>): Spawned {
  let log = '';
  const child = spawn(process.execPath, [SERVER_BUNDLE], { cwd: project, env: cleanEnv({ AH_PORT: String(port), PORT: String(port), ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', c => { log += c; });
  child.stderr!.on('data', c => { log += c; });
  return { child, log: () => log, pid: child.pid! };
}
async function stopServer(s: Spawned | undefined): Promise<void> {
  if (!s?.pid) return;
  try { s.child.kill('SIGTERM'); } catch { /* gone */ }
  if (!(await waitForExit(s.pid, 8000))) { try { s.child.kill('SIGKILL'); } catch { /* noop */ } }
}

interface CliResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; out: string }
interface CliHandle { child: ChildProcess; pid: number; done: Promise<CliResult>; out: () => string }
function spawnCli(cwd: string, args: string[], env: Record<string, string>): CliHandle {
  let stdout = ''; let stderr = '';
  const child = spawn(process.execPath, [CLI_BUNDLE, ...args], { cwd, env: withCliCoverage(cleanEnv(env)), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', c => { stdout += c; });
  child.stderr!.on('data', c => { stderr += c; });
  const done = new Promise<CliResult>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr, out: stdout + stderr }));
  });
  return { child, pid: child.pid!, done, out: () => stdout + stderr };
}

/** The agent stub: echoes the hook's env value; per-request delay; lets a test react to the Nth request. */
interface AgentStub { server: Server; endpoint: string; requests: Array<{ hookVar: string; prompt: string }>; delayMs: number; onRequest?: (n: number) => void }
async function startAgentStub(): Promise<AgentStub> {
  const stub: AgentStub = { server: undefined as any, endpoint: '', requests: [], delayMs: 0 };
  stub.server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      stub.requests.push({ hookVar: String(payload.hookVar), prompt: String(payload.prompt ?? payload.message ?? payload.input ?? '') });
      stub.onRequest?.(stub.requests.length);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: `hook=${payload.hookVar}` }));
      }, stub.delayMs);
    });
  });
  stub.endpoint = `http://127.0.0.1:${await listen(stub.server)}/ask`;
  return stub;
}

/** A project: REST agent whose beforeRequest hook forwards AH_TEST_HOOK_VAR; a Bedrock judge model for the no-credentials case. */
function writeProject(dir: string, agentEndpoint: string, dotenv: string, caseNames: string[]): void {
  mkdirSync(path.join(dir, 'cases'), { recursive: true });
  writeFileSync(path.join(dir, 'agent-health.config.mjs'), `export default {
  agents: [{
    key: 'env-echo-agent', name: 'Env Echo Agent', connectorType: 'rest', endpoint: ${JSON.stringify(agentEndpoint)}, useTraces: false,
    hooks: {
      // Reads the environment at REQUEST time — the values the hook sees are
      // the ones of the process that executes the run.
      beforeRequest: async (ctx) => ({ ...ctx, payload: { ...ctx.payload, hookVar: process.env.AH_TEST_HOOK_VAR ?? 'unset' } }),
    },
  }],
  models: [{ key: 'judge-bedrock', model_id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0', display_name: 'Bedrock judge', provider: 'bedrock' }],
};
`);
  writeFileSync(path.join(dir, '.env'), dotenv);
  writeFileSync(path.join(dir, 'cases', 'cases.json'), JSON.stringify(caseNames.map((name, i) => ({
    name, category: 'General', difficulty: 'Easy', initialPrompt: `question ${i + 1} of ${name}`, expectedOutcomes: ['echoes the environment'],
  })), null, 2));
}

const COMMON_CLI_ARGS = ['benchmark', '-d', './cases', '-a', 'env-echo-agent', '--judge-model', 'demo-model'];

function runIdFrom(out: string): string {
  const m = out.match(/eval-run-[0-9]+-[a-z0-9]+/);
  if (!m) throw new Error(`no run id in CLI output:\n${out}`);
  return m[0];
}
async function reportOf(baseUrl: string, run: any, caseIndex = 0): Promise<any> {
  const entries = Object.values(run.results ?? {}) as any[];
  const reportId = entries[caseIndex]?.reportId;
  expect(reportId).toBeTruthy();
  const r = await httpJson('GET', `${baseUrl}/api/storage/runs/${encodeURIComponent(reportId)}`);
  expect(r.status).toBe(200);
  return r.body.run ?? r.body;
}
function finalResponse(report: any): string {
  const step = [...(report.trajectory ?? [])].reverse().find((s: any) => s.type === 'response' || s.type === 'assistant');
  return step?.content ?? '';
}

/* ───────────────────────── suite ───────────────────────── */

describe('CLI executes runs in its own process and persists through the run-ingestion API (#612 step 3)', () => {
  let projectA: string;
  let projectB: string;
  let stub: AgentStub;
  let port: number;
  let baseUrl: string;
  let server: Spawned | undefined;
  const SERVER_SHELL_VALUE = 'server-shell-value';
  const uniq = Date.now().toString(36);

  const startProjectServer = async (): Promise<void> => {
    server = spawnServer(projectA, port, { AH_TEST_HOOK_VAR: SERVER_SHELL_VALUE });
    try {
      await waitForHealth(baseUrl, 60_000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- server output ---\n${server.log()}`);
    }
  };

  beforeAll(async () => {
    ensureBuilt();
    stub = await startAgentStub();
    projectA = mkdtempSync(path.join(tmpdir(), 'ah-cli-exec-a-'));
    projectB = mkdtempSync(path.join(tmpdir(), 'ah-cli-exec-b-'));
    writeProject(projectA, stub.endpoint, 'AH_TEST_HOOK_VAR=dotenv-A\n', [`cli-exec-a1-${uniq}`, `cli-exec-a2-${uniq}`, `cli-exec-a3-${uniq}`]);
    writeProject(projectB, stub.endpoint, 'AH_TEST_HOOK_VAR=dotenv-B\n', [`cli-exec-b1-${uniq}`]);
    const reservation = createServer();
    port = await listen(reservation);
    await closeServer(reservation);
    baseUrl = `http://127.0.0.1:${port}`;
    await startProjectServer();
    const storage = await httpJson<{ backend?: string }>('GET', `${baseUrl}/api/storage/health`);
    expect(storage.body.backend).toBe('file');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await stopServer(server);
    if (stub?.server) await closeServer(stub.server);
    for (const dir of [projectA, projectB]) if (dir) rmSync(dir, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  beforeEach(() => { stub.requests.length = 0; stub.delayMs = 0; stub.onRequest = undefined; });

  it('1. the CLI shell environment is what the hook sees — it changes between two runs on ONE server, no restart', async () => {
    const first = await spawnCli(projectA, COMMON_CLI_ARGS, { AH_PORT: String(port), AH_TEST_HOOK_VAR: 'shell-1' }).done;
    expect(first.code).toBe(0);
    const run1 = await waitForRun(baseUrl, runIdFrom(first.out), r => r.status === 'completed', 10_000, 'run 1 terminal');
    expect(finalResponse(await reportOf(baseUrl, run1))).toBe('hook=shell-1');

    const second = await spawnCli(projectA, COMMON_CLI_ARGS, { AH_PORT: String(port), AH_TEST_HOOK_VAR: 'shell-2' }).done;
    expect(second.code).toBe(0);
    const run2 = await waitForRun(baseUrl, runIdFrom(second.out), r => r.status === 'completed', 10_000, 'run 2 terminal');
    expect(finalResponse(await reportOf(baseUrl, run2))).toBe('hook=shell-2');

    // Run documents say who executed them, and the server never ran the agent itself.
    expect(run1.executor).toMatchObject({ kind: 'cli' });
    expect(run1.trigger).toBe('cli');
    expect(stub.requests.map(r => r.hookVar)).toEqual(['shell-1', 'shell-1', 'shell-1', 'shell-2', 'shell-2', 'shell-2']);
    expect(server!.log()).not.toContain('[EvaluationRunner] Starting run');
    // The CLI reports what the server confirmed.
    expect(first.out).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
    expect(first.out).toMatch(/Passed: 3/);
  }, TEST_TIMEOUT);

  it('2. two projects with conflicting .env values, running concurrently against one server, each see their own', async () => {
    // Neither CLI exports the variable: the value comes from each project's `.env`.
    const a = spawnCli(projectA, COMMON_CLI_ARGS, { AH_PORT: String(port) });
    const b = spawnCli(projectB, COMMON_CLI_ARGS, { AH_PORT: String(port), AH_REUSE_FOREIGN_SERVER: '1' });
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    const runA = await waitForRun(baseUrl, runIdFrom(ra.out), r => r.status === 'completed', 10_000, 'A terminal');
    const runB = await waitForRun(baseUrl, runIdFrom(rb.out), r => r.status === 'completed', 10_000, 'B terminal');
    expect(finalResponse(await reportOf(baseUrl, runA))).toBe('hook=dotenv-A');
    expect(finalResponse(await reportOf(baseUrl, runB))).toBe('hook=dotenv-B');
    expect(new Set(stub.requests.map(r => r.hookVar))).toEqual(new Set(['dotenv-A', 'dotenv-B']));
  }, TEST_TIMEOUT);

  it('3. a code-SDK eval file at a path relative to a project the server never saw runs its body in the CLI', async () => {
    mkdirSync(path.join(projectB, 'evals'), { recursive: true });
    writeFileSync(path.join(projectB, 'evals', 'local.eval.js'), `
const { test, expect } = require('@opensearch-project/agent-health');
test('cli-exec-body-${uniq}', { prompt: 'say something' }, ({ result }) => {
  // The body runs where the file was resolved: it sees this project's .env.
  expect(process.env.AH_TEST_HOOK_VAR).to.equal('dotenv-B');
  expect(result).to.haveCompletedWithin(60_000);
});
`);
    const r = await spawnCli(projectB, ['benchmark', '-f', './evals/local.eval.js', '-a', 'env-echo-agent', '--judge-model', 'demo-model', '-n', `cli-exec-code-${uniq}`],
      { AH_PORT: String(port), AH_REUSE_FOREIGN_SERVER: '1' }).done;
    expect(r.code).toBe(0);
    const run = await waitForRun(baseUrl, runIdFrom(r.out), x => x.status === 'completed', 10_000, 'code run terminal');
    const report = await reportOf(baseUrl, run);
    expect(report.passFailStatus).toBe('passed');
    expect(Array.isArray(report.matcherResults)).toBe(true);
    expect(report.matcherResults.length).toBeGreaterThanOrEqual(2);
    expect(report.matcherResults.every((m: any) => m.pass === true)).toBe(true);
    expect(report.matcherResults[0]).toMatchObject({ actual: 'dotenv-B', expected: 'dotenv-B' });
    // The stored test case names the file relative to project B — a path the server (cwd A) has never seen.
    const tc = await httpJson('GET', `${baseUrl}/api/storage/test-cases/${encodeURIComponent(report.testCaseId)}`);
    expect(tc.body.sourceFile).toBe('evals/local.eval.js');
    // Linked into the benchmark the CLI named.
    const bench = await httpJson('GET', `${baseUrl}/api/storage/benchmarks/${encodeURIComponent(run.benchmarkId)}`);
    expect(bench.body.testCaseIds).toContain(report.testCaseId);
    expect(bench.body.runs.map((x: any) => x.id)).toContain(run.id);
  }, TEST_TIMEOUT);

  it('4. judge credentials absent in the CLI → errored verdicts with the provider message, exit 1, NO judge call on the server', async () => {
    const marker = '[JudgeAPI] Error during evaluation';
    const logBefore = server!.log().length;
    const r = await spawnCli(projectA, ['benchmark', '-d', './cases', '-a', 'env-echo-agent', '--judge-model', 'judge-bedrock'],
      { AH_PORT: String(port), AH_JUDGE_MAX_ATTEMPTS: '1' }).done;
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Errored: 3/);
    expect(r.out).toMatch(/exiting with code 1/);
    const run = await waitForRun(baseUrl, runIdFrom(r.out), x => x.status === 'completed', 10_000, 'no-creds run terminal');
    const report = await reportOf(baseUrl, run);
    expect(report.status).toBe('completed');
    expect(report.metricsStatus).toBe('error');
    expect(report.passFailStatus ?? null).toBeNull();
    expect(report.judgeError?.message).toMatch(/Could not load credentials|credentials/i);
    expect(run.stats).toMatchObject({ errored: 3, passed: 0, failed: 0 });

    // The server never judged: no marker during the run …
    expect(server!.log().slice(logBefore)).not.toContain(marker);
    // … and the marker is what the server DOES print when its judge route is hit (positive control, same no-creds server).
    const probe = await httpJson('POST', `${baseUrl}/api/judge`, { trajectory: [{ type: 'response', content: 'x' }], expectedOutcomes: ['y'], modelId: 'judge-bedrock' }, 60_000);
    expect(probe.status).toBe(500);
    await until(() => server!.log().includes(marker), 5000, 'positive control marker');
  }, TEST_TIMEOUT);

  it('5. SIGKILL the CLI mid-run → the sweeper fails the run "executor lost" within the TTL, never-started cases cancelled', async () => {
    stub.delayMs = 1500;
    const cli = spawnCli(projectA, COMMON_CLI_ARGS, { AH_PORT: String(port), AH_TEST_HOOK_VAR: 'killed' });
    // Wait until the run exists and the first case is in flight, then kill the executor outright.
    await until(() => stub.requests.length >= 1, 30_000, 'first agent request');
    const inFlight = await httpJson('GET', `${baseUrl}/api/runs/in-flight`);
    const mine = (inFlight.body.runs as any[]).find(x => x.source === 'lease' && x.lease?.live);
    expect(mine).toBeTruthy();
    cli.child.kill('SIGKILL');
    const exited = await cli.done;
    expect(exited.signal).toBe('SIGKILL');

    const failed = await waitForRun(baseUrl, mine.id, x => x.status === 'failed', TTL_MS + 3 * SWEEP_MS + 5000, 'swept run');
    expect(failed.error).toMatch(/^executor lost \(no heartbeat since /);
    expect(failed.executor?.id ?? null).toBeNull();
    expect(failed.lease.generation).toBe(2);
    const statuses = Object.values(failed.results ?? {}).map((x: any) => x.status);
    expect(statuses).toContain('cancelled');
    // The spool of the unconfirmed run stays behind for the user to inspect.
    const spool = readdirSync(path.join(projectA, '.agent-health', 'spool'));
    expect(spool).toContain(`${mine.id}.ndjson`);
  }, TEST_TIMEOUT);

  it('6. UI cancel reaches the CLI through the lease echo → the CLI exits reporting the cancel; doc cancelled with markers', async () => {
    stub.delayMs = 1500;
    const cli = spawnCli(projectA, COMMON_CLI_ARGS, { AH_PORT: String(port), AH_TEST_HOOK_VAR: 'cancelled' });
    await until(() => stub.requests.length >= 1, 30_000, 'first agent request');
    const inFlight = await httpJson('GET', `${baseUrl}/api/runs/in-flight`);
    const mine = (inFlight.body.runs as any[]).find(x => x.source === 'lease' && x.lease?.live);
    expect(mine).toBeTruthy();
    const cancel = await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs/${mine.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ success: true, draining: true, viaLease: true });

    const exited = await cli.done;
    // #600 rules: a cancelled run has never-run cases → exit 1, reported as cancelled.
    expect(exited.code).toBe(1);
    expect(exited.out).toMatch(/Evaluation run cancelled/);
    const doc = await waitForRun(baseUrl, mine.id, x => x.status === 'cancelled', 10_000, 'cancelled doc');
    const statuses = Object.values(doc.results ?? {}).map((x: any) => x.status);
    expect(statuses).toContain('completed');
    expect(statuses).toContain('cancelled');
    expect(doc.cancelRequestedAt).toBeTruthy();
    // The CLI stopped after the in-flight case: the stub saw fewer requests than cases.
    expect(stub.requests.length).toBeLessThan(3);
  }, TEST_TIMEOUT);

  it('7. the server is SIGKILLed and restarted on the same port while the CLI delivers the last case → delivered after re-probe, one run', async () => {
    stub.delayMs = 1500;
    const runName = `cli-exec-restart-${uniq}`;
    // On the LAST case's agent request kill the server; restart it after the stub has answered.
    let restarted: Promise<void> | undefined;
    stub.onRequest = (n) => {
      if (n !== 3) return;
      server!.child.kill('SIGKILL');
      restarted = (async () => {
        await waitForExit(server!.pid, 8000);
        await new Promise(r => setTimeout(r, 3000)); // the CLI's result writes land on a dead port meanwhile
        await startProjectServer();
      })();
    };
    const cli = spawnCli(projectA, [...COMMON_CLI_ARGS, '-n', runName], { AH_PORT: String(port), AH_TEST_HOOK_VAR: 'restart' });
    const exited = await cli.done;
    await restarted;
    expect(exited.code).toBe(0);
    expect(exited.out).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
    const runId = runIdFrom(exited.out);
    const run = await waitForRun(baseUrl, runId, x => x.status === 'completed', 10_000, 'restart run terminal');
    expect(run.stats).toMatchObject({ passed: 3, total: 3 });
    expect(finalResponse(await reportOf(baseUrl, run, 2))).toBe('hook=restart');
    // Exactly one run under the benchmark the CLI named; no duplicate from the retries.
    const bench = await httpJson('GET', `${baseUrl}/api/storage/benchmarks/${encodeURIComponent(run.benchmarkId)}`);
    expect(bench.body.runs.map((x: any) => x.id)).toEqual([runId]);
    const all = await httpJson('GET', `${baseUrl}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(run.benchmarkId)}&size=50`);
    expect(all.body.evaluationRuns.map((x: any) => x.id)).toEqual([runId]);
    // The spool of a confirmed run is gone.
    expect(existsSync(path.join(projectA, '.agent-health', 'spool', `${runId}.ndjson`))).toBe(false);
  }, TEST_TIMEOUT);
});
