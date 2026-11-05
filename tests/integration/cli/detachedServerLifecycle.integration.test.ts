/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real packaged CLI, child server, pipes, and HTTP. No lifecycle/API mocks.
 *
 * Customer journey: no server -> list agents -> CLI exits -> named benchmark
 * reuses the server and invokes a local REST agent three times. In particular,
 * do not set CI=1: the development default intentionally keeps the server alive.
 *
 * Build first: npm run build:all
 * Storage uses the normal OPENSEARCH_STORAGE_* environment when configured.
 */
import { spawn, type ChildProcess } from 'child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';

const ROOT = join(__dirname, '../../..');
const AGENT_KEY = 'cli-lifecycle-fixture';
const EXIT_TIMEOUT_MS = 3_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function startCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let spawnError: Error | undefined;
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => { spawnError = error; });
  return { child, stdout: () => stdout, stderr: () => stderr, error: () => spawnError };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(25);
  return predicate();
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (!await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 2_000)) {
    child.kill('SIGKILL');
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 2_000);
  }
}

function packagedProject() {
  for (const file of ['cli/dist/index.js', 'server/dist/app.js', 'lib/dist/lib/index.js']) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Missing ${file}; run npm run build:all first`);
  }
  const scratchRoot = join(ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  // Dependencies resolve above the staged package, but no TS sources are copied:
  // bin/cli.js must take the same production path as an npm installation.
  const project = mkdtempSync(join(scratchRoot, 'cli-lifecycle-'));
  const packageDir = join(project, 'node_modules/@opensearch-project/agent-health');
  mkdirSync(packageDir, { recursive: true });
  for (const file of ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist', 'dist']) {
    cpSync(join(ROOT, file), join(packageDir, file), { recursive: true });
  }
  const pidFile = join(project, 'server-pids.txt');
  const pidProbe = join(project, 'capture-server-pid.cjs');
  // Observation only: capture our exact child even if it fails before /health.
  writeFileSync(pidProbe, `if (process.argv.includes('serve')) require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\n`);
  return { project, packageDir, cli: join(packageDir, 'bin/cli.js'), pidFile, pidProbe };
}

function serverPids(pidFile: string): number[] {
  return existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 1) : [];
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function assertServerExited(pidFile: string): Promise<void> {
  const pids = serverPids(pidFile);
  expect(pids.length).toBeGreaterThan(0);
  if (!await waitUntil(() => pids.every(pid => !isAlive(pid)), 10_000)) {
    throw new Error('REGRESSION: production cleanup left its owned server PID alive; emergency test cleanup has not run.');
  }
}

function removeProject(project: string, pidFile: string): void {
  if (existsSync(pidFile)) {
    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    for (const pid of pids.filter(pid => Number.isInteger(pid) && pid > 1)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  rmSync(project, { recursive: true, force: true });
}

describe('packaged CLI: persistent auto-started server lifecycle', () => {
  it('list agents exits, then its server survives and completes a three-case benchmark', async () => {
    const { project, cli, pidFile, pidProbe } = packagedProject();

    let requests = 0;
    const agent = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ response: 'deterministic fixture answer' }));
      });
    });
    const agentPort = await listen(agent);
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    const baseUrl = `http://127.0.0.1:${port}`;
    const tracker = createTestDataTracker(baseUrl);
    const children: ChildProcess[] = [];
    let benchmarkId: string | undefined;
    const api = async (path: string, init?: RequestInit): Promise<any> => {
      const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
      return response.json();
    };
    const env: NodeJS.ProcessEnv = { ...process.env, AH_PORT: String(port), PORT: String(port),
      BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
      NODE_OPTIONS: `--require=${pidProbe}`, NO_COLOR: '1' };
    delete env.CI;
    delete env.AH_REUSE_FOREIGN_SERVER;
    delete env.AH_SUPPRESS_EXPERIMENTAL;
    writeFileSync(join(project, 'agent-health.config.mjs'), `export default ${JSON.stringify({
      agents: [{ key: AGENT_KEY, name: 'CLI lifecycle fixture', connectorType: 'rest',
        endpoint: `http://127.0.0.1:${agentPort}/search`, useTraces: false }],
    })};\n`);
    mkdirSync(join(project, 'evals'));
    writeFileSync(join(project, 'evals/lifecycle.eval.ts'), `
const { test } = require('@opensearch-project/agent-health');
for (let i = 1; i <= 3; i++) {
  test('lifecycle case ' + i, { prompt: 'fixture question ' + i }, async ({ agent, expect }) => {
    const result = await agent.run();
    expect(result).to.haveCompletedWithin(10000);
  });
}
`);
    try {
      const list = startCli(cli, ['list', 'agents', '--output', 'json'], project, env);
      children.push(list.child);
      const printed = await waitUntil(() => list.stdout().includes(`"key": "${AGENT_KEY}"`)
        || list.child.exitCode !== null || !!list.error(), 60_000);
      if (!printed || !list.stdout().includes(`"key": "${AGENT_KEY}"`)) {
        throw new Error(`list agents did not print the configured agent. ${list.error() ?? ''}\n${list.stdout()}\n${list.stderr()}`);
      }
      const agents = JSON.parse(list.stdout());
      expect(agents.some((entry: { key: string }) => entry.key === AGENT_KEY)).toBe(true);
      const health = await api('/health');
      expect(health.instance.cwd).toBe(project);
      console.log('[lifecycle] list agents printed the configured agent; child /health returned 200');
      const exited = await waitUntil(() => list.child.exitCode !== null || list.child.signalCode !== null, EXIT_TIMEOUT_MS);
      if (!exited) {
        throw new Error(`REGRESSION: list agents printed valid JSON and the server is healthy, but the CLI did not exit within ${EXIT_TIMEOUT_MS}ms after printing. Expected exit code 0; CLI is still running. No benchmark has been sent.`);
      }
      expect(list.child.exitCode).toBe(0);
      console.log('[lifecycle] list CLI exited 0; checking server survival and benchmark reuse');
      expect((await api('/health')).instance.pid).toBe(health.instance.pid);

      // Create and track the exact benchmark before invoking the CLI. No cleanup
      // by name or listing other users' data, even on a shared storage cluster.
      const created = await api('/api/storage/benchmarks', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uniqueTestName('cli-lifecycle'), testCaseIds: [] }) });
      benchmarkId = (created.benchmark ?? created).id;
      if (!benchmarkId) throw new Error('Benchmark creation did not return an id');
      tracker.benchmark(benchmarkId);
      const benchmark = startCli(cli, ['benchmark', '-f', './evals/lifecycle.eval.ts',
        '-n', benchmarkId, '-a', AGENT_KEY, '--stop-server'], project, env);
      children.push(benchmark.child);
      const completed = await waitUntil(() => benchmark.child.exitCode !== null || benchmark.child.signalCode !== null, 90_000);
      if (!completed || benchmark.child.exitCode !== 0) {
        throw new Error(`Benchmark did not complete successfully (exit=${benchmark.child.exitCode}).\n${benchmark.stdout()}\n${benchmark.stderr()}`);
      }
      expect(requests).toBe(3);
      expect((await api('/health')).instance.pid).toBe(health.instance.pid);
      console.log('[lifecycle] benchmark exited 0; three real REST requests; original server still healthy');
    } finally {
      for (const child of children) await stopChild(child);
      try {
        if (benchmarkId) {
          try {
            const { evaluationRuns = [] } = await api(`/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkId)}`);
            for (const run of evaluationRuns) {
              tracker.evaluationRun(run.id);
              for (const result of Object.values(run.results ?? {}) as Array<{ reportId?: string }>) {
                if (result.reportId) tracker.run(result.reportId);
              }
            }
            const benchmark = await api(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
            for (const id of (benchmark.benchmark ?? benchmark).testCaseIds ?? []) tracker.testCase(id);
          } finally {
            await tracker.cleanup();
          }
        }
      } finally {
        // Only PIDs observed from our own spawned server, never port-wide/pattern kills.
        removeProject(project, pidFile);
        await close(agent);
      }
    }
  }, 180_000);

  it.each(['missing server bundle', 'startup timeout'])('reports %s and exits without hanging', async (failure) => {
    const { project, packageDir, cli, pidFile, pidProbe } = packagedProject();
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    if (failure === 'missing server bundle') rmSync(join(packageDir, 'server/dist/app.js'));
    const delay = failure === 'startup timeout'
      ? "if (process.argv.includes('serve')) await new Promise(resolve => setTimeout(resolve, 60000));\n"
      : '';
    const startupTimeout = failure === 'startup timeout' ? 2500 : 15_000;
    writeFileSync(join(project, 'agent-health.config.mjs'), delay + `export default { server: { startTimeout: ${startupTimeout} } };\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, AH_PORT: String(port), PORT: String(port),
      NODE_OPTIONS: `--require=${pidProbe}`, BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1' };
    delete env.CI;
    const command = startCli(cli, ['list', 'agents'], project, env);
    try {
      const exited = await waitUntil(() => command.child.exitCode !== null || command.child.signalCode !== null, 15_000);
      expect(exited).toBe(true);
      expect(command.child.exitCode).not.toBe(0);
      expect(command.stderr()).toContain('[ServerLifecycle] Server log:');
      if (failure === 'missing server bundle') {
        expect(command.stderr()).toContain('Cannot find module');
        expect(command.stderr()).toContain('Server process exited before becoming ready');
      } else {
        expect(command.stderr()).toContain('Server failed to start within 2500ms');
      }
      await assertServerExited(pidFile);
    } finally {
      await stopChild(command.child);
      removeProject(project, pidFile);
    }
  }, 45_000);

  it.each([false, true])('temporary mode exits its owned server (stalled SIGTERM handler: %s)', async (stallSignal) => {
    const { project, cli, pidFile, pidProbe } = packagedProject();
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    writeFileSync(join(project, 'agent-health.config.mjs'), 'export default {};\n');
    if (stallSignal) {
      // A real unresponsive child: exercise escalation without mocking kill/spawn.
      writeFileSync(pidProbe, readFileSync(pidProbe, 'utf8') +
        "if (process.argv.includes('serve')) process.on('SIGTERM', () => { while (true) {} });\n");
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', AH_PORT: String(port), PORT: String(port),
      NODE_OPTIONS: `--require=${pidProbe}`, BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1' };
    const command = startCli(cli, ['list', 'agents', '--output', 'json'], project, env);
    try {
      const exited = await waitUntil(() => command.child.exitCode !== null || command.child.signalCode !== null, 60_000);
      expect(exited).toBe(true);
      expect(command.child.exitCode).toBe(0);
      expect(Array.isArray(JSON.parse(command.stdout()))).toBe(true);
      await assertServerExited(pidFile);
      console.log(`[lifecycle] temporary server exited before emergency cleanup; stalled SIGTERM=${stallSignal}`);
    } finally {
      await stopChild(command.child);
      removeProject(project, pidFile);
    }
  }, 90_000);

  it('auto-starts in a read-only project using a private fallback log', async () => {
    const { project, cli, pidFile, pidProbe } = packagedProject();
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    writeFileSync(join(project, 'agent-health.config.mjs'), 'export default {};\n');
    // Existing file stays writable so the PID-only observer does not require a
    // writable project directory. The server may not mkdir .agent-health/logs.
    // Existing runtime data remains writable: the file-storage module creates
    // this directory even before selecting an external backend. Isolate the NEW
    // log-directory requirement from that pre-existing storage prerequisite.
    mkdirSync(join(project, '.agent-health/data'), { recursive: true });
    chmodSync(join(project, '.agent-health'), 0o555);
    writeFileSync(pidFile, '');
    chmodSync(project, 0o555);
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', AH_PORT: String(port), PORT: String(port),
      NODE_OPTIONS: `--require=${pidProbe}`, BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1' };
    const command = startCli(cli, ['list', 'agents', '--output', 'json'], project, env);
    let logPath: string | undefined;
    try {
      const exited = await waitUntil(() => command.child.exitCode !== null || command.child.signalCode !== null, 60_000);
      logPath = command.stderr().match(/Server log: (.+)/)?.[1];
      if (!exited || command.child.exitCode !== 0) {
        throw new Error(`REGRESSION: read-only project prevented auto-start (exit=${command.child.exitCode}).\n${command.stderr()}`);
      }
      expect(Array.isArray(JSON.parse(command.stdout()))).toBe(true);
      expect(logPath).toBeDefined();
      expect(logPath!.startsWith(project)).toBe(false);
      expect(statSync(logPath!).mode & 0o777).toBe(0o600);
      expect(statSync(join(logPath!, '..')).mode & 0o777).toBe(0o700);
      await assertServerExited(pidFile);
    } finally {
      await stopChild(command.child);
      chmodSync(project, 0o755);
      chmodSync(join(project, '.agent-health'), 0o755);
      removeProject(project, pidFile);
      if (logPath) rmSync(logPath, { force: true });
    }
  }, 90_000);

  it('uses the child-reported fallback port without touching the occupied port', async () => {
    const { project, cli, pidFile, pidProbe } = packagedProject();
    const occupied = createServer((_request, response) => {
      response.statusCode = 404;
      response.end('occupied by a different service');
    });
    const port = await listen(occupied);
    writeFileSync(join(project, 'agent-health.config.mjs'), 'export default {};\n');
    const env: NodeJS.ProcessEnv = { ...process.env, AH_PORT: String(port), PORT: String(port),
      NODE_OPTIONS: `--require=${pidProbe}`, BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1' };
    delete env.CI;
    const command = startCli(cli, ['list', 'agents'], project, env);
    try {
      const exited = await waitUntil(() => command.child.exitCode !== null || command.child.signalCode !== null, 60_000);
      if (!exited || command.child.exitCode !== 0) throw new Error(command.stdout() + command.stderr());
      // The port-fallback notice is a [ServerLifecycle] diagnostic → stderr (stdout stays data-only).
      const match = command.stderr().match(/server started on port (\d+)/);
      expect(match).not.toBeNull();
      const actualPort = Number(match![1]);
      expect(actualPort).toBeGreaterThan(port);
      const health = await fetch(`http://127.0.0.1:${actualPort}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
      expect(health.instance.cwd).toBe(project);
      expect(occupied.listening).toBe(true);
      expect(await fetch(`http://127.0.0.1:${port}/health`).then(r => r.status)).toBe(404);
    } finally {
      await stopChild(command.child);
      removeProject(project, pidFile);
      await close(occupied);
    }
  }, 90_000);
});
