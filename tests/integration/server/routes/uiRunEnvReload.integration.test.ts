/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #612 acceptance (b) for UI-started runs: editing `.env` or
 * `agent-health.config.*` between two runs on ONE long-lived server takes
 * effect on the next run — no restart. A variable exported in the shell that
 * started the server is NOT overridden by `.env`.
 *
 * Real everything: a real server process started from a temp project (via the
 * CLI `serve` command — the path a user's auto-started server takes — and via
 * `node server/dist/index.js`), a real REST agent stub, the real
 * `POST /api/storage/evaluation-runs` (UI) route, FILE storage. The agent's
 * `beforeRequest` hook reads two env vars and sends them to the stub, which
 * echoes them as the agent's answer, so the persisted report's final response
 * shows exactly which values the hook saw.
 *
 * Red on the previous behaviour: the second run still showed the boot-time
 * values (config and `.env` were loaded once, at startup).
 *
 * Build first: npm run build:server && npm run build:cli (the suite builds
 * whatever is missing). Ports: an OS-assigned free port per server.
 *
 * Run:
 *   npm run test:integration -- --testPathPatterns=uiRunEnvReload
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { tmpdir } from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const SERVER_BUNDLE = path.join(REPO_ROOT, 'server', 'dist', 'index.js');
const TEST_TIMEOUT = 180_000;

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

/** Plain `http` (not undici) — see the Jest 30 + undici loopback note in benchmarkCodeSdk. */
function httpJson<T = any>(method: string, url: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; body: T; text: string }> {
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
        let parsed: any;
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = undefined; }
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
    try {
      const r = await httpJson('GET', `${baseUrl}/health`, undefined, 3000);
      if (r.status === 200) return;
      last = `status ${r.status}`;
    } catch (e: any) { last = e?.message ?? String(e); }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server at ${baseUrl} did not become healthy in ${timeoutMs}ms (${last})`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** Minimal env for the server child: no inherited AH_PORT / NODE_OPTIONS / OPENSEARCH_* → FILE storage. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR') env[k] = v;
  }
  return Object.assign(env, {
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

function ensureBuilt(): void {
  const scripts: Array<[string, string]> = [[CLI_BUNDLE, 'build:cli'], [SERVER_BUNDLE, 'build:server']];
  for (const [file, script] of scripts) {
    if (existsSync(file)) continue;
    const b = spawnSync('npm', ['run', script], { cwd: REPO_ROOT, encoding: 'utf-8' });
    if (b.status !== 0) throw new Error(`${script} failed: ${b.stderr}`);
  }
}

/** The agent config: a REST agent whose beforeRequest hook forwards two env vars. */
function configModule(agentEndpoint: string, agentName: string): string {
  return `export default {
  agents: [
    {
      key: 'env-echo-agent',
      name: ${JSON.stringify(agentName)},
      connectorType: 'rest',
      endpoint: ${JSON.stringify(agentEndpoint)},
      useTraces: false,
      hooks: {
        // Reads the environment at REQUEST time — the values the hook sees are
        // the ones this process has when the run executes.
        beforeRequest: async (ctx) => ({
          ...ctx,
          payload: { ...ctx.payload, hookVar: process.env.AH_TEST_HOOK_VAR ?? 'unset', shellVar: process.env.AH_TEST_SHELL_VAR ?? 'unset' },
        }),
      },
    },
  ],
};
`;
}

interface Launcher { name: string; args: (port: number) => string[]; }
const LAUNCHERS: Launcher[] = [
  { name: 'agent-health serve (CLI bundle)', args: (port) => [CLI_BUNDLE, 'serve', '-p', String(port), '--headless', '--no-browser'] },
  { name: 'node server/dist/index.js', args: () => [SERVER_BUNDLE] },
];

describe.each(LAUNCHERS)('UI-started runs pick up .env / config edits without a restart — $name (#612)', ({ args }) => {
  let project: string;
  let agentServer: Server;
  let agentEndpoint: string;
  let server: ChildProcess | undefined;
  let baseUrl: string;
  let serverLog = '';
  const agentRequests: Array<{ hookVar: string; shellVar: string }> = [];

  beforeAll(async () => {
    ensureBuilt();

    // Stub agent: echoes what the hook put in the payload as its answer.
    agentServer = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        agentRequests.push({ hookVar: payload.hookVar, shellVar: payload.shellVar });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: `hook=${payload.hookVar};shell=${payload.shellVar}` }));
      });
    });
    agentEndpoint = `http://127.0.0.1:${await listen(agentServer)}/ask`;

    project = mkdtempSync(path.join(tmpdir(), 'ah-ui-env-reload-'));
    writeFileSync(path.join(project, 'agent-health.config.mjs'), configModule(agentEndpoint, 'Env Echo Agent v1'));
    // Boot-time .env: HOOK_VAR=v1; SHELL_VAR also set here but the shell
    // export below must win (dotenv never overrides the shell).
    writeFileSync(path.join(project, '.env'), 'AH_TEST_HOOK_VAR=v1\nAH_TEST_SHELL_VAR=from-dotenv\n');

    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    baseUrl = `http://127.0.0.1:${port}`;

    server = spawn(process.execPath, args(port), {
      cwd: project,
      env: cleanEnv({ AH_PORT: String(port), PORT: String(port), AH_TEST_SHELL_VAR: 'from-shell' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', c => { serverLog += c.toString(); });
    server.stderr!.on('data', c => { serverLog += c.toString(); });
    try {
      await waitForHealth(baseUrl, 60_000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- server output ---\n${serverLog}`);
    }
    const storage = await httpJson<{ backend?: string }>('GET', `${baseUrl}/api/storage/health`);
    expect(storage.body.backend).toBe('file');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Only the exact child this suite spawned, by its captured handle.
    if (server?.pid) {
      try { server.kill('SIGTERM'); } catch { /* already gone */ }
      if (!(await waitForExit(server.pid, 8000))) {
        try { server.kill('SIGKILL'); } catch { /* noop */ }
      }
    }
    if (agentServer) await closeServer(agentServer);
    if (project) rmSync(project, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  /** One UI-style run (SSE); returns the persisted report of the single case. */
  async function runOnce(testCaseId: string): Promise<{ run: any; report: any }> {
    const sse = await httpJson('POST', `${baseUrl}/api/storage/evaluation-runs`, {
      sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
      agentKey: 'env-echo-agent',
      judgeModelId: 'demo-model',
      name: `env-reload ${Date.now()}`,
    }, 120_000);
    expect(sse.status).toBe(200);
    const completedLine = sse.text.split('\n').find(l => l.startsWith('data: ') && l.includes('"status":"completed"') && l.includes('"stats"'));
    expect(completedLine).toBeDefined();
    const run = JSON.parse(completedLine!.slice(6));
    const reportId = run.results[testCaseId].reportId;
    const report = await httpJson('GET', `${baseUrl}/api/storage/runs/${encodeURIComponent(reportId)}`);
    expect(report.status).toBe(200);
    return { run, report: report.body.run ?? report.body };
  }

  function finalResponse(report: any): string {
    const step = [...(report.trajectory ?? [])].reverse().find((s: any) => s.type === 'response' || s.type === 'assistant');
    return step?.content ?? '';
  }

  it('run 1 sees boot values; edit .env + config; run 2 sees the new values; the shell export is never overridden', async () => {
    const tc = await httpJson('POST', `${baseUrl}/api/storage/test-cases`, {
      name: `env-reload-case-${Date.now()}`,
      category: 'general', difficulty: 'easy',
      initialPrompt: 'What do you see?', expectedOutcomes: ['echoes the environment'],
    });
    expect(tc.status).toBe(201);
    const testCaseId: string = tc.body.testCase?.id ?? tc.body.id;

    // Run 1: boot-time .env (v1) and config (agent name v1); shell wins over .env.
    const first = await runOnce(testCaseId);
    expect(finalResponse(first.report)).toBe('hook=v1;shell=from-shell');
    expect(first.report.agentName).toBe('Env Echo Agent v1');

    // Edit BOTH files while the server keeps running.
    writeFileSync(path.join(project, '.env'), 'AH_TEST_HOOK_VAR=v2\nAH_TEST_SHELL_VAR=from-dotenv-2\n');
    writeFileSync(path.join(project, 'agent-health.config.mjs'), configModule(agentEndpoint, 'Env Echo Agent v2'));

    // Run 2: the hook sees the new .env value, the run uses the edited config,
    // and the shell export is still what the hook sees for SHELL_VAR.
    const second = await runOnce(testCaseId);
    expect(finalResponse(second.report)).toBe('hook=v2;shell=from-shell');
    expect(second.report.agentName).toBe('Env Echo Agent v2');
    expect(second.run.id).not.toBe(first.run.id);

    // The stub saw exactly those two requests, in order.
    expect(agentRequests).toEqual([
      { hookVar: 'v1', shellVar: 'from-shell' },
      { hookVar: 'v2', shellVar: 'from-shell' },
    ]);
    expect(serverLog).not.toMatch(/Unhandled|ERR_/);
  }, TEST_TIMEOUT);
});
