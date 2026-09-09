/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for lazy report loading + infinite scroll (issue: inspect page
 * took ~10s / ~68MB because it fetched EVERY full report document up front).
 *
 * Covers:
 *   1. Run inspector (/evaluations/benchmarks/:bmId/runs/:runId/inspect)
 *      - statuses come from ONE lightweight `fields=` batch, not N full fetches
 *      - header tallies are complete before scrolling
 *      - the test-case list windows rows and reveals more on scroll
 *   2. Evaluation runs page (/evaluations/runs)
 *      - run rows are windowed (50/page) with an infinite-scroll sentinel
 *
 * Data is seeded through the storage API (file backend in e2e), mirroring
 * orphan-benchmark-run-recovery.spec.ts. Everything seeded is registered with
 * a TestDataTracker (fixture names via uniqueTestName so even a crashed run
 * is sweepable) and deleted in afterAll — with the crash ledger as backstop.
 * This spec used to leak its entire fixture set: 240 `e2e-lazy-tc-*` test
 * cases (14% of ALL test cases on the shared cluster) were measured leaked
 * because the hand-rolled afterAll never ran when a worker died.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const TC_COUNT = 120; // > ROWS_PER_PAGE (100) to exercise the inspector window
const RUN_COUNT = 60; // > RUNS_PER_PAGE (50) to exercise the runs-table window

test.describe('Run inspector — lazy report loading + infinite scroll', () => {
  // beforeAll-scoped fixtures outlive any single test, so the per-test
  // testData fixture cannot own them — this tracker does (afterAll +
  // crash ledger), and it tracks every id AT CREATION TIME so an early
  // return in beforeAll can never strand a partial fixture set.
  const tracker = createTestDataTracker();
  let testCaseIds: string[] = [];
  const reportIds: string[] = [];
  let benchmarkId: string | null = null;
  let runId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Reset: under fullyParallel a worker can leave this file and come back to
    // it, re-running beforeAll while module-level state persists — a `const []`
    // that is only ever push()ed accumulates the PREVIOUS invocation's ids
    // (already deleted by its afterAll), so `reportIds[i]` below would point at
    // 404s and rows render as PENDING. testCaseIds is reassigned, so it's fine.
    reportIds.length = 0;
    // Seeding 120 test cases + 120 reports is fast on CI's file backend but
    // can take minutes against a remote OpenSearch cluster — don't let the
    // default 60s hook timeout kill the seed halfway through.
    test.setTimeout(300_000);
    const stamp = Date.now();

    // 1. Bulk-create test cases.
    const tcRes = await request.post('/api/storage/test-cases/bulk', {
      data: {
        testCases: Array.from({ length: TC_COUNT }, (_, i) => ({
          name: uniqueTestName(`lazy-tc-${i}`),
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        })),
      },
    });
    if (!tcRes.ok()) return;
    const tcJson = await tcRes.json();
    testCaseIds = (tcJson.testCases || []).map((tc: any) => tc.id);
    tracker.testCases(testCaseIds);
    if (testCaseIds.length !== TC_COUNT) return;

    // 2. Bulk-create one completed report per test case (first one failed,
    //    rest passed) with explicit ids so the run results can reference them.
    const runsPayload = testCaseIds.map((tcId, i) => {
      const id = `report-e2e-lazy-${stamp}-${i}`;
      reportIds.push(id);
      return {
        id,
        testCaseId: tcId,
        testCaseVersionId: `${tcId}-v1`,
        agentId: 'demo',
        modelId: 'demo-model',
        iteration: 1,
        status: 'completed',
        passFailStatus: i === 0 ? 'failed' : 'passed',
        metricsStatus: 'ready',
        trajectory: [{ type: 'assistant', content: `step for ${tcId}` }],
      };
    });
    const bulkRes = await request.post('/api/storage/runs/bulk', { data: { runs: runsPayload } });
    tracker.trackAll('run', reportIds);
    if (!bulkRes.ok()) return;

    // 3. Benchmark with one completed run referencing every report.
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('lazy-benchmark'),
        description: 'lazy-report-loading E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    runId = `run-e2e-lazy-${stamp}`;
    const results: Record<string, { reportId: string; status: string }> = {};
    testCaseIds.forEach((tcId, i) => {
      results[tcId] = { reportId: reportIds[i], status: 'completed' };
    });
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [{
          id: runId,
          name: 'E2E Lazy Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results,
        }],
      },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async () => {
    // Children before parents, 404-tolerant, ledger-backed — and reconciles
    // late-written reports referencing the tracked test cases.
    await tracker.cleanup();
  });

  test('statuses load via one lightweight batch — no per-report full fetches', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    const fullReportFetches: string[] = [];
    let sawFieldsBatch = false;
    page.on('request', (req) => {
      const url = req.url();
      // Batch endpoint: /api/storage/runs?ids=...&fields=...
      if (/\/api\/storage\/runs\?/.test(url) && url.includes('fields=')) sawFieldsBatch = true;
      // Full single-report fetch: /api/storage/runs/<id> (not a query, not sub-resources)
      if (/\/api\/storage\/runs\/report-e2e-lazy-[^/?]+$/.test(url)) fullReportFetches.push(url);
    });

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });

    // Statuses are real verdicts (from the summary batch), not raw execution
    // status: exactly one failed row among the loaded window.
    await expect(page.locator('[data-testid="test-case-row"][data-status="failed"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="test-case-row"][data-status="passed"]').first()).toBeVisible();

    // Header tallies are COMPLETE (all 120 counted) even though only the
    // first window of rows is rendered.
    await expect(page.getByText(`${TC_COUNT - 1}✓`, { exact: false })).toBeVisible();
    await expect(page.getByText('1✗', { exact: false })).toBeVisible();

    // The status pass used the lightweight batch; full-report fetches only
    // ever target the SELECTED row (panel + annotation reads may re-fetch the
    // same id a few times — pre-existing behavior), never one-per-test-case.
    expect(sawFieldsBatch).toBe(true);
    const distinctFullFetches = new Set(fullReportFetches);
    expect(distinctFullFetches.size).toBeLessThanOrEqual(1);
    expect(fullReportFetches.length).toBeLessThan(TC_COUNT / 4);
  });

  test('test-case list reveals more rows on scroll (infinite scroll)', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });

    // First window: 100 rows + sentinel.
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(100);
    await expect(page.locator('[data-testid="test-case-list-sentinel"]')).toHaveCount(1);

    // Scroll the sentinel into view → remaining rows are revealed.
    await page.locator('[data-testid="test-case-list-sentinel"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(TC_COUNT, { timeout: 10_000 });
    await expect(page.locator('[data-testid="test-case-list-sentinel"]')).toHaveCount(0);
  });
});

test.describe('Evaluation runs page — infinite scroll', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let namePrefix = '';

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    namePrefix = `e2e-scroll-run-${stamp}`;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('scroll-benchmark'),
        description: 'runs infinite scroll E2E',
        testCaseIds: [],
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [] }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    const runs = Array.from({ length: RUN_COUNT }, (_, i) => ({
      id: `run-${namePrefix}-${i}`,
      name: `${namePrefix}-${i}`,
      agentKey: 'demo',
      modelId: 'demo-model',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      status: 'completed',
      benchmarkVersion: 1,
      testCaseSnapshots: [],
      results: {},
    }));
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: { name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds, runs },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async () => {
    // The 60 seeded runs are EMBEDDED subdocuments of the benchmark — they
    // die with the parent doc.
    await tracker.cleanup();
  });

  test('run rows are windowed and more load when the sentinel scrolls into view', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');

    await page.goto('/evaluations/runs');
    await page.getByPlaceholder('Search runs...').fill(namePrefix);

    // First window: 50 of our 60 rows + the sentinel row.
    await expect(page.locator('[data-testid="run-row"]')).toHaveCount(50, { timeout: 30_000 });
    await expect(page.locator('[data-testid="runs-table-sentinel"]')).toHaveCount(1);

    // Scroll the sentinel into view → the remaining rows are revealed.
    await page.locator('[data-testid="runs-table-sentinel"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="run-row"]')).toHaveCount(RUN_COUNT, { timeout: 10_000 });
    await expect(page.locator('[data-testid="runs-table-sentinel"]')).toHaveCount(0);
  });
});
