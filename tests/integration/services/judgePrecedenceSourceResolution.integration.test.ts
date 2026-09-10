/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: run-level judge selection wins over eval-body pins, and an
 * unresolvable code `sourceFile` fails the run before it starts.
 *
 * Two failure modes this suite pins (both reported from real internal suites):
 *
 *  (1) PRECEDENCE — a test body's `judge(result, claim, { evaluatorId, model })`
 *      used to WIN over the run-level `bindJudge({ evaluatorId: run.evaluatorId,
 *      model: run.judgeModelId })`, while the runners stamped `run.evaluatorId`
 *      / `run.judgeModelId` onto the report regardless. Verdict from one
 *      judge, label from another.
 *  (2) SILENT cwd-DEPENDENT DISPATCH — a stored test case whose `sourceFile`
 *      could not be loaded from the server's cwd silently ran the classic
 *      eager-judge path; the same stored test cases were judged differently
 *      depending only on where the server was started.
 *
 * This suite boots its OWN headless server (real `createApp`, FILE storage)
 * from a temp cwd that contains the eval file, so the loader's cwd-relative
 * resolution is the real thing — not a mock. Judge = the `demo-model` mock
 * provider (no Bedrock); agent = `demo` (mock connector). We assert labels
 * and precedence, never verdict content.
 *
 * Ports: AH_PORT is inherited when set to a 474x port for this worker;
 * otherwise 4742. Only the server THIS suite spawns is ever killed (by pid).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { tmpdir } from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const SERVER_APP = path.join(REPO_ROOT, 'server', 'dist', 'app.js');
const PORT = Number(process.env.AH_JUDGE_PRECEDENCE_TEST_PORT || 4742);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_TIMEOUT = 120_000;

// Plain Node http (agent:false) — Jest 30 + undici has a known localhost race
// ('other side closed') on a worker's first fetch. Same dodge as the other
// CLI integration suites.
function http<T = any>(
  method: 'GET' | 'POST' | 'DELETE',
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE_URL);
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
          try { parsed = text ? JSON.parse(text) : {}; } catch { /* SSE or non-JSON */ }
          resolve({ status: res.statusCode || 0, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Parse an `event: X\ndata: {...}` SSE transcript into [{event, data}]. */
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

async function waitForHealth(timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await http('GET', '/health');
      if (r.status === 200) return;
      lastErr = `status ${r.status}`;
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`server on ${BASE_URL} did not become healthy in ${timeoutMs}ms (${lastErr})`);
}

// The eval body PINS a different evaluator + model than the run will select.
// `require('@opensearch-project/agent-health')` is intercepted by the loader,
// so this CJS fixture loads from any cwd without a node_modules.
const EVAL_FILE_REL = 'evals/precedence.eval.js';
const EVAL_FILE_CONTENT = `
const { test } = require('@opensearch-project/agent-health');

test('body-pins-a-different-judge', {
  prompt: 'Summarise the incident',
  labels: ['category:Smoke'],
  timeout: 30000,
}, async ({ agent, judge }) => {
  const result = await agent.run();
  // The AUTHOR hard-coded evaluator + model here. The run-level selection
  // (evaluatorId=system-rca-default, judgeModelId=demo-model) must win and the
  // disagreement must be recorded — not silently applied.
  await judge(result, 'mentions the affected service', {
    evaluatorId: 'system-factuality',
    model: 'some-other-model',
  });
});
`;

describe('judge precedence + source resolution (own headless server, FILE storage)', () => {
  let child: ChildProcess | undefined;
  let cwdDir: string;
  const created = { testCaseIds: new Set<string>(), benchmarkIds: new Set<string>(), evalRunIds: new Set<string>(), reportIds: new Set<string>() };

  beforeAll(async () => {
    if (!existsSync(SERVER_APP)) {
      const b = spawnSync('npm', ['run', 'build:server'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:server failed: ${b.stderr}`);
    }
    if (!existsSync(CLI_BUNDLE)) {
      const b = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:cli failed: ${b.stderr}`);
    }

    cwdDir = mkdtempSync(path.join(tmpdir(), 'ah-judge-precedence-'));
    mkdirSync(path.join(cwdDir, 'evals'), { recursive: true });
    writeFileSync(path.join(cwdDir, EVAL_FILE_REL), EVAL_FILE_CONTENT, 'utf-8');

    // Clean env: no OPENSEARCH_* (force FILE storage under <cwd>/.agent-health),
    // no AWS, recovery sweeps disabled (never touch another server's runs).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k === 'NODE_OPTIONS') env[k] = v;
    }
    Object.assign(env, {
      AH_PORT: String(PORT),
      HOST: '127.0.0.1',
      AH_HEADLESS: '1',
      AGENT_HEALTH_STORAGE: 'file',
      BENCHMARK_RUN_RECOVERY_DISABLED: '1',
      EVALUATION_RUN_RECOVERY_DISABLED: '1',
      AH_SUPPRESS_EXPERIMENTAL: '1',
      NODE_ENV: 'test',
    });

    // `serve --headless` → createApp() only (no observio sample agent, no
    // browser). cwd = the temp dir that holds the eval file. The esbuild CLI
    // BUNDLE is used (not bin/cli.js → tsx) because tsx resolves `@/` path
    // aliases from the cwd's tsconfig — and the whole point is a cwd that
    // is NOT the repo.
    child = spawn('node', [CLI_BUNDLE, 'serve', '-p', String(PORT), '--headless', '--no-browser'], {
      cwd: cwdDir,
      env,
      stdio: 'ignore',
    });
    await waitForHealth(TEST_TIMEOUT - 30_000);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Best-effort by-id cleanup on OUR server (file storage under the temp
    // dir, which is deleted below anyway).
    for (const id of created.reportIds) await http('DELETE', `/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    for (const id of created.evalRunIds) await http('DELETE', `/api/storage/evaluation-runs/${encodeURIComponent(id)}`).catch(() => {});
    for (const id of created.benchmarkIds) await http('DELETE', `/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
    for (const id of created.testCaseIds) await http('DELETE', `/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    // Only the process THIS suite started, by its captured pid.
    if (child?.pid) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      await new Promise(r => setTimeout(r, 500));
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
    if (cwdDir) rmSync(cwdDir, { recursive: true, force: true });
  });

  /** Run a POST /api/storage/evaluation-runs and return the SSE events. */
  async function runEvaluation(body: Record<string, unknown>) {
    const res = await http('POST', '/api/storage/evaluation-runs', body);
    const events = parseSse(res.text);
    const started = events.find(e => e.event === 'started')?.data;
    if (started?.runId) created.evalRunIds.add(started.runId);
    for (const tc of started?.testCases ?? []) created.testCaseIds.add(tc.id);
    const completed = events.find(e => e.event === 'completed')?.data;
    for (const r of Object.values(completed?.results ?? {}) as any[]) if (r?.reportId) created.reportIds.add(r.reportId);
    return { status: res.status, events, started, completed, error: events.find(e => e.event === 'error')?.data };
  }

  it(
    'KEY: run-level evaluator + judge model WIN over the body\'s pins; report is labelled with what applied and lists both conflicts',
    async () => {
      const bm = await http('POST', '/api/storage/benchmarks', {
        name: `judge-precedence-${Date.now()}`,
        description: 'integration fixture',
        testCaseIds: [],
      });
      expect(bm.status).toBe(201);
      created.benchmarkIds.add(bm.body.id);

      // Import + run via code-import: the server resolves `evals/precedence.eval.js`
      // against ITS cwd (the temp dir) — that's the real cwd-relative path.
      const r1 = await runEvaluation({
        name: 'precedence run (code-import)',
        sources: [{ type: 'code-import', filenames: [EVAL_FILE_REL], testCaseIds: [] }],
        agentKey: 'demo',
        evaluatorId: 'system-rca-default',
        judgeModelId: 'demo-model',
        benchmarkId: bm.body.id,
        trigger: 'cli',
      });
      expect(r1.error).toBeUndefined();
      expect(r1.completed?.status).toBe('completed');
      const results = Object.values(r1.completed.results) as any[];
      expect(results).toHaveLength(1);

      const report = (await http('GET', `/api/storage/runs/${results[0].reportId}`)).body;
      expect(report.evaluationType).toBe('deterministic');
      // The body's judge() ran (one llm-judge matcher) …
      const llm = (report.matcherResults ?? []).filter((m: any) => m.method === 'llm-judge');
      expect(llm).toHaveLength(1);
      // … with the RUN's selection on the wire (per-call truth), not the body's pins.
      expect(llm[0].evaluatorId).toBe('system-rca-default');
      expect(llm[0].model).toBe('demo-model');
      // Report-level: applied == run selection, both conflicts recorded.
      expect(report.judgeApplied).toEqual({
        evaluatorId: 'system-rca-default',
        evaluatorIdSource: 'run',
        modelId: 'demo-model',
        modelIdSource: 'run',
      });
      expect(report.judgeSelectionConflicts).toEqual(
        expect.arrayContaining([
          { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-factuality' },
          { field: 'modelId', runValue: 'demo-model', bodyValue: 'some-other-model' },
        ]),
      );
      expect(report.judgeSelectionConflicts).toHaveLength(2);
      // Labels match what applied.
      expect(report.evaluatorId).toBe('system-rca-default');
      expect(report.judgeModelId).toBe('demo-model');
      // The mock judge returned a real verdict (not errored) — the pinned
      // evaluator id was NOT what was resolved, or /api/judge would have
      // scored with system-factuality's 80% threshold semantics; either way
      // the run must not be bucketed as errored.
      expect(report.metricsStatus).not.toBe('error');

      // SAME stored test case, launched again via the STORED benchmark source
      // (the UI path). It must dispatch identically — body re-materialized,
      // run selection applied — instead of silently falling back to the
      // classic eager-judge path.
      const r2 = await runEvaluation({
        name: 'precedence run (stored benchmark source)',
        sources: [{ type: 'benchmark', benchmarkId: bm.body.id }],
        agentKey: 'demo',
        evaluatorId: 'system-rca-default',
        judgeModelId: 'demo-model',
        benchmarkId: bm.body.id,
        trigger: 'ui',
      });
      expect(r2.error).toBeUndefined();
      expect(r2.completed?.status).toBe('completed');
      const results2 = Object.values(r2.completed.results) as any[];
      expect(results2).toHaveLength(1);
      const report2 = (await http('GET', `/api/storage/runs/${results2[0].reportId}`)).body;
      expect(report2.evaluationType).toBe('deterministic');
      expect(report2.judgeApplied?.evaluatorId).toBe('system-rca-default');
      expect(report2.judgeSelectionConflicts).toHaveLength(2);
      expect(report2.evaluatorId).toBe('system-rca-default');
      expect(report2.judgeModelId).toBe('demo-model');
    },
    TEST_TIMEOUT,
  );

  it(
    'when the run selects NO judge model, the body pin applies for that field (source=body), label follows, no conflict',
    async () => {
      const r = await runEvaluation({
        name: 'precedence run (no run-level model)',
        sources: [{ type: 'code-import', filenames: [EVAL_FILE_REL], testCaseIds: [] }],
        agentKey: 'demo',
        evaluatorId: 'system-rca-default',
        // judgeModelId intentionally omitted → body's `model: 'some-other-model'` applies
        trigger: 'cli',
      });
      expect(r.error).toBeUndefined();
      const results = Object.values(r.completed.results) as any[];
      const report = (await http('GET', `/api/storage/runs/${results[0].reportId}`)).body;
      expect(report.judgeApplied).toEqual({
        evaluatorId: 'system-rca-default',
        evaluatorIdSource: 'run',
        modelId: 'some-other-model',
        modelIdSource: 'body',
      });
      expect(report.judgeSelectionConflicts).toEqual([
        { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-factuality' },
      ]);
      expect(report.judgeModelId).toBe('some-other-model');
    },
    TEST_TIMEOUT,
  );

  it(
    'a stored test case whose sourceFile does NOT exist relative to the server cwd → SSE `error` naming file + cwd, and NO run doc is created',
    async () => {
      const tc = await http('POST', '/api/storage/test-cases', {
        name: 'orphaned-code-case',
        description: 'integration fixture',
        labels: [],
        initialPrompt: 'Do the thing',
        context: [],
        expectedOutcomes: ['ok'],
        sourceFile: 'tmp-evals/x.eval.mjs',
        sourceHash: 'fixture',
      });
      expect(tc.status).toBe(201);
      created.testCaseIds.add(tc.body.id);
      const bm = await http('POST', '/api/storage/benchmarks', {
        name: `unresolvable-source-${Date.now()}`,
        description: 'integration fixture',
        testCaseIds: [tc.body.id],
      });
      expect(bm.status).toBe(201);
      created.benchmarkIds.add(bm.body.id);

      const r = await runEvaluation({
        name: 'should not start',
        sources: [{ type: 'benchmark', benchmarkId: bm.body.id }],
        agentKey: 'demo',
        evaluatorId: 'system-rca-default',
        judgeModelId: 'demo-model',
        benchmarkId: bm.body.id,
        trigger: 'ui',
      });
      expect(r.started).toBeUndefined();
      expect(r.completed).toBeUndefined();
      expect(r.error?.error).toContain(
        `Test case "orphaned-code-case" references source file "tmp-evals/x.eval.mjs" which is not resolvable from cwd ${cwdDir}`,
      );
      expect(r.error?.error).toMatch(/start the server from the eval project root or re-import the test cases/i);

      // Pre-start path: nothing was persisted as `running` (or at all).
      const runs = await http('GET', `/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(bm.body.id)}&size=100`);
      expect((runs.body.evaluationRuns ?? []).length).toBe(0);

      // (The legacy `POST /benchmarks/:id/execute` route requires OpenSearch
      // storage and 400s on this FILE-storage server before reaching source
      // resolution; its pre-SSE 409 is pinned at the route level in
      // tests/unit/server/routes/storage/benchmarks.test.ts.)

      // The CLI `benchmark -t <id>` command (unified evaluation-runs path)
      // surfaces the same message and exits NON-ZERO.
      const cli = spawnSync(
        'node',
        [CLI_BUNDLE, 'benchmark', '-t', tc.body.id, '-a', 'demo', '--judge-model', 'demo-model'],
        {
          cwd: cwdDir,
          encoding: 'utf-8',
          timeout: 60_000,
          env: {
            PATH: process.env.PATH || '',
            HOME: process.env.HOME || '',
            AGENT_HEALTH_PORT: String(PORT),
            AH_PORT: String(PORT),
            AGENT_HEALTH_SUPPRESS_EXPERIMENTAL: '1',
          },
        },
      );
      const out = `${cli.stdout}\n${cli.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
      expect(cli.status).not.toBeNull();
      expect(cli.status).not.toBe(0);
      expect(out).toContain('which is not resolvable from cwd');
    },
    TEST_TIMEOUT,
  );

  it(
    'a stored test case whose sourceFile loads but defines no test of that name is ALSO a pre-start error',
    async () => {
      const tc = await http('POST', '/api/storage/test-cases', {
        name: 'renamed-away-case',
        description: 'integration fixture',
        labels: [],
        initialPrompt: 'Do the thing',
        context: [],
        sourceFile: EVAL_FILE_REL,
        sourceHash: 'fixture',
      });
      expect(tc.status).toBe(201);
      created.testCaseIds.add(tc.body.id);
      const r = await runEvaluation({
        name: 'should not start (name mismatch)',
        sources: [{ type: 'test-case-ids', ids: [tc.body.id] }],
        agentKey: 'demo',
        trigger: 'ui',
      });
      expect(r.started).toBeUndefined();
      expect(r.error?.error).toContain(`defines no test named "renamed-away-case"`);
    },
    TEST_TIMEOUT,
  );
});
