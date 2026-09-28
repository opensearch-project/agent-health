/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Page, Route } from '@playwright/test';

/**
 * Run report → Traces tab readability.
 *
 * A synthetic retrieval-agent trace is served for a seeded report. Asserts the
 * rendered result on BOTH row surfaces (the default Timeline/Gantt chart and
 * the Trace Tree table):
 *  - E1 every row shows the span's absolute start time (HH:MM:SS.mmm) and
 *    its offset from the trace root (+1.234 s); the header pins t=0;
 *  - E2 rows are in start-time order and the header says so;
 *  - E3 clicking the span NAME opens the attributes drawer;
 *  - E4 the full name is in the row's title attribute and in the drawer header;
 *  - E5 the root span's `*.retrieved.*` / `*.results*` id lists render as the
 *    labelled Retrieved (seen) / Returned (recommended) pair with the overlap.
 */

const T0 = Date.UTC(2026, 2, 3, 9, 15, 30, 250);
const iso = (ms: number) => new Date(ms).toISOString();
const LONG_TOOL = 'execute_tool a_very_long_tool_name_that_certainly_overflows_the_label_column_of_the_tree';
const RUN_ID = `e2e-readability-${Date.now()}`;

function buildTrace() {
  const traceId = 'readability-trace';
  const svc = { 'service.name': 'retrieval-agent', 'agent_health.run.id': RUN_ID };
  return [
    {
      traceId, spanId: 'root', name: 'POST /ask',
      startTime: iso(T0), endTime: iso(T0 + 5000), duration: 5000, status: 'OK',
      attributes: {
        ...svc, spanKind: 'SPAN_KIND_SERVER', 'http.request.method': 'POST', 'http.route': '/ask',
        'retrieval.retrieved.ids': ['d1', 'd2', 'd3', 'd4'],
        'retrieval.results.ids': ['d2', 'd4', 'd9'],
      },
    },
    // Listed out of order on purpose: 'chat' starts AFTER the tool span.
    {
      traceId, spanId: 'chat', parentSpanId: 'root', name: 'chat',
      startTime: iso(T0 + 1234), endTime: iso(T0 + 2000), duration: 766, status: 'OK',
      attributes: { ...svc, 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'example-model' },
    },
    {
      traceId, spanId: 'tool', parentSpanId: 'root', name: LONG_TOOL,
      startTime: iso(T0 + 100), endTime: iso(T0 + 900), duration: 800, status: 'OK',
      attributes: { ...svc, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'a_very_long_tool_name' },
    },
  ];
}

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function openTracesTab(page: Page, reportId: string) {
  const spans = buildTrace();
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans, total: spans.length }));
  await page.route('**/api/traces/health**', (r) => json(r, { status: 'ok', backend: 'opensearch' }));
  // No trace metrics for this run (the page tolerates a 404 → null metrics).
  await page.route('**/api/metrics/**', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no metrics' }) }));
  await page.goto(`/runs/${reportId}`);
  await page.getByRole('tab', { name: /Traces/ }).click();
  await expect(page.locator('[data-testid="span-row-name"]').first()).toBeVisible({ timeout: 20000 });
}

// Local wall-clock rendering of T0 — the browser and the test runner share a
// machine, so format with the same local getters the component uses.
const localClock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
};

test.describe('Run report Traces tab — row readability', () => {
  let reportId: string;

  // One seeded report per test, tracked by id so cleanup never touches
  // anything this test did not create (see tests/helpers/testDataTracker.ts).
  test.beforeEach(async ({ request, testData }) => {
    reportId = `e2e-trace-readability-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request.post('/api/storage/runs', {
      data: {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentKey: 'retrieval-agent',
        modelId: 'example-model',
        testCaseId: 'e2e-trace-readability-tc',
        runId: RUN_ID,
        trajectory: [],
        status: 'completed',
        evaluationType: 'llm-judge',
        metricsStatus: 'ready',
        passFailStatus: 'passed',
        metrics: { accuracy: 100 },
        performanceMetrics: { durationMs: 5000 },
      },
    });
    expect(res.ok()).toBeTruthy();
    testData.run(reportId);
  });

  test('timeline rows show absolute time + offset, are start-ordered, and the header pins t=0', async ({ page }) => {
    await openTracesTab(page, reportId);

    // Default view is the Gantt timeline with the HTML label column.
    const labels = page.locator('[data-testid="trace-timeline-labels"]');
    await expect(labels).toBeVisible();
    await expect(labels.locator('[data-testid="trace-list-sort-hint"]')).toContainText('sorted by start time');
    const anchor = page.locator('[data-testid="trace-anchor-time"]');
    await expect(anchor).toHaveText(`t=0 = ${localClock(T0)}`);
    await expect(anchor).toHaveAttribute('title', /2026-03-03T09:15:30\.250Z/);

    // E1 — every row: HH:MM:SS.mmm + offset, ISO in the tooltip.
    await expect(labels.locator('[data-testid="span-row-clock"]')).toHaveText([
      localClock(T0), localClock(T0 + 100), localClock(T0 + 1234),
    ]);
    await expect(labels.locator('[data-testid="span-row-offset"]')).toHaveText(['+0.000 s', '+0.100 s', '+1.234 s']);
    await expect(labels.locator('[data-testid="span-row-time"]').nth(2)).toHaveAttribute('title', /2026-03-03T09:15:31\.484Z/);

    // E2 — order is by start time (tool @+100ms before chat @+1234ms, despite input order).
    const names = labels.locator('[data-testid="span-row-name"]');
    await expect(names).toHaveText(['POST /ask', LONG_TOOL, 'chat']);
    // E4 — the full name is always in title.
    await expect(names.nth(1)).toHaveAttribute('title', LONG_TOOL);

    await page.screenshot({ path: '.pi/web/artifacts/traces-readability-timeline.png' });
  });

  test('clicking the span NAME opens the drawer with the full name and the Retrieved/Returned pair', async ({ page }) => {
    await openTracesTab(page, reportId);
    const drawer = page.locator('[role="dialog"][aria-label="Span details"]');
    await expect(drawer).toHaveCount(0);

    // E3 — click the long tool's name (not the bar).
    await page.locator('[data-testid="trace-timeline-labels"] [data-testid="span-row-name"]').nth(1).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('[data-testid="span-drawer-name"]')).toHaveText(LONG_TOOL);
    await expect(drawer.locator('[data-testid="span-drawer-start"]')).toHaveText(localClock(T0 + 100));
    // A tool span carries neither key family → no pair.
    await expect(drawer.locator('[data-testid="retrieved-returned-panel"]')).toHaveCount(0);

    // Keyboard affordance: focus the root's name and press Enter.
    await page.locator('[data-testid="trace-timeline-labels"] [data-testid="span-row-name"]').first().focus();
    await page.keyboard.press('Enter');
    await expect(drawer.locator('[data-testid="span-drawer-name"]')).toHaveText('POST /ask');

    // E5 — the root shows the labelled pair with counts and the overlap.
    const retrieved = drawer.locator('[data-testid="retrieved-ids"]');
    const returned = drawer.locator('[data-testid="returned-ids"]');
    await expect(retrieved).toContainText('Retrieved (seen)');
    await expect(retrieved).toContainText('4 ids');
    await expect(retrieved).toContainText('retrieval.retrieved.ids');
    await expect(retrieved.locator('li')).toHaveText(['d1', 'd2', 'd3', 'd4']);
    await expect(returned).toContainText('Returned (recommended)');
    await expect(returned).toContainText('3 ids');
    await expect(returned.locator('li')).toHaveText(['d2', 'd4', 'd9']);
    await expect(drawer.locator('[data-testid="retrieved-returned-overlap"]')).toHaveText(
      '2 of 4 retrieved were returned; 1 returned id was not in the retrieved set'
    );

    await page.screenshot({ path: '.pi/web/artifacts/traces-readability-drawer.png' });
  });

  test('Trace Tree view: same time cells, name-click opens the drawer, full name in title', async ({ page }) => {
    await openTracesTab(page, reportId);
    await page.getByRole('button', { name: /Trace Tree/ }).click();
    const header = page.locator('[data-testid="trace-list-header"]');
    await expect(header).toBeVisible();
    await expect(header.locator('[data-testid="trace-list-sort-hint"]')).toContainText('sorted by start time');
    await expect(header.locator('[data-testid="trace-anchor-time"]')).toHaveText(`t=0 = ${localClock(T0)}`);

    // The tree table renders the timeline-column layout (resize handle present) —
    // this is TraceTreeTable, not the Gantt chart.
    await expect(page.locator('[data-testid="span-name-col-resize"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="trace-timeline-labels"]')).toHaveCount(0);

    await expect(page.locator('[data-testid="span-row-clock"]')).toHaveText([
      localClock(T0), localClock(T0 + 100), localClock(T0 + 1234),
    ]);
    await expect(page.locator('[data-testid="span-row-offset"]')).toHaveText(['+0.000 s', '+0.100 s', '+1.234 s']);

    const longName = page.locator('[data-testid="span-row-name"]').nth(1);
    await expect(longName).toHaveAttribute('title', LONG_TOOL);
    await longName.click();
    const drawer = page.locator('[role="dialog"][aria-label="Span details"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('[data-testid="span-drawer-name"]')).toHaveText(LONG_TOOL);

    await page.screenshot({ path: '.pi/web/artifacts/traces-readability-tree.png' });
  });
});
