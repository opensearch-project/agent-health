/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge-identity INTEGRATION MATRIX — entry paths × judge paths, against a
 * REAL running backend (whatever `AH_PORT` points at; file or OpenSearch
 * storage), asserting what actually lands on the persisted documents.
 *
 * Why a matrix: the first fix for "which LLM judged this report" wired only
 * the classic `llmJudgeResponse` path. A code-SDK run (the CLI `benchmark -f
 * x.eval.js` path) kept persisting reports whose only judge record was
 * `matcherResults[].model = '<provider pseudo-id>'` — no `judgeModel`, no kind
 * — and no test noticed because every entry path was tested with one judge
 * path. Owner ask: "make sure this kind of miss doesn't happen again".
 *
 *   Entry paths (the customer-facing ways a run starts):
 *     E1  POST /api/storage/evaluation-runs, `{type:'benchmark'}` source
 *         — the path the UI New Run page and CLI `benchmark -b/-n` share
 *     E2  POST /api/storage/evaluation-runs, `{type:'code-import'}` source
 *         + benchmarkId — exactly what CLI `benchmark -f x.eval.js` sends
 *     E3  POST /api/evaluate — quick-run / "Run Test" path
 *     E4  the CLI binary itself: `benchmark -f <cases> -a demo -n <name>`
 *         (JSON cases AND an .eval.js), then the run's reports read back
 *         over the API
 *
 *   Judge paths:
 *     J1  classic JSON test case, auto-judged by the mock ("demo") judge
 *         provider — no LLM credentials needed, same identity contract
 *     J2  code-SDK body that calls `judge()` (one llm-judge matcher)
 *     J3  code-SDK body with code assertions only (no LLM judge call)
 *
 *   Per-report contract (lib/judgeIdentity.ts):
 *     - whenever an LLM judge ran (classic `llmJudgeResponse` present OR any
 *       `method:'llm-judge'` matcher), `report.judgeModel` is set and is
 *       never a judge-provider pseudo-id, and `report.judgeProvider` names
 *       the kind;
 *     - the run-level `judgeModel` is set from the first such report;
 *     - a J3 report carries the explicit no-LLM-judge marker
 *       (`judgeProvider: 'none'`, `judgeModel` unset).
 *
 * Every entity is created with `uniqueTestName()` and deleted by id via the
 * shared tracker (see AGENTS.md "Integration Test Cleanup"). Self-skips when
 * no backend is reachable.
 */

import { spawnSync } from 'child_process';
import { withCliCoverage } from '../../helpers/cliCoverage';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';
import { isJudgeProviderPseudoModelId, JUDGE_PROVIDER_NONE } from '@/lib/judgeIdentity';

const TEST_TIMEOUT = 120_000;
const BASE_URL = getTestBackendUrl();
const REPO_ROOT = process.cwd();
const CLI_BUNDLE = join(REPO_ROOT, 'cli/dist/index.js');
/** Mock judge provider — resolves to `judgeProvider: 'demo'`, `judgeModel: 'mock://demo-model'`. */
const DEMO_JUDGE = 'demo-model';

// ─── helpers ────────────────────────────────────────────────────────────────

async function jsonFetch<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  // Retry once on a transport error: after a CLI subprocess has hammered
  // the same loopback, undici's pooled socket can come back half-closed
  // ("other side closed") on the next request. See the sibling CLI suite.
  let r: Response;
  try {
    r = await fetch(`${BASE_URL}${path}`, init);
  } catch (err) {
    if (init?.method && init.method !== 'GET') throw err;
    await new Promise(res => setTimeout(res, 250));
    r = await fetch(`${BASE_URL}${path}`, init);
  }
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: r.status, body };
}

const post = (path: string, data: unknown) =>
  jsonFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** `'file' | 'opensearch' | null` (null = backend unreachable / storage not ok). */
async function backendStorage(): Promise<'file' | 'opensearch' | null> {
  try {
    const h = await jsonFetch('/health');
    if (h.status !== 200) return null;
    const s = await jsonFetch('/api/storage/health');
    if (s.body?.status !== 'ok') return null;
    return s.body?.backend === 'file' ? 'file' : 'opensearch';
  } catch {
    return null;
  }
}

/** Drain an SSE response into typed events (both `data:{type}` and `event:` shapes). */
async function consumeSSE(response: Response): Promise<any[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = '';
  const events: any[] = [];
  const flush = (block: string) => {
    let eventName: string | undefined;
    let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine) return;
    let parsed: any;
    try { parsed = JSON.parse(dataLine); } catch { return; }
    if (eventName && (!parsed || typeof parsed !== 'object' || !('type' in parsed))) {
      parsed = { type: eventName, ...(typeof parsed === 'object' ? parsed : { value: parsed }) };
    }
    events.push(parsed);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const p of parts) flush(p);
  }
  if (buffer.trim()) flush(buffer);
  return events;
}

/** Poll an evaluation run until terminal (the SSE stream may end first). */
async function waitForRun(runId: string): Promise<any> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { status, body } = await jsonFetch(`/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
    const run = body?.evaluationRun ?? body;
    if (status === 200 && run && ['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish: ${JSON.stringify(run).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 500));
  }
}

function classicCase(name: string) {
  return {
    name,
    category: 'Test',
    difficulty: 'Easy',
    initialPrompt: 'Summarize the incident and name the failing component.',
    expectedOutcomes: ['names the failing component', 'proposes a remediation'],
  };
}

/** A synthetic .eval.js: one body that calls judge() (J2), one that only asserts (J3). */
const SDK_FIXTURE = (judgedName: string, deterministicName: string) => `
const { test, expect } = require('@opensearch-project/agent-health');

test(${JSON.stringify(judgedName)}, { prompt: 'Summarize the incident.' }, async ({ agent, judge }) => {
  const result = await agent.run('Summarize the incident.');
  await judge(result, ['names the failing component', 'proposes a remediation']);
});

test(${JSON.stringify(deterministicName)}, { prompt: 'Summarize the incident.' }, async ({ agent }) => {
  const result = await agent.run('Summarize the incident.');
  expect(result.trajectory.length).to.be.greaterThan(0);
});
`;

// ─── the contract, applied to every persisted report ───────────────────────

function llmJudgeRan(report: any): boolean {
  if (report.llmJudgeResponse) return true;
  return (report.matcherResults ?? []).some((m: any) => m.method === 'llm-judge' && !m.notReached && !m.skipped && !m.errored);
}

function expectJudgedReport(report: any, judgeModelId: string) {
  expect(llmJudgeRan(report)).toBe(true);
  expect(report.judgeModelId).toBe(judgeModelId);
  expect(typeof report.judgeModel).toBe('string');
  expect(report.judgeModel.length).toBeGreaterThan(0);
  expect(isJudgeProviderPseudoModelId(report.judgeModel)).toBe(false);
  expect(typeof report.judgeProvider).toBe('string');
  expect(report.judgeProvider).not.toBe(JUDGE_PROVIDER_NONE);
  // the mock judge reports itself honestly
  expect(report.judgeProvider).toBe('demo');
  expect(report.judgeModel).toBe('mock://demo-model');
  for (const m of (report.matcherResults ?? []).filter((x: any) => x.method === 'llm-judge' && !x.errored && !x.skipped && !x.notReached)) {
    // SDK judge rows carry the resolved LLM next to the requested id
    if (m.judgeModel !== undefined) expect(isJudgeProviderPseudoModelId(m.judgeModel)).toBe(false);
  }
}

function expectNoLlmJudgeReport(report: any, judgeModelId: string) {
  expect(llmJudgeRan(report)).toBe(false);
  expect(report.judgeModelId).toBe(judgeModelId);
  expect(report.judgeModel).toBeUndefined();
  expect(report.judgeProvider).toBe(JUDGE_PROVIDER_NONE);
}

async function reportsOfRun(run: any, tracker: ReturnType<typeof createTestDataTracker>): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const [testCaseId, result] of Object.entries<any>(run.results ?? {})) {
    if (!result?.reportId) continue;
    tracker.run(result.reportId);
    const { status, body } = await jsonFetch(`/api/storage/runs/${encodeURIComponent(result.reportId)}`);
    expect(status).toBe(200);
    out[testCaseId] = body;
  }
  return out;
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('judge identity matrix — every entry path × every judge path (integration)', () => {
  let ready = false;
  let storageBackend: 'file' | 'opensearch' | null = null;
  let tempDir = '';
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    storageBackend = await backendStorage();
    ready = storageBackend !== null;
    if (!ready) {
      // eslint-disable-next-line no-console
      console.warn(`[judge-matrix] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
      return;
    }
    tempDir = mkdtempSync(join(tmpdir(), 'judge-identity-matrix-'));
  });

  afterAll(async () => {
    await tracker.cleanup();
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  // E1 × J1
  it('E1 evaluation-runs {type:benchmark} × J1 classic case → report.judgeModel + judgeProvider, run.judgeModel', async () => {
    if (!ready) return;
    const tc = await post('/api/storage/test-cases', classicCase(uniqueTestName('judge-matrix-e1-classic')));
    expect(tc.status).toBeLessThan(400);
    tracker.testCase(tc.body.id);
    const bm = await post('/api/storage/benchmarks', {
      name: uniqueTestName('judge-matrix-e1-bm'), description: 'judge identity matrix', testCaseIds: [tc.body.id], runs: [],
    });
    expect(bm.status).toBeLessThan(400);
    tracker.benchmark(bm.body.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('judge-matrix-e1-run'),
        sources: [{ type: 'benchmark', benchmarkId: bm.body.id }],
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: DEMO_JUDGE, trigger: 'api',
      }),
    });
    expect(res.status).toBe(200);
    const events = await consumeSSE(res);
    const runId: string = events.find(e => e.type === 'started')?.runId;
    expect(runId).toBeTruthy();
    tracker.evaluationRun(runId);

    const run = await waitForRun(runId);
    expect(run.status).toBe('completed');
    const reports = await reportsOfRun(run, tracker);
    expect(Object.keys(reports)).toHaveLength(1);
    expectJudgedReport(reports[tc.body.id], DEMO_JUDGE);
    expect(reports[tc.body.id].llmJudgeResponse?.modelId).toBe('mock://demo-model');
    // run-level rollup
    expect(run.judgeModelId).toBe(DEMO_JUDGE);
    expect(run.judgeModel).toBe('mock://demo-model');
    expect(run.judgeProvider).toBe('demo');
  }, TEST_TIMEOUT);

  // E2 × (J2 + J3)
  it('E2 evaluation-runs {type:code-import} (what CLI -f x.eval.js sends) × J2 judge() + J3 assertions-only', async () => {
    if (!ready) return;
    const judgedName = uniqueTestName('judge-matrix-e2-judged');
    const detName = uniqueTestName('judge-matrix-e2-deterministic');
    const fixture = join(tempDir, 'e2.eval.js');
    writeFileSync(fixture, SDK_FIXTURE(judgedName, detName), 'utf-8');
    const bm = await post('/api/storage/benchmarks', {
      name: uniqueTestName('judge-matrix-e2-bm'), description: 'judge identity matrix', testCaseIds: [], runs: [],
    });
    expect(bm.status).toBeLessThan(400);
    tracker.benchmark(bm.body.id);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('judge-matrix-e2-run'),
        sources: [{ type: 'code-import', filenames: [fixture] }],
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: DEMO_JUDGE, benchmarkId: bm.body.id, trigger: 'cli',
      }),
    });
    expect(res.status).toBe(200);
    const events = await consumeSSE(res);
    const started = events.find(e => e.type === 'started');
    const runId: string = started?.runId;
    expect(runId).toBeTruthy();
    tracker.evaluationRun(runId);
    // code-import upserts the two test cases — track them by the ids the run snapshotted
    const run = await waitForRun(runId);
    for (const snap of run.testCaseSnapshots ?? []) tracker.testCase(snap.id);
    expect(run.status).toBe('completed');

    const reports = await reportsOfRun(run, tracker);
    const byName = Object.fromEntries((run.testCaseSnapshots ?? []).map((s: any) => [s.name, reports[s.id]]));
    expect(byName[judgedName]).toBeDefined();
    expect(byName[detName]).toBeDefined();

    // J2: the SDK judge() call rolled the resolved LLM up
    const judged = byName[judgedName];
    expect(judged.evaluationType).toBe('deterministic');
    expect(judged.llmJudgeResponse).toBeUndefined();
    const judgeRows = judged.matcherResults.filter((m: any) => m.method === 'llm-judge');
    expect(judgeRows).toHaveLength(1);
    expect(judgeRows[0].model).toBe(DEMO_JUDGE);            // requested id, unchanged (BC)
    expect(judgeRows[0].judgeModel).toBe('mock://demo-model'); // resolved LLM on the matcher
    expect(judgeRows[0].judgeProvider).toBe('demo');
    expectJudgedReport(judged, DEMO_JUDGE);

    // J3: no LLM judge call → explicit marker
    expectNoLlmJudgeReport(byName[detName], DEMO_JUDGE);

    // run-level: the first REAL kind wins, never 'none' once any case judged
    expect(run.judgeModel).toBe('mock://demo-model');
    expect(run.judgeProvider).toBe('demo');
  }, TEST_TIMEOUT);

  // E3 × J1
  it('E3 POST /api/evaluate (quick-run) × J1 classic inline case → report.judgeModel + judgeProvider', async () => {
    if (!ready) return;
    const now = new Date().toISOString();
    const id = uniqueTestName('judge-matrix-e3-tc');
    const testCase = {
      id, name: id, description: 'judge identity matrix', labels: ['category:Test'], category: 'Test', difficulty: 'Easy',
      currentVersion: 1, isPromoted: false, createdAt: now, updatedAt: now,
      versions: [{ version: 1, createdAt: now, initialPrompt: 'Summarize the incident.', context: [], expectedOutcomes: ['names the failing component'] }],
      initialPrompt: 'Summarize the incident.', context: [], expectedOutcomes: ['names the failing component'],
    };
    const res = await fetch(`${BASE_URL}/api/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCase, agentKey: 'demo', modelId: 'demo-model', judgeModelId: DEMO_JUDGE, runName: uniqueTestName('judge-matrix-e3-run') }),
    });
    expect(res.status).toBe(200);
    const events = await consumeSSE(res);
    const completed = events.find(e => e.type === 'completed');
    expect(completed).toBeDefined();
    tracker.run(completed.reportId);

    const { status, body: report } = await jsonFetch(`/api/storage/runs/${encodeURIComponent(completed.reportId)}`);
    expect(status).toBe(200);
    expectJudgedReport(report, DEMO_JUDGE);
    expect(report.llmJudgeResponse?.modelId).toBe('mock://demo-model');
    expect(report.llmJudgeResponse?.judgeProvider).toBe('demo');
  }, TEST_TIMEOUT);

  // E4 × (J1) and E4 × (J2 + J3) — the CLI binary
  describe('E4 CLI `benchmark -f … -a demo -n <name> --judge-model demo-model`', () => {
    function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
      if (!existsSync(CLI_BUNDLE)) {
        const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
        if (build.status !== 0) throw new Error(`CLI build failed: ${build.stderr}`);
      }
      // Minimal env so Jest's NODE_OPTIONS / coverage shims don't leak into
      // the CLI's undici fetch (see tests/integration/cli/benchmarkCodeSdk).
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string' && (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k.startsWith('AWS_'))) env[k] = v;
      }
      env.AH_PORT = new URL(BASE_URL).port || '4001';
      env.AH_SUPPRESS_EXPERIMENTAL = '1';
      env.AH_QUIET_DEPRECATIONS = '1';
      const r = spawnSync('node', [CLI_BUNDLE, 'benchmark', ...args], { cwd: REPO_ROOT, env: withCliCoverage(env), encoding: 'utf-8', timeout: TEST_TIMEOUT - 20_000 });
      return { stdout: (r.stdout || '').replace(/\u001b\[[0-9;]*m/g, ''), stderr: r.stderr || '', status: r.status };
    }

    /** Find the benchmark the CLI created by its unique name, track everything under it, return it + its evaluation runs. */
    async function collectCliRuns(benchmarkName: string): Promise<{ benchmark: any; runs: any[] }> {
      const list = await jsonFetch('/api/storage/benchmarks?size=1000');
      const found = (list.body?.benchmarks || []).find((b: any) => b.name === benchmarkName);
      expect(found).toBeDefined();
      tracker.benchmark(found.id);
      const full = await jsonFetch(`/api/storage/benchmarks/${encodeURIComponent(found.id)}`);
      const benchmark = full.status === 200 ? full.body : found;
      tracker.testCases(benchmark.testCaseIds);
      const runs = await jsonFetch(`/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(found.id)}&size=50`);
      const out: any[] = [];
      for (const r of runs.body?.evaluationRuns || []) {
        tracker.evaluationRun(r.id);
        out.push(await waitForRun(r.id));
      }
      return { benchmark, runs: out };
    }

    it('× J1 classic JSON cases: every report and the run carry the resolved judge identity', async () => {
      if (!ready) return;
      // The CLI's JSON `-f` mode runs through the legacy per-benchmark
      // `/execute` route, which (pre-existing, unrelated to judge identity)
      // refuses to execute without OpenSearch storage. CI's integration job
      // runs OpenSearch, so this leg is exercised there; against a
      // file-storage dev server it is skipped with a note.
      if (storageBackend === 'file') {
        // eslint-disable-next-line no-console
        console.warn('[judge-matrix] E4×J1 skipped: CLI JSON `-f` uses /execute, which needs OpenSearch storage (backend is file)');
        return;
      }
      const casesFile = join(tempDir, 'e4-classic.json');
      const names = [uniqueTestName('judge-matrix-e4-classic-a'), uniqueTestName('judge-matrix-e4-classic-b')];
      writeFileSync(casesFile, JSON.stringify(names.map(classicCase)), 'utf-8');
      const benchmarkName = uniqueTestName('judge-matrix-e4-classic-bm');

      const cli = runCli(['-f', casesFile, '-a', 'demo', '-n', benchmarkName, '--judge-model', DEMO_JUDGE]);
      const { benchmark, runs } = await collectCliRuns(benchmarkName);
      expect(cli.status).toBe(0);
      // CLI output contract unchanged: the summary table names the agent with 2 passed.
      expect(cli.stdout).toMatch(/Benchmark Summary/);
      // The legacy JSON path persists the run INSIDE benchmark.runs[] (not as
      // an evaluation-run doc); read the reports through that run.
      const legacyRuns: any[] = benchmark.runs ?? [];
      const allRuns = [...runs, ...legacyRuns];
      expect(allRuns.length).toBeGreaterThanOrEqual(1);
      const run = allRuns.find(r => Object.keys(r.results ?? {}).length === 2) ?? allRuns[0];
      for (const lr of legacyRuns) tracker.benchmarkRun(benchmark.id, lr.id);
      expect(run.status).toBe('completed');
      const reports = await reportsOfRun(run, tracker);
      expect(Object.keys(reports)).toHaveLength(2);
      for (const report of Object.values(reports)) expectJudgedReport(report, DEMO_JUDGE);
      expect(run.judgeModel).toBe('mock://demo-model');
    }, TEST_TIMEOUT);

    it('× J2 judge() + J3 assertions-only (.eval.js): SDK reports carry the identity / the no-LLM-judge marker', async () => {
      if (!ready) return;
      const judgedName = uniqueTestName('judge-matrix-e4-sdk-judged');
      const detName = uniqueTestName('judge-matrix-e4-sdk-deterministic');
      const fixture = join(tempDir, 'e4.eval.js');
      writeFileSync(fixture, SDK_FIXTURE(judgedName, detName), 'utf-8');
      const benchmarkName = uniqueTestName('judge-matrix-e4-sdk-bm');

      const cli = runCli(['-f', fixture, '-a', 'demo', '-n', benchmarkName, '--judge-model', DEMO_JUDGE]);
      const { runs } = await collectCliRuns(benchmarkName);
      expect(cli.status).toBe(0);
      expect(runs).toHaveLength(1);
      const [run] = runs;
      expect(run.status).toBe('completed');
      const reports = await reportsOfRun(run, tracker);
      const byName = Object.fromEntries((run.testCaseSnapshots ?? []).map((s: any) => [s.name, reports[s.id]]));
      expectJudgedReport(byName[judgedName], DEMO_JUDGE);
      expect(byName[judgedName].matcherResults.find((m: any) => m.method === 'llm-judge').judgeModel).toBe('mock://demo-model');
      expectNoLlmJudgeReport(byName[detName], DEMO_JUDGE);
      expect(run.judgeModel).toBe('mock://demo-model');
      expect(run.judgeProvider).toBe('demo');
      // CLI output contract unchanged: the results block is what it always was
      expect(cli.stdout).toMatch(/Passed: 2/);
      expect(cli.stdout).toMatch(/Total: 2/);
    }, TEST_TIMEOUT);
  });
});
