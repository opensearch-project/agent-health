/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the per-benchmark Runs list (BenchmarkRunsPage) displayed the
 * "passed" count straight from the denormalized `run.stats.passed` field
 * whenever it was present, even though that field is known-stale/wrong for
 * runs where the evaluator errored on a case (issue #242 — the old
 * aggregator counted every "completed" result as passed regardless of
 * verdict). The Evaluation Runs list already recomputes from run.results
 * via lib/runStats; this pins the per-benchmark Runs list to the same
 * source of truth so the two views can't show different passed counts for
 * the same run.
 *
 * Seeds a run with a deliberately WRONG run.stats.passed (2) while
 * run.results has only 1 real pass + 1 completed-without-verdict (errored)
 * case — the correct passed count is 1.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Runs list — passed count matches run.results, not stale run.stats', () => {
  // beforeAll fixtures outlive single tests, so the per-test testData fixture
  // cannot own them — this tracker does (afterAll + crash ledger). This spec
  // used to leak its `e2e-passedcount-tc-*` test cases (5 measured on the
  // shared cluster) whenever a worker died before the hand-rolled afterAll.
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  const testCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`passedcount-tc-${i}`),
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }
    if (testCaseIds.length !== 2) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('passedcount-benchmark'),
        description: 'passed-count E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    runId = `run-passedcount-e2e-${Date.now()}`;
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [{
          id: runId,
          name: 'Passed-Count E2E Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {
            [testCaseIds[0]]: { reportId: 'report-passedcount-1', status: 'completed', passFailStatus: 'passed' },
            // Judge errored: completed but no verdict — must NOT count as passed.
            [testCaseIds[1]]: { reportId: 'report-passedcount-2', status: 'completed' },
          },
          // Deliberately wrong/stale denormalized stats (the #242 shape):
          // claims 2 passed when only 1 case actually has a 'passed' verdict.
          stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 },
        }],
      },
    });
    if (!put.ok()) {
      benchmarkId = null;
      return;
    }
  });

  test.afterAll(async () => {
    // Children before parents, 404-tolerant, ledger-backed. The seeded run is
    // an EMBEDDED subdocument of the benchmark and dies with it; its
    // `report-passedcount-*` reportIds never exist as standalone docs.
    await tracker.cleanup();
  });

  test('shows 1 passed / 1 errored (recomputed), not the stale 2 passed', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('text=Passed-Count E2E Run')).toBeVisible({ timeout: 15000 });

    // This benchmark has exactly one run, so the stats cell on the page is
    // unambiguous. The recomputed passed count is 1 (from run.results),
    // NOT the stale run.stats.passed === 2.
    const stats = page.locator('[data-testid="run-row"]', { hasText: 'Passed-Count E2E Run' }).getByTestId('run-stats');
    await expect(stats.locator('[class*="text-green-700"]')).toHaveText('1', { timeout: 15000 });
    // 1 passed / 0 failed → 100% over the evaluable set (errored excluded).
    await expect(page.getByTestId('run-passrate-cell')).toContainText('100%');

    // AlertTriangle-tagged errored badge shows the miscounted case, proving
    // it was excluded from "passed" rather than silently folded into it.
    await expect(page.locator('[title*="Evaluator could not run"]')).toBeVisible({ timeout: 15000 });
  });
});
