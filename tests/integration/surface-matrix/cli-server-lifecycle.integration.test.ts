/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · server lifecycle: `serve`, quick mode, `--stop-server`, `CI=1`
 *
 * Everything a customer sees about WHO owns the server. Runs in an ISOLATED
 * project directory (its own `.agent-health/` state + file storage) on a
 * spare port picked from the OS at runtime (`SURFACE_MATRIX_SPARE_PORT` to
 * pin one) so nothing here can touch the shared backend under test. Pinned:
 *   - `serve --headless -p <port>` answers `/health` with
 *     `{ status: 'ok', version, instance: { pid, cwd, port } }` and the
 *     storage/agents/models APIs work out of the box (file storage, built-in
 *     `demo` agent + `demo-model`);
 *   - QUICK MODE — `benchmark -a <agent>` with no `-n`/`-f` and NO server
 *     running: the CLI starts its own server, prints "Running in quick mode",
 *     "Found N test cases", "Created benchmark: quick-<ts>", runs every stored
 *     case N/N, then STOPS the server it started (the port is free afterwards).
 *     The quick benchmark + its run persist in the project's storage (visible
 *     on the next `serve`);
 *   - `benchmark` with no `-n`/`-f` while a server IS running exits 1 with
 *     "Benchmark name required when server is already running";
 *   - `--stop-server` against a server the CLI did NOT start leaves that
 *     server running (a customer's long-lived server is never killed);
 *   - `CI=1` + an already-running server (`reuseExistingServer` defaults to
 *     false under CI):
 *       - the port was named EXPLICITLY (`AH_PORT` / `server.port`) and a
 *         healthy, version-matching server answers on it ⇒ the CLI reuses it
 *         (exit 0, prints "Using existing server on :PORT (explicit port)") —
 *         the canonical CI job that started its own server first;
 *       - the port is IMPLICIT (no `AH_PORT`, no `server.port` → defaulted
 *         4001) ⇒ refusal (exit 1, "Server already running on port … In CI
 *         mode (reuseExistingServer=false)", hinting at `AH_PORT`);
 *       - the server's version differs from the CLI's ⇒ refusal (exit 1,
 *         "Server version mismatch"), and that server is never killed.
 *
 * On the reusing-an-existing-server cases the shared backend (AH_PORT) is the
 * server; those never write anything except the runs the reuse case records
 * (tracked and deleted).
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  BACKEND_PORT, BASE_URL, REPO_ROOT, backendReady, caseInput, createBenchmark, createTestCase, isPortServing,
  listTerminalRunsForBenchmark, reportIdsOf, reserveSparePort, runCli, serveHeadless, stopServerOnPort,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 300_000;
const CASES = 2;
// Chosen at runtime (a free OS port) so parallel workers never collide; see reserveSparePort.
let SPARE_PORT = 0;
let SPARE_URL = '';
/** The port the CLI falls back to when neither `AH_PORT` nor `server.port` names one. */
const IMPLICIT_DEFAULT_PORT = '4001';

async function spareApi<T = any>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SPARE_URL}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${await res.text()}`);
  return res.json();
}

describe('surface-matrix · CLI · serve / quick mode / --stop-server / CI=1', () => {
  let projectDir: string;
  let agent: TraceparentRestAgent;

  beforeAll(async () => {
    SPARE_PORT = await reserveSparePort();
    SPARE_URL = `http://127.0.0.1:${SPARE_PORT}`;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-project-'));
    // Tell the CLI-started servers where their OTLP receiver is; the fixture
    // agent exports there so trace-mode judging resolves in quick mode too.
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${SPARE_URL}/v1/traces` });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    // Safety net: never leave a server we booted behind (by its own reported pid, same cwd).
    await stopServerOnPort(SPARE_PORT, projectDir);
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  }, 60_000);

  const spareEnv = () => ({
    AH_PORT: String(SPARE_PORT),
    // Make trace polling fail fast if spans ever don't arrive; recovery off (test server).
    TRACE_POLL_MAX_ATTEMPTS: '3',
    TRACE_POLL_INTERVAL_MS: '1000',
    BENCHMARK_RUN_RECOVERY_DISABLED: '1',
    EVALUATION_RUN_RECOVERY_DISABLED: '1',
  });

  it('`serve --headless` boots a working server in the project directory; quick mode then runs every stored case and stops its own server', async () => {
    if (await isPortServing(SPARE_PORT)) throw new Error(`spare port ${SPARE_PORT} is already in use — set SURFACE_MATRIX_SPARE_PORT to a free one`);

    // ── 1. `serve --headless`: health contract + out-of-the-box APIs ──────────
    const served = await serveHeadless(SPARE_PORT, { cwd: projectDir, env: spareEnv() });
    let agentKey: string;
    try {
      expect(served.health).toMatchObject({ status: 'ok', service: 'agent-health' });
      expect(typeof served.health.version).toBe('string');
      expect(served.health.instance).toMatchObject({ pid: served.pid, cwd: projectDir, port: SPARE_PORT });
      expect(await spareApi('GET', '/api/storage/health')).toMatchObject({ status: 'ok', backend: 'file' });
      const { agents } = await spareApi<{ agents: any[] }>('GET', '/api/agents');
      expect(agents.map((a) => a.key)).toContain('demo');
      const { models } = await spareApi<{ models: any[] }>('GET', '/api/models');
      expect(models.map((m) => m.key)).toContain('demo-model');

      // Seed what quick mode will pick up: a custom REST agent + N test cases.
      const created = await spareApi<{ agent: { key: string } }>('POST', '/api/agents/custom', {
        name: uniqueTestName('quick-mode-rest-agent'), endpoint: agent.url, connectorType: 'rest', useTraces: true,
      });
      agentKey = created.agent.key;
      for (let i = 1; i <= CASES; i++) await spareApi('POST', '/api/storage/test-cases', caseInput('quick', i));
    } finally {
      await served.stop();
    }
    expect(await isPortServing(SPARE_PORT)).toBe(false);

    // ── 2. Quick mode: no server running, no -n / -f ───────────────────────
    const result = await runCli(['benchmark', '-a', agentKey!], { cwd: projectDir, env: spareEnv(), timeoutMs: 240_000 });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Running in quick mode (auto-creating benchmark from test cases)');
    expect(result.out).toContain(`Started server on port ${SPARE_PORT}`);
    expect(result.out).toContain(`Found ${CASES} test cases`);
    expect(result.out).toMatch(/Created benchmark: quick-\d+/);
    expect(result.out).toContain(`${CASES}/${CASES} passed`);
    expect(result.out).not.toContain('errored — evaluator could not run');
    expect(result.out).toContain('Benchmark Summary');
    expect(agent.invocations).toHaveLength(CASES);
    // The CLI stops the server it started in quick mode.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await isPortServing(SPARE_PORT))) await new Promise((r) => setTimeout(r, 250));
    expect(await isPortServing(SPARE_PORT)).toBe(false);

    // ── 3. What quick mode left behind is visible on the next `serve` ────────
    const served2 = await serveHeadless(SPARE_PORT, { cwd: projectDir, env: spareEnv() });
    try {
      const { benchmarks } = await spareApi<{ benchmarks: any[] }>('GET', '/api/storage/benchmarks');
      const quick = benchmarks.filter((b) => /^quick-\d+$/.test(b.name));
      expect(quick).toHaveLength(1);
      expect(quick[0].testCaseIds).toHaveLength(CASES);
      const { evaluationRuns } = await spareApi<{ evaluationRuns: any[] }>('GET', `/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(quick[0].id)}`);
      expect(evaluationRuns).toHaveLength(1);
      expect(evaluationRuns[0]).toMatchObject({ status: 'completed', trigger: 'cli', agentKey });
      expect(Object.keys(evaluationRuns[0].results)).toHaveLength(CASES);
      for (const r of Object.values(evaluationRuns[0].results) as any[]) {
        const report = await spareApi<any>('GET', `/api/storage/runs/${encodeURIComponent(r.reportId)}`);
        expect((report.run ?? report).metricsStatus).toBe('ready');
        expect(['passed', 'failed']).toContain((report.run ?? report).passFailStatus);
      }
    } finally {
      await served2.stop();
    }
  }, TEST_TIMEOUT);

  describe('against the already-running shared backend (read-only cases)', () => {
    const tracker = createTestDataTracker();
    let ready = false;
    let benchmarkName: string;
    let benchmarkId: string;

    beforeAll(async () => {
      ready = await backendReady();
      if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
      const tc = await createTestCase(caseInput('lifecycle', 1));
      tracker.testCase(tc.id);
      benchmarkName = uniqueTestName('lifecycle-bench');
      const bm = await createBenchmark(benchmarkName, [tc.id]);
      benchmarkId = bm.id;
      tracker.benchmark(benchmarkId);
    }, TEST_TIMEOUT);

    afterAll(async () => { await tracker.cleanup(); }, 60_000);

    it('`benchmark` with no -n / -f while a server is running exits 1 with the "Benchmark name required" hint', async () => {
      if (!ready) return;
      const result = await runCli(['benchmark', '-a', 'demo'], { timeoutMs: 60_000 });
      expect(result.code).toBe(1);
      expect(result.out).toContain('Benchmark name required when server is already running');
      expect(result.out).toContain('benchmark -n "Name"');
      expect(await isPortServing(Number(BACKEND_PORT))).toBe(true);
    }, TEST_TIMEOUT);

    it('`--stop-server` never stops a server the CLI did not start', async () => {
      if (!ready) return;
      const result = await runCli(['benchmark', '-n', benchmarkName, '-a', 'demo', '--stop-server']);
      for (const run of await listTerminalRunsForBenchmark(benchmarkId)) {
        tracker.evaluationRun(run.id);
        for (const id of reportIdsOf(run)) tracker.run(id);
      }
      expect(result.code).toBe(0);
      expect(result.out).toContain(`Connected to existing server on port ${BACKEND_PORT}`);
      expect(await isPortServing(Number(BACKEND_PORT))).toBe(true);
    }, TEST_TIMEOUT);

    it('`CI=1` + explicit `AH_PORT`: reuses the healthy, version-matching server (exit 0, "Using existing server on :PORT (explicit port)")', async () => {
      if (!ready) return;
      // cliEnv always names the backend port explicitly (AH_PORT) — the shape of
      // a CI job that started its own server and then drives the CLI against it.
      const result = await runCli(['benchmark', '-n', benchmarkName, '-a', 'demo'], { env: { CI: 'true' } });
      for (const run of await listTerminalRunsForBenchmark(benchmarkId)) {
        tracker.evaluationRun(run.id);
        for (const id of reportIdsOf(run)) tracker.run(id);
      }
      expect(result.code).toBe(0);
      expect(result.out).toContain(`Connected to existing server on port ${BACKEND_PORT}`);
      expect(result.out).toContain(`Using existing server on :${BACKEND_PORT} (explicit port)`);
      expect(result.out).not.toContain('In CI mode (reuseExistingServer=false)');
      expect(result.out).toContain('Benchmark Summary');
      expect(await isPortServing(Number(BACKEND_PORT))).toBe(true);
    }, TEST_TIMEOUT);

    it('`CI=1` + implicit port (no `AH_PORT`): refuses the already-running server (exit 1, hints at `AH_PORT`)', async () => {
      if (!ready) return;
      // The implicit port IS 4001, so this can only be exercised when the backend
      // under test listens there (CI does; a local run on another port would dial
      // whatever occupies 4001 on the box, which is not ours to touch).
      if (BACKEND_PORT !== IMPLICIT_DEFAULT_PORT) {
        console.warn(`[surface-matrix] backend is on :${BACKEND_PORT}, not the implicit default :${IMPLICIT_DEFAULT_PORT}; skipping the implicit-port refusal case`);
        return;
      }
      const result = await runCli(['benchmark', '-n', benchmarkName, '-a', 'demo'], {
        env: { CI: 'true', AH_PORT: undefined, AGENT_HEALTH_PORT: undefined },
        timeoutMs: 60_000,
      });
      expect(result.code).toBe(1);
      expect(result.out).toContain(`Server already running on port ${BACKEND_PORT}`);
      expect(result.out).toContain('In CI mode (reuseExistingServer=false)');
      expect(result.out).toContain(`AH_PORT=${BACKEND_PORT}`);
      expect(result.out).not.toContain('Using existing server on');
      expect(await isPortServing(Number(BACKEND_PORT))).toBe(true);
    }, TEST_TIMEOUT);

    it('`CI=1` + version mismatch: refuses (exit 1, "Server version mismatch") and never kills the server, even on an explicit port', async () => {
      // A stand-in "agent-health server" that answers /health like ours (same cwd,
      // so ownership passes) but with a version the CLI can never match.
      const fake = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'ok', service: 'agent-health', version: '0.0.0-surface-matrix', instance: { pid: process.pid, cwd: REPO_ROOT, port: fakePort } }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      const fakePort = await new Promise<number>((resolve, reject) => {
        fake.once('error', reject);
        fake.listen(0, '127.0.0.1', () => resolve((fake.address() as { port: number }).port));
      });
      try {
        const result = await runCli(['benchmark', '-n', 'irrelevant', '-a', 'demo'], { env: { CI: 'true', AH_PORT: String(fakePort) }, timeoutMs: 60_000 });
        expect(result.code).toBe(1);
        expect(result.out).toContain('Version mismatch detected');
        expect(result.out).toContain('Server version mismatch: server=0.0.0-surface-matrix');
        expect(result.out).not.toContain('Using existing server on');
        // Never killed: the stand-in still answers.
        expect(await isPortServing(fakePort)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => fake.close(() => resolve()));
      }
    }, TEST_TIMEOUT);
  });
});
