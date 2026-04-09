/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

/**
 * Builds mock span data with a mix of OK and ERROR traces.
 * Each trace has a root span (no parentSpanId) and one child span.
 */
function buildMockSpans() {
  const now = Date.now();
  const spans = [];

  // 3 OK traces
  for (let i = 0; i < 3; i++) {
    const traceId = `ok-trace-${i}`;
    const start = new Date(now - (i + 1) * 60000).toISOString();
    const end = new Date(now - i * 60000).toISOString();
    spans.push({
      traceId,
      spanId: `ok-root-${i}`,
      name: 'agent.run',
      startTime: start,
      endTime: end,
      duration: 60000,
      status: 'OK',
      attributes: { 'service.name': 'test-agent' },
    });
    spans.push({
      traceId,
      spanId: `ok-child-${i}`,
      parentSpanId: `ok-root-${i}`,
      name: 'agent.node.callModel',
      startTime: start,
      endTime: end,
      duration: 50000,
      status: 'OK',
      attributes: { 'service.name': 'test-agent' },
    });
  }

  // 2 ERROR traces
  for (let i = 0; i < 2; i++) {
    const traceId = `error-trace-${i}`;
    const start = new Date(now - (i + 4) * 60000).toISOString();
    const end = new Date(now - (i + 3) * 60000).toISOString();
    spans.push({
      traceId,
      spanId: `error-root-${i}`,
      name: 'agent.run',
      startTime: start,
      endTime: end,
      duration: 60000,
      status: 'ERROR',
      attributes: { 'service.name': 'test-agent' },
    });
    spans.push({
      traceId,
      spanId: `error-child-${i}`,
      parentSpanId: `error-root-${i}`,
      name: 'agent.node.callModel',
      startTime: start,
      endTime: end,
      duration: 50000,
      status: 'ERROR',
      attributes: { 'service.name': 'test-agent' },
    });
  }

  return spans;
}

test.describe('Trace Error Filtering', () => {
  test('should show only error traces when error percentage is clicked', async ({ page }) => {
    const mockSpans = buildMockSpans();

    // Intercept trace API to return controlled data with both OK and ERROR traces
    await page.route('**/api/traces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans: mockSpans, total: mockSpans.length, hasMore: false }),
      });
    });

    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);

    // Verify we have 5 traces total (3 OK + 2 ERROR)
    const allRows = page.locator('tbody tr');
    await expect(allRows).toHaveCount(5);

    // Expand metrics if collapsed
    const metricsToggle = page.locator('text=Metrics').first();
    if (await metricsToggle.isVisible().catch(() => false)) {
      await metricsToggle.click();
      await page.waitForTimeout(500);
    }

    // Click the error percentage button to filter to errors only
    const errorButton = page.locator('button:has-text("%")').filter({ hasText: /\d+.*%/ }).first();
    if (await errorButton.isVisible().catch(() => false)) {
      await errorButton.click();
      await page.waitForTimeout(1000);

      // Should now show only 2 error traces
      const filteredRows = page.locator('tbody tr');
      await expect(filteredRows).toHaveCount(2);

      // Status filter chip should be visible
      const statusChip = page.locator('text=Status: error');
      await expect(statusChip).toBeVisible();
    }
  });

  test('error filter should persist when new data arrives', async ({ page }) => {
    const mockSpans = buildMockSpans();
    let requestCount = 0;

    // Each request returns progressively more data (simulating live tailing / pagination)
    await page.route('**/api/traces', async (route) => {
      requestCount++;
      const extraSpans = requestCount > 1 ? [
        {
          traceId: 'extra-ok',
          spanId: 'extra-ok-root',
          name: 'agent.run',
          startTime: new Date(Date.now() - 600000).toISOString(),
          endTime: new Date(Date.now() - 540000).toISOString(),
          duration: 60000,
          status: 'OK',
          attributes: { 'service.name': 'test-agent' },
        },
        {
          traceId: 'extra-error',
          spanId: 'extra-error-root',
          name: 'agent.run',
          startTime: new Date(Date.now() - 660000).toISOString(),
          endTime: new Date(Date.now() - 600000).toISOString(),
          duration: 60000,
          status: 'ERROR',
          attributes: { 'service.name': 'test-agent' },
        },
      ] : [];

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          spans: [...mockSpans, ...extraSpans],
          total: mockSpans.length + extraSpans.length,
          hasMore: false,
        }),
      });
    });

    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);

    // Expand metrics
    const metricsToggle = page.locator('text=Metrics').first();
    if (await metricsToggle.isVisible().catch(() => false)) {
      await metricsToggle.click();
      await page.waitForTimeout(500);
    }

    // Click error percentage to activate filter
    const errorButton = page.locator('button:has-text("%")').filter({ hasText: /\d+.*%/ }).first();
    if (!await errorButton.isVisible().catch(() => false)) {
      return;
    }

    await errorButton.click();
    await page.waitForTimeout(1000);

    // Verify filter chip is active
    const statusChip = page.locator('text=Status: error');
    await expect(statusChip).toBeVisible();

    // After the error button click, additional API calls may fire (tailing/refresh).
    // The second request adds 1 extra OK + 1 extra ERROR trace.
    // The key regression test: only error traces should be visible regardless of how many
    // API calls have happened. The filter chip must remain active.
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    // Should be 2 or 3 error traces (2 original + possibly 1 extra-error from subsequent call)
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(3);

    // Crucially, the count should NOT be 5, 6, or 7 (total traces including OK ones)
    // which was the original bug — the filter was being bypassed on data refresh
    expect(count).toBeLessThan(5);

    // Filter chip should still be visible
    await expect(statusChip).toBeVisible();
  });

  test('should clear error filter via chip dismiss', async ({ page }) => {
    const mockSpans = buildMockSpans();

    await page.route('**/api/traces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans: mockSpans, total: mockSpans.length, hasMore: false }),
      });
    });

    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);

    // Expand metrics
    const metricsToggle = page.locator('text=Metrics').first();
    if (await metricsToggle.isVisible().catch(() => false)) {
      await metricsToggle.click();
      await page.waitForTimeout(500);
    }

    // Activate error filter
    const errorButton = page.locator('button:has-text("%")').filter({ hasText: /\d+.*%/ }).first();
    if (!await errorButton.isVisible().catch(() => false)) {
      return;
    }

    await errorButton.click();
    await page.waitForTimeout(1000);

    // Verify filter is active
    const filteredRows = page.locator('tbody tr');
    await expect(filteredRows).toHaveCount(2);

    // Dismiss the status filter chip via its X button
    const chipDismiss = page.locator('[aria-label="Remove Status: error filter"]');
    await expect(chipDismiss).toBeVisible();
    await chipDismiss.click();

    await page.waitForTimeout(1000);

    // Should show all 5 traces again
    const allRows = page.locator('tbody tr');
    await expect(allRows).toHaveCount(5);
  });

  test('sort should not bypass active error filter', async ({ page }) => {
    const mockSpans = buildMockSpans();

    await page.route('**/api/traces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans: mockSpans, total: mockSpans.length, hasMore: false }),
      });
    });

    await page.goto('/agent-traces');
    await page.waitForTimeout(3000);

    // Expand metrics
    const metricsToggle = page.locator('text=Metrics').first();
    if (await metricsToggle.isVisible().catch(() => false)) {
      await metricsToggle.click();
      await page.waitForTimeout(500);
    }

    // Activate error filter
    const errorButton = page.locator('button:has-text("%")').filter({ hasText: /\d+.*%/ }).first();
    if (!await errorButton.isVisible().catch(() => false)) {
      return;
    }

    await errorButton.click();
    await page.waitForTimeout(1000);

    // Should show 2 error traces
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Click a column header to change sort order
    const durationHeader = page.locator('th:has-text("Duration"), button:has-text("Duration")').first();
    if (await durationHeader.isVisible().catch(() => false)) {
      await durationHeader.click();
      await page.waitForTimeout(1000);

      // After sorting, should still show only 2 error traces (not all 5)
      await expect(page.locator('tbody tr')).toHaveCount(2);

      // Filter chip should still be active
      const statusChip = page.locator('text=Status: error');
      await expect(statusChip).toBeVisible();
    }
  });
});
