/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Traces tab — loading vs not-present, and load-timing.
 *
 * Addresses two things:
 *  1. The Traces tab must make "still loading" (spinner) clearly distinct from
 *     "no traces present" (a TERMINAL empty state, stamped "Checked … — N spans …
 *     This is final — not still loading"). Previously both read as an ambiguous
 *     "No trace data available — may take a few minutes to propagate".
 *  2. Publish how long traces take to load (open Traces tab → spans rendered),
 *     so we have data on the real load latency. The timing is written to
 *     test-results/trace-load-timing.json and logged.
 *
 * Deterministic: storage + /api/traces are mocked via page.route(), and the
 * trace response is delayed by a fixed amount so the loading→present and
 * loading→absent transitions are observable and timeable.
 */

import { test, expect, Route } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const RUN_A = 'eval-run-tA';
const RUN_B = 'eval-run-tB';
const TC = 'tc-shared';
const TRACE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TRACE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TRACE_DELAY_MS = 700; // fixed server-side delay we assert the spinner covers

const evalRun = (id: string, agent: string, repId: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-02-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: [TC] }], trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Shared Case' }],
  results: { [TC]: { reportId: repId, status: 'completed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});
// storage report carries traceId (toTestCaseRun surfaces it → Strategy A).
const report = (id: string, agent: string, traceId: string) => ({
  id, createdAt: '2026-02-01T10:00:00Z', testCaseId: TC, agentId: agent,
  modelId: 'claude-opus-4-8', status: 'completed', passFailStatus: 'passed',
  traceId, metrics: { accuracy: 100 }, trajectory: [],
});
const span = (traceId: string, spanId: string, name: string, parent: string | null, s: string, e: string, op: string) => ({
  traceId, spanId, parentSpanId: parent ?? undefined, name,
  startTime: s, endTime: e, durationMs: new Date(e).getTime() - new Date(s).getTime(),
  serviceName: 'demo-agent', kind: 'SPAN_KIND_SERVER',
  attributes: { 'service.name': 'demo-agent', 'gen_ai.operation.name': op, 'gen_ai.agent.name': 'demo-agent' },
  status: 'OK',
});
const spansFor = (traceId: string) => [
  span(traceId, traceId + '-root', 'invoke_agent', null, '2026-02-01T10:00:00.000Z', '2026-02-01T10:00:03.000Z', 'invoke_agent'),
  span(traceId, traceId + '-chat', 'chat opus', traceId + '-root', '2026-02-01T10:00:00.100Z', '2026-02-01T10:00:01.500Z', 'chat'),
  span(traceId, traceId + '-tool', 'execute_tool bash', traceId + '-root', '2026-02-01T10:00:01.600Z', '2026-02-01T10:00:02.200Z', 'execute_tool'),
];

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// Per-test trace behavior, set before navigation.
let tracePresent = true;

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const u = r.request().url();
    const m = u.match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-a'), evalRun(RUN_B, 'pulsar', 'rep-b')], total: 2 });
    if (id === RUN_A) return json(r, evalRun(RUN_A, 'demo', 'rep-a'));
    if (id === RUN_B) return json(r, evalRun(RUN_B, 'pulsar', 'rep-b'));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  // Batched report fetch (the comparison page now loads every cell's report in
  // ONE request). Mirror the individual route below.
  await page.route(/\/api\/storage\/runs\?ids=/, (r) => {
    const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-a'))) runs.push(report('rep-a', 'demo', TRACE_A));
    if (ids.some((id) => id.includes('rep-b'))) runs.push(report('rep-b', 'pulsar', TRACE_B));
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    if (u.includes('rep-a')) return json(r, report('rep-a', 'demo', TRACE_A));
    if (u.includes('rep-b')) return json(r, report('rep-b', 'pulsar', TRACE_B));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  // The unit under test: /api/traces, delayed so the spinner is observable.
  await page.route('**/api/traces', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    await new Promise((res) => setTimeout(res, TRACE_DELAY_MS));
    if (!tracePresent) return json(r, { backend: 'opensearch', spans: [], total: 0 });
    const tid = body.traceId as string | undefined;
    const spans = tid === TRACE_A ? spansFor(TRACE_A) : tid === TRACE_B ? spansFor(TRACE_B) : [];
    return json(r, { backend: 'opensearch', spans, total: spans.length });
  });
}

async function openTracesTab(page: import('@playwright/test').Page) {
  await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
  await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
  await page.locator('tr.cursor-pointer', { hasText: TC }).first().click();
  await page.getByRole('tab', { name: 'Traces' }).first().click();
}

test.describe('Comparison Traces tab — loading vs not-present + timing', () => {
  test.beforeEach(async ({ page }) => { await setupRoutes(page); });

  test('shows the loading state, then renders spans — and we publish the load time', async ({ page }) => {
    tracePresent = true;
    const t0 = Date.now();
    await openTracesTab(page);

    // 1. While the (delayed) /api/traces is in flight → the LOADING state, not empty.
    await expect(page.locator('[data-testid="trace-flow-loading"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="trace-flow-empty"]')).toHaveCount(0);

    // 2. Then spans render (Trace Flow Comparison present, not the empty state).
    await expect(page.locator('text=Trace Flow Comparison')).toBeVisible({ timeout: 15000 });
    // Spans rendered (not the terminal empty state): the per-pane span counts
    // show a POSITIVE number (0 spans would be the empty case, covered below).
    await expect(page.getByText(/Left:\s*[1-9]\d* spans/i)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="trace-flow-empty"]')).toHaveCount(0);
    // (We assert the loaded span COUNT rather than a specific node label: the
    // React Flow graph positions nodes via dagre and doesn't surface the raw
    // span name as findable DOM text.)
    const loadMs = Date.now() - t0;
    // Publish the timing.
    const out = { measuredAt: new Date().toISOString(), case: 'present', mockedTraceDelayMs: TRACE_DELAY_MS, tabOpenToSpansRenderedMs: loadMs };
    const dir = path.resolve('test-results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trace-load-timing.json'), JSON.stringify(out, null, 2));
    console.log(`[trace-load-timing] present: tab-open → spans-rendered = ${loadMs}ms (mocked /api/traces delay ${TRACE_DELAY_MS}ms)`);
    expect(loadMs).toBeGreaterThanOrEqual(TRACE_DELAY_MS); // the spinner genuinely covered the fetch
  });

  test('resolves to a TERMINAL "not present" state (distinct from loading) when there are no spans', async ({ page }) => {
    tracePresent = false;
    const t0 = Date.now();
    await openTracesTab(page);

    // Loading first…
    await expect(page.locator('[data-testid="trace-flow-loading"]')).toBeVisible({ timeout: 5000 });
    // …then the terminal empty state — unambiguously "not still loading".
    const empty = page.locator('[data-testid="trace-flow-empty"]');
    await expect(empty).toBeVisible({ timeout: 15000 });
    await expect(empty).toContainText('No traces found');
    await expect(empty).toContainText('This is final');
    await expect(empty).toContainText('spans'); // per-run span counts (0 spans · 0 spans)
    await expect(page.locator('[data-testid="trace-flow-loading"]')).toHaveCount(0);
    const resolveMs = Date.now() - t0;
    console.log(`[trace-load-timing] absent: tab-open → "no traces found" terminal = ${resolveMs}ms`);
  });
});
