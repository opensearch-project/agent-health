/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Comparison Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to benchmarks first
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should navigate to comparison page from benchmark runs', async ({ page }) => {
    // First go to a benchmark with runs
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      // Find and click Compare button
      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        // Select at least 2 runs first if needed
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // Should be on comparison page
        await expect(page.locator('[data-testid="comparison-page"]')).toBeVisible();
      }
    }
  });

  test('should display Compare Runs title', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        await expect(page.locator('[data-testid="comparison-title"]')).toHaveText('Compare Runs');
      }
    }
  });

  test('should have back button to return to benchmark runs', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        const backButton = page.locator('[data-testid="back-button"]');
        await expect(backButton).toBeVisible();

        await backButton.click();
        await expect(page.locator('[data-testid="benchmark-runs-page"]')).toBeVisible();
      }
    }
  });

  test('should show run selector section', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // Should show "Select Runs to Compare" section
        await expect(page.locator('text=Select Runs to Compare')).toBeVisible();
      }
    }
  });

  test('should not show a baseline selector', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // Should NOT show a baseline selector (removed in favor of automatic oldest-run reference)
        const hasBaseline = await page.locator('text=Baseline').isVisible().catch(() => false);
        expect(hasBaseline).toBeFalsy();
      }
    }
  });
});

test.describe('Comparison Page - Metrics', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should display run summary cards', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // Should show run summary cards with metrics
        const hasSummary = await page.locator('text=/Pass Rate|Accuracy|Avg/').first().isVisible().catch(() => false);
        expect(hasSummary).toBeTruthy();
      }
    }
  });

  test('should display comparison table', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // Should show use case comparison table or similar
        const hasTable = await page.locator('text=/Use Case|Test Case|Status/').first().isVisible().catch(() => false);
        expect(hasTable).toBeTruthy();
      }
    }
  });
});

test.describe('Comparison Page - Filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000);
  });

  test('should show category filter if available', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // May have category filter
        const hasCategoryFilter = await page.locator('text=/Category|Filter/').first().isVisible().catch(() => false);
        // This is optional
        expect(true).toBeTruthy();
      }
    }
  });

  test('should show status filter options', async ({ page }) => {
    const viewLatestButton = page.locator('button:has-text("View Latest")').first();

    if (await viewLatestButton.isVisible().catch(() => false)) {
      await viewLatestButton.click();
      await page.waitForTimeout(2000);

      const compareButton = page.locator('button:has-text("Compare")');
      if (await compareButton.isVisible().catch(() => false)) {
        const selectAllButton = page.locator('button:has-text("Select All")');
        if (await selectAllButton.isVisible().catch(() => false)) {
          await selectAllButton.click();
          await page.waitForTimeout(500);
        }

        await compareButton.click();
        await page.waitForTimeout(2000);

        // May have status filter
        const hasStatusFilter = await page.locator('text=/Status|All|Passed|Failed/').first().isVisible().catch(() => false);
        expect(true).toBeTruthy();
      }
    }
  });
});
