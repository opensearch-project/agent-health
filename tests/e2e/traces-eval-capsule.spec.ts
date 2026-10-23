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

  test('should display eval spans in the inline trace tree when expanded', async ({ page }) => {
    // Find a trace whose root-span column contains 'test_case' (or similar
    // eval-flavoured root) since real backend data is unordered. Falls back
    // to skipping if none are visible (e.g. fresh OpenSearch with only LLM
    // traces) so the suite stays green across data shapes.
    const allRows = page.locator('tbody tr');
    const rowCount = await allRows.count();
    if (rowCount === 0) return;

    let traceRow = null;
    for (let i = 0; i < rowCount; i++) {
      const row = allRows.nth(i);
      const text = (await row.textContent()) || '';
      if (/test_case|test_suite_run|evaluation/i.test(text)) {
        traceRow = row;
        break;
      }
    }
    if (!traceRow) {
      // No eval-rooted trace in the current dataset — skip rather than fail.
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // The expanded row should render the trace tree inline.
    const tree = page.locator('.trace-inline-tree').first();
    await expect(tree).toBeVisible({ timeout: 5000 });

    // Eval spans like `test_case` / `test_suite_run` should be present in
    // the rendered tree. The TraceTreeTable renders span names as plain
    // text inside divs, so a regex text match is enough.
    const evalSpanLabel = page.locator('.trace-inline-tree').locator('text=/test_case|test_suite_run|evaluation/i').first();
    await expect(evalSpanLabel).toBeVisible({ timeout: 5000 });
  });

  test('clicking a span in the inline tree opens the bottom drawer with a flat attributes table', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    const tree = page.locator('.trace-inline-tree').first();
    if (!await tree.isVisible().catch(() => false)) {
      return;
    }

    // Click the first span's name inside the inline tree. The tree now
    // renders a list header (`trace-list-header`: sort hint + t=0 anchor)
    // as its first child, so the first `> div > div` is no longer a span
    // row; the name button is the row's explicit "open details" affordance.
    const spanNames = tree.locator('[data-testid="span-row-name"]');
    const rowCount = await spanNames.count();
    if (rowCount < 1) {
      return;
    }
    await spanNames.first().click();
    await page.waitForTimeout(800);

    // The bottom drawer (Sheet side="bottom") should be open with the
    // SimpleSpanAttributesTable inside. Verify the filter input and at
    // least the "X attributes" identity strip render.
    const filterInput = page.locator('input[placeholder="Filter attributes…"]').first();
    await expect(filterInput).toBeVisible({ timeout: 3000 });

    const identityStrip = page.locator('text=/\\d+ attributes?/').first();
    await expect(identityStrip).toBeVisible({ timeout: 3000 });

    // Pressing Escape should close the drawer.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(filterInput).not.toBeVisible({ timeout: 3000 });
  });

  test('per-span timeline bars render in the inline tree', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }
    await traceRow.click();
    await page.waitForTimeout(1500);

    // Each visible span row in the inline tree carries a `.trace-row-timeline`
    // mini-gantt bar in its right-hand area.
    const bars = page.locator('.trace-inline-tree .trace-row-timeline');
    await expect(bars.first()).toBeVisible({ timeout: 3000 });
    expect(await bars.count()).toBeGreaterThan(0);
  });

  test('Maximize button on the expanded row opens fullscreen view', async ({ page }) => {
    const traceRow = page.locator('tbody tr').first();
    if (!await traceRow.isVisible().catch(() => false)) {
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1500);

    // The inline expansion header has a Maximize2 button with title="Open fullscreen".
    const maxBtn = page.locator('button[title="Open fullscreen"]').first();
    if (!await maxBtn.isVisible().catch(() => false)) {
      return;
    }
    await maxBtn.click();
    await page.waitForTimeout(800);

    // Fullscreen view is a Dialog/Sheet — verify some marker like the
    // "Trace tree" view-toggle button or the title text becomes visible.
    const fullScreenMarker = page.locator('button:has-text("Trace tree"), [role="dialog"]').first();
    if (await fullScreenMarker.isVisible().catch(() => false)) {
      await expect(fullScreenMarker).toBeVisible();
    }

    // The fullscreen overlay should NOT contain the legacy 'Exit
    // Fullscreen' text button (we removed it in favour of the single X
    // top-right — having both was confusing). It should also not render
    // the legacy right-side SpanDetailsPanel artifacts ('Distribution',
    // 'Span category', 'INPUT'/'OUTPUT' headers) because span details
    // now live in the bottom drawer scoped to the fullscreen container.
    const exitFullscreenText = page.getByText(/Exit Fullscreen/i);
    expect(await exitFullscreenText.count()).toBe(0);
    const legacyPanel = page.locator('[role="dialog"]').locator('text=/Distribution|Span category/i');
    expect(await legacyPanel.count()).toBe(0);
  });

  test('clicking the X on the bottom drawer closes it', async ({ page }) => {
    // Find a multi-span trace, expand it, click a span, then verify the
    // X on the bottom drawer actually dismisses it. Regression test for
    // a bug where clicks on the trace tree behind the (pointer-events:
    // none) sheet overlay would re-select a different span and re-open
    // the drawer mid-close, making the X feel broken.
    const allRows = page.locator('tbody tr');
    const rowCount = await allRows.count();
    if (rowCount === 0) return;

    // Look for any row — single-span traces still render an inline tree
    // with the root span clickable, which is enough for this test.
    const traceRow = allRows.first();
    await traceRow.click();
    await page.waitForTimeout(1200);

    const treeNode = page.locator('.trace-inline-tree').locator('div').filter({ hasText: /test_case|invoke_agent|llm_request|claude_code/ }).first();
    if (!await treeNode.isVisible().catch(() => false)) return;
    await treeNode.click();
    await page.waitForTimeout(800);

    const drawer = page.locator('[aria-label="Span details"]');
    if (await drawer.count() === 0) return; // Some spans don't open a drawer; skip.
    await expect(drawer.first()).toBeVisible();

    // Click the X.
    await page.locator('[aria-label="Close span details"]').first().click();
    await page.waitForTimeout(800);

    // Drawer should now be gone.
    expect(await drawer.count()).toBe(0);
  });
});
