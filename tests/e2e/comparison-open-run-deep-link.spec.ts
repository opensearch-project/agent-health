/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "Open run" deep link in the comparison scoreboard drawer.
 *
 * Regression: the drawer used to always link to `/evaluations/runs/:runId`,
 * which resolves only the SDK eval-run store — a benchmark run id there
 * renders a "not found" page. This mixes THREE runs in the same
 * `/compare?runs=` pool (the realistic shape: unscoped comparisons union
 * every benchmark's runs with every top-level eval-run):
 *
 *   1. A run actually embedded in a benchmark's `runs[]` — must deep-link to
 *      the benchmark route, and clicking it must land on the run inspector,
 *      not redirect away.
 *   2. A fully ad-hoc eval-run with no benchmark association at all — must
 *      deep-link to the bare eval-run route.
 *   3. An eval-run that merely carries a `benchmarkId` LABEL (the "associate
 *      with a benchmark" picker on the New Run page persists this on the
 *      EvaluationRun doc for context/filtering) but is NOT embedded in that
 *      benchmark's `runs[]` — this is the sharp edge the fix has to avoid:
 *      routing on `benchmarkId` truthiness alone would send this to the
 *      benchmark route, which 404s/redirects (`bm.runs.find` finds nothing).
 *      Must still deep-link to the bare eval-run route.
 *
 * Each case also clicks through and asserts the resulting URL, not just the
 * rendered `href` string.
 */

// `test`/`expect` come from the local fixtures (not raw '@playwright/test')
// so this spec's execution is captured by the E2E coverage collector.
import { test, expect } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const BENCH_ID = 'bm-deeplink-e2e';
const BENCH_RUN_ID = 'run-deeplink-bench';
const ADHOC_RUN_ID = 'run-deeplink-adhoc';
const LABELED_RUN_ID = 'run-deeplink-labeled-not-embedded';

const now = new Date().toISOString();

const benchmarkRun = {
  id: BENCH_RUN_ID,
  name: 'Benchmark Run',
  createdAt: now,
  agentKey: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  results: { 'tc-1': { reportId: 'rep-bench-1', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
};

const benchmark = {
  id: BENCH_ID,
  name: 'Deep Link Benchmark',
  description: '',
  createdAt: now,
  updatedAt: now,
  currentVersion: 1,
  versions: [{ version: 1, createdAt: now, testCaseIds: ['tc-1'] }],
  testCaseIds: ['tc-1'],
  // Only benchmarkRun lives here — LABELED_RUN_ID is deliberately absent
  // even though it carries this benchmark's id as a label (see below).
  runs: [benchmarkRun],
};

const adhocEvalRun = {
  id: ADHOC_RUN_ID,
  docType: 'evaluation-run',
  name: 'Ad-hoc Run',
  createdAt: now,
  status: 'completed',
  agentKey: 'pulsar',
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: ['tc-2'] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: 'tc-2', version: 1, name: 'Case 2' }],
  results: { 'tc-2': { reportId: 'rep-adhoc-2', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
  // no benchmarkId — this is the fully ad-hoc case
};

const labeledNotEmbeddedRun = {
  id: LABELED_RUN_ID,
  docType: 'evaluation-run',
  name: 'Labeled (not embedded) Run',
  createdAt: now,
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: ['tc-3'] }],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-3', version: 1, name: 'Case 3' }],
  results: { 'tc-3': { reportId: 'rep-labeled-3', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
  // Carries the benchmark's id as a user-chosen association/label, but is
  // NOT in `benchmark.runs[]` above — this is what NewRunPage's "benchmark
  // association" picker produces for a standalone eval-run.
  benchmarkId: BENCH_ID,
};

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Comparison scoreboard — "Open run" deep link', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => {
      const url = route.request().url();
      if (url.includes(BENCH_ID)) return json(route, benchmark);
      return json(route, { benchmarks: [benchmark], total: 1 });
    });
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/evaluation-runs/${ADHOC_RUN_ID}`)) return json(route, adhocEvalRun);
      if (url.pathname.endsWith(`/evaluation-runs/${LABELED_RUN_ID}`)) return json(route, labeledNotEmbeddedRun);
      if (url.pathname.endsWith('/evaluation-runs')) {
        return json(route, { evaluationRuns: [adhocEvalRun, labeledNotEmbeddedRun], total: 2 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/storage/annotations**', (route) => json(route, { annotations: [], total: 0 }));
    await page.route('**/api/metrics/batch**', (route) => json(route, {}));
    // Report-summary batch (RunInspectorPage's lazy-loading batch fetch) —
    // empty is fine, the inspector falls back to execution status.
    await page.route('**/api/storage/runs?ids=**', (route) => json(route, { runs: [], total: 0 }));
  });

  test('benchmark run deep-links to the benchmark route and clicking it opens the inspector (not a redirect-away)', async ({ page }) => {
    await page.goto(`/compare?runs=${BENCH_RUN_ID},${ADHOC_RUN_ID}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    // No click-to-expand needed anymore — the Open-run link is inline on the row.
    const openRunA = page.locator(`[data-testid="open-run-${BENCH_RUN_ID}"]`);
    await expect(openRunA).toBeVisible();
    await expect(openRunA).toHaveAttribute('href', `/evaluations/benchmarks/${BENCH_ID}/runs/${BENCH_RUN_ID}`);

    await openRunA.click();
    // The benchmarkId/runId route redirects to .../inspect (App.tsx) —
    // BenchmarkRunDetailPage's real successor. If `bm.runs.find` had failed
    // to locate the run it would instead redirect to the runs LIST
    // (`/evaluations/benchmarks/:benchmarkId/runs`, no trailing /:runId) —
    // assert we land on the run-specific inspector, not the list.
    await page.waitForURL(`**/evaluations/benchmarks/${BENCH_ID}/runs/${BENCH_RUN_ID}/inspect`, { timeout: 15000 });
    await expect(page).not.toHaveURL(new RegExp(`/evaluations/benchmarks/${BENCH_ID}/runs$`));
  });

  test('fully ad-hoc eval-run (no benchmark association) deep-links to the bare eval-run route', async ({ page }) => {
    await page.goto(`/compare?runs=${BENCH_RUN_ID},${ADHOC_RUN_ID}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const openRunB = page.locator(`[data-testid="open-run-${ADHOC_RUN_ID}"]`);
    await expect(openRunB).toBeVisible();
    await expect(openRunB).toHaveAttribute('href', `/evaluations/runs/${ADHOC_RUN_ID}`);

    await openRunB.click();
    await page.waitForURL(`**/evaluations/runs/${ADHOC_RUN_ID}`, { timeout: 15000 });
  });

  test('eval-run labeled with a benchmarkId but NOT embedded in that benchmark still deep-links to the bare eval-run route', async ({ page }) => {
    // Regression for routing on benchmarkId truthiness alone: this run
    // carries `benchmarkId: BENCH_ID` as a label, but BENCH_ID's `runs[]`
    // does not contain it — the benchmark route would 404/redirect for it.
    await page.goto(`/compare?runs=${BENCH_RUN_ID},${LABELED_RUN_ID}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const openRunLabeled = page.locator(`[data-testid="open-run-${LABELED_RUN_ID}"]`);
    await expect(openRunLabeled).toBeVisible();
    await expect(openRunLabeled).toHaveAttribute('href', `/evaluations/runs/${LABELED_RUN_ID}`);

    await openRunLabeled.click();
    await page.waitForURL(`**/evaluations/runs/${LABELED_RUN_ID}`, { timeout: 15000 });
    // Never routed through the benchmark path at all.
    await expect(page).not.toHaveURL(new RegExp(`/evaluations/benchmarks/${BENCH_ID}/runs`));
  });
});
