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
      await expect(page.locator('text=Surface failing runs and regressions to improve your agent fast')).toBeVisible();
    } else {
      expect(hasFirstRun).toBeTruthy();
      await expect(page.locator('[data-testid="first-run-experience"]')).toBeVisible();
      await expect(page.locator('text=Know if your agent is actually working')).toBeVisible();
    }
  });

  test('should show first-run or dashboard content after loading', async ({ page }) => {
    const contentIndicator = page.locator('text=Know if your agent is actually working')
      .or(page.locator('[data-testid="first-run-experience"]'))
      .or(page.locator('text=Leaderboard Overview'))
      .or(page.locator('text=Recent Evaluation Runs'));
    await expect(contentIndicator.first()).toBeVisible({ timeout: 15000 });
  });

  test('should display getting started steps when no data', async ({ page }) => {
    const hasFirstRun = await page.locator('[data-testid="first-run-experience"]').isVisible().catch(() => false);

    if (hasFirstRun) {
      await expect(page.locator('[data-testid="first-run-experience"]')).toBeVisible();
      await expect(page.locator('text=Know if your agent is actually working')).toBeVisible();
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
      await page.waitForURL(/.*\/benchmarks/, { timeout: 5000 });
      expect(page.url()).toContain('/benchmarks');
    }
  });

  test('should navigate to test cases page when clicking test cases stat', async ({ page }) => {
    const testCasesCard = page.locator('[data-testid="stats-test-cases"]');
    const isVisible = await testCasesCard.isVisible().catch(() => false);

    if (isVisible) {
      await testCasesCard.click();
      await page.waitForURL(/.*\/test-cases/, { timeout: 5000 });
      expect(page.url()).toContain('/test-cases');
    }
  });
});

test.describe('Dashboard Recent Runs Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const pageReady = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(pageReady).toBeVisible({ timeout: 30000 });
  });

  test('should show Recent Evaluation Runs section when data exists', async ({ page }) => {
    const hasRecent = await page.locator('[data-testid="recent-runs-card"]').isVisible().catch(() => false);

    if (hasRecent) {
      await expect(page.locator('text=Recent Evaluation Runs')).toBeVisible();
    }
  });

  test('should show Needs Attention section when data exists', async ({ page }) => {
    const hasNeedsAttention = await page.locator('[data-testid="needs-attention-card"]').isVisible().catch(() => false);

    if (hasNeedsAttention) {
      await expect(page.locator('text=Needs Attention')).toBeVisible();
    }
  });
});
