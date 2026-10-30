/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a code-SDK body that catches the agent's HTTP 500 and asserts on it
 * renders as FAILED (with the assertion) in the run inspector — for the
 * benchmark-runner path (`POST /api/storage/benchmarks/:id/execute`) exactly
 * as for the evaluation-runs path (CLI / `POST /api/storage/evaluation-runs`).
 *
 * Owner-hit bug (intake 2026-10-28): the benchmark runner bucketed that case
 * as AGENT ERROR (`failureStage: 'agent'`, excluded from the pass rate: the
 * header read "0✓ 0✗ ⚡2 / 2") while the CLI said FAILED. Nothing here is
 * seeded: a real local HTTP server answers 500, it is registered as a REST
 * custom agent, a real `.eval.js` body runs through BOTH runners, and the
 * inspector is asserted on the reports each runner persisted.
 *
 * Requires an OpenSearch-backed backend: `/execute` returns 400 under file
 * storage (requireStorageClient), so the spec self-skips there.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';

const STAMP = Date.now();
const FIXTURE = `
const { test, expect } = require('@opensearch-project/agent-health');

test('caught-500-asserted', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  let error = '';
  try { await agent.run(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  expect(error, 'request succeeded (HTTP 2xx)').to.equal('');
});

test('uncaught-500', { prompt: 'What is the status of order 42?' }, async ({ agent }) => {
  await agent.run();
});
`;

/**
 * POST to an SSE execution endpoint and return the parsed `data:` payloads.
 * Both execution routes close the stream after their terminal event
 * (`completed` / `complete` / `error`), so a plain request resolves once the
 * run is over; the 120 s cap is well above a 2-case run against a local stub
 * (measured ~30 s per route on a remote OpenSearch cluster).
 */
async function sseEvents(request: APIRequestContext, url: string, data: Record<string, unknown>): Promise<any[]> {
  const res = await request.post(url, { data, timeout: 120_000 });
  if (!res.ok()) throw new Error(`${url} → ${res.status()} ${await res.text()}`);
  const text = await res.text();
  const events: any[] = [];
  for (const block of text.split('\n\n')) {
    let eventName: string | undefined; let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine);
      events.push(eventName && !('type' in parsed) ? { type: eventName, ...parsed } : parsed);
    } catch { /* ignore */ }
  }
  const terminal = events.find(e => ['completed', 'complete', 'error', 'cancelled'].includes(e.type) || e.status === 'completed' || e.error);
  if (!terminal) throw new Error(`${url}: stream ended without a terminal event; saw ${JSON.stringify(events.map(e => e.type))}`);
  if (terminal.type === 'error' || (terminal.error && !terminal.run)) throw new Error(`${url}: run errored: ${JSON.stringify(terminal).slice(0, 300)}`);
  return events;
}

test.describe('Caught agent 500 + failing expect → FAILED in the inspector (both runners)', () => {
  let skipReason = '';
  let agentServer: http.Server;
  let tempDir: string;
  let fixturePath: string;
  let agentKey = '';
  let benchmarkId = '';
  let evalRunId = '';
  let benchRunId = '';
  let caughtTcId = '';
  let uncaughtTcId = '';
  let benchReports: Record<string, string> = {};
  let evalReports: Record<string, string> = {};
  // Ids created in beforeAll are deleted in afterAll by a tracker-equivalent
  // explicit DELETE list (the per-test `testData` fixture is per test).
  const created: Array<[string, string]> = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    const health = await (await request.get('/api/storage/health')).json().catch(() => ({}));
    if (health.backend === 'file' || health.status !== 'ok') { skipReason = 'POST …/benchmarks/:id/execute requires an OpenSearch-backed server'; return; }

    agentServer = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Search is temporarily unavailable. Please retry.' }));
      });
    });
    await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/ask`;

    const reg = await request.post('/api/agents/custom', { data: { name: `ahtest-caught-500-rest-${STAMP}`, endpoint, connectorType: 'rest' } });
    if (reg.status() === 409) { skipReason = 'code-first backend: custom agents are managed in agent-health.config.ts'; return; }
    expect(reg.status()).toBe(201);
    agentKey = (await reg.json()).agent.key;
    created.push(['custom-agent', agentKey]);

    tempDir = mkdtempSync(join(tmpdir(), 'e2e-caught-500-'));
    fixturePath = join(tempDir, 'caught-500.eval.js');
    writeFileSync(fixturePath, FIXTURE, 'utf-8');

    const bm = await request.post('/api/storage/benchmarks', { data: { name: `ahtest-caught-500-${STAMP}`, description: 'e2e: caught agent 500 verdict', testCaseIds: [] } });
    expect(bm.ok()).toBeTruthy();
    benchmarkId = (await bm.json()).id;
    created.push(['benchmark', benchmarkId]);

    // 1) evaluation-runs path (what the CLI uses): imports the code file,
    //    links the test cases into the benchmark, runs both bodies.
    const evalEvents = await sseEvents(request, '/api/storage/evaluation-runs', {
      name: `ahtest-caught-500-evalrun-${STAMP}`, benchmarkId, agentKey, modelId: 'demo-model', concurrency: 1, trigger: 'e2e-test',
      sources: [{ type: 'code-import', filenames: [fixturePath], testCaseIds: [] }],
    });
    const evalStarted = evalEvents.find(e => e.type === 'started');
    expect(evalStarted?.runId).toBeTruthy();
    evalRunId = evalStarted.runId;
    created.push(['evaluation-run', evalRunId]);
    for (const tc of evalStarted.testCases ?? []) {
      created.push(['test-case', tc.id]);
      if (tc.name === 'caught-500-asserted') caughtTcId = tc.id;
      if (tc.name === 'uncaught-500') uncaughtTcId = tc.id;
    }
    expect(caughtTcId && uncaughtTcId).toBeTruthy();
    const evalRun = (await (await request.get(`/api/storage/evaluation-runs/${evalRunId}`)).json());
    const evalDoc = evalRun.evaluationRun ?? evalRun;
    for (const [tcId, r] of Object.entries<any>(evalDoc.results ?? {})) { if (r.reportId) { created.push(['run', r.reportId]); evalReports[tcId] = r.reportId; } }

    // 2) benchmark-runner path (what the Benchmark page "Run" dialog uses).
    const benchEvents = await sseEvents(request, `/api/storage/benchmarks/${benchmarkId}/execute`, {
      name: `ahtest-caught-500-benchrun-${STAMP}`, agentKey, modelId: 'demo-model',
    });
    const benchStarted = benchEvents.find(e => e.type === 'started');
    expect(benchStarted?.runId).toBeTruthy();
    benchRunId = benchStarted.runId;
    created.push(['benchmark-run', `${benchmarkId}/${benchRunId}`]);
    const bmDoc = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    const benchRun = (bmDoc.benchmark ?? bmDoc).runs.find((r: any) => r.id === benchRunId);
    for (const [tcId, r] of Object.entries<any>(benchRun?.results ?? {})) { if (r.reportId) { created.push(['run', r.reportId]); benchReports[tcId] = r.reportId; } }
  });

  test.afterAll(async ({ request }) => {
    // Children before parents; every id here was created above by this spec
    // (never a listing + name match). A failed DELETE is reported, not hidden.
    const order = ['run', 'benchmark-run', 'evaluation-run', 'benchmark', 'test-case', 'custom-agent'];
    const leaked: string[] = [];
    for (const kind of order) {
      for (const [k, id] of created) {
        if (k !== kind) continue;
        const path = kind === 'run' ? `/api/storage/runs/${id}`
          : kind === 'benchmark-run' ? `/api/storage/benchmarks/${id.split('/')[0]}/runs/${id.split('/')[1]}`
          : kind === 'evaluation-run' ? `/api/storage/evaluation-runs/${id}`
          : kind === 'test-case' ? `/api/storage/test-cases/${id}`
          : kind === 'benchmark' ? `/api/storage/benchmarks/${id}`
          : `/api/agents/custom/${id}`;
        const r = await request.delete(path).catch(() => null);
        if (!r || (!r.ok() && r.status() !== 404)) leaked.push(`${kind} ${id} → ${r ? r.status() : 'network error'}`);
      }
    }
    if (leaked.length) console.warn(`[caught-agent-error-verdict] cleanup left data behind:\n  ${leaked.join('\n  ')}`);
    if (agentServer) await new Promise<void>(r => agentServer.close(() => r()));
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('benchmark run inspector: caught case is FAILED with the assertion, uncaught case is AGENT ERROR, header counts 1 failed', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${benchRunId}/inspect?reportId=${benchReports[caughtTcId]}`);

    const caughtRow = page.locator(`[data-testid="test-case-row"][data-test-case-id="${caughtTcId}"]`);
    await expect(caughtRow).toBeVisible({ timeout: 20_000 });
    await expect(caughtRow.getByTestId('status-label')).toHaveText('FAILED');
    const uncaughtRow = page.locator(`[data-testid="test-case-row"][data-test-case-id="${uncaughtTcId}"]`);
    await expect(uncaughtRow.getByTestId('status-label')).toHaveText('AGENT ERROR');

    // Right pane: FAILED badge, no agent-error card, and the assertion the
    // body recorded under Judge Evaluation (where SDK matcher verdicts render).
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('FAILED', { timeout: 20_000 });
    await expect(page.getByTestId('run-failure-card')).toHaveCount(0);
    await expect(page.getByText('Agent request failed')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Judge Evaluation' }).click();
    await expect(page.getByText(/request succeeded \(HTTP 2xx\)/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/REST request failed: 500/).first()).toBeVisible();

    // Header tallies: the caught case counts as a failed verdict; only the uncaught one is an agent error.
    await expect(page.getByTestId('inspector-agent-error-count')).toHaveText('1');
  });

  test('evaluation run inspector (CLI path) shows the identical verdicts', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await page.goto(`/evaluations/runs/${evalRunId}/inspect?reportId=${evalReports[caughtTcId]}`);
    const caughtRow = page.locator(`[data-testid="test-case-row"][data-test-case-id="${caughtTcId}"]`);
    await expect(caughtRow).toBeVisible({ timeout: 20_000 });
    await expect(caughtRow.getByTestId('status-label')).toHaveText('FAILED');
    await expect(page.locator(`[data-testid="test-case-row"][data-test-case-id="${uncaughtTcId}"]`).getByTestId('status-label')).toHaveText('AGENT ERROR');
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('FAILED', { timeout: 20_000 });
    await page.getByRole('tab', { name: 'Judge Evaluation' }).click();
    await expect(page.getByText(/request succeeded \(HTTP 2xx\)/).first()).toBeVisible({ timeout: 15_000 });
  });
});
