/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real CLI processes, real sockets: every server the CLI starts binds loopback
 * only (#622), honours `AH_HOST` / `--host` for a deliberate wider bind, warns
 * on stderr when it does, ignores the generic `HOST` variable (with a notice),
 * and prints the bound address.
 *
 * Covered paths:
 *   - `agent-health serve` (default bind, `AH_HOST=0.0.0.0`, `--host` over
 *     `AH_HOST`, inherited `HOST=0.0.0.0` ignored)
 *   - `node server/dist/index.js` (the entry point that used to read `HOST`
 *     with a `0.0.0.0` default; now the same loopback default as the CLI)
 *   - the server `agent-health benchmark` auto-starts (detached child) — and
 *     the CLI still reaches it; with `AH_HOST=0.0.0.0` the parent CLI warns.
 *
 * "Loopback only" is asserted by actually connecting: `127.0.0.1:<port>`
 * answers `/health`; the machine's own non-loopback IPv4 address (the one a
 * LAN peer would use) is refused. A runner with no non-loopback interface has
 * no LAN peer to protect against: that half is skipped locally (noted on
 * stdout) but is mandatory under `CI`, so the guarantee is always exercised
 * where it is enforced.
 *
 * The CLI runs from a staged package copy (`<project>/node_modules/@opensearch-project/agent-health`,
 * like detachedServerLifecycle) so `bin/cli.js` takes the production path —
 * the detached auto-start spawns `bin/cli.js serve`, which in a dev checkout
 * would run the TS sources through tsx from a cwd without a tsconfig.
 *
 * Self-contained: FILE storage under a temp project dir removed in afterAll;
 * nothing touches a shared cluster. Port: `AH_CLI_BIND_TEST_PORT`, else an
 * OS-assigned free port. Build first: npm run build:server && npm run
 * build:cli && npm run build:lib (the suite builds whatever is missing).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type Server } from 'http';
import { connect as netConnect } from 'net';
import { networkInterfaces } from 'os';
import * as path from 'path';
import { withCliCoverage } from '../../helpers/cliCoverage';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
/** Built artefacts staged into a packaged project (see `stagePackage`). */
const PACKAGE_FILES = ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist'];
const BUILD_SCRIPTS: Record<string, string> = { 'cli/dist': 'build:cli', 'server/dist': 'build:server', 'lib/dist': 'build:lib' };
const TEST_TIMEOUT = 180_000;
const CLI_TIMEOUT = 120_000;

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** First non-internal IPv4 address — what a LAN peer would dial. */
function lanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

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
function httpGet<T = any>(host: string, port: number, pathname: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: host, port, path: pathname, method: 'GET', agent: false, timeout: 3000 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T) }); }
        catch { resolve({ status: res.statusCode || 0, body: text as any }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** TCP connect outcome: 'connected' or the error code (ECONNREFUSED for a closed bind). */
function tcpConnect(host: string, port: number): Promise<string> {
  return new Promise(resolve => {
    const socket = netConnect({ host, port });
    socket.setTimeout(3000);
    socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('timeout', () => { socket.destroy(); resolve('ETIMEDOUT'); });
    socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
  });
}

async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpGet(host, port, '/health');
      if (r.status === 200) return;
      last = `status ${r.status}`;
    } catch (e: any) { last = e?.message ?? String(e); }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on ${host}:${port} did not become healthy in ${timeoutMs}ms (${last})`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Minimal env for the server + CLI children (see benchmarkErroredSummary):
 * no inherited HOST / AH_PORT / NODE_OPTIONS, no OPENSEARCH_* → FILE storage.
 */
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

/**
 * Stage the built package under a scratch project inside the repo (so its
 * dependencies resolve upward to the repo's node_modules) — no TS sources, so
 * bin/cli.js takes the same path as an npm installation.
 */
function stagePackage(): { project: string; cli: string } {
  for (const [dir, script] of Object.entries(BUILD_SCRIPTS)) {
    if (existsSync(path.join(REPO_ROOT, dir))) continue;
    const b = spawnSync('npm', ['run', script], { cwd: REPO_ROOT, encoding: 'utf-8' });
    if (b.status !== 0) throw new Error(`${script} failed: ${b.stderr}`);
  }
  const scratchRoot = path.join(REPO_ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(path.join(scratchRoot, 'cli-bind-loopback-'));
  const packageDir = path.join(project, 'node_modules/@opensearch-project/agent-health');
  mkdirSync(packageDir, { recursive: true });
  for (const file of PACKAGE_FILES) cpSync(path.join(REPO_ROOT, file), path.join(packageDir, file), { recursive: true });
  return { project, cli: path.join(packageDir, 'bin/cli.js') };
}

const ONE_CASE_EVAL = `
const { test, expect } = require('@opensearch-project/agent-health');
test('loopback case', { prompt: 'question A' }, async ({ agent }) => {
  const r = await agent.run();
  expect(r).to.haveCompletedWithin(60000);
});
`;

interface ServeHandle { child: ChildProcess; stdout: () => string; stderr: () => string }

describe('CLI-started servers bind loopback by default (#622) — real `serve` and `benchmark` auto-start', () => {
  let project: string;
  let cli: string;
  let agentServer: Server;
  let port: number;
  const lanIp = lanIPv4();
  const started: ChildProcess[] = [];
  /** Pid of the server `benchmark` auto-started (detached; verified ours via /health cwd). */
  let autoStartedPid: number | undefined;

  function serve(args: string[], env: Record<string, string>): ServeHandle {
    const child = spawn(process.execPath, [cli, 'serve', '-p', String(port), '--headless', '--no-browser', ...args], {
      cwd: project,
      env: withCliCoverage(cleanEnv({ AH_PORT: String(port), ...env })),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(child);
    let out = '';
    let err = '';
    child.stdout!.on('data', c => { out += c.toString(); });
    child.stderr!.on('data', c => { err += c.toString(); });
    return { child, stdout: () => stripAnsi(out), stderr: () => stripAnsi(err) };
  }

  async function stop(child: ChildProcess): Promise<void> {
    // Only the exact child this suite spawned, by its captured handle.
    if (!child.pid) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    if (!(await waitForExit(child.pid, 8000))) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      await waitForExit(child.pid, 2000);
    }
    // The listener must be gone before the next case binds the same port.
    const start = Date.now();
    while (Date.now() - start < 5000 && (await tcpConnect('127.0.0.1', port)) === 'connected') {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: project,
        env: withCliCoverage(cleanEnv({ AH_PORT: String(port), ...env })),
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

  async function expectLanRefused(): Promise<void> {
    if (!lanIp) {
      if (process.env.CI) throw new Error('CI runner has no non-loopback IPv4 interface — the LAN-refused assertion cannot be skipped in CI');
      console.log('[bindLoopback] no non-loopback IPv4 interface on this runner — skipping the LAN-refused half');
      return;
    }
    expect(await tcpConnect(lanIp, port)).toBe('ECONNREFUSED');
  }

  beforeAll(async () => {
    ({ project, cli } = stagePackage());

    // Stub REST agent for the benchmark auto-start case.
    agentServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'deterministic fixture answer' }));
      });
    });
    const agentPort = await listen(agentServer);

    writeFileSync(path.join(project, 'agent-health.config.mjs'), `export default ${JSON.stringify({
      agents: [
        { key: 'stub', name: 'Stub Agent', connectorType: 'rest', endpoint: `http://127.0.0.1:${agentPort}/run`, useTraces: false },
      ],
    }, null, 2)};\n`);
    mkdirSync(path.join(project, 'evals'));
    writeFileSync(path.join(project, 'evals/one.eval.js'), ONE_CASE_EVAL);

    if (process.env.AH_CLI_BIND_TEST_PORT) {
      port = Number(process.env.AH_CLI_BIND_TEST_PORT);
    } else {
      const reservation = createServer();
      port = await listen(reservation);
      await closeServer(reservation);
    }
    if ((await tcpConnect('127.0.0.1', port)) === 'connected') {
      throw new Error(`port ${port} is already in use — every case here must start its own server on a free port`);
    }
  }, TEST_TIMEOUT);

  /** Stop the server a `benchmark` case auto-started (verified ours via /health cwd before the pid was recorded). */
  async function stopAutoStarted(): Promise<void> {
    if (!autoStartedPid) return;
    const pid = autoStartedPid;
    autoStartedPid = undefined;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    if (!(await waitForExit(pid, 8000))) { try { process.kill(pid, 'SIGKILL'); } catch { /* noop */ } }
    const start = Date.now();
    while (Date.now() - start < 5000 && (await tcpConnect('127.0.0.1', port)) === 'connected') {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  afterAll(async () => {
    for (const child of started) await stop(child);
    await stopAutoStarted();
    if (agentServer) await closeServer(agentServer);
    if (project) rmSync(project, { recursive: true, force: true });
  });

  it('`serve` with no AH_HOST / --host: reachable on 127.0.0.1, refused on the LAN address, bound address printed, no warning', async () => {
    const s = serve([], {});
    try {
      await waitForHealth('127.0.0.1', port, 60_000);
      expect((await httpGet('127.0.0.1', port, '/health')).status).toBe(200);
      await expectLanRefused();
      expect(s.stdout()).toContain(`API server running on http://127.0.0.1:${port}`);
      expect(s.stdout()).not.toContain('0.0.0.0');
      expect(s.stderr()).not.toMatch(/WARNING: listening on/);
    } finally {
      await stop(s.child);
    }
  }, TEST_TIMEOUT);

  it('`AH_HOST=0.0.0.0 serve`: reachable on the LAN address, bound address printed, unauthenticated-API warning on stderr', async () => {
    const s = serve([], { AH_HOST: '0.0.0.0' });
    try {
      await waitForHealth('127.0.0.1', port, 60_000);
      if (lanIp) expect((await httpGet(lanIp, port, '/health')).status).toBe(200);
      expect(s.stdout()).toContain(`API server running on http://0.0.0.0:${port}`);
      expect(s.stderr()).toMatch(/WARNING: listening on 0\.0\.0\.0 .*unauthenticated/);
    } finally {
      await stop(s.child);
    }
  }, TEST_TIMEOUT);

  it('an inherited generic `HOST=0.0.0.0` is ignored: still loopback only, with a notice naming AH_HOST', async () => {
    const s = serve([], { HOST: '0.0.0.0' });
    try {
      await waitForHealth('127.0.0.1', port, 60_000);
      await expectLanRefused();
      expect(s.stdout()).toContain(`API server running on http://127.0.0.1:${port}`);
      expect(s.stderr()).toContain('HOST=0.0.0.0 is ignored');
      expect(s.stderr()).toContain('AH_HOST');
      expect(s.stderr()).not.toMatch(/WARNING: listening on/);
    } finally {
      await stop(s.child);
    }
  }, TEST_TIMEOUT);

  it('`--host` wins over AH_HOST: `AH_HOST=127.0.0.1 serve --host 0.0.0.0` binds all interfaces and warns', async () => {
    const s = serve(['--host', '0.0.0.0'], { AH_HOST: '127.0.0.1' });
    try {
      await waitForHealth('127.0.0.1', port, 60_000);
      if (lanIp) expect((await httpGet(lanIp, port, '/health')).status).toBe(200);
      expect(s.stdout()).toContain(`API server running on http://0.0.0.0:${port}`);
      expect(s.stderr()).toMatch(/WARNING: listening on 0\.0\.0\.0/);
    } finally {
      await stop(s.child);
    }
  }, TEST_TIMEOUT);

  it('`node server/dist/index.js` (dev / production entry point) binds loopback by default too — even with a generic HOST=0.0.0.0 in the env', async () => {
    const serverEntry = path.join(path.dirname(cli), '..', 'server', 'dist', 'index.js');
    const child = spawn(process.execPath, [serverEntry], {
      cwd: project,
      env: cleanEnv({ AH_PORT: String(port), PORT: String(port), HOST: '0.0.0.0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(child);
    let out = '';
    child.stdout!.on('data', c => { out += c.toString(); });
    child.stderr!.on('data', c => { out += c.toString(); });
    try {
      await waitForHealth('127.0.0.1', port, 60_000);
      await expectLanRefused();
      expect(out).toContain(`Backend Server running on http://127.0.0.1:${port}`);
      expect(out).toContain('HOST=0.0.0.0 is ignored');
    } finally {
      await stop(child);
    }
  }, TEST_TIMEOUT);

  it('`benchmark` with no server running auto-starts one on loopback only and still reaches it', async () => {
    expect(await tcpConnect('127.0.0.1', port)).toBe('ECONNREFUSED'); // nothing on the port yet

    const cli = await runCli(['benchmark', '-f', 'evals/one.eval.js', '-a', 'stub', '-n', 'bind-loopback']);
    // The auto-started server is detached and outlives the CLI. Record its pid
    // FIRST so afterAll stops it even if an assertion below fails.
    const health = await httpGet<{ instance?: { pid?: number; cwd?: string } }>('127.0.0.1', port, '/health');
    expect(health.status).toBe(200);
    expect(health.body.instance?.cwd).toBe(project); // ours, not a foreign server on the port
    autoStartedPid = health.body.instance?.pid;
    expect(typeof autoStartedPid).toBe('number');

    expect(cli.stderr).toContain(`Started server on port ${port}`); // spinner line: auto-start, not reuse
    expect(cli.stdout).toContain('✓ Passed: 1');
    expect(cli.status).toBe(0);
    await expectLanRefused();
    expect(cli.stderr).not.toMatch(/WARNING: listening on/);
  }, TEST_TIMEOUT);

  it('`AH_HOST=0.0.0.0 benchmark` auto-start: the parent CLI itself prints the unauthenticated-API warning (the child only has a log file)', async () => {
    await stopAutoStarted();
    expect(await tcpConnect('127.0.0.1', port)).toBe('ECONNREFUSED');

    const cli = await runCli(['benchmark', '-f', 'evals/one.eval.js', '-a', 'stub', '-n', 'bind-wide'], { AH_HOST: '0.0.0.0' });
    const health = await httpGet<{ instance?: { pid?: number; cwd?: string } }>('127.0.0.1', port, '/health');
    expect(health.body.instance?.cwd).toBe(project);
    autoStartedPid = health.body.instance?.pid;      // recorded before any assertion can fail
    expect(typeof autoStartedPid).toBe('number');

    expect(cli.stderr).toContain(`Started server on port ${port}`);
    expect(cli.stderr).toMatch(/\[ServerLifecycle\] WARNING: listening on 0\.0\.0\.0 .*unauthenticated/);
    expect(cli.status).toBe(0);
    if (lanIp) expect((await httpGet(lanIp, port, '/health')).status).toBe(200);
  }, TEST_TIMEOUT);
});
