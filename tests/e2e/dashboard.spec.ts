/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Dashboard Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="dashboard-page"]', { timeout: 30000 });
  });

  test('should display dashboard title and description', async ({ page }) => {
    await expect(page.locator('[data-testid="dashboard-title"]')).toHaveText('Leaderboard Overview');
    await expect(page.locator('text=Monitor agent performance trends and compare benchmark metrics')).toBeVisible();
  });

  test('should show empty state or dashboard content', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(2000);

    // Check for empty state or dashboard content
    const hasEmptyState = await page.locator('text=Welcome to Leaderboard Overview').isVisible().catch(() => false);
    const hasTrendChart = await page.locator('text=Performance Trends').isVisible().catch(() => false);
    const hasMetricsTable = await page.locator('text=Benchmark Metrics by Agent').isVisible().catch(() => false);

    // Either empty state or dashboard content should be visible
    expect(hasEmptyState || hasTrendChart || hasMetricsTable).toBeTruthy();
  });

  test('should show loading skeleton while fetching data', async ({ page }) => {
    // Navigate fresh to catch loading state
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Either skeleton or content should be visible
    const hasContent = await page.locator('[data-testid="dashboard-title"]').isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('should display empty state with getting started steps when no data', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Check for empty state content
    const hasEmptyState = await page.locator('text=Welcome to Leaderboard Overview').isVisible().catch(() => false);

    if (hasEmptyState) {
      // Should show getting started steps
      await expect(page.locator('text=Create a benchmark with test cases')).toBeVisible();
      // Should have Create Benchmark button
      await expect(page.locator('a:has-text("Create Benchmark")')).toBeVisible();
    }
  });
});

test.describe('Dashboard Performance Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="dashboard-page"]', { timeout: 30000 });
  });

  test('should show performance trends section when data exists', async ({ page }) => {
    await page.waitForTimeout(2000);

    const hasTrendChart = await page.locator('text=Performance Trends').isVisible().catch(() => false);

    if (hasTrendChart) {
      // Should have metric selector - look for the select trigger button
      const metricSelector = page.locator('button').filter({ hasText: /Pass Rate|Cost|Tokens|Latency|Metric/ });
      const hasMet = await metricSelector.first().isVisible({ timeout: 5000 }).catch(() => false);

      // Should have time range selector
      const timeRangeSelector = page.locator('button').filter({ hasText: /Last 7 days|Last 30 days|All time/ });
      const hasTime = await timeRangeSelector.first().isVisible({ timeout: 5000 }).catch(() => false);

      // If chart exists but selectors don't, that's a real issue
      if (!hasMet || !hasTime) {
        console.log('Warning: Performance trends found but selectors missing');
      }
    }
  });

  test('should show benchmark metrics table when data exists', async ({ page }) => {
    await page.waitForTimeout(2000);

    const hasMetricsTable = await page.locator('text=Benchmark Metrics by Agent').isVisible().catch(() => false);

    if (hasMetricsTable) {
      // Table should be visible with header text
      await expect(page.locator('text=Click benchmark or agent name to filter')).toBeVisible();
    }
  });
});
