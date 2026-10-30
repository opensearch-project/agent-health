/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real CLI process, real server, real REST agent that REJECTS requests.
 *
 * Bug (seen on 0.8.2 against a local file store): `agent-health benchmark`
 * printed "✓ Passed: N" and exited 0 when ALL N test cases ERRORED — every
 * agent request got a 403 (expired SigV4 credentials). The unified summary
 * counted `results[*].status === 'completed'` as passed, but the runner
 * writes `completed` for any case whose execution finished, including one
 * whose agent request failed and therefore has NO verdict (report
 * `metricsStatus: 'error'`, `failureStage: 'agent'`).
 *
 * This suite reproduces that shape end to end — a stub REST agent answers
 * 403 to every request (`/forbidden`) or only to prompts containing `DENY`
 * (`/mixed`) — and asserts the summary and exit code of the real
 * `cli/dist/index.js` process, for `benchmark` text output, `benchmark -o
 * json`, a pass/fail-only run (exit-code convention guard) and `run`.
 *
 * Self-contained: it boots its OWN headless server (FILE storage under a temp
 * project dir that is deleted in afterAll), so nothing is created on a shared
 * cluster and no id tracking is needed. Port: `AH_CLI_SUMMARY_TEST_PORT`, else
 * an OS-assigned free port. Build first: npm run build:server && npm run
 * build:cli (the suite builds whatever is missing).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { tmpdir } from 'os';
import * as path from 'path';
import { withCliCoverage } from '../../helpers/cliCoverage';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const TEST_TIMEOUT = 180_000;
const CLI_TIMEOUT = 120_000;

const FORBIDDEN_BODY = JSON.stringify({ message: 'The security token included in the request is expired' });

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

/** Plain `http` (not undici) — the Jest 30 + undici loopback race documented in benchmarkCodeSdk. */
function httpGet<T = any>(url: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T) }); }
        catch { resolve({ status: res.statusCode || 0, body: text as any }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpGet(`${base}/health`);
      if (r.status === 200) return;
      last = `status ${r.status}`;
    } catch (e: any) { last = e?.message ?? String(e); }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on ${base} did not become healthy in ${timeoutMs}ms (${last})`);
}

/**
 * Minimal env for the server + CLI children: jest's own NODE_OPTIONS /
 * coverage shims confuse undici inside the spawned CLI (see
 * benchmarkCodeSdk.integration.test.ts), and no OPENSEARCH_* so storage is
 * the FILE backend under the temp project dir.
 */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR') env[k] = v;
  }
  return Object.assign(env, {
    HOST: '127.0.0.1',
    AH_HEADLESS: '1',
    AGENT_HEALTH_STORAGE: 'file',
    BENCHMARK_RUN_RECOVERY_DISABLED: '1',
    EVALUATION_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1',
    AH_QUIET_DEPRECATIONS: '1',
    NO_COLOR: '1',
    NODE_ENV: 'test',
  }, extra);
}

const ALL_ERRORED_EVAL = `
const { test, expect } = require('@opensearch-project/agent-health');
for (let i = 1; i <= 5; i++) {
  test('errored case ' + i, { prompt: 'question ' + i }, async ({ agent }) => {
    const result = await agent.run();
    expect(result).to.haveCompletedWithin(60000);
  });
}
`;

// 2 pass (agent 200 + matcher passes), 1 fail (agent 200 + failing chai
// assertion), 2 errored (prompt carries DENY → agent 403 → agent.run() rejects).
const MIXED_EVAL = `
const { test, expect } = require('@opensearch-project/agent-health');
test('pass 1', { prompt: 'question A' }, async ({ agent }) => { const r = await agent.run(); expect(r).to.haveCompletedWithin(60000); });
test('pass 2', { prompt: 'question B' }, async ({ agent }) => { const r = await agent.run(); expect(r).to.haveCompletedWithin(60000); });
test('fail 1', { prompt: 'question C' }, async ({ agent }) => { await agent.run(); expect('a').to.equal('b'); });
test('errored 1', { prompt: 'DENY question D' }, async ({ agent }) => { const r = await agent.run(); expect(r).to.haveCompletedWithin(60000); });
test('errored 2', { prompt: 'DENY question E' }, async ({ agent }) => { const r = await agent.run(); expect(r).to.haveCompletedWithin(60000); });
`;

const PASS_FAIL_EVAL = `
const { test, expect } = require('@opensearch-project/agent-health');
test('pass 1', { prompt: 'question A' }, async ({ agent }) => { const r = await agent.run(); expect(r).to.haveCompletedWithin(60000); });
test('fail 1', { prompt: 'question C' }, async ({ agent }) => { await agent.run(); expect('a').to.equal('b'); });
`;

describe('CLI summary counts errored (not judged) cases — real CLI vs a 403-ing REST agent (own headless server, FILE storage)', () => {
  let project: string;
  let agentServer: Server;
  let agentRequests: Array<{ path: string; status: number }> = [];
  let server: ChildProcess | undefined;
  let port: number;
  let baseUrl: string;

  /**
   * Async spawn (NOT spawnSync): the stub agent lives on THIS process's event
   * loop, so a blocking wait would never let it answer the server's requests.
   */
  function runCli(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
        cwd: project,
        env: withCliCoverage(cleanEnv({ AH_PORT: String(port) })),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => { stdout += c.toString(); });
      child.stderr.on('data', c => { stderr += c.toString(); });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI timed out after ${CLI_TIMEOUT}ms.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }, CLI_TIMEOUT);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', status => {
        clearTimeout(timer);
        resolve({ stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), status });
      });
    });
  }

  beforeAll(async () => {
    if (!existsSync(SERVER_APP)) {
      const b = spawnSync('npm', ['run', 'build:server'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:server failed: ${b.stderr}`);
    }
    if (!existsSync(CLI_BUNDLE)) {
      const b = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:cli failed: ${b.stderr}`);
    }

    // Stub REST agent. `/forbidden`: 403 for every request (expired-credential
    // shape). `/mixed`: 403 only when the prompt contains DENY, else a 200
    // with a deterministic answer.
    agentServer = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const deny = (req.url || '').startsWith('/forbidden') || ((req.url || '').startsWith('/mixed') && body.includes('DENY'));
        const status = deny ? 403 : 200;
        agentRequests.push({ path: req.url || '', status });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(deny ? FORBIDDEN_BODY : JSON.stringify({ response: 'deterministic fixture answer' }));
      });
    });
    const agentPort = await listen(agentServer);

    project = mkdtempSync(path.join(tmpdir(), 'ah-cli-errored-summary-'));
    writeFileSync(path.join(project, 'agent-health.config.mjs'), `export default ${JSON.stringify({
      agents: [
        { key: 'stub-forbidden', name: 'Stub Forbidden Agent', connectorType: 'rest', endpoint: `http://127.0.0.1:${agentPort}/forbidden`, useTraces: false },
        { key: 'stub-mixed', name: 'Stub Mixed Agent', connectorType: 'rest', endpoint: `http://127.0.0.1:${agentPort}/mixed`, useTraces: false },
      ],
    }, null, 2)};\n`);
    mkdirSync(path.join(project, 'evals'));
    writeFileSync(path.join(project, 'evals/all-errored.eval.js'), ALL_ERRORED_EVAL);
    writeFileSync(path.join(project, 'evals/mixed.eval.js'), MIXED_EVAL);
    writeFileSync(path.join(project, 'evals/pass-fail.eval.js'), PASS_FAIL_EVAL);

    if (process.env.AH_CLI_SUMMARY_TEST_PORT) {
      port = Number(process.env.AH_CLI_SUMMARY_TEST_PORT);
    } else {
      const reservation = createServer();
      port = await listen(reservation);
      await closeServer(reservation);
    }
    baseUrl = `http://127.0.0.1:${port}`;

    // Own headless server from the temp project (its config.mjs = the two
    // stub agents; no storage block + no OPENSEARCH_* env = FILE storage).
    server = spawn(process.execPath, [CLI_BUNDLE, 'serve', '-p', String(port), '--headless', '--no-browser'], {
      cwd: project,
      env: cleanEnv({ AH_PORT: String(port), PORT: String(port) }),
      stdio: 'ignore',
    });
    await waitForHealth(baseUrl, 60_000);
    const storage = await httpGet<{ backend?: string }>(`${baseUrl}/api/storage/health`);
    expect(storage.body.backend).toBe('file');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Only the server THIS suite spawned, by its captured handle.
    if (server?.pid) {
      try { server.kill('SIGTERM'); } catch { /* noop */ }
      await new Promise(r => setTimeout(r, 500));
      try { server.kill('SIGKILL'); } catch { /* noop */ }
    }
    if (agentServer) await closeServer(agentServer);
    // FILE storage (test cases, benchmarks, runs, reports) lives under
    // <project>/.agent-health — removed with the temp dir.
    if (project) rmSync(project, { recursive: true, force: true });
  });

  beforeEach(() => { agentRequests = []; });

  it('all 5 agent requests 403 → "Errored: 5", "Passed: 0", never "Passed: 5", exit code 1', async () => {
    const cli = await runCli(['benchmark', '-f', 'evals/all-errored.eval.js', '-a', 'stub-forbidden', '-n', 'all-errored']);

    expect(agentRequests).toHaveLength(5);
    expect(agentRequests.every(r => r.status === 403)).toBe(true);

    expect(cli.stdout).toContain('✓ Passed: 0');
    expect(cli.stdout).toContain('✗ Failed: 0');
    expect(cli.stdout).toContain('Errored: 5');
    expect(cli.stdout).toContain('Total: 5');
    expect(cli.stdout).not.toContain('Passed: 5');
    expect(cli.stdout).toContain('5 of 5 test case(s) could not be evaluated');
    expect(cli.status).toBe(1);
  }, TEST_TIMEOUT);

  it('mixed run → exactly "Passed: 2", "Failed: 1", "Errored: 2", exit code 1', async () => {
    const cli = await runCli(['benchmark', '-f', 'evals/mixed.eval.js', '-a', 'stub-mixed', '-n', 'mixed']);

    expect(agentRequests.filter(r => r.status === 403)).toHaveLength(2);
    expect(agentRequests.filter(r => r.status === 200)).toHaveLength(3);

    expect(cli.stdout).toContain('✓ Passed: 2');
    expect(cli.stdout).toContain('✗ Failed: 1');
    expect(cli.stdout).toContain('Errored: 2');
    expect(cli.stdout).toContain('Total: 5');
    expect(cli.status).toBe(1);
  }, TEST_TIMEOUT);

  it('mixed run with -o json → machine-readable counts incl. errored; passRate over the judged set; exit code 1', async () => {
    const cli = await runCli(['benchmark', '-f', 'evals/mixed.eval.js', '-a', 'stub-mixed', '-n', 'mixed-json', '-o', 'json']);

    const start = cli.stdout.indexOf('{');
    const end = cli.stdout.lastIndexOf('}');
    expect(start).toBeGreaterThanOrEqual(0);
    const summary = JSON.parse(cli.stdout.slice(start, end + 1));
    expect(summary).toMatchObject({
      agent: { key: 'stub-mixed' },
      status: 'completed',
      passed: 2,
      failed: 1,
      errored: 2,
      notRun: 0,
      total: 5,
      passRate: 67,
    });
    expect(typeof summary.runId).toBe('string');
    expect(typeof summary.benchmarkId).toBe('string');
    expect(cli.stdout).not.toContain('✓ Passed:');
    expect(cli.status).toBe(1);
  }, TEST_TIMEOUT);

  it('exit-code convention guard: a run where every case was judged (1 passed, 1 FAILED verdict) still exits 0', async () => {
    const cli = await runCli(['benchmark', '-f', 'evals/pass-fail.eval.js', '-a', 'stub-mixed', '-n', 'pass-fail']);

    expect(cli.stdout).toContain('✓ Passed: 1');
    expect(cli.stdout).toContain('✗ Failed: 1');
    expect(cli.stdout).not.toContain('Errored:');
    expect(cli.stdout).toContain('Total: 2');
    expect(cli.status).toBe(0);
  }, TEST_TIMEOUT);

  it('`run` against the 403-ing agent reports ERRORED (not a FAILED verdict) and exits 1', async () => {
    // Reuse a test case persisted by the runs above (FILE storage of this suite's own server).
    const list = await httpGet<any>(`${baseUrl}/api/storage/test-cases?size=5`);
    const testCaseId: string | undefined = (list.body.testCases || list.body.items || [])[0]?.id;
    expect(testCaseId).toBeDefined();

    const cli = await runCli(['run', '-t', testCaseId!, '-a', 'stub-forbidden']);

    expect(agentRequests).toHaveLength(1);
    expect(agentRequests[0].status).toBe(403);
    expect(cli.stdout).toContain('ERRORED');
    expect(cli.stdout).not.toMatch(/\bFAILED\b/);
    expect(cli.status).toBe(1);
  }, TEST_TIMEOUT);
});
