/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: configurable eval roots + persisted `describePath`.
 *
 * The problem this pins: a code-SDK test case's `sourceFile` is stored
 * RELATIVE (e.g. `evals/demo.eval.js`) and used to be resolved against the
 * SERVER's `process.cwd()` only. A shared server started from the
 * agent-health checkout therefore could not run suites that live in another
 * repo/directory. With `AGENT_HEALTH_EVAL_ROOTS` (or `evalRoots` config) the
 * server resolves the relative path against those directories instead.
 *
 * Two OWN headless servers (real `createApp` via the CLI bundle's `serve
 * --headless`, FILE storage), both started from a temp cwd that does NOT
 * contain the eval file:
 *   • server A: `AGENT_HEALTH_EVAL_ROOTS=<eval repo>` → the CLI import
 *     (`benchmark -f evals/demo.eval.js`, run from the eval repo) resolves,
 *     the body executes (deterministic matcher result asserted), the stored
 *     case carries the ROOT-relative `sourceFile` and its `describePath`,
 *     and export round-trips `describePath`.
 *   • server B: no env → `GET config/status` reports `evalRoots=[cwd]`
 *     (source=default) and the same relative import fails naming the roots
 *     tried (the behaviour that #503 turns into a hard pre-start error for
 *     STORED cases too).
 *
 * Agent = `demo` (mock connector); no judge calls (bodies are deterministic).
 * Ports 4861/4862 (override: AH_EVAL_ROOTS_TEST_PORT_A / _B). Only the two
 * processes THIS suite spawns are ever killed, by captured pid.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const PORT_A = Number(process.env.AH_EVAL_ROOTS_TEST_PORT_A || 4861);
const PORT_B = Number(process.env.AH_EVAL_ROOTS_TEST_PORT_B || 4862);
const TEST_TIMEOUT = 150_000;

const EVAL_FILE_REL = 'evals/demo.eval.js';
// `require('@opensearch-project/agent-health')` is intercepted by the loader,
// so this CJS fixture loads from any directory without a node_modules.
const EVAL_FILE_CONTENT = `
const { test, describe, expect } = require('@opensearch-project/agent-health');

describe('Demo Suite', () => {
  test('grouped-deterministic-pass', {
    description: 'no prompt → body runs without the agent; chai matcher records a PASS',
    labels: ['category:Smoke', 'difficulty:Easy'],
  }, ({ testInfo }) => {
    expect(testInfo.name).to.equal('grouped-deterministic-pass');
  });
});

test('top-level-deterministic-pass', () => {
  expect([1, 2, 3]).to.have.lengthOf(3);
});
`;

function http<T = any>(
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        agent: false,
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: any = text;
          try { parsed = text ? JSON.parse(text) : {}; } catch { /* SSE / non-JSON */ }
          resolve({ status: res.statusCode || 0, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSse(text: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) continue;
    try { out.push({ event, data: JSON.parse(data) }); } catch { out.push({ event, data }); }
  }
  return out;
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await http(base, 'GET', '/health');
      if (r.status === 200) return;
      lastErr = `status ${r.status}`;
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on ${base} did not become healthy in ${timeoutMs}ms (${lastErr})`);
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k === 'NODE_OPTIONS') env[k] = v;
  }
  return Object.assign(env, {
    HOST: '127.0.0.1',
    AH_HEADLESS: '1',
    AGENT_HEALTH_STORAGE: 'file',
    BENCHMARK_RUN_RECOVERY_DISABLED: '1',
    EVALUATION_RUN_RECOVERY_DISABLED: '1',
    AH_SUPPRESS_EXPERIMENTAL: '1',
    AH_QUIET_DEPRECATIONS: '1',
    NODE_ENV: 'test',
  }, extra);
}

function startServer(cwd: string, port: number, extraEnv: Record<string, string>): ChildProcess {
  // The esbuild CLI BUNDLE (not bin/cli.js → tsx): tsx resolves `@/` aliases
  // from the cwd's tsconfig, and the whole point is a cwd that is NOT the repo.
  return spawn('node', [CLI_BUNDLE, 'serve', '-p', String(port), '--headless', '--no-browser'], {
    cwd,
    env: cleanEnv({ AH_PORT: String(port), ...extraEnv }),
    stdio: 'ignore',
  });
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  // Only the process THIS suite started, by its captured pid.
  if (!child?.pid) return;
  try { child.kill('SIGTERM'); } catch { /* noop */ }
  await new Promise(r => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch { /* noop */ }
}

describe('eval roots + describePath (own headless servers, FILE storage)', () => {
  let serverA: ChildProcess | undefined;
  let serverB: ChildProcess | undefined;
  let tmp: string;
  let serverCwd: string; // NOT where the eval file lives
  let evalRepo: string;  // where the eval file lives
  const BASE_A = `http://127.0.0.1:${PORT_A}`;
  const BASE_B = `http://127.0.0.1:${PORT_B}`;

  beforeAll(async () => {
    if (!existsSync(SERVER_APP)) {
      const b = spawnSync('npm', ['run', 'build:server'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:server failed: ${b.stderr}`);
    }
    if (!existsSync(CLI_BUNDLE)) {
      const b = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:cli failed: ${b.stderr}`);
    }

    tmp = mkdtempSync(path.join(tmpdir(), 'ah-eval-roots-int-'));
    serverCwd = path.join(tmp, 'server-cwd');
    evalRepo = path.join(tmp, 'eval-repo');
    mkdirSync(serverCwd, { recursive: true });
    mkdirSync(path.join(evalRepo, 'evals'), { recursive: true });
    writeFileSync(path.join(evalRepo, EVAL_FILE_REL), EVAL_FILE_CONTENT, 'utf-8');

    serverA = startServer(serverCwd, PORT_A, { AGENT_HEALTH_EVAL_ROOTS: evalRepo });
    serverB = startServer(serverCwd, PORT_B, {});
    await Promise.all([waitForHealth(BASE_A, 60_000), waitForHealth(BASE_B, 60_000)]);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await Promise.all([stopServer(serverA), stopServer(serverB)]);
    // FILE storage lives under <serverCwd>/.agent-health — removed with the temp dir.
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it(
    'GET config/status: server A reports the env roots (source=environment); server B reports [cwd] (source=default)',
    async () => {
      const a = await http(BASE_A, 'GET', '/api/storage/config/status');
      expect(a.status).toBe(200);
      expect(a.body.evalRoots).toEqual({ roots: [evalRepo], source: 'environment' });

      const b = await http(BASE_B, 'GET', '/api/storage/config/status');
      expect(b.status).toBe(200);
      expect(b.body.evalRoots).toEqual({ roots: [serverCwd], source: 'default' });
    },
    TEST_TIMEOUT,
  );

  it(
    'KEY: server A (cwd ≠ eval repo, AGENT_HEALTH_EVAL_ROOTS=<eval repo>): `benchmark -f evals/demo.eval.js` from the eval repo imports + EXECUTES the bodies; stored cases carry root-relative sourceFile + describePath; export round-trips describePath',
    async () => {
      const benchmarkName = `eval-roots-${Date.now()}`;
      const cli = spawnSync(
        'node',
        [CLI_BUNDLE, 'benchmark', '-f', EVAL_FILE_REL, '-a', 'demo', '-n', benchmarkName],
        {
          cwd: evalRepo,
          encoding: 'utf-8',
          timeout: 90_000,
          // The CLI runs from the eval repo against a server started from a
          // DIFFERENT directory — the shared-server scenario. The CLI's
          // foreign-instance guard (cli/utils/serverOwnership.ts) requires the
          // explicit opt-in; that is how operators use a shared server today.
          env: cleanEnv({ AH_PORT: String(PORT_A), AGENT_HEALTH_PORT: String(PORT_A), AH_REUSE_FOREIGN_SERVER: '1' }),
        },
      );
      const out = `${cli.stdout}\n${cli.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
      if (cli.status !== 0) throw new Error(`CLI exited ${cli.status}:\n${out}`);

      // The unified code-import run: one eval-run doc, results per test case.
      const urlRe = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/g;
      const pairs: Array<{ bid: string; rid: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(out)) !== null) pairs.push({ bid: m[1], rid: m[2] });
      expect(pairs.length).toBeGreaterThan(0);

      const run = (await http(BASE_A, 'GET', `/api/storage/evaluation-runs/${pairs[0].rid}`)).body;
      const evaluationRun = run.evaluationRun ?? run;
      expect(evaluationRun.status).toBe('completed');
      const results = Object.values(evaluationRun.results ?? {}) as any[];
      expect(results).toHaveLength(2);

      // The BODIES ran (deterministic matcher results from chai), not the classic judge.
      const byName = new Map<string, any>();
      for (const r of results) {
        const report = (await http(BASE_A, 'GET', `/api/storage/runs/${r.reportId}`)).body;
        byName.set(report.testCaseName ?? report.testCase?.name ?? report.name, report);
        expect(report.evaluationType).toBe('deterministic');
        expect(report.passFailStatus).toBe('passed');
        const matchers = (report.matcherResults ?? []).filter((mr: any) => mr.method !== 'llm-judge');
        expect(matchers.length).toBeGreaterThan(0);
        expect(matchers.every((mr: any) => mr.method === 'code-assertion' && mr.pass === true)).toBe(true);
      }

      // Stored test cases: sourceFile is spelled relative to the ROOT (not
      // `../eval-repo/...` from the server cwd) and describePath is persisted.
      const tcs: any[] = [];
      for (const snap of evaluationRun.testCaseSnapshots ?? []) {
        const tc = (await http(BASE_A, 'GET', `/api/storage/test-cases/${snap.id}`)).body;
        tcs.push(tc.testCase ?? tc);
      }
      expect(tcs).toHaveLength(2);
      const grouped = tcs.find(tc => tc.name === 'grouped-deterministic-pass');
      const top = tcs.find(tc => tc.name === 'top-level-deterministic-pass');
      expect(grouped.sourceFile).toBe(EVAL_FILE_REL);
      expect(top.sourceFile).toBe(EVAL_FILE_REL);
      expect(grouped.describePath).toEqual(['Demo Suite']);
      expect(top.describePath).toEqual([]);

      // Summary projection (list endpoint) keeps describePath too.
      const list = (await http(BASE_A, 'GET', '/api/storage/test-cases?size=100')).body;
      const summary = (list.testCases ?? list.items ?? []).find((tc: any) => tc.id === grouped.id);
      expect(summary?.describePath).toEqual(['Demo Suite']);

      // Export round-trip: grouped → describePath present; top-level ([]) → omitted.
      const exported = (await http(BASE_A, 'GET', `/api/storage/benchmarks/${pairs[0].bid}/export`)).body as any[];
      expect(Array.isArray(exported)).toBe(true);
      const exportedGrouped = exported.find(e => e.name === 'grouped-deterministic-pass');
      const exportedTop = exported.find(e => e.name === 'top-level-deterministic-pass');
      if (exportedGrouped) expect(exportedGrouped.describePath).toEqual(['Demo Suite']);
      if (exportedTop) expect('describePath' in exportedTop).toBe(false);
      expect(exportedGrouped || exportedTop).toBeTruthy();

      // And the STORED-case path (the UI "run again" route): the same
      // relative sourceFile re-materializes on server A because the roots
      // contain it — the run completes with deterministic verdicts again.
      const rerun = await http(BASE_A, 'POST', '/api/storage/evaluation-runs', {
        name: 'eval-roots rerun (code-import, relative path, other cwd)',
        sources: [{ type: 'code-import', filenames: [EVAL_FILE_REL], testCaseIds: [] }],
        agentKey: 'demo',
        trigger: 'ui',
      });
      const events = parseSse(rerun.text);
      expect(events.find(e => e.event === 'error')).toBeUndefined();
      const completed = events.find(e => e.event === 'completed')?.data;
      expect(completed?.status).toBe('completed');
      // Same stored ids reused (upsert by (name, sourceFile)) — no duplicates.
      const started = events.find(e => e.event === 'started')?.data;
      expect((started?.testCases ?? []).map((t: any) => t.id).sort()).toEqual(tcs.map(tc => tc.id).sort());
    },
    TEST_TIMEOUT,
  );

  it(
    'server B (no roots configured): the same relative import fails naming the roots tried — no silent fall-through',
    async () => {
      const res = await http(BASE_B, 'POST', '/api/storage/evaluation-runs', {
        name: 'eval-roots should fail',
        sources: [{ type: 'code-import', filenames: [EVAL_FILE_REL], testCaseIds: [] }],
        agentKey: 'demo',
        trigger: 'ui',
      });
      const events = parseSse(res.text);
      expect(events.find(e => e.event === 'started')).toBeUndefined();
      const error = events.find(e => e.event === 'error')?.data?.error as string;
      expect(error).toContain(`Code file not found: ${EVAL_FILE_REL}`);
      expect(error).toContain(`looked under eval roots ${JSON.stringify(serverCwd)}`);
    },
    TEST_TIMEOUT,
  );

  it(
    'CLI `benchmark -n <stored benchmark>` prints a one-line hint naming the server\'s eval roots when a stored sourceFile is under none of them',
    async () => {
      const tc = await http(BASE_B, 'POST', '/api/storage/test-cases', {
        name: 'stored-elsewhere',
        description: 'integration fixture',
        labels: [],
        initialPrompt: 'Do the thing',
        context: [],
        expectedOutcomes: ['ok'],
        sourceFile: EVAL_FILE_REL,
        sourceHash: 'fixture',
      });
      expect(tc.status).toBe(201);
      const bm = await http(BASE_B, 'POST', '/api/storage/benchmarks', {
        name: `eval-roots-hint-${Date.now()}`,
        description: 'integration fixture',
        testCaseIds: [tc.body.id],
      });
      expect(bm.status).toBe(201);

      const cli = spawnSync(
        'node',
        [CLI_BUNDLE, 'benchmark', '-n', bm.body.name, '-a', 'demo', '--judge-model', 'demo-model'],
        {
          cwd: evalRepo,
          encoding: 'utf-8',
          timeout: 90_000,
          env: cleanEnv({ AH_PORT: String(PORT_B), AGENT_HEALTH_PORT: String(PORT_B), AH_REUSE_FOREIGN_SERVER: '1' }),
        },
      );
      const out = `${cli.stdout}\n${cli.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
      expect(cli.status).not.toBeNull();
      const hint = out.split('\n').find(l => l.includes('Hint:'));
      if (!hint) throw new Error(`no hint in CLI output:\n${out}`);
      expect(hint).toContain(`1 stored test case reference "${EVAL_FILE_REL}"`);
      expect(hint).toContain(JSON.stringify(serverCwd));
      expect(hint).toContain('AGENT_HEALTH_EVAL_ROOTS');

      // Same hint on the unified (`-t <id>`, evaluation-runs API) path.
      const cliUnified = spawnSync(
        'node',
        [CLI_BUNDLE, 'benchmark', '-t', tc.body.id, '-a', 'demo', '--judge-model', 'demo-model'],
        {
          cwd: evalRepo,
          encoding: 'utf-8',
          timeout: 90_000,
          env: cleanEnv({ AH_PORT: String(PORT_B), AGENT_HEALTH_PORT: String(PORT_B), AH_REUSE_FOREIGN_SERVER: '1' }),
        },
      );
      const outUnified = `${cliUnified.stdout}\n${cliUnified.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
      const hintUnified = outUnified.split('\n').find(l => l.includes('Hint:'));
      if (!hintUnified) throw new Error(`no hint in unified CLI output:\n${outUnified}`);
      expect(hintUnified).toContain(`"${EVAL_FILE_REL}"`);
    },
    TEST_TIMEOUT,
  );
});
