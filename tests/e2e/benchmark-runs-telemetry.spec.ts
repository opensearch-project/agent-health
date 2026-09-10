/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark pages telemetry (owner ask, 2026-09-09: "telemetry should be
 * emitted for all the pages, especially the benchmarks page").
 *
 *   - Runs tab table gains Tokens · Cost · LLM calls · Time/case columns, fed
 *     by ONE `POST /api/metrics/batch` per page visit (keyed by the reports'
 *     runIds, with sessionIds / traceIds / Strategy-C agents hints).
 *   - Run inspector (the routed benchmark run detail) gains a telemetry strip.
 *
 * `/api/metrics/batch` is mocked with `page.route` (no trace cluster in the
 * test environment); the storage side is real. The seeded reports are
 * standalone report docs (tracked + deleted), one run's reports carry a
 * connector runId + session.id, one run's reports carry none (keyed by report
 * id — the REST-connector path).
 */

import { test, expect, type Page, type Route } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

interface MockMetric { runId: string; hasSpans: boolean; totalTokens: number; costUsd: number; llmCalls: number; toolCalls: number; partial?: boolean }

test.describe('Benchmark Runs — telemetry columns + inspector strip', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  const testCaseIds: string[] = [];
  const stamp = Date.now();
  const RUN_SUB = uniqueTestName('tel-run-subprocess');
  const RUN_REST = uniqueTestName('tel-run-rest');
  const RUN_NOSPANS = uniqueTestName('tel-run-nospans');
  const RUN_ID_SUB = `run-tel-sub-${stamp}`;
  const RUN_ID_REST = `run-tel-rest-${stamp}`;
  const RUN_ID_NOSPANS = `run-tel-nospans-${stamp}`;
  /** reportIds per run, in test-case order. */
  const reportIds: Record<string, string[]> = {};
  /** The metrics keys the page is expected to request for each run. */
  const keysByRun: Record<string, string[]> = {};
  let batchCalls: Array<{ runIds: string[]; sessionIds?: Record<string, string>; traceIds?: Record<string, string>; agents?: Record<string, unknown[]> }> = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 3; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: { name: uniqueTestName(`tel-tc-${i}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }
    if (testCaseIds.length !== 3) return;

    const day = 86_400_000, now = Date.now();
    const seedReports = async (runId: string, agentKey: string, protocol: string, createdAt: number, verdicts: Array<'passed' | 'failed'>, durations: number[], withIds: boolean) => {
      const ids: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < testCaseIds.length; i++) {
        const r = await request.post('/api/storage/runs', {
          data: {
            testCaseId: testCaseIds[i], testCaseVersion: 1, agentKey, agentName: agentKey, modelId: 'demo-model', modelName: 'demo-model',
            status: 'completed', passFailStatus: verdicts[i], trajectory: [], metrics: { accuracy: verdicts[i] === 'passed' ? 90 : 30 },
            connectorProtocol: protocol, timestamp: new Date(createdAt + i * 60_000).toISOString(),
            ...(withIds ? { runId: `${runId}-agent-${i}`, traceId: `${'c'.repeat(28)}${String(i).padStart(4, '0')}`, sessionId: `${runId}-session-${i}` } : {}),
            performanceMetrics: { durationMs: durations[i], agentDurationMs: durations[i] - 1000 },
            experimentRunId: runId,
          },
        });
        if (!r.ok()) throw new Error(`seed report failed: ${r.status()}`);
        const j = await r.json();
        tracker.run(j.id);
        ids.push(j.id);
        keys.push(withIds ? `${runId}-agent-${i}` : j.id);
      }
      reportIds[runId] = ids;
      keysByRun[runId] = keys;
      return ids;
    };
    const mkRun = (id: string, name: string, agentKey: string, createdAt: number, verdicts: Array<'passed' | 'failed'>, ids: string[]) => ({
      id, name, agentKey, modelId: 'demo-model', judgeModelId: 'demo-judge-model',
      createdAt: new Date(createdAt).toISOString(), status: 'completed', benchmarkVersion: 1,
      testCaseSnapshots: testCaseIds.map(tc => ({ id: tc, version: 1, name: tc })),
      results: Object.fromEntries(testCaseIds.map((tc, i) => [tc, { reportId: ids[i], status: 'completed', passFailStatus: verdicts[i] }])),
    });

    try {
      const subIds = await seedReports(RUN_ID_SUB, 'demo', 'claude-code', now - 1 * day, ['passed', 'passed', 'failed'], [44_000, 38_000, 61_000], true);
      const restIds = await seedReports(RUN_ID_REST, 'demo-rest', 'rest', now - 2 * day, ['passed', 'failed', 'failed'], [12_000, 15_000, 9_000], false);
      const noIds = await seedReports(RUN_ID_NOSPANS, 'demo', 'claude-code', now - 3 * day, ['passed', 'passed', 'passed'], [20_000, 22_000, 25_000], true);

      const bmRes = await request.post('/api/storage/benchmarks', {
        data: {
          name: uniqueTestName('tel-benchmark'), description: 'telemetry E2E', testCaseIds, runs: [], currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
        },
      });
      if (!bmRes.ok()) return;
      benchmarkId = (await bmRes.json()).id;
      tracker.benchmark(benchmarkId!);
      const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
      const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
        data: {
          name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
          runs: [
            mkRun(RUN_ID_SUB, RUN_SUB, 'demo', now - 1 * day, ['passed', 'passed', 'failed'], subIds),
            mkRun(RUN_ID_REST, RUN_REST, 'demo-rest', now - 2 * day, ['passed', 'failed', 'failed'], restIds),
            mkRun(RUN_ID_NOSPANS, RUN_NOSPANS, 'demo', now - 3 * day, ['passed', 'passed', 'passed'], noIds),
          ],
        },
      });
      if (!put.ok()) benchmarkId = null;
    } catch (e) {
      console.warn('telemetry e2e seed failed:', e);
      benchmarkId = null;
    }
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  /** Mock the batch route: subprocess run → 5.9M/$20.19/312; REST run → smaller; no-spans run → hasSpans:false. */
  function mockMetrics(): Record<string, MockMetric> {
    const m: Record<string, MockMetric> = {};
    const tok = [2_000_000, 2_000_000, 1_900_000], cost = [7.00, 7.00, 6.19], llm = [100, 100, 112], tool = [40, 40, 38];
    keysByRun[RUN_ID_SUB].forEach((k, i) => { m[k] = { runId: k, hasSpans: true, totalTokens: tok[i], costUsd: cost[i], llmCalls: llm[i], toolCalls: tool[i] }; });
    keysByRun[RUN_ID_REST].forEach((k, i) => { m[k] = { runId: k, hasSpans: true, totalTokens: 100_000 + i, costUsd: 0.40, llmCalls: 10, toolCalls: 3 }; });
    keysByRun[RUN_ID_NOSPANS].forEach(k => { m[k] = { runId: k, hasSpans: false, totalTokens: 0, costUsd: 0, llmCalls: 0, toolCalls: 0 }; });
    return m;
  }

  async function routeBatch(page: Page, handler: (route: Route, body: any) => Promise<void>) {
    batchCalls = [];
    await page.route('**/api/metrics/batch', async route => {
      const body = route.request().postDataJSON();
      batchCalls.push(body);
      await handler(route, body);
    });
  }

  const fulfillWith = (mock: Record<string, MockMetric>) => async (route: Route, body: any) => {
    const metrics = (body.runIds as string[]).map(k => mock[k] || { runId: k, error: 'No sample data found', status: 'error' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metrics, aggregate: {} }) });
  };

  async function openRunsTab(page: Page) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
      const table = page.getByTestId('benchmark-runs-table');
      await Promise.race([
        table.waitFor({ state: 'visible', timeout: 30_000 }),
        page.waitForURL(/\/evaluations\/benchmarks\/?$/, { timeout: 30_000 }).catch(() => {}),
      ]).catch(() => {});
      if (await table.isVisible().catch(() => false)) break;
    }
    await expect(page.getByTestId('run-row')).toHaveCount(3, { timeout: 30_000 });
  }

  test('Runs table shows Tokens / Cost / LLM calls / Time-per-case per run from ONE batch call carrying runIds + sessionIds + agents hints', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await openRunsTab(page);

    const headers = (await page.locator('[data-testid="benchmark-runs-table"] thead th').allInnerTexts()).map(h => h.trim()).filter(Boolean);
    expect(headers).toEqual(['Run', 'Agent', 'Model', 'Size', 'Pass %', 'Tokens', 'Cost', 'LLM calls', 'Time/case', 'Judge', 'J. Model', 'Date']);

    const sub = page.locator('[data-testid="run-row"]', { hasText: RUN_SUB });
    await expect(sub.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(sub.getByTestId('run-tokens-cell')).toContainText('5.9M');
    await expect(sub.getByTestId('run-cost-cell')).toHaveText('$20.19');
    await expect(sub.getByTestId('run-llmcalls-cell')).toHaveText('312');
    await expect(sub.getByTestId('run-timepercase-cell')).toHaveText('44 s');   // median of 44/38/61 s
    // Tooltip on the value carries the exact count + span coverage.
    await expect(sub.getByTestId('run-tokens-cell').locator('span').first()).toHaveAttribute('title', /5,900,000 tokens · spans found for 3 of 3 cases/);

    // REST run (reports with no runId) is keyed by report id and still populated.
    const rest = page.locator('[data-testid="run-row"]', { hasText: RUN_REST });
    await expect(rest.getByTestId('run-tokens-cell')).toContainText('300.0K');
    await expect(rest.getByTestId('run-cost-cell')).toHaveText('$1.20');
    await expect(rest.getByTestId('run-llmcalls-cell')).toHaveText('30');
    await expect(rest.getByTestId('run-timepercase-cell')).toHaveText('12 s');

    // Exactly one batch request for the whole page, with every key + hints.
    await page.waitForTimeout(500);
    expect(batchCalls).toHaveLength(1);
    const call = batchCalls[0];
    const allKeys = [...keysByRun[RUN_ID_SUB], ...keysByRun[RUN_ID_REST], ...keysByRun[RUN_ID_NOSPANS]];
    expect([...call.runIds].sort()).toEqual([...allKeys].sort());
    expect(call.sessionIds?.[keysByRun[RUN_ID_SUB][0]]).toBe(`${RUN_ID_SUB}-session-0`);
    expect(call.traceIds?.[keysByRun[RUN_ID_SUB][0]]).toBe(`${'c'.repeat(28)}0000`);
    expect((call.agents?.[keysByRun[RUN_ID_SUB][0]]?.[0] as any)?.serviceName).toBe('claude-code-agent');
    expect(call.agents?.[keysByRun[RUN_ID_REST][0]]).toBeUndefined();  // generic transport, no guessed name

    // Rows stay compact.
    for (const row of await page.getByTestId('run-row').all()) {
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(40);
    }
  });

  test('sorting by Tokens reorders the rows (desc first, then asc); runs without spans sink to the bottom', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await openRunsTab(page);
    await expect(page.locator('[data-testid="run-row"]', { hasText: RUN_SUB }).getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });

    const tokensHeader = page.getByRole('columnheader', { name: /^Tokens/ });
    await tokensHeader.click();
    await expect(tokensHeader).toHaveAttribute('aria-sort', 'descending');
    let names = (await page.getByTestId('run-name-link').allInnerTexts()).map(n => n.trim());
    expect(names).toEqual([RUN_SUB, RUN_REST, RUN_NOSPANS]);

    await tokensHeader.click();
    await expect(tokensHeader).toHaveAttribute('aria-sort', 'ascending');
    names = (await page.getByTestId('run-name-link').allInnerTexts()).map(n => n.trim());
    expect(names).toEqual([RUN_REST, RUN_SUB, RUN_NOSPANS]);   // no-spans still last
  });

  test('a run whose spans were not found reads "—" with a tooltip; Time/case still shows the wall-clock', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await openRunsTab(page);

    const row = page.locator('[data-testid="run-row"]', { hasText: RUN_NOSPANS });
    await expect(row.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'empty', { timeout: 15_000 });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      await expect(row.getByTestId(id)).toHaveText('—');
      await expect(row.getByTestId(id).locator('span')).toHaveAttribute('title', 'No spans found for this run yet');
    }
    await expect(row.getByTestId('run-timepercase-cell')).toHaveText('22 s');
    // Hover shows the native tooltip: assert the title attribute is the hover text.
    await row.getByTestId('run-tokens-cell').hover();
    expect(await row.getByTestId('run-tokens-cell').locator('span').getAttribute('title')).toBe('No spans found for this run yet');
  });

  test('batch endpoint 500 → span cells read "—" (Metrics unavailable), page still renders, Retry recovers', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, async route => { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }); });
    await openRunsTab(page);

    const sub = page.locator('[data-testid="run-row"]', { hasText: RUN_SUB });
    await expect(sub.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'empty', { timeout: 15_000 });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      await expect(sub.getByTestId(id).locator('span')).toHaveAttribute('title', 'Metrics unavailable');
    }
    // Wall-clock comes from the reports, not the trace store — still shown.
    await expect(sub.getByTestId('run-timepercase-cell')).toHaveText('44 s');
    // Everything else on the row is intact.
    await expect(sub.getByTestId('run-passrate-cell')).toContainText('66.7%');
    await expect(page.getByTestId('benchmark-passrate-chart')).toBeVisible();
    // No retry storm: one request, then the cached error + a Retry affordance.
    await page.waitForTimeout(800);
    expect(batchCalls).toHaveLength(1);
    await expect(page.getByTestId('telemetry-unavailable-note')).toBeVisible();

    // Retry: the endpoint recovers → one more request → values appear, note disappears.
    await page.unroute('**/api/metrics/batch');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await page.getByTestId('telemetry-retry').click();
    await expect(sub.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(sub.getByTestId('run-tokens-cell')).toContainText('5.9M');
    await expect(page.getByTestId('telemetry-unavailable-note')).toHaveCount(0);
    expect(batchCalls).toHaveLength(1);   // routeBatch reset the log; exactly one retry request
  });

  test('the run inspector (benchmark run detail) shows the telemetry strip: tokens · cost · LLM calls · tool calls · time/case · spans N/M', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_SUB}/inspect`);
    await expect(page.getByTestId('test-case-row')).toHaveCount(3, { timeout: 30_000 });

    const strip = page.getByTestId('run-telemetry-strip');
    await expect(strip).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(strip.getByTestId('strip-tokens')).toContainText('5.9M');
    await expect(strip.getByTestId('strip-cost')).toContainText('$20.19');
    await expect(strip.getByTestId('strip-llmcalls')).toContainText('312');
    await expect(strip.getByTestId('strip-toolcalls')).toContainText('118');
    await expect(strip.getByTestId('strip-timepercase')).toContainText('44 s');
    await expect(strip.getByTestId('strip-spans')).toHaveText('spans: 3/3 cases');
    expect(batchCalls).toHaveLength(1);
    expect([...batchCalls[0].runIds].sort()).toEqual([...keysByRun[RUN_ID_SUB]].sort());

    // No-spans run: dashes + 0/3, wall-clock still shown.
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_NOSPANS}/inspect`);
    await expect(page.getByTestId('run-telemetry-strip')).toHaveAttribute('data-state', 'empty', { timeout: 30_000 });
    await expect(page.getByTestId('strip-tokens')).toContainText('—');
    await expect(page.getByTestId('strip-tokens')).toHaveAttribute('title', 'No spans found for this run yet');
    await expect(page.getByTestId('strip-timepercase')).toContainText('22 s');
    await expect(page.getByTestId('strip-spans')).toHaveText('spans: 0/3 cases');
  });
});
