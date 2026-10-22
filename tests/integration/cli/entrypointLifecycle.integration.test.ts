/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The CLI entry point and the server lifecycle a user hits before any data
 * command: `--version`, `--help`, `--env-file`, `kill`, `serve --headless`,
 * the bare `agent-health` default action, and the auto-start / auto-stop of a
 * server when a data command finds nothing listening on its port.
 *
 * Every server started here is started BY the CLI under test, on a port this
 * suite picked, and stopped by the exact PID the server reports on `/health`
 * (or by the CLI's own cleanup, which is what is being asserted). Nothing is
 * killed by name or by port-wide sweep. The auto-start scenarios run from a
 * throwaway cwd so the file-backed store they create is deleted with it.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  CLI_BUNDLE,
  REPO_ROOT,
  ensureCliBundle,
  cleanCliEnv,
  runCli,
  plain,
  makeTempDir,
  httpJson,
  writeCasesFile,
  trackBenchmarkByName,
} from '../../helpers/cliProcess';
import { withCliCoverage } from '../../helpers/cliCoverage';

const TEST_TIMEOUT = 180_000;
const SERVER_READY_TIMEOUT = 60_000;
const VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * A free TCP port. `AH_CLI_TEST_PORTS=a-b` restricts the search to a range
 * (dev boxes that partition ports between parallel servers); otherwise the OS
 * picks one.
 */
async function freePort(): Promise<number> {
  const range = /^(\d+)-(\d+)$/.exec(process.env.AH_CLI_TEST_PORTS ?? '');
  const candidates = range ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i) : [0];
  for (const p of candidates) {
    const got = await new Promise<number | null>(resolve => {
      const srv = createServer();
      srv.once('error', () => resolve(null));
      srv.listen(p, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : null;
        srv.close(() => resolve(port));
      });
    });
    if (got) return got;
  }
  throw new Error(`no free port in ${process.env.AH_CLI_TEST_PORTS}`);
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const res = await httpJson(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<{ pid: number; port: number; cwd: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpJson<{ status: string; instance?: { pid: number; port: number; cwd: string } }>(`http://127.0.0.1:${port}/health`);
      if (res.ok && res.body.status === 'ok' && res.body.instance) return res.body.instance;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/** Terminate ONLY the given pid (one we observed from our own child), escalating once. */
async function stopPid(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  if (!await waitForExit(pid, 10_000)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await waitForExit(pid, 5_000);
  }
}

interface LiveCli {
  child: ChildProcess;
  output: () => string;
}

function startCli(args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): LiveCli {
  const env = withCliCoverage(cleanCliEnv({ env: opts.env }));
  const child = spawn(process.execPath, [CLI_BUNDLE, ...args], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout!.on('data', c => { buf += c.toString(); });
  child.stderr!.on('data', c => { buf += c.toString(); });
  return { child, output: () => buf };
}

describe('CLI entry point and server lifecycle (real CLI processes)', () => {
  const tracker = createTestDataTracker();
  let tmp: string;
  const pidsToReap = new Set<number>();

  beforeAll(() => {
    ensureCliBundle();
    tmp = makeTempDir('ah-cli-entry');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const pid of pidsToReap) await stopPid(pid);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  it('--version prints the package version; --help prints the grouped command guide; <cmd> --help its options', () => {
    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);

    const help = runCli(['--help']);
    const out = plain(help.stdout);
    expect(help.status).toBe(0);
    expect(out).toMatch(/Usage: agent-health \[options\] \[command\]/);
    expect(out).toMatch(/--headless\s+Run API server only/);
    for (const section of ['Getting Started:', 'Running Evaluations:', 'Viewing Results:', 'Remote Servers:', 'Infrastructure:', 'Agent Profiling:', 'Importing:', 'Maintenance:', 'Examples:']) {
      expect(out).toContain(section);
    }
    expect(out).toMatch(/agent-health benchmark -f <file>\s+Run a full benchmark/);

    const sub = runCli(['benchmark', '--help']);
    expect(sub.status).toBe(0);
    expect(plain(sub.stdout)).toMatch(/--judge-model <id>/);
    expect(plain(sub.stdout)).toMatch(/-c, --concurrency <n>/);
  }, TEST_TIMEOUT);

  it('kill <unknown target> exits 1 listing the valid targets; kill sample-agent with nothing running says so', () => {
    const unknown = runCli(['kill', 'frobnicator']);
    expect(unknown.status).toBe(1);
    expect(plain(unknown.output)).toMatch(/Unknown target: frobnicator/);
    expect(plain(unknown.output)).toMatch(/Available targets: sample-agent/);

    // Nothing of ours listens on the sample agent's port; either outcome is a
    // clean message, never a crash.
    const none = runCli(['kill', 'sample-agent']);
    expect([0, 1]).toContain(none.status);
    expect(plain(none.output)).toMatch(/No process found on port \d+|Sample agent stopped|Failed to stop sample agent/);
  }, TEST_TIMEOUT);

  it('serve --headless -p <port> boots an API-only server that answers /health and stops on SIGTERM', async () => {
    const port = await freePort();
    const live = startCli(['serve', '--headless', '--no-browser', '-p', String(port)], { cwd: tmp });
    const instance = await waitForHealth(port, SERVER_READY_TIMEOUT);
    if (instance) pidsToReap.add(instance.pid);
    const out = () => plain(live.output());

    expect(instance).not.toBeNull();
    expect(instance!.port).toBe(port);
    expect(out()).toMatch(new RegExp(`Agent Health v${VERSION.replace(/\\./g, '\\\\.')}`));
    expect(out()).toMatch(/Headless API server started/);
    expect(out()).toContain(`API server running on http://0.0.0.0:${port}`);
    expect(out()).toMatch(/Mode: headless \(API only, no frontend\)/);
    // Headless: the SPA is not served.
    const index = await httpJson(`http://127.0.0.1:${port}/`);
    expect(index.status).not.toBe(200);
    // Data API is live.
    const storage = await httpJson<{ status?: string }>(`http://127.0.0.1:${port}/api/storage/health`);
    expect(storage.ok).toBe(true);

    live.child.kill('SIGTERM');
    expect(await waitForExit(instance!.pid, 15_000)).toBe(true);
    await sleep(300);
    expect(await portOpen(port)).toBe(false);
  }, TEST_TIMEOUT);

  it('bare `agent-health -p <port> --no-browser -e .env --agent-path <dir>` loads the env file, announces the agent path and serves the UI', async () => {
    const port = await freePort();
    const proj = join(tmp, 'default-action');
    mkdirSync(proj);
    writeFileSync(join(proj, 'custom.env'), 'AH_TEST_MARKER=from-env-file\n');
    // `-e` rather than `--env-file`: Node >= 22 scans the WHOLE argv for
    // `--env-file` (even after the script path) and handles it itself, exiting
    // 9 on a missing file before our CLI runs. The short alias reaches the CLI.
    const live = startCli(['-p', String(port), '--no-browser', '-e', 'custom.env', '--agent-path', proj], { cwd: proj });
    const instance = await waitForHealth(port, SERVER_READY_TIMEOUT);
    if (instance) pidsToReap.add(instance.pid);
    const out = () => plain(live.output());

    expect(instance).not.toBeNull();
    expect(out()).toContain('Loaded environment from: custom.env');
    expect(out()).toContain(`Agent path: ${proj}`);
    expect(out()).toMatch(/Server started/);
    expect(out()).toContain(`Server running at http://localhost:${port}`);
    expect(out()).toMatch(/Press Ctrl\+C to stop/);
    expect(out()).not.toMatch(/Opening browser/);
    const index = await httpJson(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);

    live.child.kill('SIGTERM');
    expect(await waitForExit(instance!.pid, 15_000)).toBe(true);
  }, TEST_TIMEOUT);

  it('a port that is already taken makes the server fall back to another port and say so', async () => {
    const port = await freePort();
    const first = startCli(['serve', '--headless', '--no-browser', '-p', String(port)], { cwd: tmp });
    const firstInstance = await waitForHealth(port, SERVER_READY_TIMEOUT);
    if (firstInstance) pidsToReap.add(firstInstance.pid);
    expect(firstInstance).not.toBeNull();

    const second = startCli(['serve', '--headless', '--no-browser', '-p', String(port)], { cwd: tmp });
    const deadline = Date.now() + SERVER_READY_TIMEOUT;
    let fallbackPort: number | null = null;
    while (Date.now() < deadline && !fallbackPort) {
      const m = /Port \d+ was in use, started on port (\d+) instead/.exec(plain(second.output()));
      if (m) fallbackPort = Number(m[1]);
      else await sleep(200);
    }
    expect(fallbackPort).not.toBeNull();
    expect(fallbackPort).not.toBe(port);
    const secondInstance = await waitForHealth(fallbackPort!, SERVER_READY_TIMEOUT);
    if (secondInstance) pidsToReap.add(secondInstance.pid);
    expect(secondInstance?.port).toBe(fallbackPort);
    expect(plain(second.output())).toContain(`API server running on http://0.0.0.0:${fallbackPort}`);

    second.child.kill('SIGTERM');
    first.child.kill('SIGTERM');
    expect(await waitForExit(secondInstance!.pid, 15_000)).toBe(true);
    expect(await waitForExit(firstInstance!.pid, 15_000)).toBe(true);
  }, TEST_TIMEOUT);

  // The auto-started server is `bin/cli.js serve`, which in a source checkout
  // runs the TypeScript via tsx and needs the repo's tsconfig for the `@/`
  // aliases — so these run from the repo root (as a user runs `npx` in their
  // project; the packaged path is covered by detachedServerLifecycle).
  describe('auto-start when nothing listens on AH_PORT', () => {
    it('`list benchmarks` starts a persistent server, exits, and leaves that server (and only that one) running', async () => {
      const port = await freePort();
      const proj = REPO_ROOT;
      const res = runCli(['list', 'benchmarks'], { cwd: proj, env: { AH_PORT: String(port) }, timeoutMs: 120_000 });
      const instance = await waitForHealth(port, 5_000);
      if (instance) pidsToReap.add(instance.pid);
      const out = plain(res.output);

      expect(res.status).toBe(0);
      expect(out).toMatch(/\[ServerLifecycle\] Server log: .*server-\d+-.*\.log/);
      expect(out).toMatch(/Available Benchmarks|No benchmarks found/);
      // The CLI exited (spawnSync returned) while its server kept serving…
      expect(instance).not.toBeNull();
      expect(instance!.port).toBe(port);
      expect(instance!.cwd).toBe(proj);
      // …and a second command reuses it instead of starting another.
      const again = runCli(['list', 'agents'], { cwd: proj, env: { AH_PORT: String(port) } });
      expect(again.status).toBe(0);
      expect(plain(again.output)).toMatch(/Reusing existing server/);
      const same = await waitForHealth(port, 5_000);
      expect(same?.pid).toBe(instance!.pid);

      // A command run from ANOTHER directory refuses to borrow this server.
      const elsewhere = join(tmp, 'autostart-elsewhere');
      mkdirSync(elsewhere);
      const foreign = runCli(['list', 'benchmarks'], { cwd: elsewhere, env: { AH_PORT: String(port) } });
      expect(foreign.status).toBe(1);
      expect(plain(foreign.output)).toMatch(/Refusing to use the server already running on port \d+: it was started from a different directory/);
      expect(plain(foreign.output)).toContain(`server cwd    : ${proj} (pid ${instance!.pid})`);
      expect(plain(foreign.output)).toMatch(/AH_REUSE_FOREIGN_SERVER=1/);
      // …unless told to, explicitly.
      const overridden = runCli(['list', 'benchmarks'], { cwd: elsewhere, env: { AH_PORT: String(port), AH_REUSE_FOREIGN_SERVER: '1' } });
      expect(overridden.status).toBe(0);

      await stopPid(instance!.pid);
      expect(await portOpen(port)).toBe(false);
    }, TEST_TIMEOUT);

    it('legacy file-mode `benchmark -f` starts a server for the run and stops it again when done', async () => {
      const port = await freePort();
      const proj = REPO_ROOT;
      const fixtures = join(tmp, 'autostart-benchmark');
      mkdirSync(fixtures);
      writeCasesFile(fixtures, 'cases.json', 1, 'cli-entry-autostart');
      const name = uniqueTestName('cli-entry-autostart-bm');
      const res = runCli(['benchmark', '-f', join(fixtures, 'cases.json'), '-a', 'demo', '-n', name, '--judge-model', 'demo-model'], {
        cwd: proj,
        env: { AH_PORT: String(port) },
        timeoutMs: 150_000,
      });
      const out = plain(res.output);
      expect(res.status).toBe(0);
      expect(out).toMatch(/Running in file mode/);
      expect(out).toContain(`Started server on port ${port}`);
      expect(out).toMatch(/Loaded 1 test cases from/);
      expect(out).toMatch(/Imported 1 test cases/);
      expect(out).toMatch(/Benchmark Summary/);
      // The auto-started server was stopped by the CLI itself (file mode).
      await sleep(500);
      expect(await portOpen(port)).toBe(false);
      expect(existsSync(join(proj, '.agent-health', 'logs'))).toBe(true);
      // Whatever landed in a store the backend under test can also see is
      // deleted by id (the ephemeral server's own file store is otherwise
      // local to this checkout's .agent-health/data).
      await trackBenchmarkByName(tracker, name).catch(() => null);
    }, TEST_TIMEOUT);
  });
});
