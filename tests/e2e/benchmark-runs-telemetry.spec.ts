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
 *
 * Real-shaped fixtures (owner rule, 2026-10-20): FOUR runs, two of them
 * under the SAME agent name; one run with 50 cases whose keys sort first, so
 * the page needs TWO batch requests (TELEMETRY_BATCH_CHUNK = 50; the hook
 * requests keys in sorted order) and that run IS the first chunk — which lets
 * the specs hold one chunk (slow second-step load → skeletons, then values)
 * and fail one chunk (524 → 'unavailable' on that run only). This is the shape that bit
 * on the shared cluster on 2026-10-22: a 62-run × 62-case benchmark whose
 * 200-key requests timed out behind a 50 s proxy and rendered every row '—'.
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
  const RUN_BIG = uniqueTestName('tel-run-big');
  const RUN_ID_SUB = `run-tel-sub-${stamp}`;
  const RUN_ID_REST = `run-tel-rest-${stamp}`;
  const RUN_ID_NOSPANS = `run-tel-nospans-${stamp}`;
  /** Sorts before every other key (`report-…`, `run-tel-…`) so its 50 keys are exactly the first chunk. */
  const RUN_ID_BIG = `aaa-run-tel-big-${stamp}`;
  /** Cases of the big run: the 3 shared ones + 47 of its own = 50 keys = one full batch chunk. */
  const BIG_CASES = 50;
  const bigTestCaseIds: string[] = [];
  /** reportIds per run, in test-case order. */
  const reportIds: Record<string, string[]> = {};
  /** The metrics keys the page is expected to request for each run. */
  const keysByRun: Record<string, string[]> = {};
  let batchCalls: Array<{ runIds: string[]; sessionIds?: Record<string, string>; traceIds?: Record<string, string>; agents?: Record<string, unknown[]> }> = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    const mkTestCase = async (name: string) => {
      const r = await request.post('/api/storage/test-cases', {
        data: { name, category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] },
      });
      if (!r.ok()) return null;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      return id as string;
    };
    for (let i = 0; i < 3; i++) {
      const id = await mkTestCase(uniqueTestName(`tel-tc-${i}`));
      if (!id) return;
      testCaseIds.push(id);
    }
    if (testCaseIds.length !== 3) return;
    bigTestCaseIds.push(...testCaseIds);
    for (let i = 3; i < BIG_CASES; i++) {
      const id = await mkTestCase(uniqueTestName(`tel-tc-${i}`));
      if (!id) return;
      bigTestCaseIds.push(id);
    }

    const day = 86_400_000, now = Date.now();
    const seedReports = async (runId: string, agentKey: string, protocol: string, createdAt: number, verdicts: Array<'passed' | 'failed'>, durations: number[], withIds: boolean, cases: string[] = testCaseIds) => {
      const ids: string[] = [];
      const keys: string[] = [];
      for (let i = 0; i < cases.length; i++) {
        const r = await request.post('/api/storage/runs', {
          data: {
            testCaseId: cases[i], testCaseVersion: 1, agentKey, agentName: agentKey, modelId: 'demo-model', modelName: 'demo-model',
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
    const mkRun = (id: string, name: string, agentKey: string, createdAt: number, verdicts: Array<'passed' | 'failed'>, ids: string[], cases: string[] = testCaseIds) => ({
      id, name, agentKey, modelId: 'demo-model', judgeModelId: 'demo-judge-model',
      createdAt: new Date(createdAt).toISOString(), status: 'completed', benchmarkVersion: 1,
      testCaseSnapshots: cases.map(tc => ({ id: tc, version: 1, name: tc })),
      results: Object.fromEntries(cases.map((tc, i) => [tc, { reportId: ids[i], status: 'completed', passFailStatus: verdicts[i] }])),
    });
    const bigVerdicts = bigTestCaseIds.map((_, i) => (i % 4 === 3 ? 'failed' : 'passed') as 'passed' | 'failed');
    const bigDurations = bigTestCaseIds.map((_, i) => 30_000 + (i % 7) * 1_000);

    try {
      const subIds = await seedReports(RUN_ID_SUB, 'demo', 'claude-code', now - 1 * day, ['passed', 'passed', 'failed'], [44_000, 38_000, 61_000], true);
      const restIds = await seedReports(RUN_ID_REST, 'demo-rest', 'rest', now - 2 * day, ['passed', 'failed', 'failed'], [12_000, 15_000, 9_000], false);
      const noIds = await seedReports(RUN_ID_NOSPANS, 'demo', 'claude-code', now - 3 * day, ['passed', 'passed', 'passed'], [20_000, 22_000, 25_000], true);
      // Newest run, SAME agent name as RUN_SUB, 50 cases → its keys ARE the first chunk.
      const bigIds = await seedReports(RUN_ID_BIG, 'demo', 'claude-code', now - 0.5 * day, bigVerdicts, bigDurations, true, bigTestCaseIds);

      const bmRes = await request.post('/api/storage/benchmarks', {
        data: {
          name: uniqueTestName('tel-benchmark'), description: 'telemetry E2E', testCaseIds: bigTestCaseIds, runs: [], currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: bigTestCaseIds }],
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
            mkRun(RUN_ID_BIG, RUN_BIG, 'demo', now - 0.5 * day, bigVerdicts, bigIds, bigTestCaseIds),
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
    // Big run: 50 × 10K tokens / $0.02 / 2 LLM calls → 500.0K · $1.00 · 100.
    keysByRun[RUN_ID_BIG].forEach(k => { m[k] = { runId: k, hasSpans: true, totalTokens: 10_000, costUsd: 0.02, llmCalls: 2, toolCalls: 1 }; });
    return m;
  }
  /** The chunk made of the big run's keys — the FIRST request the page makes (keys are requested in sorted order). */
  const isBigChunk = (body: any) => (body.runIds as string[]).some(k => keysByRun[RUN_ID_BIG].includes(k));

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
    await expect(page.getByTestId('run-row')).toHaveCount(4, { timeout: 30_000 });
  }

  test('Runs table shows Tokens / Cost / LLM calls / Time-per-case per run from chunked batch calls (50 keys each) carrying runIds + sessionIds + agents hints', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await openRunsTab(page);

    const headers = (await page.locator('[data-testid="benchmark-runs-table"] thead th').allInnerTexts()).map(h => h.trim()).filter(Boolean);
    expect(headers).toEqual(['Run', 'Agent', 'Model', 'Size', 'Conc.', 'Pass %', 'Tokens', 'Cost', 'LLM calls', 'Time/case', 'Judge', 'J. Model', 'Date']);

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

    // The 50-case run (same agent name as RUN_SUB) is populated too.
    const big = page.locator('[data-testid="run-row"]', { hasText: RUN_BIG });
    await expect(big.getByTestId('run-tokens-cell')).toContainText('500.0K');
    await expect(big.getByTestId('run-llmcalls-cell')).toHaveText('100');

    // 59 keys → exactly two requests of ≤ 50 keys (one OpenSearch query each server-side), covering every key once, hints riding along.
    await page.waitForTimeout(500);
    expect(batchCalls).toHaveLength(2);
    for (const c of batchCalls) expect(c.runIds.length).toBeLessThanOrEqual(50);
    const requested = batchCalls.flatMap(c => c.runIds).sort();
    const allKeys = [...keysByRun[RUN_ID_BIG], ...keysByRun[RUN_ID_SUB], ...keysByRun[RUN_ID_REST], ...keysByRun[RUN_ID_NOSPANS]];
    expect(requested).toEqual([...allKeys].sort());
    const subKey = keysByRun[RUN_ID_SUB][0];
    const call = batchCalls.find(c => c.runIds.includes(subKey))!;
    expect(call.sessionIds?.[subKey]).toBe(`${RUN_ID_SUB}-session-0`);
    expect(call.traceIds?.[subKey]).toBe(`${'c'.repeat(28)}0000`);
    expect((call.agents?.[subKey]?.[0] as any)?.serviceName).toBe('claude-code-agent');
    const restCall = batchCalls.find(c => c.runIds.includes(keysByRun[RUN_ID_REST][0]))!;
    expect(restCall.agents?.[keysByRun[RUN_ID_REST][0]]).toBeUndefined();  // generic transport, no guessed name

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
    expect(names).toEqual([RUN_SUB, RUN_BIG, RUN_REST, RUN_NOSPANS]);   // 5.9M > 500K > 300K > none

    await tokensHeader.click();
    await expect(tokensHeader).toHaveAttribute('aria-sort', 'ascending');
    names = (await page.getByTestId('run-name-link').allInnerTexts()).map(n => n.trim());
    expect(names).toEqual([RUN_REST, RUN_BIG, RUN_SUB, RUN_NOSPANS]);   // no-spans still last
  });

  test('a run whose spans were not found reads "no traces" (not a bare "—") with a tooltip saying the agent was not traced and how to enable it; Time/case still shows the wall-clock', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await openRunsTab(page);

    const row = page.locator('[data-testid="run-row"]', { hasText: RUN_NOSPANS });
    await expect(row.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'empty', { timeout: 15_000 });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      await expect(row.getByTestId(id)).toHaveText('no traces');
      await expect(row.getByTestId(id)).toHaveAttribute('data-empty-kind', 'no-traces');
      await expect(row.getByTestId(id).locator('span')).toHaveAttribute('title', /^No traces for this run — no spans were found for any of its 3 cases, so this agent's runs were not traced\. Enable trace mode on the agent \(useTraces: true\)/);
    }
    await expect(row.getByTestId('run-timepercase-cell')).toHaveText('22 s');
    // The SAME agent name on a traced run next to it is populated — "no traces" is per run, not per agent.
    await expect(page.locator('[data-testid="run-row"]', { hasText: RUN_SUB }).getByTestId('run-tokens-cell')).toContainText('5.9M');
  });

  test('a SLOW chunk (held request) shows skeletons on its run only; the fast chunk\'s runs render values immediately; release → values (never a premature "no traces")', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    const mock = mockMetrics();
    let releaseBig: (() => void) | undefined;
    const held = new Promise<void>(r => { releaseBig = r; });
    await routeBatch(page, async (route, body) => {
      if (isBigChunk(body)) await held;   // the big run's chunk stalls (a slow trace store)
      await fulfillWith(mock)(route, body);
    });
    await openRunsTab(page);

    const sub = page.locator('[data-testid="run-row"]', { hasText: RUN_SUB });
    const big = page.locator('[data-testid="run-row"]', { hasText: RUN_BIG });
    await expect(sub.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(sub.getByTestId('run-tokens-cell')).toContainText('5.9M');
    // Big run: trace cells are LOADING (not "—", not "no traces"); Time/case (from the reports) already shows.
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      await expect(big.getByTestId(id)).toHaveAttribute('data-state', 'loading');
      await expect(big.getByTestId(id).getByLabel('Loading')).toBeVisible();
    }
    await expect(big.getByTestId('run-timepercase-cell')).toHaveText('33 s');
    expect(await big.getByTestId('run-tokens-cell').textContent()).not.toContain('no traces');

    releaseBig!();
    await expect(big.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(big.getByTestId('run-tokens-cell')).toContainText('500.0K');
    await expect(big.getByTestId('run-cost-cell')).toHaveText('$1.00');
    await expect(page.getByTestId('telemetry-unavailable-note')).toHaveCount(0);
  });

  test('a FAILED chunk (proxy 524) marks only ITS run "unavailable" (tooltip carries the failure, Retry offered); the other chunk\'s runs keep their values', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    const mock = mockMetrics();
    await routeBatch(page, async (route, body) => {
      if (isBigChunk(body)) { await route.fulfill({ status: 524, contentType: 'text/plain', body: 'local target did not respond in 50s' }); return; }
      await fulfillWith(mock)(route, body);
    });
    await openRunsTab(page);

    const sub = page.locator('[data-testid="run-row"]', { hasText: RUN_SUB });
    const big = page.locator('[data-testid="run-row"]', { hasText: RUN_BIG });
    await expect(sub.getByTestId('run-tokens-cell')).toContainText('5.9M', { timeout: 15_000 });
    await expect(big.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'empty', { timeout: 15_000 });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      await expect(big.getByTestId(id)).toHaveText('unavailable');
      await expect(big.getByTestId(id)).toHaveAttribute('data-empty-kind', 'unavailable');
      await expect(big.getByTestId(id).locator('span')).toHaveAttribute('title', /^Metrics unavailable — the trace-store query failed for 50 of 50 cases \(.*524.*\)\. Spans may well exist; use Retry\.$/);
    }
    await expect(big.getByTestId('run-timepercase-cell')).toHaveText('33 s');
    await expect(page.getByTestId('telemetry-unavailable-note')).toBeVisible();

    // Retry with the proxy recovered: the big run fills in; the note goes away.
    await page.unroute('**/api/metrics/batch');
    await routeBatch(page, fulfillWith(mock));
    await page.getByTestId('telemetry-retry').click();
    await expect(big.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(big.getByTestId('run-tokens-cell')).toContainText('500.0K');
    await expect(page.getByTestId('telemetry-unavailable-note')).toHaveCount(0);
  });

  test('batch endpoint 500 on every chunk → span cells read "unavailable", page still renders, Retry recovers', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await routeBatch(page, async route => { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }); });
    await openRunsTab(page);

    const sub = page.locator('[data-testid="run-row"]', { hasText: RUN_SUB });
    await expect(sub.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'empty', { timeout: 15_000 });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      await expect(sub.getByTestId(id)).toHaveText('unavailable');
      await expect(sub.getByTestId(id).locator('span')).toHaveAttribute('title', /^Metrics unavailable — the trace-store query failed for 3 of 3 cases \(boom\)/);
    }
    // Wall-clock comes from the reports, not the trace store — still shown.
    await expect(sub.getByTestId('run-timepercase-cell')).toHaveText('44 s');
    // Everything else on the row is intact.
    await expect(sub.getByTestId('run-passrate-cell')).toContainText('66.7%');
    await expect(page.getByTestId('benchmark-passrate-chart')).toBeVisible();
    // No retry storm: one request per chunk, then the cached error + a Retry affordance.
    await page.waitForTimeout(800);
    expect(batchCalls).toHaveLength(2);
    await expect(page.getByTestId('telemetry-unavailable-note')).toBeVisible();

    // Retry: the endpoint recovers → one more request → values appear, note disappears.
    await page.unroute('**/api/metrics/batch');
    await routeBatch(page, fulfillWith(mockMetrics()));
    await page.getByTestId('telemetry-retry').click();
    await expect(sub.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 15_000 });
    await expect(sub.getByTestId('run-tokens-cell')).toContainText('5.9M');
    await expect(page.getByTestId('telemetry-unavailable-note')).toHaveCount(0);
    expect(batchCalls).toHaveLength(2);   // routeBatch reset the log; exactly one retry request per chunk
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

    // No-spans run: "no traces" (with the how-to-enable tooltip) + 0/3, wall-clock still shown.
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_NOSPANS}/inspect`);
    await expect(page.getByTestId('run-telemetry-strip')).toHaveAttribute('data-state', 'empty', { timeout: 30_000 });
    await expect(page.getByTestId('run-telemetry-strip')).toHaveAttribute('data-empty-kind', 'no-traces');
    await expect(page.getByTestId('strip-tokens')).toContainText('no traces');
    await expect(page.getByTestId('strip-tokens')).toHaveAttribute('title', /^No traces for this run — no spans were found for any of its 3 cases/);
    await expect(page.getByTestId('strip-timepercase')).toContainText('22 s');
    await expect(page.getByTestId('strip-spans')).toHaveText('spans: 0/3 cases');
  });
});
