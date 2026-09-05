/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark detail → Runs tab as a compact TABLE with a pass-rate-over-time
 * CHART on top (owner sketch, 2026-09-03). Columns: Run (link) · Agent ·
 * Model · Size · Pass % · Judge · J. Model · Date. Clicking a categorical
 * cell (or a chart legend entry) filters the table; active filters render as
 * removable pills.
 *
 * Seeds one benchmark with three embedded runs across two agents so the
 * chart has two series and a filter actually narrows the rows. Everything
 * is tracked by id and cleaned up (runs are embedded subdocuments and die
 * with the benchmark; the reportIds never exist as standalone docs).
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Runs tab — table + chart + click-to-filter pills', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  const testCaseIds: string[] = [];
  const RUN_CC = uniqueTestName('runs-table-cc');
  const RUN_CC_OLD = uniqueTestName('runs-table-cc-old');
  const RUN_AIS = uniqueTestName('runs-table-ais');
  const RUN_ID_CC = `run-rt-cc-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 3; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`runs-table-tc-${i}`),
          category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
        },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }
    if (testCaseIds.length !== 3) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('runs-table-benchmark'),
        description: 'runs-table E2E',
        testCaseIds, runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const snaps = testCaseIds.map(id => ({ id, version: 1, name: id }));
    const day = 86_400_000;
    const now = Date.now();
    const mkRun = (id: string, name: string, agentKey: string, createdAt: number, verdicts: Array<'passed' | 'failed'>, extra: Record<string, unknown> = {}) => ({
      id, name, agentKey, modelId: 'demo-model', judgeModelId: 'demo-judge-model', evaluatorId: undefined,
      createdAt: new Date(createdAt).toISOString(), status: 'completed', benchmarkVersion: 1,
      testCaseSnapshots: snaps,
      results: Object.fromEntries(testCaseIds.map((tc, i) => [tc, { reportId: `report-rt-${id}-${i}`, status: 'completed', passFailStatus: verdicts[i] }])),
      ...extra,
    });
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
        runs: [
          mkRun(RUN_ID_CC, RUN_CC, 'demo', now - 1 * day, ['passed', 'passed', 'failed']),           // 66.7%
          mkRun(`run-rt-ccold-${now}`, RUN_CC_OLD, 'demo', now - 3 * day, ['passed', 'failed', 'failed']), // 33.3%
          mkRun(`run-rt-ais-${now}`, RUN_AIS, 'e2e-other-agent', now - 2 * day, ['passed', 'passed', 'passed']), // 100%
        ],
      },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  /**
   * Open the Runs tab and wait for the table. The page's loader bounces to the
   * benchmarks LIST on a failed `GET /api/storage/benchmarks/:id` (pre-existing
   * behaviour) — under CI's parallel workers that GET occasionally times out
   * right after seeding, which produced a first-attempt flake. One retry after
   * a bounce keeps the assertions about the TABLE, not about backend latency.
   */
  async function openRunsTab(page: import('@playwright/test').Page, expectedRows: number) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
      const table = page.getByTestId('benchmark-runs-table');
      await Promise.race([
        table.waitFor({ state: 'visible', timeout: 30_000 }),
        page.waitForURL(/\/evaluations\/benchmarks\/?$/, { timeout: 30_000 }).catch(() => {}),
      ]).catch(() => {});
      if (await table.isVisible().catch(() => false)) break;
    }
    await expect(page.getByTestId('run-row')).toHaveCount(expectedRows, { timeout: 30_000 });
  }

  test('renders the runs as a table with the sketch columns and a chart above it', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await openRunsTab(page, 3);

    // Column headers exactly as sketched (+ Run as the first column).
    const headers = await page.locator('[data-testid="benchmark-runs-table"] thead th').allInnerTexts();
    expect(headers.map(h => h.trim()).filter(Boolean)).toEqual(['Run', 'Agent', 'Model', 'Size', 'Pass %', 'Judge', 'J. Model', 'Date']);

    // Chart sits ABOVE the table with one legend entry per agent.
    const chart = page.getByTestId('benchmark-passrate-chart');
    await expect(chart).toBeVisible();
    const chartBox = (await chart.boundingBox())!;
    const tableBox = (await page.getByTestId('benchmark-runs-table').boundingBox())!;
    expect(chartBox.y + chartBox.height).toBeLessThanOrEqual(tableBox.y + 1);
    await expect(page.getByTestId('chart-legend-demo')).toBeVisible();
    await expect(page.getByTestId('chart-legend-e2e-other-agent')).toBeVisible();
    // One plotted point per evaluated run (a single-point series has no
    // connecting path, so count dots rather than curves).
    await expect(chart.locator('svg .recharts-line-dot')).toHaveCount(3);

    // Row content: run name is a link to the inspector; Size + Pass % derive
    // from the seeded results (not from any denormalized stats).
    const cc = page.locator('[data-testid="run-row"]', { hasText: RUN_CC });
    await expect(cc.getByTestId('run-name-link')).toHaveAttribute('href', `/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_CC}/inspect`);
    await expect(cc.getByTestId('run-size-cell')).toHaveText('3');
    await expect(cc.getByTestId('run-passrate-cell')).toContainText('66.7%');
    await expect(cc.getByTestId('run-cell-judge')).toHaveText('demo-judge-model');
    await expect(cc.getByTestId('run-latest-badge')).toBeVisible(); // newest of the three
    // Default sort: newest first.
    const names = await page.getByTestId('run-name-link').allInnerTexts();
    expect(names.map(n => n.trim())).toEqual([RUN_CC, RUN_AIS, RUN_CC_OLD]);
  });

  test('is compact: run rows are ≤ 40px tall', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await openRunsTab(page, 3);
    for (const row of await page.getByTestId('run-row').all()) {
      const box = (await row.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(40);
    }
    // No dead vertical band between the tab strip and the chart (regression:
    // the inactive Cases panel used to stay display:flex and push the runs
    // ~400px down the page).
    const tabs = (await page.getByRole('tab', { name: /Runs/ }).boundingBox())!;
    const chart = (await page.getByTestId('benchmark-passrate-chart').boundingBox())!;
    expect(chart.y - (tabs.y + tabs.height)).toBeLessThan(60);
  });

  test('clicking an Agent cell filters the table, shows a pill, and the pill removes the filter', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await openRunsTab(page, 3);
    await expect(page.getByTestId('run-filter-pills')).toHaveCount(0);

    const ais = page.locator('[data-testid="run-row"]', { hasText: RUN_AIS });
    await ais.getByTestId('run-cell-agent').click();

    await expect(page.getByTestId('run-row')).toHaveCount(1);
    await expect(page.locator('[data-testid="run-row"]', { hasText: RUN_AIS })).toBeVisible();
    // Clicking the cell must not have navigated to the run.
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs$`));

    const pill = page.getByTestId('run-filter-pill');
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveAttribute('data-filter-field', 'agent');
    await expect(pill).toHaveAttribute('data-filter-value', 'e2e-other-agent');
    await expect(page.getByTestId('run-filter-count')).toHaveText('1 of 3 runs');
    // Legend entry for the active agent is pressed; the other agent is still
    // listed (agent filters dim, they don't drop, so you can toggle it back).
    await expect(page.getByTestId('chart-legend-e2e-other-agent')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chart-legend-demo')).toBeVisible();

    await pill.click();
    await expect(page.getByTestId('run-row')).toHaveCount(3);
    await expect(page.getByTestId('run-filter-pills')).toHaveCount(0);
  });

  test('filters on different fields AND together; the chart legend toggles agents; Clear resets', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await openRunsTab(page, 3);

    // Legend click → agent filter (demo has 2 runs).
    await page.getByTestId('chart-legend-demo').click();
    await expect(page.getByTestId('run-row')).toHaveCount(2);
    // J. Model is shared by all runs → adding it keeps 2 rows and adds a pill.
    await page.locator('[data-testid="run-row"]').first().getByTestId('run-cell-judge').click();
    await expect(page.getByTestId('run-row')).toHaveCount(2);
    await expect(page.getByTestId('run-filter-pill')).toHaveCount(2);
    await expect(page.getByTestId('run-filter-pill').nth(1)).toContainText('J. Model:');
    // Second agent via legend → OR within the agent field → back to 3.
    await page.getByTestId('chart-legend-e2e-other-agent').click();
    await expect(page.getByTestId('run-row')).toHaveCount(3);
    await expect(page.getByTestId('run-filter-pill')).toHaveCount(3);

    await page.getByTestId('run-filter-clear').click();
    await expect(page.getByTestId('run-filter-pills')).toHaveCount(0);
    await expect(page.getByTestId('run-row')).toHaveCount(3);
  });

  test('run name link opens the run inspector; expanding a row shows the case heat strip', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await openRunsTab(page, 3);

    const cc = page.locator('[data-testid="run-row"]', { hasText: RUN_CC });
    await expect(page.getByTestId('run-row-cases')).toHaveCount(0);
    await cc.getByTestId('run-expand-cases').click();
    await expect(page.getByTestId('run-row-cases')).toHaveCount(1);
    await expect(page.getByLabel(`${RUN_CC} case verdicts`)).toBeVisible();

    await cc.getByTestId('run-name-link').click();
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_CC}/inspect$`), { timeout: 15_000 });
  });
});
