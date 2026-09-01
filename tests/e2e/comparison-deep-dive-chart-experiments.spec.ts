/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison deep-dive — suggested-experiments section + header metrics.
 *
 * The deep-dive agent can record (via `record_deepdive_extras`, tested at the
 * unit level in comparisonTraceTools.test.ts) a small A-vs-B chart and a list
 * of concrete follow-up experiment ideas alongside its markdown narrative.
 *
 * Owner feedback (screenshot-verified) on the panel this spec covers:
 *   1. the chart's "Score" row printed a bare number ("100 pts") with no
 *      unit context — in a multi-hundred-case comparison that misreads as a
 *      CASE COUNT, not a judge score;
 *   2. the whole "Performance & Outcome" bars block was redundant chrome —
 *      duration/tool-call numbers for the same case are visible elsewhere;
 *   3. "show the numbers in the top header itself" instead of a chart.
 *
 * So the UI no longer renders `chart` at all (the API field itself is
 * unchanged/still optional — see comparisonTraceTools.test.ts — the UI
 * simply never reads it any more), and a compact `DeepDiveHeaderMetrics`
 * line (Score / Duration / Tools, A vs B) always renders in the panel header
 * instead, sourced from the reports directly rather than the LLM's chart
 * tool call. This spec asserts: (a) the chart block is GONE even when the
 * API still returns a `chart` field (regression guard against re-adding it),
 * (b) the header metrics line renders the real per-report numbers, and
 * (c) the suggested-experiments section — a separate, still-wanted feature —
 * is unaffected.
 *
 * Deterministic: storage, /api/comparison/deep-dive and /api/traces are all
 * mocked via page.route() — no LLM/AWS creds required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-chartA';
const RUN_B = 'eval-run-chartB';
const TC = 'tc-chart-experiments';
const RUNID_A = 'subprocess-chartA';
const RUNID_B = 'subprocess-chartB';
const TRACE_A = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const TRACE_B = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
const CITED_SPAN_A = TRACE_A + '-tool';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const evalRun = (id: string, agent: string, repId: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-03-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: [TC] }], trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Shared Case' }],
  results: { [TC]: { reportId: repId, status: 'completed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});
// `opts` lets each side of the A/B pair carry its OWN score/duration/tool
// count — the exact numbers the (now-removed) bars block used to chart, now
// asserted directly against the header-metrics line instead.
const report = (
  id: string,
  agent: string,
  runId: string,
  traceId: string,
  opts: { accuracy?: number; durationMs?: number; toolCalls?: number } = {}
) => ({
  id, createdAt: '2026-03-01T10:00:00Z', testCaseId: TC, agentId: agent,
  runId, modelId: 'claude-opus-4-8', status: 'completed', passFailStatus: 'passed',
  traceId, metrics: { accuracy: opts.accuracy ?? 100 },
  performanceMetrics: { durationMs: opts.durationMs ?? 60000, agentDurationMs: opts.durationMs ?? 60000 },
  trajectory: Array.from({ length: opts.toolCalls ?? 0 }, (_, i) => ({
    id: `t${i}`, timestamp: 0, type: 'action', content: '', toolName: 'some_tool',
  })),
});
// Report-A / report-B numbers match the owner's own example numbers
// ("Duration: 36.9s vs 29.2s"; "Tools: 3 vs 3") for a direct regression check.
const REPORT_A_OPTS = { accuracy: 100, durationMs: 36900, toolCalls: 3 };
const REPORT_B_OPTS = { accuracy: 50, durationMs: 29200, toolCalls: 3 };
const span = (traceId: string, spanId: string, name: string) => ({
  traceId, spanId, name, startTime: '2026-03-01T10:00:00.000Z', endTime: '2026-03-01T10:00:01.000Z',
  durationMs: 1000, serviceName: 'demo-agent', kind: 'SPAN_KIND_SERVER',
  attributes: { 'service.name': 'demo-agent' }, status: 'OK',
});

const deepDiveBodyWithExtras = {
  markdown: `**Both resolved it correctly — A was more thorough**\n\n- **Tool economy**: A made more tool calls than B.\n- **Errors**: no errors observed in run A; no errors observed in run B.\n`,
  modelId: 'amazon-bedrock/claude-opus-4-8',
  durationMs: 4200,
  // The API can still return `chart` (older/other agent runs may populate
  // it) — the UI must NOT render it any more regardless. See test below.
  chart: {
    title: 'Tool usage & retries',
    series: [
      { label: 'Tool calls', a: 12, b: 5 },
      { label: 'Retries', a: 3, b: 0, unit: 'calls' },
      { label: 'Duration', a: 211, b: 88, unit: 's' },
    ],
  },
  experiments: [
    {
      title: 'Force a mid-task tool failure',
      rationale: `A recovered from a retried [tool call](span:${RUNID_A}:${CITED_SPAN_A}) B never hit.`,
    },
    {
      title: 'Add a second related ticket to the prompt',
      rationale: 'Neither run explored cross-ticket linkage — worth probing.',
    },
  ],
  runs: [
    { key: 'A', reportId: 'rep-chart-a', runId: RUNID_A, serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
    { key: 'B', reportId: 'rep-chart-b', runId: RUNID_B, serviceName: 'demo-agent', startedAt: 1, endedAt: 2 },
  ],
};

async function setupRoutes(page: import('@playwright/test').Page, deepDiveBody: unknown) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const u = r.request().url();
    const m = u.match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-chart-a'), evalRun(RUN_B, 'pulsar', 'rep-chart-b')], total: 2 });
    if (id === RUN_A) return json(r, evalRun(RUN_A, 'demo', 'rep-chart-a'));
    if (id === RUN_B) return json(r, evalRun(RUN_B, 'pulsar', 'rep-chart-b'));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (r) => {
    const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-chart-a'))) runs.push(report('rep-chart-a', 'demo', RUNID_A, TRACE_A, REPORT_A_OPTS));
    if (ids.some((id) => id.includes('rep-chart-b'))) runs.push(report('rep-chart-b', 'pulsar', RUNID_B, TRACE_B, REPORT_B_OPTS));
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    if (u.includes('rep-chart-a')) return json(r, report('rep-chart-a', 'demo', RUNID_A, TRACE_A, REPORT_A_OPTS));
    if (u.includes('rep-chart-b')) return json(r, report('rep-chart-b', 'pulsar', RUNID_B, TRACE_B, REPORT_B_OPTS));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await mockDeepDiveJob(page, { result: deepDiveBody });
  await page.route('**/api/traces', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const tid = body.traceId as string | undefined;
    const spans = tid === TRACE_A ? [span(TRACE_A, CITED_SPAN_A, 'execute_tool bash')] : tid === TRACE_B ? [] : [];
    return json(r, { backend: 'opensearch', spans, total: spans.length });
  });
}

test.describe('Comparison deep-dive — no test-case info anywhere in the panel chrome, no metrics line, no chart + suggested experiments', () => {
  test('does not render any case label/anchor anywhere (not header, not footer), no metrics line, no chart; suggested experiments still render', async ({ page }) => {
    await setupRoutes(page, deepDiveBodyWithExtras);
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // The bars/chart block must NOT render, even though the mocked API
    // response above still includes a `chart` field — regression guard
    // against re-introducing the redundant "Performance & Outcome" bars.
    await expect(page.locator('[data-testid="deep-dive-chart"]')).toHaveCount(0);

    // Round 2: the compact "Score/Duration/Tools" header line is gone.
    // Round 3 (revised): the "Case: <name>" header line is gone too, AND (per
    // the owner's explicit revision) it does NOT reappear anywhere else in
    // the panel chrome — no header case label, no footer case anchor. The
    // trace grounding is comparison-wide now (any case, not one
    // representative case), so there is no single case identity left to name.
    await expect(page.locator('[data-testid="deep-dive-header-metrics"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="deep-dive-case-label"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="deep-dive-case-anchor"]')).toHaveCount(0);
    await expect(page.getByText('spans from case:')).toHaveCount(0);

    const footer = page.locator('[data-testid="deep-dive-footer"]');
    await expect(footer).toBeVisible({ timeout: 20000 });
    await expect(footer).toContainText('Generated by');
    await expect(footer).toContainText('click a highlighted span to open it in the Traces tab below');

    // Suggested experiments: heading + both suggestion titles + rationale text.
    // Unaffected by the header/footer case-info removal — a separate, still-wanted feature.
    const experiments = page.locator('[data-testid="deep-dive-experiments"]');
    await expect(experiments).toBeVisible();
    await expect(experiments).toContainText('Suggested next experiments');
    await expect(experiments).toContainText('Force a mid-task tool failure');
    await expect(experiments).toContainText('Add a second related ticket to the prompt');
    await expect(experiments).toContainText('Neither run explored cross-ticket linkage');

    // The span citation embedded in a suggestion's rationale still renders as
    // a clickable deep-link pill (reuses the same SpanAnchor as the narrative).
    const citation = experiments.locator(`button[data-span-id="${CITED_SPAN_A}"]`);
    await expect(citation).toBeVisible();
    await expect(citation).toHaveAttribute('data-run-id', RUNID_A);
  });

  test('footer stays plain (no case info) when the API response omits experiments', async ({ page }) => {
    const { experiments, ...bare } = deepDiveBodyWithExtras;
    await setupRoutes(page, bare);
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toBeVisible({ timeout: 20000 });
    // Chart never renders regardless of the API response.
    await expect(page.locator('[data-testid="deep-dive-chart"]')).toHaveCount(0);
    // Experiments section is genuinely absent when the API omits it.
    await expect(page.locator('[data-testid="deep-dive-experiments"]')).toHaveCount(0);
    // No metrics line, no header case label, no footer case anchor either way.
    await expect(page.locator('[data-testid="deep-dive-header-metrics"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="deep-dive-case-label"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="deep-dive-case-anchor"]')).toHaveCount(0);
    const footer = page.locator('[data-testid="deep-dive-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText('Generated by');
  });
});
