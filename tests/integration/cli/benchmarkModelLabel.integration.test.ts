/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real packaged CLI, child server, a local REST agent — no mocks.
 *
 * #612 problem 7: `agent-health benchmark` printed `Model: demo-model` for a
 * REST agent that declares no model (the first key of the built-in catalog),
 * which users read as "the mock judge is on". The CLI must print the model the
 * agent declares in its own connector config, or `—` when it declares none.
 *
 * The project is a throw-away directory with its own `agent-health.config.mjs`
 * (two REST agents against one local stub) and FILE storage under its own
 * `.agent-health/`, so nothing touches shared storage; the directory and the
 * server the CLI auto-started (observed PIDs only) are removed afterwards.
 *
 * Build first: npm run build:all
 */
import { spawn, type ChildProcess } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const DECLARED_MODEL = 'provider.deployment-v2';
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
  const project = mkdtempSync(join(scratchRoot, 'cli-model-label-'));
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

/** The `Model:` line the CLI printed (trimmed), or undefined. */
function modelLine(stdout: string): string | undefined {
  return stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('Model:'));
}

describe('packaged CLI: `benchmark` prints the agent-declared model or — (#612 problem 7)', () => {
  it('REST agent without a model → `Model: —`; with a declared model → that model', async () => {
    const { project, cli, pidFile, pidProbe } = packagedProject();

    const agent = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ response: 'deterministic fixture answer' }));
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
      NODE_OPTIONS: `--require=${pidProbe}`, NO_COLOR: '1' };
    // File storage in the throw-away project only — never the shared cluster.
    for (const key of Object.keys(env)) if (key.startsWith('OPENSEARCH_')) delete env[key];
    delete env.CI;
    delete env.AH_REUSE_FOREIGN_SERVER;
    delete env.AH_SUPPRESS_EXPERIMENTAL;
    writeFileSync(join(project, 'agent-health.config.mjs'), `export default ${JSON.stringify({
      agents: [
        { key: 'rest-no-model', name: 'REST agent (no model)', connectorType: 'rest',
          endpoint: `http://127.0.0.1:${agentPort}/ask`, useTraces: false },
        { key: 'rest-with-model', name: 'REST agent (declared model)', connectorType: 'rest',
          endpoint: `http://127.0.0.1:${agentPort}/ask`, useTraces: false,
          connectorConfig: { model: DECLARED_MODEL } },
      ],
    })};\n`);
    mkdirSync(join(project, 'evals'));
    writeFileSync(join(project, 'evals/model-label.eval.ts'), `
const { test } = require('@opensearch-project/agent-health');
test('model label case', { prompt: 'fixture question' }, async ({ agent, expect }) => {
  const result = await agent.run();
  expect(result).to.haveCompletedWithin(10000);
});
`);

    const runBenchmark = async (agentKey: string, extraArgs: string[] = []) => {
      const cmd = startCli(cli, ['benchmark', '-f', './evals/model-label.eval.ts', '-a', agentKey, ...extraArgs], project, env);
      children.push(cmd.child);
      const done = await waitUntil(() => cmd.child.exitCode !== null || cmd.child.signalCode !== null, 90_000);
      if (!done || cmd.child.exitCode !== 0) {
        throw new Error(`benchmark -a ${agentKey} did not complete (exit=${cmd.child.exitCode}).\n${cmd.stdout()}\n${cmd.stderr()}`);
      }
      return cmd.stdout();
    };

    try {
      const noModelOut = await runBenchmark('rest-no-model');
      console.log(`[model-label] rest-no-model printed: ${modelLine(noModelOut)}`);
      expect(modelLine(noModelOut)).toBe('Model: —');
      expect(noModelOut).not.toContain('demo-model');

      // What the server recorded as the run's model, read back before the
      // second run stops the server. Only the PRINTED line changes in this
      // fix: the no-model agent's run still carries the catalog fallback
      // (`demo-model`, the first key of the built-in catalog) — the wire half
      // of #612 problem 7 is a separate change.
      const list = await fetch(`${baseUrl}/api/storage/evaluation-runs`, { signal: AbortSignal.timeout(15_000) });
      const { evaluationRuns = [] } = (await list.json()) as { evaluationRuns?: Array<{ agentKey: string; modelId?: string }> };
      for (const run of evaluationRuns) console.log(`[model-label] stored run agentKey=${run.agentKey} modelId=${JSON.stringify(run.modelId)}`);
      expect(evaluationRuns.find(r => r.agentKey === 'rest-no-model')?.modelId).toBe('demo-model');

      // Second run reuses the server and asks the CLI to stop it on exit.
      const withModelOut = await runBenchmark('rest-with-model', ['--stop-server']);
      console.log(`[model-label] rest-with-model printed: ${modelLine(withModelOut)}`);
      expect(modelLine(withModelOut)).toBe(`Model: ${DECLARED_MODEL}`);
    } finally {
      for (const child of children) await stopChild(child);
      // Only PIDs observed from our own spawned server; the project (and its file storage) goes with it.
      removeProject(project, pidFile);
      await close(agent);
    }
  }, 240_000);
});
