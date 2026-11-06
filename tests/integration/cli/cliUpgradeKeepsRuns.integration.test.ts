/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real packaged CLI, real child server, real HTTP — no lifecycle mocks.
 *
 * Customer journey (issue #612, problem 5): a benchmark is running in the
 * server auto-started by the INSTALLED CLI. The user then runs the CLI from a
 * NEWER package (what `npx @opensearch-project/agent-health@latest` does after
 * a release). The newer CLI sees a version mismatch. Before this fix it killed
 * the server to restart it on its own version, losing the in-flight run.
 *
 * Expected now:
 *   1. the upgraded CLI REFUSES (exit 1) and names the in-flight run + both
 *      versions + what to do — the old server PID stays alive;
 *   2. the run completes normally;
 *   3. the next upgraded-CLI call restarts the server (new PID, new version).
 *
 * The two versions are exercised legitimately: two staged copies of the built
 * package whose package.json versions differ (that is exactly what two npm
 * installs are). No test-only hooks in production code.
 *
 * Build first: npm run build:all
 */
import { spawn, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server, type ServerResponse } from 'http';
import { join } from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';

const ROOT = join(__dirname, '../../..');
const AGENT_KEY = 'cli-upgrade-fixture';
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
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) await sleep(50);
  return predicate();
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

async function stopChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  child.kill('SIGTERM');
  if (!await waitUntil(() => exited(child), 2_000)) {
    child.kill('SIGKILL');
    await waitUntil(() => exited(child), 2_000);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Stage the built package twice under one project: the "installed" copy at
 * node_modules/@opensearch-project/agent-health (what the eval file's
 * `require('@opensearch-project/agent-health')` resolves to) and an
 * "upgraded" copy whose package.json version has its patch bumped — the
 * server and the CLI each read their own package.json for /health `version`
 * and the CLI version, so the two copies really do disagree.
 */
function stagePackages() {
  for (const file of ['cli/dist/index.js', 'server/dist/app.js', 'lib/dist/lib/index.js']) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Missing ${file}; run npm run build:all first`);
  }
  const scratchRoot = join(ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, 'cli-upgrade-'));
  const stage = (packageDir: string, version?: string) => {
    mkdirSync(packageDir, { recursive: true });
    for (const file of ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist', 'dist']) {
      cpSync(join(ROOT, file), join(packageDir, file), { recursive: true });
    }
    const manifestPath = join(packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (version) {
      manifest.version = version;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return { cli: join(packageDir, 'bin/cli.js'), version: manifest.version as string };
  };
  const installed = stage(join(project, 'node_modules/@opensearch-project/agent-health'));
  const [major, minor, patch] = installed.version.split('.').map(Number);
  const upgraded = stage(
    join(project, '.npx-cache/node_modules/@opensearch-project/agent-health'),
    `${major}.${minor}.${patch + 1}`,
  );
  const pidFile = join(project, 'server-pids.txt');
  const pidProbe = join(project, 'capture-server-pid.cjs');
  // Observation only: record every server child we spawn so cleanup kills
  // exactly those PIDs, never a port-wide or pattern kill.
  writeFileSync(pidProbe, `if (process.argv.includes('serve')) require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\n`);
  return { project, installed, upgraded, pidFile, pidProbe };
}

function serverPids(pidFile: string): number[] {
  return existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 1) : [];
}

function removeProject(project: string, pidFile: string): void {
  for (const pid of serverPids(pidFile)) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  rmSync(project, { recursive: true, force: true });
}

describe('packaged CLI: upgrading the CLI while a run is in flight', () => {
  it('refuses to restart the mismatched server until the run completes, then restarts it', async () => {
    const { project, installed, upgraded, pidFile, pidProbe } = stagePackages();
    expect(upgraded.version).not.toBe(installed.version);

    // A REST agent that HOLDS every request until the test releases it: while
    // it holds, the server has a run in flight.
    const held: ServerResponse[] = [];
    let requests = 0;
    const agent = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests++;
        held.push(response);
      });
    });
    const release = () => {
      for (const response of held.splice(0)) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ response: 'deterministic fixture answer' }));
      }
    };
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
    const health = () => api('/health');
    const env: NodeJS.ProcessEnv = { ...process.env, AH_PORT: String(port), PORT: String(port),
      BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
      NODE_OPTIONS: `--require=${pidProbe}`, NO_COLOR: '1',
      // killServerOnPort shells out to lsof; some hosts keep it in sbin only.
      PATH: [process.env.PATH, '/usr/sbin', '/sbin'].filter(Boolean).join(':') };
    delete env.CI;
    delete env.AH_REUSE_FOREIGN_SERVER;
    delete env.AH_SUPPRESS_EXPERIMENTAL;
    writeFileSync(join(project, 'agent-health.config.mjs'), `export default ${JSON.stringify({
      agents: [{ key: AGENT_KEY, name: 'CLI upgrade fixture', connectorType: 'rest',
        endpoint: `http://127.0.0.1:${agentPort}/search`, useTraces: false }],
    })};\n`);
    mkdirSync(join(project, 'evals'));
    writeFileSync(join(project, 'evals/upgrade.eval.ts'), `
const { test } = require('@opensearch-project/agent-health');
test('upgrade case', { prompt: 'fixture question' }, async ({ agent, expect }) => {
  const result = await agent.run();
  expect(result).to.haveCompletedWithin(120000);
});
`);
    try {
      // ── 1. Installed CLI starts the server ────────────────────────────
      const list = startCli(installed.cli, ['list', 'agents', '--output', 'json'], project, env);
      children.push(list.child);
      if (!await waitUntil(() => exited(list.child), 60_000) || list.child.exitCode !== 0) {
        throw new Error(`installed CLI could not start the server (exit=${list.child.exitCode}).\n${list.stdout()}\n${list.stderr()}`);
      }
      const before = await health();
      expect(before.version).toBe(installed.version);
      const oldPid: number = before.instance.pid;
      expect(isAlive(oldPid)).toBe(true);

      // ── 2. A benchmark run goes in flight (agent holds the request) ───
      const created = await api('/api/storage/benchmarks', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uniqueTestName('cli-upgrade'), testCaseIds: [] }) });
      benchmarkId = (created.benchmark ?? created).id;
      if (!benchmarkId) throw new Error('Benchmark creation did not return an id');
      tracker.benchmark(benchmarkId);
      const benchmark = startCli(installed.cli, ['benchmark', '-f', './evals/upgrade.eval.ts',
        '-n', benchmarkId, '-a', AGENT_KEY], project, env);
      children.push(benchmark.child);
      if (!await waitUntil(() => requests >= 1 || exited(benchmark.child), 60_000) || exited(benchmark.child)) {
        throw new Error(`benchmark never reached the agent (exit=${benchmark.child.exitCode}).\n${benchmark.stdout()}\n${benchmark.stderr()}`);
      }
      const duringRun = await health();
      const inFlightRunId: string | undefined = duringRun.activeRuns?.runs?.[0]?.id;
      console.log(`[upgrade] run ${inFlightRunId} in flight on server pid ${oldPid} (v${installed.version})`);

      // ── 3. Upgraded CLI meets the mismatch while the run is in flight ─
      const refused = startCli(upgraded.cli, ['list', 'agents', '--output', 'json'], project, env);
      children.push(refused.child);
      await waitUntil(() => exited(refused.child), 60_000);
      // The customer-visible regression is checked FIRST so that a failing
      // run reports the lost server, not a missing /health field.
      if (!isAlive(oldPid)) {
        throw new Error(`REGRESSION: the upgraded CLI (v${upgraded.version}) killed server pid ${oldPid} ` +
          `(v${installed.version}) while a run was in flight.\n${refused.stdout()}\n${refused.stderr()}`);
      }
      // /health reports what THIS process is executing (not storage status).
      expect(before.activeRuns).toEqual({ count: 0, runs: [] });
      expect(duringRun.activeRuns.count).toBe(1);
      expect(duringRun.activeRuns.runs).toEqual([{ id: inFlightRunId, kind: 'evaluation' }]);
      expect(exited(refused.child)).toBe(true);
      expect(refused.child.exitCode).toBe(1);
      const message = refused.stderr();
      expect(message).toContain('Refusing to restart');
      expect(message).toContain(inFlightRunId!);
      expect(message).toContain(`server version : ${installed.version}`);
      expect(message).toContain(`CLI version    : ${upgraded.version}`);
      expect(message).toContain(`kill ${oldPid}`);
      expect(refused.stdout()).toBe('');
      const stillRunning = await health();
      expect(stillRunning.instance.pid).toBe(oldPid);
      expect(stillRunning.activeRuns.runs.map((run: { id: string }) => run.id)).toEqual([inFlightRunId]);
      console.log(`[upgrade] upgraded CLI exited 1 and left pid ${oldPid} alive; run still registered`);

      // ── 4. The run completes on the old server ────────────────────────
      release();
      if (!await waitUntil(() => exited(benchmark.child), 90_000) || benchmark.child.exitCode !== 0) {
        throw new Error(`benchmark did not complete (exit=${benchmark.child.exitCode}).\n${benchmark.stdout()}\n${benchmark.stderr()}`);
      }
      expect(requests).toBe(1);
      const afterRun = await health();
      expect(afterRun.instance.pid).toBe(oldPid);
      expect(afterRun.activeRuns).toEqual({ count: 0, runs: [] });
      console.log(`[upgrade] benchmark exited 0 on the old server; no runs in flight`);

      // ── 5. With nothing in flight, the upgraded CLI restarts the server ─
      const restart = startCli(upgraded.cli, ['list', 'agents', '--output', 'json'], project, env);
      children.push(restart.child);
      if (!await waitUntil(() => exited(restart.child), 60_000) || restart.child.exitCode !== 0) {
        throw new Error(`upgraded CLI did not restart the idle server (exit=${restart.child.exitCode}).\n${restart.stdout()}\n${restart.stderr()}`);
      }
      expect(restart.stderr()).toContain('Version mismatch detected');
      expect(restart.stderr()).toContain(`starting v${upgraded.version}`);
      const after = await health();
      expect(after.version).toBe(upgraded.version);
      expect(after.instance.pid).not.toBe(oldPid);
      expect(after.instance.cwd).toBe(project);
      expect(isAlive(oldPid)).toBe(false);
      console.log(`[upgrade] idle server restarted: pid ${oldPid} (v${installed.version}) → pid ${after.instance.pid} (v${after.version})`);
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
        release();
        removeProject(project, pidFile);
        await close(agent);
      }
    }
  }, 240_000);
});
