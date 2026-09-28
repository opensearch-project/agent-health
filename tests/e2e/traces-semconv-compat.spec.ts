/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * e2e: trace rendering correctness for current OTel GenAI semconv spans.
 *
 *  1. Compliance: an LLM span stamped with `gen_ai.provider.name` (semconv
 *     >= 1.37; `gen_ai.system` deprecated) renders WITHOUT an OTel Compliance
 *     warning; a span with neither key names the preferred key + alias.
 *  2. Time Distribution: shares are SELF time — an agent loop span wrapping an
 *     LLM call and a tool call is not credited with its children's time — and
 *     the basis is labelled.
 *
 * `/api/traces` is stubbed at the network boundary with a synthetic trace
 * (same approach as traces-plain-raw.spec.ts / traces-error-span-red.spec.ts).
 */

import { test, expect } from './fixtures/test-fixtures';

const T0 = Date.now() - 5 * 60_000;
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const TRACE_ID = 'semconv-e2e-trace';
const SERVICE = { 'service.name': 'retrieval-agent', serviceName: 'retrieval-agent' };

/**
 * root (SERVER, 10s)
 *  └─ invoke_agent (10s)
 *      └─ execute_event_loop_cycle (10s)          ← wrapper: 0 self time
 *          ├─ chat  gen_ai.provider.name (8s)     ← compliant LLM span
 *          └─ execute_tool search_products (2s)
 *              └─ search products-index (1.5s)   ← OTHER, nested inside the tool
 */
function buildTrace() {
  return [
    {
      traceId: TRACE_ID, spanId: 'root', name: 'POST /ask', kind: 'SERVER',
      startTime: iso(0), endTime: iso(10_000), duration: 10_000, status: 'OK',
      attributes: { ...SERVICE, 'http.request.method': 'POST', 'url.path': '/ask', spanKind: 'SPAN_KIND_SERVER' },
      events: [],
    },
    {
      traceId: TRACE_ID, spanId: 'agent', parentSpanId: 'root', name: 'invoke_agent retrieval-agent', kind: 'INTERNAL',
      startTime: iso(0), endTime: iso(10_000), duration: 10_000, status: 'OK',
      attributes: { ...SERVICE, 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'retrieval-agent' },
      events: [],
    },
    {
      traceId: TRACE_ID, spanId: 'cycle', parentSpanId: 'agent', name: 'execute_event_loop_cycle', kind: 'INTERNAL',
      startTime: iso(0), endTime: iso(10_000), duration: 10_000, status: 'OK',
      attributes: { ...SERVICE, 'gen_ai.operation.name': 'execute_event_loop_cycle' },
      events: [],
    },
    {
      traceId: TRACE_ID, spanId: 'chat', parentSpanId: 'cycle', name: 'chat', kind: 'CLIENT',
      startTime: iso(0), endTime: iso(8_000), duration: 8_000, status: 'OK',
      attributes: {
        ...SERVICE,
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'gpt-4o',
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 300,
      },
      events: [],
    },
    {
      traceId: TRACE_ID, spanId: 'tool', parentSpanId: 'cycle', name: 'execute_tool search_products', kind: 'INTERNAL',
      startTime: iso(8_000), endTime: iso(10_000), duration: 2_000, status: 'OK',
      attributes: { ...SERVICE, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_products' },
      events: [],
    },
    {
      traceId: TRACE_ID, spanId: 'search', parentSpanId: 'tool', name: 'search products-index', kind: 'CLIENT',
      startTime: iso(8_200), endTime: iso(9_700), duration: 1_500, status: 'OK',
      attributes: { ...SERVICE, 'db.system.name': 'opensearch', 'db.operation.name': 'search', 'db.query.text': '{"query":{"match_all":{}}}' },
      events: [],
    },
  ];
}

/** Same trace, but the LLM span carries neither provider key. */
function buildTraceWithoutProvider() {
  const spans = buildTrace();
  const chat = spans.find(s => s.spanId === 'chat')!;
  delete (chat.attributes as any)['gen_ai.provider.name'];
  return spans;
}

async function openFullscreen(page: any, spans: any[]) {
  await page.route('**/api/traces', async (route: any) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ spans, total: spans.length, hasMore: false, nextCursor: null }),
    });
  });
  await page.route('**/api/traces/health**', async (route: any) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', backend: 'opensearch' }) });
  });
  await page.goto('/agent-traces');
  await page.waitForTimeout(2500);
  const row = page.locator('tbody tr').first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForTimeout(1000);
  await page.locator('[aria-label="Open trace in fullscreen view"]').click();
  await page.waitForTimeout(800);
}

test.describe('Traces — semconv compatibility + self-time distribution', () => {
  test('Info view: Time Distribution is labelled self time and does not credit wrappers with nested time', async ({ page }) => {
    await openFullscreen(page, buildTrace());
    await page.locator('button:has-text("Info")').first().click();
    await page.waitForTimeout(800);

    await expect(page.getByTestId('time-distribution-basis').first()).toContainText('self time');

    // Inclusive summing would credit AGENT with the whole 10s wrapper (~30%).
    // Self time: LLM 8s (80%), TOOL 0.5s (5%), OTHER 1.5s (15%: the loop-cycle
    // wrapper has 0 self time, the nested search has 1.5s), AGENT 0s (0%).
    await expect(page.getByTestId('time-distribution-llm')).toContainText('80%');
    await expect(page.getByTestId('time-distribution-llm')).toContainText('8.00s');
    await expect(page.getByTestId('time-distribution-agent')).toContainText('0ms');
    await expect(page.getByTestId('time-distribution-tool')).toContainText('500ms');
    await expect(page.getByTestId('time-distribution-other')).toContainText('1.50s');

    // The inclusive figure is still discoverable on hover.
    await expect(page.getByTestId('time-distribution-agent')).toHaveAttribute('title', /0ms self \(0\.0%\) · 10\.00s incl\. children/);

    await page.screenshot({ path: '.pi/web/artifacts/traces-semconv-compat/e2e-time-distribution.png', fullPage: true });
  });

  test('Agent map: an LLM span with gen_ai.provider.name carries no OTel Compliance warning', async ({ page }) => {
    await openFullscreen(page, buildTrace());
    await page.locator('button:has-text("Agent map")').first().click();
    await page.waitForTimeout(1200);

    // Nodes rendered (the chat node is the LLM one) …
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await expect(page.locator('.react-flow__node', { hasText: 'gpt-4o' }).first()).toBeVisible();
    // … and NO node shows the amber compliance triangle. Pre-fix the chat node
    // was flagged "gen_ai.system" missing despite stamping gen_ai.provider.name.
    await expect(page.getByTestId('otel-compliance-warning')).toHaveCount(0);

    await page.screenshot({ path: '.pi/web/artifacts/traces-semconv-compat/e2e-compliance-ok.png', fullPage: true });
  });

  test('Agent map: an LLM span with neither provider key is flagged, naming the preferred key and the deprecated alias', async ({ page }) => {
    await openFullscreen(page, buildTraceWithoutProvider());
    await page.locator('button:has-text("Agent map")').first().click();
    await page.waitForTimeout(1200);

    const warning = page.getByTestId('otel-compliance-warning');
    await expect(warning).toHaveCount(1);
    await expect(warning).toHaveAttribute(
      'data-missing-attributes',
      'gen_ai.provider.name (or deprecated gen_ai.system)',
    );
    // The warning sits on the LLM node, not on any other node.
    await expect(page.locator('.react-flow__node', { has: warning })).toContainText('gpt-4o');

    await warning.hover();
    await expect(page.locator('text=gen_ai.provider.name (or deprecated gen_ai.system)').first()).toBeVisible();

    await page.screenshot({ path: '.pi/web/artifacts/traces-semconv-compat/e2e-compliance-missing.png', fullPage: true });
  });
});
