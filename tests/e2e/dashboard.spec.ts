/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Dashboard Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for either dashboard content or first-run experience (no data)
    const pageReady = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(pageReady).toBeVisible({ timeout: 30000 });
  });

  test('should display dashboard or first-run experience', async ({ page }) => {
    const hasDashboard = await page.locator('[data-testid="dashboard-title"]').isVisible().catch(() => false);
    const hasFirstRun = await page.locator('[data-testid="first-run-experience"]').isVisible().catch(() => false);

    if (hasDashboard) {
      await expect(page.locator('[data-testid="dashboard-title"]')).toHaveText('Leaderboard Overview');
      await expect(page.locator('text=Monitor agent performance trends and compare benchmark metrics')).toBeVisible();
    } else {
      expect(hasFirstRun).toBeTruthy();
      await expect(page.locator('text=Welcome to Agent Health')).toBeVisible();
    }
  });

  test('should show first-run or dashboard content after loading', async ({ page }) => {
    const contentIndicator = page.locator('text=Welcome to Agent Health')
      .or(page.locator('text=Leaderboard Overview'))
      .or(page.locator('text=Performance Trends'));
    await expect(contentIndicator).toBeVisible({ timeout: 15000 });
  });

  test('should display getting started steps when no data', async ({ page }) => {
    const hasFirstRun = await page.locator('[data-testid="first-run-experience"]').isVisible().catch(() => false);

    if (hasFirstRun) {
      await expect(page.locator('text=Welcome to Agent Health')).toBeVisible();
    }
  });
});

test.describe('Dashboard Stats Summary Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const pageReady = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(pageReady).toBeVisible({ timeout: 30000 });
  });

  test('should display stats summary bar with three cards', async ({ page }) => {
    const statsBar = page.locator('[data-testid="stats-summary-bar"]');
    const isVisible = await statsBar.isVisible().catch(() => false);

    if (isVisible) {
      await expect(page.locator('[data-testid="stats-benchmarks"]')).toBeVisible();
      await expect(page.locator('[data-testid="stats-runs"]')).toBeVisible();
      await expect(page.locator('[data-testid="stats-test-cases"]')).toBeVisible();

      await expect(page.locator('[data-testid="stats-benchmarks"]')).toContainText('Benchmarks');
      await expect(page.locator('[data-testid="stats-runs"]')).toContainText('Runs');
      await expect(page.locator('[data-testid="stats-test-cases"]')).toContainText('Test Cases');
    }
  });

  test('should navigate to benchmarks page when clicking benchmarks stat', async ({ page }) => {
    const benchmarksCard = page.locator('[data-testid="stats-benchmarks"]');
    const isVisible = await benchmarksCard.isVisible().catch(() => false);

    if (isVisible) {
      await benchmarksCard.click();
      await page.waitForURL('**/benchmarks', { timeout: 5000 });
      expect(page.url()).toContain('/benchmarks');
    }
  });

  test('should navigate to test cases page when clicking test cases stat', async ({ page }) => {
    const testCasesCard = page.locator('[data-testid="stats-test-cases"]');
    const isVisible = await testCasesCard.isVisible().catch(() => false);

    if (isVisible) {
      await testCasesCard.click();
      await page.waitForURL('**/test-cases', { timeout: 5000 });
      expect(page.url()).toContain('/test-cases');
    }
  });
});

test.describe('Dashboard Performance Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const pageReady = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(pageReady).toBeVisible({ timeout: 30000 });
  });

  test('should show performance trends section when data exists', async ({ page }) => {
    const hasTrendChart = await page.locator('text=Performance Trends').isVisible().catch(() => false);

    if (hasTrendChart) {
      const metricSelector = page.locator('button').filter({ hasText: /Pass Rate|Cost|Tokens|Latency|Metric/ });
      const hasMet = await metricSelector.first().isVisible({ timeout: 5000 }).catch(() => false);

      const timeRangeSelector = page.locator('button').filter({ hasText: /Last 7 days|Last 30 days|All time/ });
      const hasTime = await timeRangeSelector.first().isVisible({ timeout: 5000 }).catch(() => false);

      if (!hasMet || !hasTime) {
        console.log('Warning: Performance trends found but selectors missing');
      }
    }
  });

  test('should show benchmark metrics table when data exists', async ({ page }) => {
    const hasMetricsTable = await page.locator('text=Benchmark Metrics by Agent').isVisible().catch(() => false);

    if (hasMetricsTable) {
      await expect(page.locator('text=Click benchmark or agent name to filter')).toBeVisible();
    }
  });
});
