/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: benchmark-free comparison.
 *
 * Comparison is a test-case-level primitive — it must work for ad-hoc runs that
 * have no benchmarkId. This spec lands on `/compare?runs=a,b` (NO benchmark in
 * the URL) with two ad-hoc evaluation-runs whose test-case coverage only
 * partially overlaps, and asserts:
 *
 *   1. The comparison page renders (no redirect to /benchmarks, no empty state).
 *   2. The benchmark selector shows "All runs" (the runs-first, no-benchmark mode).
 *   3. Both runs are selected from the `?runs=` param.
 *   4. The test-level overlap banner renders in its PARTIAL state, naming how
 *      many cases are shared vs. only-in-some — the honesty surface the user
 *      asked for ("the summary tells which tests overlapped and which didn't").
 *
 * Storage + metrics endpoints are mocked via page.route() so the test is
 * deterministic and needs no backend data, AWS, or OpenSearch.
 */

// `test`/`expect` come from the local fixtures (not raw '@playwright/test')
// so this spec's execution is captured by the E2E Istanbul coverage collector
// (see tests/e2e/fixtures/test-fixtures.ts) — it renders ComparisonScoreboard
// end-to-end and was previously invisible to coverage reporting entirely.
import { test, expect } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-a';
const RUN_B = 'eval-run-b';

// Run A ran tc-1, tc-2; Run B ran tc-2, tc-3 → shared {tc-2}, partial {tc-1, tc-3}.
const evalRunA = {
  id: RUN_A,
  docType: 'evaluation-run',
  name: 'Ad-hoc Run A',
  createdAt: '2026-02-01T10:00:00Z',
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }],
  trigger: 'cli',
  testCaseSnapshots: [
    { id: 'tc-1', version: 1, name: 'Case 1' },
    { id: 'tc-2', version: 1, name: 'Case 2' },
  ],
  results: {
    'tc-1': { reportId: 'rep-a-1', status: 'completed' },
    'tc-2': { reportId: 'rep-a-2', status: 'completed' },
  },
  stats: { passed: 2, failed: 0, total: 2 },
  // no benchmarkId — this is the ad-hoc case
};

const evalRunB = {
  id: RUN_B,
  docType: 'evaluation-run',
  name: 'Ad-hoc Run B',
  createdAt: '2026-02-02T10:00:00Z',
  status: 'completed',
  agentKey: 'pulsar',
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: ['tc-2', 'tc-3'] }],
  trigger: 'cli',
  testCaseSnapshots: [
    { id: 'tc-2', version: 1, name: 'Case 2' },
    { id: 'tc-3', version: 1, name: 'Case 3' },
  ],
  results: {
    'tc-2': { reportId: 'rep-b-2', status: 'completed' },
    'tc-3': { reportId: 'rep-b-3', status: 'failed' },
  },
  stats: { passed: 1, failed: 1, total: 2 },
};

function storageRun(id: string, testCaseId: string, agentId: string, passed: boolean) {
  return {
    id,
    createdAt: '2026-02-01T10:00:00Z',
    testCaseId,
    agentId,
    modelId: 'claude-sonnet-4-20250514',
    status: 'completed',
    passFailStatus: passed ? 'passed' : 'failed',
    metrics: { accuracy: passed ? 90 : 40, faithfulness: passed ? 85 : 35 },
    trajectory: [],
  };
}

const reports: Record<string, ReturnType<typeof storageRun>> = {
  'rep-a-1': storageRun('rep-a-1', 'tc-1', 'demo', true),
  'rep-a-2': storageRun('rep-a-2', 'tc-2', 'demo', true),
  'rep-b-2': storageRun('rep-b-2', 'tc-2', 'pulsar', true),
  'rep-b-3': storageRun('rep-b-3', 'tc-3', 'pulsar', false),
};

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Benchmark-free comparison (test-level primitive)', () => {
  test.beforeEach(async ({ page }) => {
    // No benchmarks at all — proves comparison does not require one.
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));

    // Test cases (names are best-effort; rows fall back to ids if absent).
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));

    // Evaluation-runs: list returns both ad-hoc runs; single-id returns the run.
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith('/evaluation-runs')) {
        return json(route, { evaluationRuns: [evalRunA, evalRunB], total: 2 });
      }
      const id = path.split('/').pop();
      if (id === RUN_A) return json(route, evalRunA);
      if (id === RUN_B) return json(route, evalRunB);
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
    });

    // Reports for the selected runs' results.
    await page.route('**/api/storage/runs/**', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').pop() || '';
      const rep = reports[id];
      if (rep) return json(route, rep);
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
    });

    // Trace metrics — none available; page falls back gracefully.
    await page.route('**/api/metrics/batch', (route) => json(route, { metrics: [] }));
  });

  test('renders runs-first comparison with a partial-overlap banner (no benchmark)', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);

    // Page renders (did NOT redirect to /benchmarks or show the old empty state).
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="comparison-title"]')).toHaveText('Compare Runs');

    // Both runs selected from the ?runs= param — shown in the unified search
    // trigger, which replaced the benchmark-select + run-multiselect toolbar.
    await expect(page.locator('[data-testid="comparison-search"]')).toContainText('2 of');

    // The honesty surface: the scoreboard's coverage cell carries the overlap
    // contract (was a standalone banner). Partial overlap shows a plain
    // "N in both · M only in A/B" statement (bug #4, iteration 4: reworded
    // from "N shared / M total" — owner feedback that phrasing was
    // confusing); the per-run "only here" breakdown lives in the tooltip.
    const banner = page.locator('[data-testid="comparison-overlap-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-overlap', 'partial');
    await expect(banner).toContainText('in both');
    await expect(banner).toHaveAttribute('title', /only in some runs/);

    // A/B legend: the scoreboard IS the legend now — one row per run with the
    // A/B badge and the full run name (URL order — A = first run, B = second).
    const legend = page.locator('[data-testid="comparison-scoreboard"]');
    await expect(legend).toBeVisible();
    await expect(legend.locator('[data-testid="scoreboard-row-A"]')).toBeVisible();
    await expect(legend.locator('[data-testid="scoreboard-row-B"]')).toBeVisible();
  });

  test('run row shows every metric inline and an Open-run link + Remove button (no drawer); A/B swap keeps both rows rendered', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const rowA = page.locator('[data-testid="scoreboard-row-A"]');
    await expect(rowA).toBeVisible();

    // Every metric renders directly on the row (Change 2) — no click needed.
    await expect(rowA.locator(`[data-testid="run-passrate-${RUN_A}"]`)).toBeVisible();
    await expect(rowA.locator(`[data-testid="run-accuracy-${RUN_A}"]`)).toBeVisible();

    // Inline "Open run" link (Change 3) — no drawer, no click-to-expand.
    const openRunLink = rowA.locator(`a[href="/evaluations/runs/${RUN_A}"]`);
    await expect(openRunLink).toBeVisible();

    // Judge info renders exactly once for the whole scoreboard, not per row.
    await expect(page.locator('[data-testid="scoreboard-judge-line"]')).toHaveCount(1);

    // No "All metrics" expander and no chart in this flow anymore.
    await expect(page.locator('[data-testid="scoreboard-all-metrics-toggle"]')).toHaveCount(0);
    await expect(page.locator('.recharts-wrapper')).toHaveCount(0);

    // Remove affordance is inline on the row (title="Remove"), no drawer needed.
    await expect(rowA.locator('button[title="Remove"]')).toBeVisible();

    // Swap A/B via the delta-footer control — both rows re-render (no crash,
    // no request outside the mocks set up in beforeEach).
    await page.locator('button[title="Swap A/B"]').click();
    await expect(page.locator('[data-testid="scoreboard-row-A"]')).toBeVisible();
    await expect(page.locator('[data-testid="scoreboard-row-B"]')).toBeVisible();
  });
});
