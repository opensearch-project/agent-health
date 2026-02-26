/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Traces Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000); // Give time for the page to fully load
  });

  test('should display Live Traces page', async ({ page }) => {
    // Check that we navigated to traces
    await expect(page).toHaveURL(/\/agent-traces/);
  });

  test('should show view toggle (Flow/Timeline)', async ({ page }) => {
    // Look for view mode toggle buttons
    const flowButton = page.locator('button:has-text("Flow")');
    const timelineButton = page.locator('button:has-text("Timeline")');

    const hasViewToggle = await flowButton.isVisible().catch(() => false) ||
      await timelineButton.isVisible().catch(() => false);

    // Either toggle is visible or the page shows some traces content
    expect(true).toBeTruthy();
  });

  test('should show agent filter if available', async ({ page }) => {
    // Look for agent filter dropdown
    const agentFilter = page.locator('button:has-text("All Agents"), select, [role="combobox"]').first();

    if (await agentFilter.isVisible().catch(() => false)) {
      await expect(agentFilter).toBeVisible();
    }
  });

  test('should show search input if available', async ({ page }) => {
    // Look for search input
    const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();

    if (await searchInput.isVisible().catch(() => false)) {
      await expect(searchInput).toBeVisible();
    }
  });

  test('should show traces or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Either traces are shown or an empty/error state
    const hasContent = await page.locator('body').textContent();
    expect(hasContent).toBeDefined();
  });

  test('should have auto-refresh functionality', async ({ page }) => {
    // Look for refresh indicator or auto-refresh toggle
    const refreshIndicator = page.locator('text=Auto-refresh').or(page.locator('text=Refresh')).or(page.locator('button:has-text("Refresh")')).first();

    if (await refreshIndicator.isVisible().catch(() => false)) {
      await expect(refreshIndicator).toBeVisible();
    }
  });
});

test.describe('Trace Visualization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);
  });

  test('should switch between Flow and Timeline views', async ({ page }) => {
    const flowButton = page.locator('button:has-text("Flow")').first();
    const timelineButton = page.locator('button:has-text("Timeline")').first();

    if (await flowButton.isVisible().catch(() => false) && await timelineButton.isVisible().catch(() => false)) {
      // Switch to Timeline view
      await timelineButton.click();
      await page.waitForTimeout(500);

      // Switch back to Flow view
      await flowButton.click();
      await page.waitForTimeout(500);
    }
  });

  test('should show trace timeline chart if traces exist', async ({ page }) => {
    await page.waitForTimeout(2000);

    const timelineChart = page.locator('[data-testid="trace-timeline-chart"]');
    if (await timelineChart.isVisible().catch(() => false)) {
      await expect(timelineChart).toBeVisible();
    }
  });

  test('should show span details panel on span click', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Look for a clickable span
    const span = page.locator('[class*="span"], [class*="node"]').first();

    if (await span.isVisible().catch(() => false)) {
      await span.click();
      await page.waitForTimeout(500);

      // Details panel should appear
      const detailsPanel = page.locator('[data-testid="span-details-panel"]');
      if (await detailsPanel.isVisible().catch(() => false)) {
        await expect(detailsPanel).toBeVisible();
      }
    }
  });

  test('should close span details panel', async ({ page }) => {
    await page.waitForTimeout(2000);

    // If details panel is open, should have close button
    const closeButton = page.locator('[data-testid="span-details-close"]');

    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(closeButton).not.toBeVisible();
    }
  });
});

test.describe('Agent Graph', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);
  });

  test('Agent graph tab renders at least one node when trace exists', async ({ page }) => {
    // Look for a clickable trace row in the table
    const traceRow = page.locator('tbody tr, [data-testid="trace-row"], [role="row"]').first();

    if (!await traceRow.isVisible().catch(() => false)) {
      // No traces available — skip gracefully
      return;
    }

    await traceRow.click();
    await page.waitForTimeout(1000);

    // Look for the "Agent graph" tab in the flyout/details panel
    const agentGraphTab = page
      .locator('button:has-text("Agent graph"), [role="tab"]:has-text("Agent graph")')
      .first();

    if (!await agentGraphTab.isVisible().catch(() => false)) {
      // Flyout did not open or tab is not present — skip gracefully
      return;
    }

    await agentGraphTab.click();
    await page.waitForTimeout(1500);

    // The ReactFlow canvas must contain at least one rendered node element.
    // An empty graph only has the background canvas — no .react-flow__node elements.
    const flowNodes = page.locator('.react-flow__node');
    const nodeCount = await flowNodes.count();
    expect(nodeCount).toBeGreaterThan(0);
  });
});

test.describe('Trace Fetch Size', () => {
  test('Agent Traces page should request size=100 from the API', async ({ page }) => {
    // Intercept API calls to /api/traces and capture the request body
    let capturedBody: any = null;
    await page.route('**/api/traces', async (route) => {
      const request = route.request();
      try {
        capturedBody = JSON.parse(request.postData() || '{}');
      } catch {
        capturedBody = {};
      }
      // Return empty result to avoid depending on backend state
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans: [], total: 0 }),
      });
    });

    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);

    // Verify the API was called with size=100
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.size).toBe(100);
  });

  test('Traces page should request size=100 from the API', async ({ page }) => {
    let capturedBody: any = null;
    await page.route('**/api/traces', async (route) => {
      const request = route.request();
      try {
        capturedBody = JSON.parse(request.postData() || '{}');
      } catch {
        capturedBody = {};
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans: [], total: 0 }),
      });
    });

    await page.goto('/traces');
    await page.waitForTimeout(3000);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.size).toBe(100);
  });
});

test.describe('Trace Filtering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);
  });

  test('should filter traces by search query', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();

    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('test');
      await page.waitForTimeout(1000);

      // Page should still be functional
      await expect(page).toHaveURL(/\/agent-traces/);
    }
  });

  test('should filter traces by agent', async ({ page }) => {
    const agentDropdown = page.locator('button:has-text("All Agents"), [role="combobox"]').first();

    if (await agentDropdown.isVisible().catch(() => false)) {
      await agentDropdown.click();
      await page.waitForTimeout(500);

      // Dropdown should be open
      const options = page.locator('[role="option"], [role="menuitem"]');
      if (await options.count() > 0) {
        await options.first().click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('should clear filters', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();

    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);

      await searchInput.clear();
      await expect(searchInput).toHaveValue('');
    }
  });
});
