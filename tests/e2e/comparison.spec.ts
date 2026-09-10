/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect, Page } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

/**
 * These tests used to click "the first View Latest / first h3" on whatever
 * benchmark happened to exist in shared storage — nondeterministic under
 * fullyParallel (another suite's single-run or mid-flight benchmark can be
 * the first card, leaving Compare disabled or the comparison page in an
 * empty state without its chrome), and vacuously green with no data at all.
 *
 * Each describe now seeds its OWN benchmark with two completed runs AND real
 * report documents (so the comparison table + Judge grid hydrate from
 * storage, not from missing-report fallbacks), navigates straight to it, and
 * asserts against the seeded names only. Seeding:
 *   - hard-fails loudly (expect() inside beforeAll) — a failed seed fails
 *     the whole describe instead of letting it skip quietly green;
 *   - registers every entity with a TestDataTracker AT CREATION TIME, so a
 *     partial seed or a killed worker still leaves reapable ids behind
 *     (afterAll cleanup + the crash ledger in tests/helpers/testDataTracker.ts).
 *
 * Known follow-up gap (out of scope here): deep-dive and traces e2e coverage
 * for the comparison page — those need seeded trace/span data, not just
 * report docs.
 */

interface ComparisonSeed {
  benchmarkId: string;
  testCaseIds: string[];
  testCaseNames: string[];
  runNames: string[];
  /** Judge-reasoning marker strings, one per seeded report, used to assert the Judge grid hydrated from OUR reports. */
  judgeReasonings: string[];
}

async function seedComparisonFixture(
  request: APIRequestContext,
  tracker: ReturnType<typeof createTestDataTracker>
): Promise<ComparisonSeed> {
  // --- Test cases ---
  const testCaseIds: string[] = [];
  const testCaseNames: string[] = [];
  for (let i = 0; i < 2; i++) {
    const name = uniqueTestName(`comparison-tc-${i + 1}`);
    const r = await request.post('/api/storage/test-cases', {
      data: {
        name,
        category: 'E2E',
        difficulty: 'Easy',
        initialPrompt: 'p',
        expectedOutcomes: ['o'],
      },
    });
    expect(r.ok(), `seed test case ${i + 1} POST status ${r.status()}`).toBeTruthy();
    const j = await r.json();
    const id = j.id || j.testCase?.id;
    expect(id, `seed test case ${i + 1} must have an id`).toBeTruthy();
    tracker.testCase(id); // registered AT CREATION — partial seeds still clean up
    testCaseIds.push(id);
    testCaseNames.push(name);
  }

  // --- Real report documents (2 runs x 2 test cases) ---
  // Post-#463 validation requires a valid testCaseId on every report create.
  const runNames = [uniqueTestName('comparison-run-1'), uniqueTestName('comparison-run-2')];
  const judgeReasonings: string[] = [];
  const reportIds: Record<string, string> = {}; // `${runIdx}-${tcIdx}` -> report id
  for (let runIdx = 0; runIdx < 2; runIdx++) {
    for (let tcIdx = 0; tcIdx < 2; tcIdx++) {
      const passed = !(runIdx === 0 && tcIdx === 1); // run 1 fails tc 2; everything else passes
      const reasoning = `Seeded judge reasoning ${runIdx + 1}-${tcIdx + 1} for ${runNames[runIdx]}`;
      const r = await request.post('/api/storage/runs', {
        data: {
          testCaseId: testCaseIds[tcIdx],
          testCaseName: testCaseNames[tcIdx],
          agentName: 'demo',
          modelName: 'demo-model',
          status: 'completed',
          passFailStatus: passed ? 'passed' : 'failed',
          metrics: { accuracy: passed ? 85 : 40 },
          llmJudgeReasoning: reasoning,
          trajectory: [],
          timestamp: new Date().toISOString(),
        },
      });
      expect(r.ok(), `seed report r${runIdx + 1}/tc${tcIdx + 1} POST status ${r.status()}`).toBeTruthy();
      const doc = await r.json();
      expect(doc.id, `seed report r${runIdx + 1}/tc${tcIdx + 1} must have an id`).toBeTruthy();
      tracker.run(doc.id); // registered AT CREATION
      reportIds[`${runIdx}-${tcIdx}`] = doc.id;
      judgeReasonings.push(reasoning);
    }
  }

  // --- Benchmark with two completed runs referencing the real reports ---
  const bmName = uniqueTestName('comparison-benchmark');
  const bmRes = await request.post('/api/storage/benchmarks', {
    data: {
      name: bmName,
      description: 'comparison e2e seed',
      testCaseIds,
      runs: [],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
    },
  });
  expect(bmRes.ok(), `seed benchmark POST status ${bmRes.status()}`).toBeTruthy();
  const benchmarkId = (await bmRes.json()).id;
  expect(benchmarkId, 'seed benchmark must have an id').toBeTruthy();
  tracker.benchmark(benchmarkId); // registered AT CREATION

  const snapshots = testCaseIds.map((id, i) => ({ id, version: 1, name: testCaseNames[i] }));
  const makeRun = (runIdx: number) => ({
    id: `run-comparison-${runIdx + 1}-${process.pid}-${Date.now()}`,
    name: runNames[runIdx],
    agentKey: 'demo',
    modelId: 'demo-model',
    createdAt: new Date(Date.now() - (2 - runIdx) * 60_000).toISOString(),
    status: 'completed',
    benchmarkVersion: 1,
    testCaseSnapshots: snapshots,
    results: {
      [testCaseIds[0]]: { reportId: reportIds[`${runIdx}-0`], status: 'completed', passFailStatus: 'passed' },
      [testCaseIds[1]]: {
        reportId: reportIds[`${runIdx}-1`],
        status: 'completed',
        passFailStatus: runIdx === 0 ? 'failed' : 'passed',
      },
    },
    stats: {
      passed: runIdx === 0 ? 1 : 2,
      failed: runIdx === 0 ? 1 : 0,
      pending: 0,
      errored: 0,
      total: 2,
    },
  });

  const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
  expect(get.ok(), 'seeded benchmark must be fetchable').toBeTruthy();
  const bm = await get.json();
  const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
    data: {
      name: bm.name,
      description: bm.description,
      testCaseIds: bm.testCaseIds,
      runs: [makeRun(0), makeRun(1)],
    },
  });
  expect(put.ok(), `seed runs PUT status ${put.status()}`).toBeTruthy();

  return { benchmarkId, testCaseIds, testCaseNames, runNames, judgeReasonings };
}

/** From the seeded benchmark's runs page: select both runs and open Compare. */
async function openComparison(page: Page, seed: ComparisonSeed): Promise<void> {
  await page.goto(`/benchmarks/${seed.benchmarkId}/runs`);
  await page.waitForSelector('[data-testid="benchmark-runs-page"]', { timeout: 30000 });

  const selectAllButton = page.locator('button:has-text("Select All")');
  await expect(selectAllButton).toBeVisible({ timeout: 10000 });
  await selectAllButton.click();

  const compareButton = page.locator('button:has-text("Compare")').first();
  await expect(compareButton).toBeEnabled({ timeout: 10000 });
  await compareButton.click();
  await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
}

test.describe('Comparison Page', () => {
  const tracker = createTestDataTracker();
  let seed: ComparisonSeed;

  test.beforeAll(async ({ request }) => {
    // Hard-fails via expect() inside — never leaves `seed` half-initialized
    // without also failing the describe.
    seed = await seedComparisonFixture(request, tracker);
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('should navigate to comparison page from benchmark runs', async ({ page }) => {
    await openComparison(page, seed);
    await expect(page.locator('[data-testid="comparison-page"]')).toBeVisible();
  });

  test('should display Compare Runs title', async ({ page }) => {
    await openComparison(page, seed);
    await expect(page.locator('[data-testid="comparison-title"]')).toHaveText('Compare Runs');
  });

  test('breadcrumb navigates back out of the comparison', async ({ page }) => {
    await openComparison(page, seed);

    // The redesigned comparison page has no dedicated back button — its back
    // navigation is the breadcrumb (Home > Evaluations > Compare Runs).
    const crumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumb).toBeVisible();
    await crumb.locator('a:has-text("Evaluations")').click();
    await expect(page.locator('[data-testid="benchmarks-page"]')).toBeVisible({ timeout: 10000 });
  });

  test('should show run selector section', async ({ page }) => {
    await openComparison(page, seed);

    // The run selector is the "N of M runs" popover launcher; opening it must
    // list both seeded runs (asserted by their unique names).
    const selector = page.locator('button', { hasText: /\d+ of \d+ runs/ }).first();
    await expect(selector).toBeVisible();
    await selector.click();
    await expect(page.locator(`text=${seed.runNames[0]}`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`text=${seed.runNames[1]}`).first()).toBeVisible();
  });

  test('should not show a baseline selector', async ({ page }) => {
    await openComparison(page, seed);

    // Should NOT show a baseline selector (removed in favor of automatic oldest-run reference)
    const hasBaseline = await page.locator('text=Baseline').isVisible().catch(() => false);
    expect(hasBaseline).toBeFalsy();
  });
});

test.describe('Comparison Page - Metrics', () => {
  const tracker = createTestDataTracker();
  let seed: ComparisonSeed;

  test.beforeAll(async ({ request }) => {
    seed = await seedComparisonFixture(request, tracker);
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('should display run summary rows with Pass Rate for the seeded runs', async ({ page }) => {
    await openComparison(page, seed);

    // Scoped to the seeded entities: the run-summary table (the table whose
    // rows carry our unique run names) must expose a Pass Rate column and a
    // row per seeded run.
    const summaryTable = page.locator('table', { hasText: seed.runNames[0] }).first();
    await expect(summaryTable).toBeVisible({ timeout: 10000 });
    await expect(summaryTable.locator('th', { hasText: 'Pass Rate' }).first()).toBeVisible();
    await expect(summaryTable.locator('tr', { hasText: seed.runNames[0] }).first()).toBeVisible();
    await expect(summaryTable.locator('tr', { hasText: seed.runNames[1] }).first()).toBeVisible();
  });

  test('should display the per-case comparison table with the seeded cases hydrated from real reports', async ({ page }) => {
    await openComparison(page, seed);

    // Both seeded test-case rows must render, by their unique names — not
    // "some table exists somewhere on the page".
    const caseRow1 = page.locator('tr', { hasText: seed.testCaseNames[0] }).first();
    const caseRow2 = page.locator('tr', { hasText: seed.testCaseNames[1] }).first();
    await expect(caseRow1).toBeVisible({ timeout: 10000 });
    await expect(caseRow2).toBeVisible({ timeout: 10000 });

    // The cells hydrate from the REAL seeded report docs (run 1 failed tc 2)
    // — a missing-report fallback would render "Not run" instead of verdicts.
    await expect(caseRow2.locator('text=/Failed/i').first()).toBeVisible({ timeout: 10000 });
  });

  test('expanding a seeded case row shows the Judge grid hydrated from the seeded reports', async ({ page }) => {
    await openComparison(page, seed);

    // Expand the row of seeded test case 2 (the split verdict: failed on run
    // 1, passed on run 2) and open its Judge tab.
    const caseRow = page.locator('tr', { hasText: seed.testCaseNames[1] }).first();
    await expect(caseRow).toBeVisible({ timeout: 10000 });
    await caseRow.click();

    const judgeTab = page.locator('[role="tab"]', { hasText: 'Judge' }).first();
    await expect(judgeTab).toBeVisible({ timeout: 10000 });
    await judgeTab.click();

    // The grid must render one card per seeded run, hydrated with OUR judge
    // reasoning from the real report docs (not "No judge reasoning available").
    const grid = page.locator('[data-testid="judge-comparison-grid"]');
    await expect(grid).toBeVisible({ timeout: 10000 });
    await expect(grid.locator(`text=Seeded judge reasoning 1-2 for ${seed.runNames[0]}`).first()).toBeVisible({ timeout: 10000 });
    await expect(grid.locator(`text=Seeded judge reasoning 2-2 for ${seed.runNames[1]}`).first()).toBeVisible();
  });
});
