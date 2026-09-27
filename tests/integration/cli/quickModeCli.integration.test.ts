/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the REAL `agent-health benchmark` quick-mode command, twice.
 *
 * Owner-facing contract for quick mode (`benchmark -a <agent>` with no
 * `-n`/`-f` and no server running): each invocation starts its own server,
 * finds-or-creates ONE stable benchmark named `Quick run — all test cases`,
 * runs every stored test case under it, and stops the server it started.
 * Running it twice must leave exactly one such benchmark with two runs
 * attached (the Runs page's Benchmark column links on `run.benchmarkId`).
 *
 * Self-contained and isolated: the CLI runs in a temp cwd with the FILE
 * storage backend on its own free port, so nothing here touches a shared
 * server — which is also why this test can use the real benchmark name.
 * It exercises the whole orchestration the unit tests only mock (server
 * lifecycle incl. SIGTERM shutdown, ApiClient, unified evaluation-runs API,
 * dual-write into benchmark.runs[]).
 */

import { spawn, execSync } from 'child_process';
import net from 'net';
import path from 'path';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'cli.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const CLI_DIST = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const QUICK_NAME = 'Quick run — all test cases';
const TEST_TIMEOUT = 240_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`/health on ${port} did not respond within ${timeoutMs}ms`);
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await fetch(`http://127.0.0.1:${port}/health`); } catch { return; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server on ${port} still answering after ${timeoutMs}ms`);
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_ENTRY, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms (hang?). Output so far:\n${out}`));
    }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }); });
  });
}

describe('CLI quick mode end-to-end — one stable benchmark across two invocations', () => {
  let cwd: string;
  let port: number;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    if (!existsSync(SERVER_APP)) execSync('npm run build:server', { cwd: REPO_ROOT, stdio: 'ignore' });
    if (!existsSync(CLI_DIST)) execSync('npm run build:cli', { cwd: REPO_ROOT, stdio: 'ignore' });
    cwd = mkdtempSync(path.join(tmpdir(), 'ah-quickmode-cli-'));
    port = await freePort();
    env = {
      ...process.env,
      // bin/cli.js runs the TS source through tsx in a checkout; tsx resolves
      // the `@/` path aliases from the tsconfig nearest to the CWD, which is
      // our temp dir — point it at the repo's tsconfig explicitly.
      TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'tsconfig.json'),
      HOST: '127.0.0.1',
      AH_PORT: String(port),
      PORT: String(port),
      AGENT_HEALTH_STORAGE: 'file',
      BENCHMARK_RUN_RECOVERY_DISABLED: '1',
      EVALUATION_RUN_RECOVERY_DISABLED: '1',
      CI: '', // not CI: exercise the quick-mode (start-and-stop) lifecycle, not the CI one
    };
    delete env.CI;

    // Seed two test cases through a throwaway `serve` (quick mode itself
    // requires that no server is running when it starts).
    const seed = spawn('node', [CLI_ENTRY, 'serve', '-p', String(port), '--headless', '--no-browser'], {
      cwd, env, stdio: 'ignore',
    });
    try {
      await waitForHealth(port, 60_000);
      for (const n of [1, 2]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/storage/test-cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `quick-cli-tc-${n}`, category: 'General', difficulty: 'Easy',
            initialPrompt: `Say hello number ${n}.`, expectedOutcomes: ['Greets the user'],
          }),
        });
        if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
      }
    } finally {
      seed.kill('SIGTERM');
      await waitForPortFree(port, 15_000);
    }
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it(
    'creates the benchmark on the first run, reuses it on the second, stops its server each time, and both runs are attached',
    async () => {
      const first = await runCli(['benchmark', '-a', 'demo'], cwd, env, 90_000);
      expect(first.out).toContain(`Running in quick mode (all test cases under benchmark '${QUICK_NAME}')`);
      expect(first.out).toContain('Found 2 test cases');
      expect(first.out).toContain(`Created benchmark '${QUICK_NAME}'`);
      expect(first.out).toContain('Evaluation run completed (2/2 test cases)');
      expect(first.out).not.toContain('ad-hoc run');
      expect(first.code).toBe(0);
      // The server it started is gone (the CLI would otherwise hang on it).
      await waitForPortFree(port, 10_000);

      const second = await runCli(['benchmark', '-a', 'demo'], cwd, env, 90_000);
      expect(second.out).toContain(`Reusing benchmark '${QUICK_NAME}'`);
      expect(second.out).not.toContain('Created benchmark');
      expect(second.out).not.toContain('refreshed'); // same stored set → untouched
      expect(second.out).toContain('Evaluation run completed (2/2 test cases)');
      expect(second.code).toBe(0);
      await waitForPortFree(port, 10_000);

      // Inspect the store through a fresh `serve` on the same cwd.
      const inspect = spawn('node', [CLI_ENTRY, 'serve', '-p', String(port), '--headless', '--no-browser'], {
        cwd, env, stdio: 'ignore',
      });
      try {
        await waitForHealth(port, 60_000);
        const { benchmarks } = await (await fetch(`http://127.0.0.1:${port}/api/storage/benchmarks`)).json();
        const quick = benchmarks.filter((b: any) => b.name === QUICK_NAME);
        expect(quick).toHaveLength(1); // exactly one — never a second one
        expect(benchmarks.filter((b: any) => /^quick-\d+$/.test(b.name))).toHaveLength(0);
        expect(quick[0].testCaseIds).toHaveLength(2);
        expect(quick[0].currentVersion).toBe(1);
        expect(quick[0].runs.map((r: any) => r.status)).toEqual(['completed', 'completed']);

        const runsBody = await (await fetch(`http://127.0.0.1:${port}/api/storage/evaluation-runs`)).json();
        const runs = (runsBody.evaluationRuns ?? runsBody.runs ?? []) as any[];
        expect(runs).toHaveLength(2);
        for (const run of runs) {
          expect(run.benchmarkId).toBe(quick[0].id); // what the Runs page's Benchmark column links on
          expect(run.status).toBe('completed');
        }
        expect(quick[0].runs.map((r: any) => r.id).sort()).toEqual(runs.map((r) => r.id).sort());
      } finally {
        inspect.kill('SIGTERM');
        await waitForPortFree(port, 15_000);
      }
    },
    TEST_TIMEOUT
  );
});
