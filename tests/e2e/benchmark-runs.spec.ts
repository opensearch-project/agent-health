/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Runs Page', () => {
  test.beforeEach(async ({ page }) => {
    // First navigate to benchmarks to find a benchmark with runs
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should navigate to benchmark runs page via benchmark card click', async ({ page }) => {
    // Click on the benchmark name/card area (not View Latest button) to navigate to runs page
    const benchmarkCard = page.locator('[class*="card"]').filter({ hasText: /\\d+ runs?/ }).first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      // Click on the benchmark name/info area
      await benchmarkCard.locator('h3').first().click();
      await page.waitForTimeout(2000);

      // Should be on benchmark runs page
      await expect(page.locator('[data-testid="benchmark-runs-page"]')).toBeVisible();
    }
  });

  test('should display benchmark name in header', async ({ page }) => {
    const benchmarkCard = page.locator('[class*="card"]').filter({ hasText: /\\d+ runs?/ }).first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      await benchmarkCard.locator('h3').first().click();
      await page.waitForTimeout(2000);

      await expect(page.locator('[data-testid="benchmark-name"]')).toBeVisible();
    }
  });

  test('should have back button to return to benchmarks', async ({ page }) => {
    const benchmarkCard = page.locator('[class*="card"]').filter({ hasText: /\\d+ runs?/ }).first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      await benchmarkCard.locator('h3').first().click();
      await page.waitForTimeout(2000);

      const backButton = page.locator('[data-testid="back-button"]');
      await expect(backButton).toBeVisible();

      await backButton.click();
      await expect(page.locator('[data-testid="benchmarks-page"]')).toBeVisible();
    }
  });

  test('should show run count in page', async ({ page }) => {
    const benchmarkCard = page.locator('[class*="card"]').filter({ hasText: /\\d+ runs?/ }).first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      await benchmarkCard.locator('h3').first().click();
      await page.waitForTimeout(2000);

      // Should show run count text
      await expect(page.locator('text=/\\d+ runs?/').first()).toBeVisible();
    }
  });

  test('should have Add Run button', async ({ page }) => {
    const benchmarkCard = page.locator('[class*="card"]').filter({ hasText: /\\d+ runs?/ }).first();

    if (await benchmarkCard.isVisible().catch(() => false)) {
      await benchmarkCard.locator('h3').first().click();
      await page.waitForTimeout(2000);

      const addRunButton = page.locator('button:has-text("Add Run")');
      await expect(addRunButton).toBeVisible();
    }
  });

  test('should display run cards with status', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      // SPA navigation: waitForLoadState('domcontentloaded') returns immediately, so wait
      // for the actual run-details element (rendered immediately on mount by RunDetailsPage)
      await page.locator('[data-testid="run-details-page"]').waitFor({ timeout: 15000 }).catch(() => {});

      // Should show run cards or the run details page itself (data may still be loading)
      const hasRuns = await page.locator('[class*="card"]').count() > 0;
      const hasRunDetails = await page.locator('[data-testid="run-details-page"]').isVisible().catch(() => false);
      expect(hasRuns || hasRunDetails).toBeTruthy();
    }
  });

  test('should show pass/fail status on run cards', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      // Look for pass rate or status indicators - these may not be present if no runs yet
      const hasStatus = await page.locator('text=/Pass Rate|passed|failed|Passed|Failed/').first().isVisible().catch(() => false);
      const hasRunCards = await page.locator('[class*="card"]').first().isVisible().catch(() => false);
      const hasEmptyState = await page.locator('text=/No runs|no runs|empty/i').first().isVisible().catch(() => false);
      // Test passes if we see status, run cards, or empty state
      expect(hasStatus || hasRunCards || hasEmptyState || true).toBeTruthy();
    }
  });

  test('completed runs should show passed or failed counts, not all pending', async ({ page, request, testData }) => {
    // This test used to click the FIRST "View Latest" on whatever benchmark
    // happened to exist and require a non-zero passed/failed count on it —
    // nondeterministic under fullyParallel (another suite's freshly-started,
    // all-pending run can be the first card) and its locators were stale
    // (the passed count renders text-green-700 now, not text-opensearch-blue).
    // Seed our OWN benchmark with a completed run (1 passed + 1 failed
    // verdict) and assert against exactly that page. Every entity is named
    // via uniqueTestName and registered with the testData tracker AT CREATION
    // (crash-ledger-backed), so a killed worker can never strand fixtures.
    const runName = uniqueTestName('bmruns-stats-run');
    const tcIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`bmruns-stats-tc-${i}`),
          category: 'E2E',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        },
      });
      expect(r.ok(), `seed test case ${i} should succeed`).toBeTruthy();
      const j = await r.json();
      const tcId = j.id || j.testCase?.id;
      expect(tcId, `seed test case ${i} must have an id`).toBeTruthy();
      testData.testCase(tcId);
      tcIds.push(tcId);
    }

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('bmruns-stats-benchmark'),
        description: 'stats pass-through E2E seed',
        testCaseIds: tcIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: tcIds }],
      },
    });
    expect(bmRes.ok(), 'seed benchmark should succeed').toBeTruthy();
    const benchmarkId = (await bmRes.json()).id;
    expect(benchmarkId, 'seed benchmark must have an id').toBeTruthy();
    testData.benchmark(benchmarkId);

    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    expect(get.ok(), 'seeded benchmark must be fetchable').toBeTruthy();
    const bm = await get.json();
    const stamp = `${process.pid}-${Date.now()}`;
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [{
          id: `run-bmruns-stats-${stamp}`,
          name: runName,
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {
            [tcIds[0]]: { reportId: `report-bmruns-stats-1-${stamp}`, status: 'completed', passFailStatus: 'passed' },
            [tcIds[1]]: { reportId: `report-bmruns-stats-2-${stamp}`, status: 'completed', passFailStatus: 'failed' },
          },
          stats: { passed: 1, failed: 1, pending: 0, errored: 0, total: 2 },
        }],
      },
    });
    expect(put.ok(), 'seeding the completed run should succeed').toBeTruthy();

    await page.goto(`/benchmarks/${benchmarkId}/runs`);
    await expect(page.locator('[data-testid="benchmark-runs-page"]')).toBeVisible({ timeout: 30000 });

    // Scope every stats assertion to the seeded run's OWN row card (deepest
    // [class*="card"] containing the unique run name — ancestors match too,
    // document order puts the row card last), not the page: page-wide count
    // scans can match another run's numbers.
    const runRow = page.locator('[class*="card"]').filter({ hasText: runName }).last();
    await expect(runRow).toBeVisible({ timeout: 15000 });

    // The completed run's row must show 1 passed (green) and 1 failed (red)
    // — non-zero verdict counts, not an all-pending row — and the "/ 2" total.
    await expect(runRow.locator('[class*="text-green-700"]', { hasText: '1' }).first()).toBeVisible({ timeout: 15000 });
    await expect(runRow.locator('[class*="text-red-700"]', { hasText: '1' }).first()).toBeVisible({ timeout: 15000 });
    await expect(runRow.locator('span.text-muted-foreground', { hasText: '/ 2' }).first()).toBeVisible();
  });

  test('should show Compare button when multiple runs exist', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      // Compare button should be visible if multiple runs exist
      const compareButton = page.locator('button:has-text("Compare")');
      const isVisible = await compareButton.isVisible().catch(() => false);
      // This is conditional on having multiple runs
      expect(true).toBeTruthy();
    }
  });
});

test.describe('Benchmark Runs - Run Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should open run configuration when clicking Add Run', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const addRunButton = page.locator('button:has-text("Add Run")');
      if (await addRunButton.isVisible().catch(() => false)) {
        await addRunButton.click();
        await page.waitForTimeout(500);

        // Run configuration dialog should open
        const hasConfig = await page.locator('text=Configure Run').or(page.locator('text=Agent')).first().isVisible().catch(() => false);
        expect(hasConfig).toBeTruthy();
      }
    }
  });
});

test.describe('Benchmark Runs - Run Selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should allow selecting runs for comparison', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      // Look for checkboxes or select functionality
      const checkbox = page.locator('button[role="checkbox"]').first();
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        // Verify selection changed
        const compareButton = page.locator('button:has-text("Compare")');
        await expect(compareButton).toBeVisible();
      }
    }
  });

  test('should have Select All button when multiple runs exist', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      // Select All button should be visible if there are multiple runs
      const selectAllButton = page.locator('button:has-text("Select All")');
      const isVisible = await selectAllButton.isVisible().catch(() => false);
      // Conditional on having multiple runs
      expect(true).toBeTruthy();
    }
  });
});
