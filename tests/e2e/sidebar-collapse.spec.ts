/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: left nav (sidebar) collapse behavior.
 *
 *   1. The collapse/expand preset is REMEMBERED — persisted to localStorage
 *      (`agent-health:sidebar:collapsed`) and survives a reload.
 *   2. Landing on a SPECIFIC run URL (`/runs/<id>`, `/evaluations/runs/<id>`,
 *      …/runs/<id>/inspect) collapses the nav (dense single-run view), even
 *      when the saved preset is "expanded".
 *
 * Assertions key off the toolbar toggle: "Collapse sidebar" shows when
 * expanded, "Expand sidebar" shows when collapsed.
 */

import { test, expect } from './fixtures/test-fixtures';

const EXPANDED = 'button[aria-label="Collapse sidebar"]'; // visible only when expanded
const COLLAPSED = 'button[aria-label="Expand sidebar"]';  // visible only when collapsed

test.describe('Sidebar collapse — persistence + run URLs', () => {
  test('remembers the collapse preset across reloads', async ({ page }) => {
    // Fresh Playwright context => empty localStorage => sidebar starts expanded.
    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    // Default: expanded.
    await expect(page.locator(EXPANDED)).toBeVisible();

    // Collapse via the toggle.
    await page.locator(EXPANDED).click();
    await expect(page.locator(COLLAPSED)).toBeVisible();

    // Reload — the preset is remembered (still collapsed).
    await page.reload();
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator(COLLAPSED)).toBeVisible();
  });

  test('collapses when landing on a specific run URL even if the preset is expanded', async ({ page }) => {
    // Saved preset = expanded.
    await page.addInitScript(() => localStorage.setItem('agent-health:sidebar:collapsed', 'false'));

    // A run-LIST URL must NOT force-collapse.
    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator(EXPANDED)).toBeVisible();

    // A specific run URL collapses the nav (route-driven; holds even if the
    // run doesn't exist — the collapse fires on landing and is persisted).
    await page.goto('/runs/e2e-nonexistent-run');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator(COLLAPSED)).toBeVisible();
  });

  test('collapsed Evaluations button navigates to the Evaluation Runs page', async ({ page }) => {
    // Start collapsed so the icon-only Evaluations button is the one rendered.
    await page.addInitScript(() => localStorage.setItem('agent-health:sidebar:collapsed', 'true'));
    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator(COLLAPSED)).toBeVisible(); // confirm collapsed

    // The closed-navbar Evaluations button points at Evaluation Runs, not Benchmarks.
    // SidebarMenuButton uses asChild, so the testid lands on the <a> itself.
    const evalsBtn = page.locator('a[data-testid="nav-evals3"]');
    await expect(evalsBtn).toBeVisible();
    await expect(evalsBtn).toHaveAttribute('href', /\/evaluations\/runs$/);
    await expect(evalsBtn).not.toHaveAttribute('href', /benchmarks/);
  });
});
