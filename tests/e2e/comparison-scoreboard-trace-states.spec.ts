/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E (#652 / #653 / #654): the Comparison scoreboard's trace-derived cells
 * (Cost / Tokens / LLM Calls) tell three states apart:
 *
 *   A. traced run    → the batch metrics' numbers (already leaf-attributed by
 *                      the server, so the page shows the de-duplicated totals
 *                      the same `/api/metrics` route returns for every view);
 *   B. untraced run  → "--" with a "not captured" tooltip (never a `$0.00`);
 *   C. store failure → "⚠ --" with the failure message — pre-fix this rendered
 *                      exactly like B, so an expired trace-store credential
 *                      read as "this run was not traced".
 *
 * Real-shaped: 3 cases per run, runs A and B share the SAME name (only the
 * agent differs), the batch response is HELD for a moment before answering
 * (the page must not settle on "--" while the request is in flight), and the
 * URL order (B, A, C) is not the run-pool order.
 *
 * Deterministic: storage + /api/metrics/batch are mocked via page.route().
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-tracestate-traced';
const RUN_B = 'eval-run-tracestate-untraced';
const RUN_C = 'eval-run-tracestate-storefail';
const CASES = ['tc-ts-1', 'tc-ts-2', 'tc-ts-3'];

/** Per-case leaf-attributed usage the server would return for run A (3 chat calls each). */
const A_CASE_METRICS = [
  { totalTokens: 6300, inputTokens: 6000, outputTokens: 300, costUsd: 0.0225, llmCalls: 3, toolCalls: 1, durationMs: 10_000 },
  { totalTokens: 4200, inputTokens: 4000, outputTokens: 200, costUsd: 0.015, llmCalls: 2, toolCalls: 1, durationMs: 8_000 },
  { totalTokens: 2100, inputTokens: 2000, outputTokens: 100, costUsd: 0.0075, llmCalls: 1, toolCalls: 0, durationMs: 4_000 },
];
const A_TOTAL_TOKENS = 12_600;
const A_TOTAL_LLM_CALLS = 6;

const reportId = (run: string, tc: string) => `rep-${run}-${tc}`;
const requestId = (run: string, tc: string) => `req-${run}-${tc}`;

const evalRun = (id: string, name: string, agentKey: string) => ({
  id,
  docType: 'evaluation-run',
  name,
  createdAt: '2026-03-10T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'demo-model',
  sources: [{ type: 'test-case-ids', ids: CASES }],
  trigger: 'cli',
  testCaseSnapshots: CASES.map((tc, i) => ({ id: tc, version: 1, name: `Help-center question ${i + 1}` })),
  results: Object.fromEntries(CASES.map((tc) => [tc, { reportId: reportId(id, tc), status: 'completed', passFailStatus: 'passed' }])),
  stats: { passed: 3, failed: 0, total: 3 },
});

const report = (run: string, tc: string, agentKey: string) => ({
  id: reportId(run, tc),
  createdAt: '2026-03-10T10:00:00Z',
  testCaseId: tc,
  agentId: agentKey,
  runId: requestId(run, tc),
  sessionId: requestId(run, tc),
  modelId: 'demo-model',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 80 },
  // Untraced reports carry NO totalTokens/totalCostUsd (#654) — only timings.
  performanceMetrics: { durationMs: 12_000, agentDurationMs: 11_500 },
  trajectory: [{ id: 't0', timestamp: 0, type: 'action', content: '', toolName: 'search' }],
});

const RUNS: Record<string, { name: string; agentKey: string }> = {
  [RUN_A]: { name: 'Nightly help-center QA', agentKey: 'demo-agent-traced' },
  [RUN_B]: { name: 'Nightly help-center QA', agentKey: 'demo-agent' },
  [RUN_C]: { name: 'Nightly help-center QA (store outage)', agentKey: 'demo-agent-traced' },
};
const allReports = () =>
  Object.entries(RUNS).flatMap(([run, { agentKey }]) => CASES.map((tc) => report(run, tc, agentKey)));

const pendingPlaceholder = (runId: string) => ({
  runId, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending', hasSpans: false,
});
const STORE_ERROR = 'The security token included in the request is expired';

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Comparison scoreboard — trace cells distinguish traced / untraced / store-failure (#652, #654)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      for (const [id, { name, agentKey }] of Object.entries(RUNS)) {
        if (url.pathname.endsWith(`/evaluation-runs/${id}`)) return json(route, evalRun(id, name, agentKey));
      }
      if (url.pathname.endsWith('/evaluation-runs')) {
        return json(route, { evaluationRuns: Object.entries(RUNS).map(([id, r]) => evalRun(id, r.name, r.agentKey)), total: 3 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
      const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
      const runs = allReports().filter((r) => ids.includes(r.id));
      return json(route, { runs, total: runs.length });
    });
    await page.route('**/api/storage/runs/**', (route) => {
      const hit = allReports().find((r) => route.request().url().includes(r.id));
      return hit ? json(route, hit) : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    // The batch metrics API, keyed exactly as the page keys it (report.runId):
    // real leaf-attributed numbers for A, pending placeholders for B, a
    // per-key store failure for C. HELD for 1.5 s so the page is observed
    // while the request is still in flight.
    await page.route('**/api/metrics/batch**', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      const runIds: string[] = body.runIds || [];
      const metrics = runIds.map((key) => {
        const aIdx = CASES.findIndex((tc) => key === requestId(RUN_A, tc));
        if (aIdx >= 0) {
          return { runId: key, traceId: `trace-${aIdx}`, ...A_CASE_METRICS[aIdx], toolsUsed: ['search'], status: 'success', hasSpans: true, correlatedBy: 'ids' };
        }
        if (CASES.some((tc) => key === requestId(RUN_C, tc))) {
          return { runId: key, error: STORE_ERROR, status: 'error' };
        }
        return pendingPlaceholder(key);
      });
      await new Promise((r) => setTimeout(r, 1500));
      return json(route, { metrics, aggregate: {} });
    });
    await mockDeepDiveJob(page, { result: { markdown: 'stub', modelId: 'stub/model', durationMs: 1, runs: [] } });
  });

  test('traced run shows the numbers; untraced run shows "--" (not captured); store failure shows "⚠ --" with the error', async ({ page }) => {
    // URL order ≠ pool order: B first, then A, then C.
    await page.goto(`/compare?runs=${RUN_B},${RUN_A},${RUN_C}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const tokensA = page.locator(`[data-testid="run-tokens-${RUN_A}"]`);
    const tokensB = page.locator(`[data-testid="run-tokens-${RUN_B}"]`);
    const tokensC = page.locator(`[data-testid="run-tokens-${RUN_C}"]`);

    // A (traced): the batch numbers — summed per run, leaf-attributed server-side.
    await expect(tokensA).toHaveAttribute('data-trace-state', 'value', { timeout: 15000 });
    await expect(tokensA).toHaveText(/12\.6K/);
    await expect(page.locator(`[data-testid="run-llmcalls-${RUN_A}"]`)).toHaveText(String(A_TOTAL_LLM_CALLS));
    await expect(page.locator(`[data-testid="run-cost-${RUN_A}"]`)).toContainText('$0.0');
    expect(A_TOTAL_TOKENS).toBe(A_CASE_METRICS.reduce((a, m) => a + m.totalTokens, 0));

    // B (untraced): "--", and the tooltip says NOT CAPTURED — never $0.00 / 0.
    await expect(tokensB).toHaveAttribute('data-trace-state', 'none');
    await expect(tokensB).toHaveText('--');
    await expect(tokensB).toHaveAttribute('title', /not captured/i);
    await expect(page.locator(`[data-testid="run-cost-${RUN_B}"]`)).toHaveText('--');
    await expect(page.locator(`[data-testid="run-llmcalls-${RUN_B}"]`)).toHaveText('--');

    // C (store failure): visibly different from B — a warning marker and the
    // store's own message in the tooltip.
    await expect(tokensC).toHaveAttribute('data-trace-state', 'unavailable');
    await expect(tokensC).toContainText('⚠');
    await expect(tokensC).toHaveAttribute('title', new RegExp(`unavailable: ${STORE_ERROR}`));
    await expect(page.locator(`[data-testid="run-cost-${RUN_C}"]`)).toHaveAttribute('data-trace-state', 'unavailable');
    await expect(page.locator(`[data-testid="run-llmcalls-${RUN_C}"]`)).toHaveAttribute('data-trace-state', 'unavailable');

    // Avg Duration comes from the reports' own timings and is shown for every run.
    for (const run of [RUN_A, RUN_B, RUN_C]) {
      await expect(page.locator(`[data-testid="run-duration-${run}"]`)).not.toHaveText('--');
    }
  });

  test('when the whole batch request fails, every run reads "unavailable" rather than "not captured"', async ({ page }) => {
    await page.route('**/api/metrics/batch**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'trace store unreachable' }) }));
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
    const tokensA = page.locator(`[data-testid="run-tokens-${RUN_A}"]`);
    await expect(tokensA).toHaveAttribute('data-trace-state', 'unavailable', { timeout: 15000 });
    await expect(tokensA).toHaveAttribute('title', /unavailable: trace store unreachable/);
    await expect(page.locator(`[data-testid="run-tokens-${RUN_B}"]`)).toHaveAttribute('data-trace-state', 'unavailable');
  });
});
