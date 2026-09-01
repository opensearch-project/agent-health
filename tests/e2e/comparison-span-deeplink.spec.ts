/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: clicking a span citation in the AI deep-dive must select THAT
 * span — not always run B's first span.
 *
 * Root cause (fixed in components/traces/TraceVisualization.tsx): the two
 * comparison trace panels (run A left, run B right) share ONE controlled
 * `selectedSpan` + `onSelectSpan`. TraceVisualization auto-selected its first
 * span whenever nothing was selected; because the setter was shared, BOTH
 * panels ran it and the second panel (run B) fired last, clobbering the
 * deep-link selection with run B's first span — for every citation. The fix
 * disables that auto-select when selection is externally controlled.
 *
 * Deterministic: storage, /api/comparison/deep-dive and /api/traces are all
 * mocked via page.route(). The deep-dive cites run A's THIRD span (a tool span,
 * not its first), so a regression that lands on run B's first span is
 * unambiguous.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-dlA';
const RUN_B = 'eval-run-dlB';
const TC = 'tc-deeplink';
const RUNID_A = 'subprocess-dlA';
const RUNID_B = 'subprocess-dlB';
const TRACE_A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const TRACE_B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';

// The cited span: run A's TOOL span (3rd), deliberately NOT run A's first span.
const CITED_SPAN_A = TRACE_A + '-tool';
// A run-B span reachable ONLY via the Strategy-C window query (agents), NOT via
// run B's traceId alone — guards the window-agents-lookup fix.
const B_WINDOW_SPAN = TRACE_B + '-winonly';
// The span the pre-fix bug always landed on: run B's first (root) span.
const RUN_B_FIRST = TRACE_B + '-root';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const evalRun = (id: string, agent: string, repId: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-02-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: [TC] }], trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Shared Case' }],
  results: { [TC]: { reportId: repId, status: 'completed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});
// report carries BOTH runId (→ td.runId, must match the citation) and traceId
// (→ Strategy A trace fetch).
const report = (id: string, agent: string, runId: string, traceId: string) => ({
  id, createdAt: '2026-02-01T10:00:00Z', testCaseId: TC, agentId: agent,
  runId, modelId: 'claude-opus-4-8', status: 'completed', passFailStatus: 'passed',
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

const deepDiveBody = {
  // Cite run A's tool span (regression lands on RUN_B_FIRST instead), AND a run-B
  // span that only exists in the Strategy-C window result.
  markdown: `**What's different**\n\n- Run A shelled out to a tool [bash call](span:${RUNID_A}:${CITED_SPAN_A}); run B did not.\n- Run B did extra work [window tool](span:${RUNID_B}:${B_WINDOW_SPAN}).\n`,
  modelId: 'amazon-bedrock/claude-opus-4-8',
  durationMs: 5000,
  runs: [
    { key: 'A', reportId: 'rep-a', runId: RUNID_A, serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
    { key: 'B', reportId: 'rep-b', runId: RUNID_B, serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
  ],
};

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
    if (ids.some((id) => id.includes('rep-a'))) runs.push(report('rep-a', 'demo', RUNID_A, TRACE_A));
    if (ids.some((id) => id.includes('rep-b'))) runs.push(report('rep-b', 'pulsar', RUNID_B, TRACE_B));
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    if (u.includes('rep-a')) return json(r, report('rep-a', 'demo', RUNID_A, TRACE_A));
    if (u.includes('rep-b')) return json(r, report('rep-b', 'pulsar', RUNID_B, TRACE_B));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await mockDeepDiveJob(page, { result: deepDiveBody });
  await page.route('**/api/traces', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const tid = body.traceId as string | undefined;
    const hasWindow = Array.isArray(body.agents) && body.agents.length > 0;
    let spans = tid === TRACE_A ? spansFor(TRACE_A) : tid === TRACE_B ? spansFor(TRACE_B) : [];
    // The window-only run-B span is returned ONLY when the Strategy-C window
    // (agents) is part of the query — i.e. only if the window-agents lookup fix
    // made the client send it.
    if (tid === TRACE_B && hasWindow) {
      spans = [...spans, span(TRACE_B, B_WINDOW_SPAN, 'execute_tool ripgrep', TRACE_B + '-root', '2026-02-01T10:00:02.300Z', '2026-02-01T10:00:02.800Z', 'execute_tool')];
    }
    return json(r, { backend: 'opensearch', spans, total: spans.length });
  });
}

test.describe('Comparison deep-dive — span citations deep-link to the cited span', () => {
  test.beforeEach(async ({ page }) => { await setupRoutes(page); });

  test('clicking a run-A span citation selects THAT span, not run B\'s first span', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // The deep-dive auto-runs and renders the citation pill (a button carrying
    // the cited spanId). Wait for it.
    const citation = page.locator(`button[data-span-id="${CITED_SPAN_A}"]`);
    await expect(citation).toBeVisible({ timeout: 20000 });
    // It is tagged for run A.
    await expect(citation).toHaveAttribute('data-run-id', RUNID_A);

    // Click it → opens the test-case row's Traces tab and deep-links the span.
    await citation.click();

    // The selected span detail panel must show the CITED run-A span…
    await expect(page.locator(`[data-selected-span-id="${CITED_SPAN_A}"]`)).toBeVisible({ timeout: 20000 });
    // …and NOT run B's first span (the pre-fix bug target).
    await expect(page.locator(`[data-selected-span-id="${RUN_B_FIRST}"]`)).toHaveCount(0);
  });

  test('a citation whose span is only in the Strategy-C window still opens (window-agents lookup)', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const citation = page.locator(`button[data-span-id="${B_WINDOW_SPAN}"]`);
    await expect(citation).toBeVisible({ timeout: 20000 });
    await citation.click();

    // The window-only span is reachable only because the client now sends the
    // Strategy-C window (agents) for the run; its detail must open.
    await expect(page.locator(`[data-selected-span-id="${B_WINDOW_SPAN}"]`)).toBeVisible({ timeout: 20000 });
  });
});
