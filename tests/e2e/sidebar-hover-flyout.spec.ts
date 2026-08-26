/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Chrome-vertical-tabs-style sidebar flyout.
 *
 * When the sidebar is pinned collapsed (icon rail), hovering the rail must
 * temporarily expand it as an OVERLAY — the content area keeps the rail width
 * (no reflow) — and leaving must collapse it again. The expand button inside
 * the flyout acts as "pin open" and persists.
 */

// Import the local fixtures (not the raw '@playwright/test' module) so this
// spec's page interactions are captured by the E2E Istanbul coverage
// collector (see tests/e2e/fixtures/test-fixtures.ts) — this spec exercises
// most of Layout.tsx's hover-flyout logic and was previously invisible to
// coverage reporting entirely.
import { test, expect } from './fixtures/test-fixtures';

test.describe('Sidebar hover flyout', () => {
  test('collapsed rail expands on hover as an overlay and collapses on leave', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(zone).toBeVisible();

    // Pin collapsed via the collapse button.
    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar).toHaveCSS('width', '64px');

    // Hover the rail → flyout expands the SIDEBAR (after the 150ms intent
    // delay) while the layout zone keeps the rail width — content never moves.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar.getByText('Settings', { exact: true })).toBeVisible();

    // Leave the sidebar → collapses back to the rail (250ms grace).
    await page.mouse.move(700, 400);
    await expect(sidebar).toHaveCSS('width', '64px');

    // The pin preference persisted: still a rail after reload.
    await page.reload();
    await expect(zone).toHaveCSS('width', '64px');
  });

  test('expand button inside the flyout pins the sidebar open', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');

    // Fly out, then pin open.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await page.getByLabel('Expand sidebar').click();

    // Pinned: the LAYOUT zone widens too (content reflows), and mousing away
    // no longer collapses it.
    await expect(zone).toHaveCSS('width', '180px');
    await page.mouse.move(700, 400);
    await expect(sidebar).toHaveCSS('width', '180px');

    // Persisted across reload.
    await page.reload();
    await expect(zone).toHaveCSS('width', '180px');
  });
});
