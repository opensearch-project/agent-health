/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Chrome-vertical-tabs-style sidebar hover-open.
 *
 * When the sidebar is pinned collapsed (icon rail), hovering — or
 * keyboard-focusing — the rail must temporarily expand the FULL sidebar as an
 * OVERLAY: the content area keeps reserving the rail width (no reflow), and
 * leaving/blurring it collapses the sidebar again. The expand button inside
 * the expanded sidebar acts as "pin open" and persists.
 */

// Import the local fixtures (not the raw '@playwright/test' module) so this
// spec's page interactions are captured by the E2E Istanbul coverage
// collector (see tests/e2e/fixtures/test-fixtures.ts) — this spec exercises
// most of Layout.tsx's hover-open logic.
import { test, expect } from './fixtures/test-fixtures';
import type { Page } from '@playwright/test';

// Loads `path` with the sidebar ALREADY pinned collapsed (via localStorage,
// like a returning user) and the virtual mouse parked away from the rail's
// screen region — set up BEFORE navigation, not after. The default cursor
// position for a brand-new page is (0,0), which overlaps the collapsed rail
// (0..64px); moving it away only after the page has rendered leaves a race
// window (hydration/render time) during which that (0,0) cursor can
// spuriously trigger the MOUSE hover-open before the test gets a chance to
// move it — contaminating what's meant to be a keyboard-only scenario.
async function gotoWithRailCollapsed(page: Page, path = '/settings') {
  await page.mouse.move(700, 400);
  await page.goto(path);
  await page.evaluate(() => localStorage.setItem('agent-health:sidebar:collapsed', 'true'));
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
}

test.describe('Sidebar hover-open', () => {
  test('collapsed rail expands to the full sidebar on hover as an overlay and collapses on leave', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(zone).toBeVisible();

    // Pin collapsed via the collapse button.
    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar).toHaveCSS('width', '64px');

    // Hover the rail → the FULL sidebar expands (after the 150ms intent
    // delay) while the layout zone keeps the rail width — content never
    // moves. Every nav group (not just one item) is visible in the expansion.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar.getByText('Overview', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Evaluations', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Settings', { exact: true })).toBeVisible();

    // Leave the sidebar → collapses back to the rail (250ms grace).
    await page.mouse.move(700, 400);
    await expect(sidebar).toHaveCSS('width', '64px');

    // The pin preference persisted: still a rail after reload.
    await page.reload();
    await expect(zone).toHaveCSS('width', '64px');
  });

  test('real keyboard Tab into the collapsed rail opens the full sidebar; Shift+Tab back out closes it (a11y — not mouse-only)', async ({ page }) => {
    const sidebar = page.locator('[data-testid="sidebar"]');
    const expandBtn = page.getByLabel('Expand sidebar');

    // Fresh load, already pinned collapsed, mouse parked away — nothing is
    // focused yet, mirroring a keyboard user tabbing in from outside the
    // page (e.g. from the browser chrome) on a returning visit.
    await gotoWithRailCollapsed(page);
    await expect(sidebar).toHaveCSS('width', '64px');

    // First REAL Tab keypress (page.keyboard.press dispatches an actual key
    // event through the browser's native focus-traversal, NOT el.focus() —
    // a scripted .focus() call bypasses tab order/event-bubbling entirely and
    // would pass even if the rail were unreachable by a real keyboard). It
    // must land on the rail's first focusable element AND open the overlay
    // immediately (no hover-intent delay for keyboard users).
    await page.keyboard.press('Tab');
    await expect(expandBtn).toBeFocused();
    await expect(sidebar).toHaveCSS('width', '180px');

    // Tabbing further while still inside the sidebar subtree keeps it open —
    // focus never leaves the hover zone.
    await page.keyboard.press('Tab');
    await expect(sidebar).toHaveCSS('width', '180px');

    // Shift+Tab (real reverse traversal) back to the rail's first element,
    // then OUT of the sidebar subtree entirely — must collapse back to the
    // rail (onBlur's relatedTarget check sees the newly-focused element is
    // no longer inside the hover zone).
    await page.keyboard.press('Shift+Tab');
    await expect(expandBtn).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(sidebar).toHaveCSS('width', '64px');
  });

  test('Escape closes the keyboard-opened overlay without moving focus', async ({ page }) => {
    const sidebar = page.locator('[data-testid="sidebar"]');
    const expandBtn = page.getByLabel('Expand sidebar');

    await gotoWithRailCollapsed(page);
    await expect(sidebar).toHaveCSS('width', '64px');

    await page.keyboard.press('Tab');
    await expect(expandBtn).toBeFocused();
    await expect(sidebar).toHaveCSS('width', '180px');

    // Escape collapses the overlay but does NOT move focus — the DOM nodes
    // never unmount (only their CSS width/labels change), so the same
    // element stays focused, just narrower.
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveCSS('width', '64px');
    await expect(expandBtn).toBeFocused();
  });

  test('mouse-leave does not collapse the sidebar while a keyboard user still has focus inside (mixed modality)', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');

    // Open via mouse hover, then move keyboard focus onto a link inside via
    // a REAL Tab press (not .focus()) — now both the pointer and focus are
    // "in" the zone.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await page.keyboard.press('Tab');
    await expect(zone.locator(':focus')).toHaveCount(1);

    // Mouse leaves, but focus is still inside — must NOT collapse (a naive
    // mouseleave timer with no focus check would close it out from under
    // the focused link after the 250ms grace).
    await page.mouse.move(700, 400);
    await page.waitForTimeout(400);
    await expect(sidebar).toHaveCSS('width', '180px');

    // Moving focus away too now collapses it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(sidebar).toHaveCSS('width', '64px');
  });

  test('blur does not collapse the sidebar while the mouse is still hovering it (mixed modality)', async ({ page }) => {
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    await expect(zone).toHaveCSS('width', '64px');

    // Open via mouse hover, then focus a link inside (real Tab, not
    // .focus()) without moving the mouse.
    await zone.hover();
    await expect(sidebar).toHaveCSS('width', '180px');
    await page.keyboard.press('Tab');

    // Blur the focused link WITHOUT moving the mouse away — the mouse still
    // owns the open state (no fresh mouseenter will ever fire since the
    // cursor never moved), so it must stay open.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(sidebar).toHaveCSS('width', '180px');

    // Actually moving the mouse away now collapses it.
    await page.mouse.move(700, 400);
    await expect(sidebar).toHaveCSS('width', '64px');
  });

  test('expand button inside the hover-open sidebar pins it open', async ({ page }) => {
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

  test('the collapsed Evaluations icon and the expanded Evaluations link share the nav-evals3 testid', async ({ page }) => {
    // Regression guard for the flyout mid-click retarget: both the rail's
    // icon-only Evaluations button and the hover-opened group-header link
    // must carry the same testid so a click that starts on the rail lands on
    // the expanded target if the flyout swaps in mid-click.
    await page.goto('/settings');
    const zone = page.locator('[data-testid="sidebar-hover-zone"]');
    const sidebar = page.locator('[data-testid="sidebar"]');

    await page.getByLabel('Collapse sidebar').click();
    // Let the collapse transition finish BEFORE hovering. The hover zone
    // animates 180px -> 64px over 200ms; hovering mid-transition lets
    // Playwright pick a center point that ends up OUTSIDE the settled 64px
    // rail, so Chromium synthesizes a mouseleave once the zone finishes
    // shrinking under the stationary cursor and the flyout collapses again
    // 250ms later (observed in CI as 178px -> 80px -> 64px). Waiting for the
    // settled rail width first, then hovering well inside it, removes the
    // race — the same sequence the first test in this file already uses.
    await expect(zone).toHaveCSS('width', '64px');
    await expect(sidebar).toHaveCSS('width', '64px');
    const collapsedEvals = sidebar.locator('a[data-testid="nav-evals3"]');
    await expect(collapsedEvals).toBeVisible();
    await expect(collapsedEvals).toHaveAttribute('href', /\/evaluations\/runs$/);

    await zone.hover({ position: { x: 32, y: 300 } });
    await expect(sidebar).toHaveCSS('width', '180px');
    const expandedEvals = sidebar.locator('a[data-testid="nav-evals3"]');
    await expect(expandedEvals).toBeVisible();
    await expect(expandedEvals).toHaveAttribute('href', /\/evaluations\/runs$/);
  });
});
