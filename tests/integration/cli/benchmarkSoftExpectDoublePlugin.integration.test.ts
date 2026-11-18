/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real packaged CLI, child server, a local REST agent — no mocks. Regression
 * guard for #621: a failing `expect.soft(...)` in an eval file was persisted
 * with `pass: true` and the case reported as passed.
 *
 * The trigger is a process holding two compiled copies of the recording
 * plugin on one chai: the project's `agent-health.config.mjs` imports
 * `defineConfig` from `@opensearch-project/agent-health` (the documented
 * pattern), which loads the package entry (`lib/dist`) into the server at
 * config time; the server bundle (`server/dist`) later lazily installs its
 * own copy. The inner copy swallowed the soft failure, the outer one — whose
 * session the report is built from — recorded a pass.
 *
 * The project is a throw-away directory with FILE storage under its own
 * `.agent-health/`, so nothing touches shared storage; the directory and the
 * server the CLI auto-started (observed PIDs only) are removed afterwards.
 *
 * Build first: npm run build:all
 */
import { spawn, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { withCliCoverage } from '../../helpers/cliCoverage';

const ROOT = join(__dirname, '../../..');
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

/** Stage the built package the way an npm install lays it out; no TS sources. */
function packagedProject() {
  for (const file of ['cli/dist/index.js', 'server/dist/app.js', 'lib/dist/lib/index.js']) {
    if (!existsSync(join(ROOT, file))) throw new Error(`Missing ${file}; run npm run build:all first`);
  }
  const scratchRoot = join(ROOT, '.agent-health');
  mkdirSync(scratchRoot, { recursive: true });
  const project = mkdtempSync(join(scratchRoot, 'cli-soft-expect-'));
  const packageDir = join(project, 'node_modules/@opensearch-project/agent-health');
  mkdirSync(packageDir, { recursive: true });
  for (const file of ['package.json', 'bin', 'cli/dist', 'server/dist', 'lib/dist', 'dist']) {
    cpSync(join(ROOT, file), join(packageDir, file), { recursive: true });
  }
  const pidFile = join(project, 'server-pids.txt');
  const pidProbe = join(project, 'capture-server-pid.cjs');
  // Observation only: record the exact server child the CLI spawns so cleanup kills nothing else.
  writeFileSync(pidProbe, `if (process.argv.includes('serve')) require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\n`);
  return { project, cli: join(packageDir, 'bin/cli.js'), pidFile, pidProbe };
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}

interface MatcherRow { description: string; pass: boolean; errorMessage?: string; notReached?: boolean }
interface Report { passFailStatus?: string; matcherResults?: MatcherRow[] }

describe('packaged CLI: failing expect.soft is persisted as pass: false when the config imports the package (#621)', () => {
  it('soft failures fail the case; soft passes and the rest of the body are unaffected', async () => {
    const { project, cli, pidFile, pidProbe } = packagedProject();

    const agent = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ response: 'top 3: alpha; beta; gamma' }));
      });
    });
    const agentPort = await listen(agent);
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    const baseUrl = `http://127.0.0.1:${port}`;
    const children: ChildProcess[] = [];

    const env: NodeJS.ProcessEnv = { ...process.env, AH_PORT: String(port), PORT: String(port),
      BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
      NODE_OPTIONS: `--require=${pidProbe}`, NO_COLOR: '1', AH_SUPPRESS_EXPERIMENTAL: '1' };
    // File storage in the throw-away project only — never the shared cluster.
    for (const key of Object.keys(env)) if (key.startsWith('OPENSEARCH_')) delete env[key];
    delete env.CI;
    delete env.AH_REUSE_FOREIGN_SERVER;

    // The documented config shape — and the #621 trigger: this import loads
    // the package entry (lib/dist) into the server process before the
    // server bundle's own lazily-initialised copy of the plugin.
    writeFileSync(join(project, 'agent-health.config.mjs'), `
import { defineConfig } from '@opensearch-project/agent-health';
export default defineConfig({
  agents: [
    { key: 'rest-fixture', name: 'REST fixture agent', connectorType: 'rest',
      endpoint: 'http://127.0.0.1:${agentPort}/ask', useTraces: false },
  ],
});
`);
    mkdirSync(join(project, 'evals'));
    writeFileSync(join(project, 'evals/soft.eval.ts'), `
const { test } = require('@opensearch-project/agent-health');

// Soft check whose expectation is NOT in the agent output: must be recorded
// as a failure, and the case must fail — the body still runs to the end.
test('soft-fail', { prompt: 'fixture question' }, async ({ agent, expect }) => {
  const result = await agent.run();
  expect.soft(result.agentOutput, 'expected item in the top 3').to.include('delta');
  expect(result).to.haveCompletedWithin(60000);
});

// Soft check that holds: must be recorded as a pass, and the case passes.
test('soft-pass', { prompt: 'fixture question' }, async ({ agent, expect }) => {
  const result = await agent.run();
  expect.soft(result.agentOutput, 'expected item in the top 3').to.include('alpha');
});
`);

    try {
      const cmd = startCli(cli, ['benchmark', '-f', './evals/soft.eval.ts', '-a', 'rest-fixture'], project, withCliCoverage(env as Record<string, string>));
      children.push(cmd.child);
      const done = await waitUntil(() => cmd.child.exitCode !== null || cmd.child.signalCode !== null, 120_000);
      if (!done) {
        throw new Error(`benchmark did not complete.\n${cmd.stdout()}\n${cmd.stderr()}`);
      }
      // The CLI exits non-zero when a case fails; the persisted reports are
      // the gate here, not the exit code.
      const stdout = cmd.stdout().replace(/\u001b\[[0-9;]*m/g, '');
      console.log(`[soft-expect] CLI exit=${cmd.child.exitCode}\n${stdout.split('\n').filter(l => /soft-(fail|pass)|passed|failed/i.test(l)).join('\n')}`);

      // Read the per-case reports back through the server the CLI started
      // (still running — no --stop-server; cleanup kills the observed PID).
      const { evaluationRuns = [] } = await getJson<{ evaluationRuns?: Array<{
        results?: Record<string, { reportId?: string }>; testCaseSnapshots?: Array<{ id: string; name: string }> }> }>(
        `${baseUrl}/api/storage/evaluation-runs`);
      const byName = new Map<string, Report>();
      for (const run of evaluationRuns) {
        for (const [tcId, result] of Object.entries(run.results ?? {})) {
          const name = run.testCaseSnapshots?.find(s => s.id === tcId)?.name;
          if (name && result.reportId) {
            byName.set(name, await getJson<Report>(`${baseUrl}/api/storage/runs/${encodeURIComponent(result.reportId)}`));
          }
        }
      }
      for (const [name, report] of byName) {
        console.log(`[soft-expect] ${name}: ${report.passFailStatus} ${JSON.stringify(report.matcherResults?.map(m => ({ d: m.description, pass: m.pass })))}`);
      }
      expect([...byName.keys()].sort()).toEqual(['soft-fail', 'soft-pass']);

      // The bug: this row was persisted with pass: true and the case passed.
      const softFail = byName.get('soft-fail')!;
      const failingRow = (softFail.matcherResults ?? []).find(m => /to include 'delta'/.test(m.description));
      expect(failingRow).toBeDefined();
      expect(failingRow!.pass).toBe(false);
      expect(failingRow!.errorMessage).toContain('expected item in the top 3');
      expect(softFail.passFailStatus).toBe('failed');
      // Soft: the body kept running past the failure (one record per assertion).
      const bodyRows = (softFail.matcherResults ?? []).filter(m => !m.notReached && !/hook/.test(m.description));
      expect(bodyRows.map(m => m.pass)).toEqual([false, true]);

      const softPass = byName.get('soft-pass')!;
      expect((softPass.matcherResults ?? []).filter(m => !m.notReached).map(m => m.pass)).toEqual([true]);
      expect(softPass.passFailStatus).toBe('passed');
    } finally {
      for (const child of children) await stopChild(child);
      // Only PIDs observed from our own spawned server; the project (and its file storage) goes with it.
      removeProject(project, pidFile);
      await close(agent);
    }
  }, 240_000);
});
