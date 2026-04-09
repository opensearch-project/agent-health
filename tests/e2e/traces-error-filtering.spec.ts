/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

/**
 * Builds mock span data with a mix of OK and ERROR traces.
 * Each trace has a root span (no parentSpanId) and one child span.
 * OK traces have varying durations for sort testing.
 */
function buildMockSpans() {
  const now = Date.now();
  const spans = [];

  // 3 OK traces with different durations
  const okDurations = [30000, 60000, 90000];
  for (let i = 0; i < 3; i++) {
    const traceId = `ok-trace-${i}`;
    const start = new Date(now - (i + 1) * 60000).toISOString();
    const end = new Date(now - (i + 1) * 60000 + okDurations[i]).toISOString();
    spans.push({
      traceId,
      spanId: `ok-root-${i}`,
      name: 'agent.run',
      startTime: start,
      endTime: end,
      duration: okDurations[i],
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
      duration: okDurations[i] - 10000,
      status: 'OK',
      attributes: { 'service.name': 'test-agent' },
    });
  }

  // 2 ERROR traces with different durations
  const errorDurations = [45000, 75000];
  for (let i = 0; i < 2; i++) {
    const traceId = `error-trace-${i}`;
    const start = new Date(now - (i + 4) * 60000).toISOString();
    const end = new Date(now - (i + 4) * 60000 + errorDurations[i]).toISOString();
    spans.push({
      traceId,
      spanId: `error-root-${i}`,
      name: 'agent.run',
      startTime: start,
      endTime: end,
      duration: errorDurations[i],
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
      duration: errorDurations[i] - 10000,
      status: 'ERROR',
      attributes: { 'service.name': 'test-agent' },
    });
  }

  return spans;
}

/** Helper to set up mock API route and navigate to traces page */
async function setupMockTraces(page: any, mockSpans: any[]) {
  await page.route('**/api/traces', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ spans: mockSpans, total: mockSpans.length, hasMore: false }),
    });
  });

  await page.goto('/agent-traces');
  await page.waitForTimeout(3000);
}

/** Helper to expand metrics section and click the error % button */
async function activateErrorFilter(page: any) {
  // Expand metrics if collapsed
  const metricsToggle = page.locator('text=Metrics').first();
  if (await metricsToggle.isVisible().catch(() => false)) {
    await metricsToggle.click();
    await page.waitForTimeout(500);
  }

  // Click the error percentage button
  const errorButton = page.locator('button:has-text("%")').filter({ hasText: /\d+.*%/ }).first();
  await expect(errorButton).toBeVisible();
  await expect(errorButton).toBeEnabled();
  await errorButton.click();
  await page.waitForTimeout(1000);
}

test.describe('Trace Error Filtering', () => {
  test('should show only error traces when error percentage is clicked', async ({ page }) => {
    const mockSpans = buildMockSpans();
    await setupMockTraces(page, mockSpans);

    // Verify we have 5 traces total (3 OK + 2 ERROR)
    await expect(page.locator('tbody tr')).toHaveCount(5);

    await activateErrorFilter(page);

    // Should now show only 2 error traces
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Status filter chip should be visible
    await expect(page.locator('text=Status: error')).toBeVisible();
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

    await activateErrorFilter(page);

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
    await setupMockTraces(page, mockSpans);

    await activateErrorFilter(page);

    // Verify filter is active
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Dismiss the status filter chip via its X button
    const chipDismiss = page.locator('[aria-label="Remove Status: error filter"]');
    await expect(chipDismiss).toBeVisible();
    await chipDismiss.click();

    await page.waitForTimeout(1000);

    // Should show all 5 traces again
    await expect(page.locator('tbody tr')).toHaveCount(5);
  });

  test('sort should not bypass active error filter', async ({ page }) => {
    const mockSpans = buildMockSpans();
    await setupMockTraces(page, mockSpans);

    await activateErrorFilter(page);

    // Should show 2 error traces
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Click a column header to change sort order
    const durationHeader = page.locator('th:has-text("Duration"), button:has-text("Duration")').first();
    await expect(durationHeader).toBeVisible();
    await durationHeader.click();
    await page.waitForTimeout(1000);

    // After sorting, should still show only 2 error traces (not all 5)
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Filter chip should still be active
    await expect(page.locator('text=Status: error')).toBeVisible();
  });

  test('sort then filter should show correct filtered count', async ({ page }) => {
    const mockSpans = buildMockSpans();
    await setupMockTraces(page, mockSpans);

    // Verify all 5 traces visible initially
    await expect(page.locator('tbody tr')).toHaveCount(5);

    // Sort by duration first
    const durationHeader = page.locator('th:has-text("Duration"), button:has-text("Duration")').first();
    await expect(durationHeader).toBeVisible();
    await durationHeader.click();
    await page.waitForTimeout(1000);

    // Should still show all 5 traces after sort (no filter active)
    await expect(page.locator('tbody tr')).toHaveCount(5);

    // Now activate error filter
    await activateErrorFilter(page);

    // Should show only 2 error traces
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('text=Status: error')).toBeVisible();
  });

  test('filter then sort then clear should restore all traces', async ({ page }) => {
    const mockSpans = buildMockSpans();
    await setupMockTraces(page, mockSpans);

    // Step 1: Apply error filter
    await activateErrorFilter(page);
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Step 2: Sort by duration while filtered
    const durationHeader = page.locator('th:has-text("Duration"), button:has-text("Duration")').first();
    await expect(durationHeader).toBeVisible();
    await durationHeader.click();
    await page.waitForTimeout(1000);

    // Still 2 error traces after sort
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Step 3: Clear the filter
    const chipDismiss = page.locator('[aria-label="Remove Status: error filter"]');
    await expect(chipDismiss).toBeVisible();
    await chipDismiss.click();
    await page.waitForTimeout(1000);

    // All 5 traces should be visible again (sorted by duration)
    await expect(page.locator('tbody tr')).toHaveCount(5);

    // No filter chip should remain
    await expect(page.locator('text=Status: error')).not.toBeVisible();
  });

  test('multiple sort clicks should not affect filtered count', async ({ page }) => {
    const mockSpans = buildMockSpans();
    await setupMockTraces(page, mockSpans);

    // Apply error filter
    await activateErrorFilter(page);
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Click duration header multiple times to toggle sort direction
    const durationHeader = page.locator('th:has-text("Duration"), button:has-text("Duration")').first();
    await expect(durationHeader).toBeVisible();

    // Sort ascending
    await durationHeader.click();
    await page.waitForTimeout(500);
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Sort descending
    await durationHeader.click();
    await page.waitForTimeout(500);
    await expect(page.locator('tbody tr')).toHaveCount(2);

    // Sort by a different column
    const startTimeHeader = page.locator('th:has-text("Start Time"), button:has-text("Start Time")').first();
    if (await startTimeHeader.isVisible().catch(() => false)) {
      await startTimeHeader.click();
      await page.waitForTimeout(500);
      await expect(page.locator('tbody tr')).toHaveCount(2);
    }

    // Filter chip should persist through all sort changes
    await expect(page.locator('text=Status: error')).toBeVisible();
  });
});
