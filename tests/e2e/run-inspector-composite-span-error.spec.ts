/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run inspector telemetry strip on a COMPOSITE observability backend when the
 * agent's trace contains an errored span — end to end, nothing mocked in the
 * browser.
 *
 * Pre-fix the header read "TOKENS — · COST — · LLM CALLS — (Metrics
 * unavailable) · spans: — cases" for any run whose trace had ONE span with
 * OTel status ERROR (a failing tool call): the composite backend took the
 * holding source's `status: 'error'` for a failed store query. The per-case
 * view showed the same run's tokens, which is how the owner noticed.
 *
 * This spec boots ITS OWN agent-health server (file storage in a temp dir —
 * nothing touches the shared backend) configured with two OpenSearch
 * observability sources, both served by tiny in-process fake OpenSearch HTTP
 * servers:
 *   - primary          holds the control case's trace (no errored span);
 *   - "Team B cluster" holds the 59-span trace whose 2nd tool call failed
 *                      (+ its 4xx HTTP child) — the real-shaped case;
 *   - a third case has no trace anywhere (missing trace — also real).
 * Requires `server/dist/index.js` + `dist/index.html` (built before e2e in CI);
 * skips with a reason otherwise.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';
import { buildAgentTraceWithErrorSpan, AGENT_TRACE_FIXTURE, type AgentTraceSpanDoc } from '../helpers/agentTraceWithErrorSpan';

const REPO_ROOT = process.cwd();   // playwright runs from the repo root (playwright.config.ts)
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'dist', 'index.js');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.html');
/** Fixed ports for the three servers (`AH_E2E_AUX_PORT_BASE`, e.g. 5511 → 5511/5512/5513); ephemeral when unset. */
const PORT_BASE = Number(process.env.AH_E2E_AUX_PORT_BASE || 0);
/** When set, full-page screenshots of the inspector header land here (proof pack); never in CI. */
const SHOTS_DIR = process.env.AH_E2E_SHOTS_DIR || '';
async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  await page.setViewportSize({ width: 1600, height: 700 });
  await page.mouse.move(1200, 400);   // let the hover-open sidebar collapse off the header
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/** A minimal OpenSearch look-alike: `_search` answers the span docs whose run id / trace id the query names. */
function fakeOpenSearch(docs: AgentTraceSpanDoc[], port: number): Promise<{ server: http.Server; port: number; searches: number }> {
  const state = { server: null as unknown as http.Server, port: 0, searches: 0 };
  state.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (/\/_search(\?|$)/.test(req.url || '')) {
        state.searches++;
        const hits = docs.filter((d) => body.includes(d.traceId) || body.includes(String(d.attributes['agent_health.run.id'])));
        res.end(JSON.stringify({ took: 1, timed_out: false, hits: { total: { value: hits.length, relation: 'eq' }, hits: hits.map((d) => ({ _index: 'otel-v1-apm-span-000001', _id: d.spanId, _source: d, sort: [d.startTime] })) } }));
        return;
      }
      if ((req.url || '').startsWith('/_cat/indices')) { res.end('[]'); return; }
      res.end(JSON.stringify({ name: 'fake', version: { number: '2.11.0', distribution: 'opensearch' } }));
    });
  });
  return new Promise((resolve, reject) => {
    state.server.once('error', reject);
    state.server.listen(port, '127.0.0.1', () => { state.port = (state.server.address() as any).port; resolve(state); });
  });
}

async function waitForHealth(url: string, child: ChildProcess, log: string[], timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}\n${log.join('')}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become healthy in ${timeoutMs} ms\n${log.join('')}`);
}

// One worker: the spec owns three servers (fixed ports when AH_E2E_AUX_PORT_BASE is set).
test.describe.configure({ mode: 'serial' });

test.describe('Run inspector telemetry — composite backend, agent trace with an errored span', () => {
  const T0 = Date.parse('2026-03-01T10:00:00Z');
  const RUN_ID = `run-span-err-${Date.now()}`;
  const KEY_ERR = `${RUN_ID}-case-failing-tool`;      // agent runId of the case whose trace has the errored span
  const KEY_OK = `${RUN_ID}-case-control`;            // control: same trace shape, no errored span
  const KEY_NONE = `${RUN_ID}-case-untraced`;         // no trace anywhere
  const TRACE_ERR = 'e'.repeat(32);
  const TRACE_OK = 'd'.repeat(32);
  // A second run in the same benchmark where EVERY case's trace has the failing tool call —
  // the owner's exact symptom: pre-fix its header read "Metrics unavailable · spans: — cases".
  const RUN_ALL_ERR = `${RUN_ID}-all-errored`;
  const KEYS_ALL_ERR = [`${RUN_ID}-all-a`, `${RUN_ID}-all-b`];
  const TRACES_ALL_ERR = ['a'.repeat(32), 'b'.repeat(32)];

  let primary: Awaited<ReturnType<typeof fakeOpenSearch>> | null = null;
  let teamB: Awaited<ReturnType<typeof fakeOpenSearch>> | null = null;
  let server: ChildProcess | null = null;
  let serverLog: string[] = [];
  let tmpDir: string | null = null;
  let baseUrl = '';
  let benchmarkId = '';
  let skipReason = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    if (!fs.existsSync(SERVER_ENTRY) || !fs.existsSync(DIST_INDEX)) {
      skipReason = `needs a built server + frontend (${SERVER_ENTRY}, ${DIST_INDEX})`;
      return;
    }
    // Two fake trace stores. The errored-span trace lives ONLY in the second source.
    primary = await fakeOpenSearch(buildAgentTraceWithErrorSpan({ runId: KEY_OK, traceId: TRACE_OK, startedAt: T0, withErrorSpan: false, tokensPerCall: { input: 10_000, output: 200 } }), PORT_BASE ? PORT_BASE + 1 : 0);
    teamB = await fakeOpenSearch([
      ...buildAgentTraceWithErrorSpan({ runId: KEY_ERR, traceId: TRACE_ERR, startedAt: T0 + 120_000 }),
      ...KEYS_ALL_ERR.flatMap((k, i) => buildAgentTraceWithErrorSpan({ runId: k, traceId: TRACES_ALL_ERR[i], startedAt: T0 + 3_600_000 + i * 120_000 })),
    ], PORT_BASE ? PORT_BASE + 2 : 0);

    // The server: file storage in a temp project dir, ui-first state.json with both sources.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-e2e-span-err-'));
    fs.mkdirSync(path.join(tmpDir, '.agent-health'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.agent-health', 'state.json'), JSON.stringify({
      observability: { type: 'opensearch', endpoint: `http://127.0.0.1:${primary.port}`, authType: 'none' },
      observabilitySources: [{ id: 'team-b', name: 'Team B cluster', type: 'opensearch', endpoint: `http://127.0.0.1:${teamB.port}`, authType: 'none' }],
    }, null, 2));
    const port = PORT_BASE || 0;
    // An ephemeral port needs the server to tell us which one it picked; the server only
    // listens on PORT, so pick a free one ourselves via a throwaway listener when unset.
    const chosen = port || await new Promise<number>((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
    baseUrl = `http://127.0.0.1:${chosen}`;
    serverLog = [];
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: tmpDir,
      env: {
        ...process.env,
        PORT: String(chosen), AH_PORT: String(chosen), AGENT_HEALTH_STORAGE: 'file',
        BENCHMARK_RUN_RECOVERY_DISABLED: '1', EVALUATION_RUN_RECOVERY_DISABLED: '1',
        TRACE_POLL_MAX_ATTEMPTS: '1', TRACE_POLL_INTERVAL_MS: '100',
        // No cluster storage / no authored config: the state.json above is authoritative.
        OPENSEARCH_STORAGE_ENDPOINT: '', OPENSEARCH_LOGS_ENDPOINT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (d) => serverLog.push(String(d)));
    server.stderr!.on('data', (d) => serverLog.push(String(d)));
    await waitForHealth(`${baseUrl}/health`, server, serverLog);

    // Seed: 3 test cases, one report each (keyed by agent runId + traceId), one benchmark run.
    const post = async (p: string, data: unknown) => {
      const r = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
      return r.json() as Promise<any>;
    };
    const cases = [
      { key: KEY_ERR, traceId: TRACE_ERR, name: 'failing tool call', verdict: 'passed', durationMs: 62_000 },
      { key: KEY_OK, traceId: TRACE_OK, name: 'control', verdict: 'passed', durationMs: 48_000 },
      { key: KEY_NONE, traceId: 'c'.repeat(32), name: 'untraced', verdict: 'failed', durationMs: 31_000 },
    ];
    const testCaseIds: string[] = [];
    const reportIds: string[] = [];
    for (const [i, c] of cases.entries()) {
      const tc = await post('/api/storage/test-cases', { name: uniqueTestName(`span-err-${c.name}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] });
      const tcId = tc.id || tc.testCase?.id;
      testCaseIds.push(tcId);
      const rep = await post('/api/storage/runs', {
        testCaseId: tcId, testCaseVersion: 1, agentKey: 'example-rest-agent', agentName: 'example-rest-agent', modelId: AGENT_TRACE_FIXTURE.model, modelName: AGENT_TRACE_FIXTURE.model,
        status: 'completed', passFailStatus: c.verdict, trajectory: [], metrics: { accuracy: c.verdict === 'passed' ? 90 : 30 },
        connectorProtocol: 'rest', timestamp: new Date(T0 + i * 120_000).toISOString(),
        runId: c.key, traceId: c.traceId, performanceMetrics: { durationMs: c.durationMs, agentDurationMs: c.durationMs - 2_000 },
        experimentRunId: RUN_ID,
      });
      reportIds.push(rep.id);
    }
    const allErrReportIds: string[] = [];
    for (const [i, key] of KEYS_ALL_ERR.entries()) {
      const rep = await post('/api/storage/runs', {
        testCaseId: testCaseIds[i], testCaseVersion: 1, agentKey: 'example-rest-agent', agentName: 'example-rest-agent', modelId: AGENT_TRACE_FIXTURE.model, modelName: AGENT_TRACE_FIXTURE.model,
        status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: { accuracy: 80 },
        connectorProtocol: 'rest', timestamp: new Date(T0 + 3_600_000 + i * 120_000).toISOString(),
        runId: key, traceId: TRACES_ALL_ERR[i], performanceMetrics: { durationMs: 55_000 + i * 1_000, agentDurationMs: 53_000 },
        experimentRunId: RUN_ALL_ERR,
      });
      allErrReportIds.push(rep.id);
    }
    const bm = await post('/api/storage/benchmarks', {
      name: uniqueTestName('span-err-benchmark'), description: 'composite + errored span e2e', testCaseIds, runs: [], currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
    });
    benchmarkId = bm.id;
    const put = await fetch(`${baseUrl}/api/storage/benchmarks/${benchmarkId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: bm.name, description: bm.description, testCaseIds,
        runs: [{
          id: RUN_ID, name: 'nightly — one tool call failed', agentKey: 'example-rest-agent', modelId: AGENT_TRACE_FIXTURE.model, judgeModelId: 'demo-judge-model',
          createdAt: new Date(T0).toISOString(), status: 'completed', benchmarkVersion: 1,
          testCaseSnapshots: testCaseIds.map((id, i) => ({ id, version: 1, name: cases[i].name })),
          results: Object.fromEntries(testCaseIds.map((id, i) => [id, { reportId: reportIds[i], status: 'completed', passFailStatus: cases[i].verdict }])),
        }, {
          id: RUN_ALL_ERR, name: 'nightly — every case hit the failing tool', agentKey: 'example-rest-agent', modelId: AGENT_TRACE_FIXTURE.model, judgeModelId: 'demo-judge-model',
          createdAt: new Date(T0 + 3_600_000).toISOString(), status: 'completed', benchmarkVersion: 1,
          testCaseSnapshots: testCaseIds.slice(0, 2).map((id, i) => ({ id, version: 1, name: cases[i].name })),
          results: Object.fromEntries(testCaseIds.slice(0, 2).map((id, i) => [id, { reportId: allErrReportIds[i], status: 'completed', passFailStatus: 'passed' }])),
        }],
      }),
    });
    if (!put.ok) throw new Error(`benchmark PUT → ${put.status} ${await put.text()}`);
  });

  test.afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => { server!.once('exit', r); setTimeout(r, 5_000); });
    }
    for (const s of [primary, teamB]) if (s) await new Promise((r) => s.server.close(() => r(null)));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });   // the whole file store went with it — nothing to clean elsewhere
  });

  test('the strip shows tokens · cost · LLM calls for the run (2/3 cases traced), not "Metrics unavailable"', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    const batchResponses: any[] = [];
    page.on('response', async (r) => { if (r.url().endsWith('/api/metrics/batch') && r.request().method() === 'POST') batchResponses.push(await r.json().catch(() => null)); });

    await page.goto(`${baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect`);
    await expect(page.getByTestId('test-case-row')).toHaveCount(3, { timeout: 30_000 });

    const strip = page.getByTestId('run-telemetry-strip');
    await expect(strip).toHaveAttribute('data-state', 'value', { timeout: 20_000 });
    // 306_000 (errored-span case, Team B) + 153_000 (control, primary); the untraced case adds nothing.
    await expect(strip.getByTestId('strip-tokens')).toHaveText(/Tokens\s*459\.0K/);
    await expect(strip.getByTestId('strip-llmcalls')).toHaveText(/LLM calls\s*30/);
    await expect(strip.getByTestId('strip-toolcalls')).toHaveText(/Tool calls\s*6/);
    await expect(strip.getByTestId('strip-cost')).toHaveText(/Cost\s*\$\d/);
    await expect(strip.getByTestId('strip-spans')).toHaveText('spans: 2/3 cases');
    await expect(strip.getByTestId('strip-tokens')).not.toHaveAttribute('title', /unavailable/i);
    await expect(strip.getByTestId('strip-retry')).toHaveCount(0);
    await shot(page, 'after-mixed-run');

    // What the browser actually received from the real route: the errored-span case came from
    // the second source with its numbers and no `error`; the failing spans are reported separately.
    expect(batchResponses.length).toBeGreaterThan(0);
    const metrics = batchResponses.flatMap((b) => b?.metrics ?? []);
    const err = metrics.find((m: any) => m.runId === KEY_ERR);
    expect(err).toMatchObject({ source: 'Team B cluster', hasSpans: true, totalTokens: 306_000, llmCalls: AGENT_TRACE_FIXTURE.llmCalls, agentErrorSpans: AGENT_TRACE_FIXTURE.errorSpans });
    expect(err.error).toBeUndefined();
    expect(metrics.find((m: any) => m.runId === KEY_OK)).toMatchObject({ source: 'primary', hasSpans: true, totalTokens: 153_000 });
    expect(metrics.find((m: any) => m.runId === KEY_NONE)).toMatchObject({ hasSpans: false });
    expect(teamB!.searches).toBeGreaterThan(0);
  });

  test('a run where EVERY case\'s trace has the failing tool call still shows its tokens — not "Metrics unavailable · spans: — cases"', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await page.goto(`${baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ALL_ERR}/inspect`);
    await expect(page.getByTestId('test-case-row')).toHaveCount(2, { timeout: 30_000 });
    const strip = page.getByTestId('run-telemetry-strip');
    await expect(strip).toHaveAttribute('data-state', 'value', { timeout: 20_000 });
    await expect(strip.getByTestId('strip-tokens')).toHaveText(/Tokens\s*612\.0K/);     // 2 × 306_000
    await expect(strip.getByTestId('strip-llmcalls')).toHaveText(/LLM calls\s*30/);
    await expect(strip.getByTestId('strip-spans')).toHaveText('spans: 2/2 cases');
    await expect(strip.getByTestId('strip-retry')).toHaveCount(0);
    await shot(page, 'after-all-errored-run');
  });

  test('the per-case metrics route (what the per-case view calls) agrees with the header: same tokens, same source, no error', async () => {
    test.skip(!!skipReason, skipReason);
    const single = await fetch(`${baseUrl}/api/metrics/${encodeURIComponent(KEY_ERR)}?traceId=${TRACE_ERR}`);
    expect(single.status).toBe(200);
    const m = await single.json();
    expect(m).toMatchObject({ runId: KEY_ERR, status: 'success', hasSpans: true, totalTokens: 306_000, llmCalls: 15, agentErrorSpans: 2, source: 'Team B cluster' });
    expect(m.error).toBeUndefined();

    const batch = await fetch(`${baseUrl}/api/metrics/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runIds: [KEY_ERR], traceIds: { [KEY_ERR]: TRACE_ERR } }) });
    const [b] = (await batch.json()).metrics;
    expect(b).toMatchObject({ totalTokens: m.totalTokens, costUsd: m.costUsd, llmCalls: m.llmCalls, source: m.source, agentErrorSpans: 2 });
    expect(b.error).toBeUndefined();
  });
});
