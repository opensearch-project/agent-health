/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * RETRIEVAL span category — end-to-end on the Agent Traces page.
 *
 * A synthetic retrieval-agent trace contains the three span classes that
 * used to be bucketed as OTHER: an HTTP SERVER entrypoint (`POST /ask`), a
 * framework-specific `gen_ai.operation.name` loop span, and OTel DB-semconv
 * search spans (`db.system.name`, `db.query.text`, `db.response.returned_rows`).
 *
 * Asserts the rendered result: the fullscreen Info view's Time Distribution
 * legend lists RETRIEVAL and no OTHER; the Agent map renders a cyan retrieval
 * node; and selecting the search span shows the retrieval summary (target,
 * system, returned rows) plus the pretty-printed query text in the detail drawer.
 */
const QUERY = '{"size":20,"query":{"multi_match":{"query":"desk lamp","fields":["title","description"]}}}';

function buildRetrievalAgentTrace() {
  const t0 = Date.now() - 5 * 60000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const traceId = 'retrieval-cat-trace';
  const svc = { 'service.name': 'retrieval-agent' };
  const spans: any[] = [
    {
      traceId, spanId: 'root', name: 'POST /ask',
      startTime: iso(t0), endTime: iso(t0 + 5000), duration: 5000, status: 'OK',
      attributes: { ...svc, spanKind: 'SPAN_KIND_SERVER', 'http.request.method': 'POST', 'url.path': '/ask', 'http.route': '/ask' },
    },
    {
      traceId, spanId: 'invoke', parentSpanId: 'root', name: 'invoke_agent retrieval-agent',
      startTime: iso(t0 + 10), endTime: iso(t0 + 4990), duration: 4980, status: 'OK',
      attributes: { ...svc, spanKind: 'SPAN_KIND_INTERNAL', 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'retrieval-agent', 'gen_ai.provider.name': 'openai' },
    },
    {
      traceId, spanId: 'cycle', parentSpanId: 'invoke', name: 'execute_event_loop_cycle',
      startTime: iso(t0 + 20), endTime: iso(t0 + 4980), duration: 4960, status: 'OK',
      attributes: { ...svc, spanKind: 'SPAN_KIND_INTERNAL', 'gen_ai.operation.name': 'execute_event_loop_cycle', 'gen_ai.provider.name': 'openai' },
    },
    {
      traceId, spanId: 'chat', parentSpanId: 'cycle', name: 'chat',
      startTime: iso(t0 + 30), endTime: iso(t0 + 2000), duration: 1970, status: 'OK',
      attributes: { ...svc, spanKind: 'SPAN_KIND_INTERNAL', 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'example-model', 'gen_ai.usage.input_tokens': 900, 'gen_ai.usage.output_tokens': 120 },
    },
    {
      traceId, spanId: 'tool', parentSpanId: 'cycle', name: 'execute_tool search_index',
      startTime: iso(t0 + 2010), endTime: iso(t0 + 3500), duration: 1490, status: 'OK',
      attributes: { ...svc, spanKind: 'SPAN_KIND_INTERNAL', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_index' },
    },
    {
      traceId, spanId: 'search', parentSpanId: 'tool', name: 'search products',
      startTime: iso(t0 + 2020), endTime: iso(t0 + 3400), duration: 1380, status: 'OK',
      attributes: {
        ...svc,
        spanKind: 'SPAN_KIND_CLIENT',
        'db.system.name': 'opensearch',
        'db.operation.name': 'search',
        'db.namespace': 'catalog',
        'db.collection.name': 'products',
        'db.query.text': QUERY,
        'db.response.returned_rows': '20',
        'db.response.status_code': '200',
        'retrieval-agent.search.hit_ids': ['prod-101', 'prod-202', 'prod-303'],
      },
    },
  ];
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

async function openFullscreen(page: any) {
  await page.locator('[aria-label="Open trace in fullscreen view"]').click();
  await page.waitForTimeout(800);
}

test.describe('RETRIEVAL span category', () => {
  test('selecting the search span shows the retrieval summary and query text in the detail drawer', async ({ page }) => {
    const { spans } = buildRetrievalAgentTrace();
    await openTraceRow(page, spans);

    // Summary strip above the tree counts the retrieval span.
    await expect(page.locator('[data-testid="trace-summary-retrieval"]').first()).toContainText('1');

    const tree = page.locator('.trace-inline-tree').first();
    await expect(tree).toBeVisible();
    // Only roots are expanded on load — drill down to the leaf search span.
    for (const name of ['invoke_agent retrieval-agent', 'execute_event_loop_cycle', 'execute_tool search_index']) {
      const row = tree.locator('div.cursor-pointer', { hasText: name }).first();
      await expect(row).toBeVisible();
      await row.locator('button').last().click(); // expand chevron
      await page.waitForTimeout(300);
    }
    await tree.locator('text=search products').first().click();
    await page.waitForTimeout(600);

    const summary = page.locator('[data-testid="span-retrieval-summary"]').first();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('search products (opensearch)');
    await expect(summary).toContainText('20 rows');

    // The query text is in the flat attributes table, pretty-printed.
    await expect(page.locator('text=db.query.text').first()).toBeVisible();
    await expect(page.locator('text=desk lamp').first()).toBeVisible();
    await expect(page.locator('text=db.response.returned_rows').first()).toBeVisible();

    await page.screenshot({ path: '.pi/web/artifacts/retrieval-span-drawer.png' });
  });

  test('fullscreen Info view: Time Distribution legend shows RETRIEVAL and no OTHER share', async ({ page }) => {
    const { spans } = buildRetrievalAgentTrace();
    await openTraceRow(page, spans);
    await openFullscreen(page);
    await page.locator('[role="dialog"] button:has-text("Info")').first().click();
    await page.waitForTimeout(1000);

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('text=Time Distribution').first()).toBeVisible();
    // Legend entries render the category name; RETRIEVAL present, OTHER absent.
    await expect(dialog.locator('text=/^RETRIEVAL$/').first()).toBeVisible();
    expect(await dialog.locator('text=/^OTHER$/').count()).toBe(0);

    await page.screenshot({ path: '.pi/web/artifacts/retrieval-info-legend.png' });
  });

  test('fullscreen Agent map renders the search span as a cyan RETRIEVAL node', async ({ page }) => {
    const { spans } = buildRetrievalAgentTrace();
    await openTraceRow(page, spans);
    await openFullscreen(page);
    await page.locator('[role="dialog"] button:has-text("Agent map")').first().click();
    await page.waitForTimeout(1200);

    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    const retrievalNode = page.locator('.react-flow__node .border-cyan-500').first();
    await expect(retrievalNode).toBeVisible();
    await expect(retrievalNode).toContainText('search products');

    await page.screenshot({ path: '.pi/web/artifacts/retrieval-agent-map.png' });
  });

  test('fullscreen Timeline view renders the trace with the retrieval span', async ({ page }) => {
    const { spans } = buildRetrievalAgentTrace();
    await openTraceRow(page, spans);
    await openFullscreen(page);
    await page.locator('[role="dialog"] button:has-text("Timeline")').first().click();
    await page.waitForTimeout(1200);

    await expect(page.locator('[data-testid="trace-timeline-chart"]')).toBeVisible();
    await page.screenshot({ path: '.pi/web/artifacts/retrieval-timeline.png' });
  });
});
