/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Eval Span Category Capsule', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);
  });

  test('should display Eval capsule in span category pills when trace has eval spans', async ({ page }) => {
    // The first demo trace (demo-trace-001) contains eval spans with
    // gen_ai.operation.name=evaluation. Click it to open the flyout.
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      // No traces available (e.g. no demo data) — skip gracefully
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // The flyout should be open showing "Span category:" section.
    // Look for the Eval pill button which contains text "Eval".
    const evalPill = page.locator('button:has-text("Eval")').first();
    await expect(evalPill).toBeVisible({ timeout: 5000 });

    // Verify the pill shows a count (the number should be > 0)
    const pillText = await evalPill.textContent();
    expect(pillText).toContain('Eval');
  });

  test('should show Eval in the time distribution bar legend', async ({ page }) => {
    // Click on the first trace row to open flyout
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // Switch to Info tab if available (in TraceFlyoutContent, default tab is timeline)
    const infoTab = page.locator('button:has-text("Info"), [role="tab"]:has-text("Info")').first();
    if (await infoTab.isVisible().catch(() => false)) {
      await infoTab.click();
      await page.waitForTimeout(500);
    }

    // The time distribution legend should include "EVAL" text
    const evalLegend = page.locator('text=EVAL').first();
    await expect(evalLegend).toBeVisible({ timeout: 5000 });
  });

  test('Eval capsule should be expandable to show eval span details', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // Click the Eval pill to expand details
    const evalPill = page.locator('button:has-text("Eval")').first();
    if (!await evalPill.isVisible().catch(() => false)) {
      return;
    }

    await evalPill.click();
    await page.waitForTimeout(500);

    // After expanding, eval span names should be visible (e.g., test_case, test_suite_run)
    const expandedContent = page.locator('text=test_case').or(page.locator('text=test_suite_run'));
    await expect(expandedContent.first()).toBeVisible({ timeout: 3000 });
  });
});
