/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for Agent Selection
 *
 * All agents (including subprocess/claude-code connectors) run server-side,
 * so every agent should be selectable in the UI without restriction.
 */

import { test, expect } from '@playwright/test';

test.describe('Agent Selection', () => {

  test.describe('QuickRunModal', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/test-cases');
      await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
      await page.waitForTimeout(2000);
    });

    test('should allow selecting any agent in dropdown', async ({ page }) => {
      const testCaseCard = page.locator('[class*="card"]').filter({ hasText: /run/ }).first();

      if (await testCaseCard.isVisible().catch(() => false)) {
        await testCaseCard.hover();
        await page.waitForTimeout(300);

        const runButton = testCaseCard.locator('button[title="Run test case"]');
        if (await runButton.isVisible().catch(() => false)) {
          await runButton.click();
          await page.waitForTimeout(500);

          const agentDropdown = page.locator('button').filter({ hasText: /Agent|Demo Agent|Langgraph/i }).first();
          if (await agentDropdown.isVisible().catch(() => false)) {
            await agentDropdown.click();
            await page.waitForTimeout(300);

            // All agents should be enabled — none should have data-disabled
            const options = page.locator('[role="option"]');
            const count = await options.count();
            for (let i = 0; i < count; i++) {
              const isDisabled = await options.nth(i).getAttribute('data-disabled');
              expect(isDisabled).toBeNull();
            }

            // No "(CLI only)" labels should appear
            const cliOnlyText = page.locator('[role="option"]').filter({ hasText: /CLI only/i });
            await expect(cliOnlyText).toHaveCount(0);

            await page.keyboard.press('Escape');
          }

          await page.keyboard.press('Escape');
        }
      }
    });
  });

  test.describe('BenchmarkRunsPage', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/benchmarks');
      await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
      await page.waitForTimeout(2000);
    });

    test('should allow selecting any agent in run config dialog', async ({ page }) => {
      const benchmarkCard = page.locator('[class*="card"]').filter({ hasText: /\\d+ runs?/ }).first();

      if (await benchmarkCard.isVisible().catch(() => false)) {
        await benchmarkCard.locator('h3').first().click();
        await page.waitForTimeout(2000);

        const addRunButton = page.locator('button:has-text("Add Run")');
        if (await addRunButton.isVisible().catch(() => false)) {
          await addRunButton.click();
          await page.waitForTimeout(500);

          const agentDropdown = page.locator('button').filter({ hasText: /Agent|Select|Demo Agent|Langgraph/i }).first();
          if (await agentDropdown.isVisible().catch(() => false)) {
            await agentDropdown.click();
            await page.waitForTimeout(300);

            // All agents should be enabled
            const options = page.locator('[role="option"]');
            const count = await options.count();
            for (let i = 0; i < count; i++) {
              const isDisabled = await options.nth(i).getAttribute('data-disabled');
              expect(isDisabled).toBeNull();
            }

            await page.keyboard.press('Escape');
          }

          const cancelButton = page.locator('button:has-text("Cancel")').last();
          if (await cancelButton.isVisible()) {
            await cancelButton.click();
          }
        }
      }
    });
  });

  test.describe('SettingsPage', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/settings');
      await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
      await page.waitForTimeout(1000);
    });

    test('should show Agent Endpoints section', async ({ page }) => {
      await expect(page.locator('text=Agent Endpoints').first()).toBeVisible();
    });

    test('should not show CLI-only badges for any agent', async ({ page }) => {
      const cliOnlyBadges = page.locator('span').filter({ hasText: 'CLI only' });
      await expect(cliOnlyBadges).toHaveCount(0);
    });

    test('should show built-in badges for agents', async ({ page }) => {
      const builtInBadges = page.locator('span').filter({ hasText: 'built-in' });
      const builtInCount = await builtInBadges.count();
      expect(builtInCount).toBeGreaterThanOrEqual(3);
    });
  });
});
