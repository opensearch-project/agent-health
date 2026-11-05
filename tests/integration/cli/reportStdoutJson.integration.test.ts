/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real packaged CLI, real child server, real pipes: the stdout contract of
 * `report -f json --stdout`.
 *
 * Why this test exists
 * ────────────────────
 * `report -f json --stdout | jq` must parse. Before the fix, `ensureServer()`
 * printed `[ServerLifecycle] Reusing existing server (version …)` with
 * `console.log`, so the first line of stdout was prose and `JSON.parse` threw.
 * Spinners already go to stderr (ora default); this pins that EVERY
 * diagnostic — lifecycle, config, failure hints — is on stderr and stdout is
 * exactly the report body, across both server paths:
 *   1. an existing server is reused (the `[ServerLifecycle] Reusing …` line);
 *   2. no server is running and the CLI auto-starts one (the `Server log:` line;
 *      this path was already stderr-only and is pinned so it stays that way).
 * And that a failure (unknown benchmark) exits non-zero with an empty stdout.
 *
 * Process ownership: the only things ever signalled are (a) the `serve` child
 * this file spawned and (b) a server whose /health reports BOTH our scratch
 * project as `instance.cwd` AND a pid — i.e. the CLI's detached auto-started
 * server for this project, never a stranger that raced onto the port.
 *
 * Runs against the staged production package (bin/cli.js takes the dist path
 * when it lives under node_modules) in a scratch project with its own
 * file-backed storage, so nothing here touches a shared cluster.
 *
 * Build first: npm run build:all
 */
import { spawn, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const TEST_TIMEOUT = 180_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function reserveEphemeralPort(): Promise<number> {
  const reservation: Server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port));
  });
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}

function stagePackage(): { project: string; cli: string } {
  for (const file of ['bin/cli.js', 'cli/dist/index.js', 'server/dist/app.js', 'server/dist/index.js']) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Missing ${file}; run npm run build:all first`);
  }
  const scratchRoot = join(ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, 'report-stdout-'));
  const packageDir = join(project, 'node_modules/@opensearch-project/agent-health');
  mkdirSync(packageDir, { recursive: true });
  for (const file of ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist', 'dist']) {
    if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(packageDir, file), { recursive: true });
  }
  // Empty project config: code-first mode ignores any ~/.agent-health user config.
  writeFileSync(join(project, 'agent-health.config.mjs'), 'export default {};\n');
  return { project, cli: join(packageDir, 'bin/cli.js') };
}

interface CliRun {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}

function startCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CliRun {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(25);
  return predicate();
}

async function runCliToExit(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  const run = startCli(cli, args, cwd, env);
  if (!(await waitUntil(() => exited(run.child), timeoutMs))) {
    run.child.kill('SIGKILL');
    throw new Error(`CLI ${args.join(' ')} did not exit within ${timeoutMs}ms\nstdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`);
  }
  return { status: run.child.exitCode, stdout: run.stdout(), stderr: run.stderr() };
}

interface HealthIdentity { pid: number; cwd: string }

async function healthIdentity(port: number): Promise<HealthIdentity | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    const health = (await response.json()) as { instance?: { pid?: number; cwd?: string } };
    if (!health.instance?.pid || !health.instance.cwd) return undefined;
    return { pid: health.instance.pid, cwd: health.instance.cwd };
  } catch {
    return undefined;
  }
}

/** /health identity, only if the server belongs to OUR scratch project. */
async function ownServer(port: number, project: string): Promise<HealthIdentity | undefined> {
  const identity = await healthIdentity(port);
  return identity && identity.cwd === project ? identity : undefined;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** SIGTERM → SIGKILL exactly one pid; never throws (cleanup must reach every owned process). */
async function stopPid(pid: number): Promise<void> {
  try {
    if (!isAlive(pid)) return;
    process.kill(pid, 'SIGTERM');
    if (!(await waitUntil(() => !isAlive(pid), 10_000))) {
      process.kill(pid, 'SIGKILL');
      await waitUntil(() => !isAlive(pid), 5_000);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.warn(`[report-stdout] could not stop pid ${pid}: ${error}`);
  }
}

async function createBenchmark(port: number, name: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, testCaseIds: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`create benchmark: HTTP ${response.status} ${await response.text()}`);
  const created = await response.json();
  const id = (created.benchmark ?? created).id as string | undefined;
  if (!id) throw new Error('Benchmark creation did not return an id');
  return id;
}

/** The contract: stdout IS the report. If anything else were there, JSON.parse would throw. */
function expectReportJson(stdout: string, benchmarkId: string): void {
  let parsed: any;
  expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();
  expect(parsed.benchmark.id).toBe(benchmarkId);
  expect(Array.isArray(parsed.runs)).toBe(true);
}

describe('packaged CLI: report -f json --stdout writes only the report to stdout', () => {
  let project: string;
  let cli: string;
  let port: number;
  let env: NodeJS.ProcessEnv;
  let benchmarkId: string;
  /** The `serve` child we spawn ourselves (test 1 reuses it; test 3 stops it). */
  let ownServe: ChildProcess | undefined;

  beforeAll(async () => {
    ({ project, cli } = stagePackage());
    port = await reserveEphemeralPort();
    env = {
      ...process.env,
      AH_PORT: String(port),
      PORT: String(port),
      BENCHMARK_RUN_RECOVERY_DISABLED: '1',
      EVALUATION_RUN_RECOVERY_DISABLED: '1',
      NO_COLOR: '1',
    };
    // Isolated file-backed storage inside the scratch project — never a shared cluster.
    for (const key of Object.keys(env)) if (key.startsWith('OPENSEARCH_')) delete env[key];
    delete env.CI; // development default: the CLI keeps its auto-started server alive
    delete env.AH_REUSE_FOREIGN_SERVER;

    // Boot our own server from the staged package and seed one benchmark. Every
    // test below is independent of the others' assertions.
    const server = startCli(cli, ['serve', '-p', String(port), '--no-browser'], project, env);
    ownServe = server.child;
    const deadline = Date.now() + 90_000;
    while (!(await ownServer(port, project))) {
      if (exited(server.child) || Date.now() > deadline) {
        throw new Error(`serve did not become healthy for ${project}\nstdout:\n${server.stdout()}\nstderr:\n${server.stderr()}`);
      }
      await sleep(200);
    }
    expect((await ownServer(port, project))!.pid).toBe(server.child.pid);
    benchmarkId = await createBenchmark(port, `report-stdout-${Date.now()}`);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Order-independent, never throws past the first failure: our serve child
    // (by handle), then whatever server still answers /health FOR OUR PROJECT
    // (the CLI's detached auto-started one), then the scratch dir.
    if (ownServe?.pid) await stopPid(ownServe.pid);
    const detached = await ownServer(port, project);
    if (detached) await stopPid(detached.pid);
    if (project) rmSync(project, { recursive: true, force: true });
  }, TEST_TIMEOUT);

  it(
    'reused server: stdout is parseable JSON, the [ServerLifecycle] reuse line is on stderr',
    async () => {
      const before = await ownServer(port, project);
      expect(before?.pid).toBe(ownServe!.pid);

      // stdout piped exactly like `| jq`.
      const result = await runCliToExit(cli, ['report', '-b', benchmarkId, '-f', 'json', '--stdout'], project, env, 60_000);

      expect(result.status).toBe(0);
      expectReportJson(result.stdout, benchmarkId);
      // The lifecycle diagnostic is still emitted — on stderr.
      expect(result.stderr).toMatch(/\[ServerLifecycle\] Reusing existing server/);
      expect(result.stderr).toMatch(/Found benchmark/);
      // It reused ours rather than starting a second server.
      expect((await ownServer(port, project))?.pid).toBe(ownServe!.pid);
    },
    TEST_TIMEOUT,
  );

  it(
    'unknown benchmark: exits non-zero, stdout stays empty, the hint is on stderr',
    async () => {
      const result = await runCliToExit(cli, ['report', '-b', 'does-not-exist', '-f', 'json', '--stdout'], project, env, 60_000);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Benchmark not found/);
      expect(result.stderr).toMatch(/Available benchmarks/);
    },
    TEST_TIMEOUT,
  );

  it(
    'auto-started server: stdout is parseable JSON, the server-start diagnostics are on stderr',
    async () => {
      // Stop OUR serve child so the CLI has to start one itself. The benchmark
      // lives in the scratch project's file storage, so the auto-started server
      // (same cwd) sees it.
      if (ownServe?.pid) await stopPid(ownServe.pid);
      ownServe = undefined;
      expect(await ownServer(port, project)).toBeUndefined();

      const result = await runCliToExit(cli, ['report', '-b', benchmarkId, '-f', 'json', '--stdout'], project, env, 120_000);

      expect(result.status).toBe(0);
      expectReportJson(result.stdout, benchmarkId);
      // Start-path diagnostics are emitted — on stderr.
      expect(result.stderr).toMatch(/\[ServerLifecycle\] Server log:/);
      expect(result.stderr).not.toMatch(/Reusing existing server/);
      // The detached server it left behind is ours (cwd = scratch project); afterAll stops it.
      expect(await ownServer(port, project)).toBeDefined();
    },
    TEST_TIMEOUT,
  );
});
