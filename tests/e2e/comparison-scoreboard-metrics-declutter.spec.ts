/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the comparison-scoreboard declutter (owner UX request):
 *
 *   1. Every RunAggregateMetrics metric (Pass Rate, Avg Accuracy, Cost, Avg
 *      Duration, Tokens, LLM Calls, Tool Calls) renders directly on the run
 *      row — no click, no separate "All metrics" panel.
 *   2. No chart renders anywhere in this flow (the recharts bar chart that
 *      used to live in the removed MetricComparisonPanel is gone).
 *   3. Judge info renders exactly ONCE for the whole scoreboard (not
 *      per-row), as a single muted line.
 *
 * Deterministic: storage + metrics are mocked via page.route(), no LLM/AWS
 * creds or seeded backend data required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-declutter-a';
const RUN_B = 'eval-run-declutter-b';
const TC = 'tc-declutter-shared';

const evalRun = (id: string, agentKey: string, reportId: string) => ({
  id,
  docType: 'evaluation-run',
  name: `Declutter Run ${agentKey}`,
  createdAt: '2026-03-05T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'claude-sonnet-4-20250514', // SAME judge model on both sides
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Declutter Shared Case' }],
  results: { [TC]: { reportId, status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});

const report = (id: string, agentKey: string) => ({
  id,
  createdAt: '2026-03-05T10:00:00Z',
  testCaseId: TC,
  agentId: agentKey,
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 88 },
  performanceMetrics: { durationMs: 42000 },
  trajectory: [],
});

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Comparison scoreboard — all metrics on the row, no chart, judge shown once', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_A}`)) return json(route, evalRun(RUN_A, 'demo', 'rep-declutter-a'));
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_B}`)) return json(route, evalRun(RUN_B, 'pulsar', 'rep-declutter-b'));
      if (url.pathname.endsWith('/evaluation-runs')) {
        return json(route, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-declutter-a'), evalRun(RUN_B, 'pulsar', 'rep-declutter-b')], total: 2 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
      const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
      const runs: unknown[] = [];
      if (ids.some((id) => id.includes('rep-declutter-a'))) runs.push(report('rep-declutter-a', 'demo'));
      if (ids.some((id) => id.includes('rep-declutter-b'))) runs.push(report('rep-declutter-b', 'pulsar'));
      return json(route, { runs, total: runs.length });
    });
    await page.route('**/api/storage/runs/**', (route) => {
      const url = route.request().url();
      if (url.includes('rep-declutter-a')) return json(route, report('rep-declutter-a', 'demo'));
      if (url.includes('rep-declutter-b')) return json(route, report('rep-declutter-b', 'pulsar'));
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
    await mockDeepDiveJob(page, { result: { markdown: 'stub', modelId: 'stub/model', durationMs: 1, runs: [] } });
  });

  test('every metric column renders on the run rows and no chart/expander appears', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const rowA = page.locator('[data-testid="scoreboard-row-A"]');
    const rowB = page.locator('[data-testid="scoreboard-row-B"]');
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    // Change 2 — every RunAggregateMetrics field visible directly on the row.
    await expect(rowA.locator(`[data-testid="run-passrate-${RUN_A}"]`)).toContainText('100%');
    await expect(rowA.locator(`[data-testid="run-accuracy-${RUN_A}"]`)).toContainText('88%');
    await expect(rowA).toContainText('--'); // cost/duration/tokens fall back to "--" without trace metrics
    await expect(rowB.locator(`[data-testid="run-passrate-${RUN_B}"]`)).toContainText('100%');
    await expect(rowB.locator(`[data-testid="run-accuracy-${RUN_B}"]`)).toContainText('88%');

    // The standalone "All metrics" expander + MetricComparisonPanel are gone.
    await expect(page.locator('[data-testid="scoreboard-all-metrics-toggle"]')).toHaveCount(0);
    await expect(page.getByText('All metrics', { exact: true })).toHaveCount(0);

    // Change 1 — no chart anywhere in this flow.
    await expect(page.locator('.recharts-wrapper')).toHaveCount(0);
    await expect(page.getByText('Quality metrics (higher is better)')).toHaveCount(0);
  });

  test('judge info renders exactly once, not per row (same judge model collapses to one line)', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const judgeLine = page.locator('[data-testid="scoreboard-judge-line"]');
    await expect(judgeLine).toHaveCount(1);
    await expect(judgeLine).toContainText('Judge:');
    // Not "Judge: A ... · B ..." since both runs share the same modelId.
    await expect(judgeLine).not.toContainText('· B');
  });

  test('inline Open-run link + Remove button replace the old per-row drawer', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const rowA = page.locator('[data-testid="scoreboard-row-A"]');
    await expect(rowA.locator(`[data-testid="open-run-${RUN_A}"]`)).toBeVisible();
    await expect(rowA.locator('button[title="Remove"]')).toBeVisible();
    // No expand affordance / drawer left behind.
    await expect(page.locator('text=started')).toHaveCount(0);
  });
});
