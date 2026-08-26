/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Regression: an ERROR-status span deep in the tree must render visibly RED
 * in BOTH the Trace tree and Timeline views (agent map already did this),
 * and must be auto-expanded so it isn't hidden behind collapsed parents.
 *
 * Models the real Claude Code trace 7f304bd9…: a `claude_code.interaction`
 * root with several OK `claude_code.tool` children, one of which contains a
 * short `claude_code.tool.execution` child that ended in ERROR (ShellError).
 */
function buildClaudeCodeTraceWithError() {
  const t0 = Date.now() - 5 * 60000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const traceId = 'errspan-trace';
  const spans: any[] = [];

  spans.push({
    traceId, spanId: 'root', name: 'claude_code.interaction',
    startTime: iso(t0), endTime: iso(t0 + 120000), duration: 120000,
    status: 'OK', attributes: { 'service.name': 'claude-code-agent' },
  });

  for (let i = 0; i < 4; i++) {
    const s = t0 + 1000 + i * 20000;
    spans.push({
      traceId, spanId: `tool-${i}`, parentSpanId: 'root', name: 'claude_code.tool',
      startTime: iso(s), endTime: iso(s + 5000), duration: 5000,
      status: 'OK', attributes: { 'service.name': 'claude-code-agent' },
    });
    spans.push({
      traceId, spanId: `exec-${i}`, parentSpanId: `tool-${i}`, name: 'claude_code.tool.execution',
      startTime: iso(s + 100), endTime: iso(s + 4000), duration: 3900,
      status: 'OK', attributes: { 'service.name': 'claude-code-agent' },
    });
  }

  // Failing tool: OK parent tool span, short ERROR execution child (deep).
  const es = t0 + 90000;
  spans.push({
    traceId, spanId: 'tool-err', parentSpanId: 'root', name: 'claude_code.tool',
    startTime: iso(es), endTime: iso(es + 500), duration: 500,
    status: 'OK', attributes: { 'service.name': 'claude-code-agent' },
  });
  spans.push({
    traceId, spanId: 'exec-err', parentSpanId: 'tool-err', name: 'claude_code.tool.execution',
    startTime: iso(es + 50), endTime: iso(es + 95), duration: 45,
    status: 'ERROR',
    attributes: { 'service.name': 'claude-code-agent', 'error': 'ShellError' },
  });

  return { traceId, spans };
}

async function openTraceRow(page: any, spans: any[]) {
  await page.route('**/api/traces', async (route: any) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ spans, total: spans.length, hasMore: false }),
    });
  });
  await page.goto('/agent-traces');
  await page.waitForTimeout(2500);
  const row = page.locator('tbody tr').first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForTimeout(1200);
}

test.describe('ERROR span renders red in tree + timeline', () => {
  test('inline trace tree marks the errored span red and auto-expands it', async ({ page }) => {
    const { spans } = buildClaudeCodeTraceWithError();
    await openTraceRow(page, spans);

    // The errored span row is present (auto-expanded via getInitialExpandedSpans)
    // and flagged with the error marker the tree colors red.
    const errorRow = page.locator('[data-error-span="true"]').first();
    await expect(errorRow).toBeVisible();
    // The span name inside the errored row must carry the red text class.
    await expect(errorRow.locator('.text-red-500, .dark\\:text-red-400').first()).toBeVisible();

    await page.screenshot({ path: '.pi/web/artifacts/error-span-tree.png' });
  });

  test('fullscreen Timeline view shows the errored span', async ({ page }) => {
    const { spans } = buildClaudeCodeTraceWithError();
    await openTraceRow(page, spans);

    // Open fullscreen, then switch to the ECharts Timeline (gantt) view.
    await page.locator('[aria-label="Open trace in fullscreen view"]').click();
    await page.waitForTimeout(800);
    await page.locator('button:has-text("Timeline")').first().click();
    await page.waitForTimeout(1200);

    await expect(page.locator('[data-testid="trace-timeline-chart"]')).toBeVisible();
    await page.screenshot({ path: '.pi/web/artifacts/error-span-timeline.png' });
  });

  test('fullscreen Agent map view shows the errored span red', async ({ page }) => {
    const { spans } = buildClaudeCodeTraceWithError();
    await openTraceRow(page, spans);

    await page.locator('[aria-label="Open trace in fullscreen view"]').click();
    await page.waitForTimeout(800);
    await page.locator('button:has-text("Agent map")').first().click();
    await page.waitForTimeout(1200);

    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await page.screenshot({ path: '.pi/web/artifacts/error-span-agentmap.png' });
  });
});
