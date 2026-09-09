/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression test for the legacy run-report page
 * (/benchmarks/:benchmarkId/runs/:runId, RunDetailsPage.tsx).
 *
 * Repro (live tunnel, 84-case completed run): the content pane rendered two
 * header skeleton bars then nothing, indefinitely, with no loading/progress
 * indicator. Root cause: the page fetched EVERY full report body one at a
 * time AND the ENTIRE test-case corpus via an unscoped getAll() (168MB
 * observed against the shared cluster) just to resolve ~84 relevant test
 * cases. Same class of bug as #393 / #429, never ported to this legacy page.
 *
 * Covers:
 *   - the case list renders promptly for a large (84-case) run
 *   - an explicit loading indicator is shown while data is in flight (never
 *     a silent void)
 *   - the initial load never issues an unscoped test-cases fetch or a
 *     per-report full-body fetch for every case
 *   - a genuine fetch failure surfaces an inline error + Retry instead of a
 *     permanent blank pane
 */

import { test, expect } from './fixtures/test-fixtures';

const TC_COUNT = 84; // matches the reported repro run size

test.describe('Run report page (legacy /benchmarks/:id/runs/:id) — large run', () => {
  let testCaseIds: string[] = [];
  const reportIds: string[] = [];
  let benchmarkId: string | null = null;
  let runId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Reset: under fullyParallel a worker can leave this file and come back to
    // it, re-running beforeAll while module-level state persists — a `const []`
    // that is only ever push()ed accumulates the PREVIOUS invocation's ids
    // (already deleted by its afterAll), so `reportIds[i]` below would point at
    // 404s and rows render as PENDING. testCaseIds is reassigned, so it's fine.
    reportIds.length = 0;
    const stamp = Date.now();

    const tcRes = await request.post('/api/storage/test-cases/bulk', {
      data: {
        testCases: Array.from({ length: TC_COUNT }, (_, i) => ({
          name: `e2e-report-lazy-tc-${i}-${stamp}`,
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        })),
      },
    });
    if (!tcRes.ok()) return;
    const tcJson = await tcRes.json();
    testCaseIds = (tcJson.testCases || []).map((tc: any) => tc.id);
    if (testCaseIds.length !== TC_COUNT) return;

    const runsPayload = testCaseIds.map((tcId, i) => {
      const id = `report-e2e-report-lazy-${stamp}-${i}`;
      reportIds.push(id);
      return {
        id,
        testCaseId: tcId,
        testCaseVersionId: `${tcId}-v1`,
        agentId: 'demo',
        modelId: 'demo-model',
        iteration: 1,
        status: 'completed',
        passFailStatus: i === 0 ? 'failed' : 'passed',
        metricsStatus: 'ready',
        trajectory: [{ type: 'assistant', content: `step for ${tcId}` }],
      };
    });
    const bulkRes = await request.post('/api/storage/runs/bulk', { data: { runs: runsPayload } });
    if (!bulkRes.ok()) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `E2E Report Lazy Benchmark ${stamp}`,
        description: 'run-report-lazy-load E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;

    runId = `run-e2e-report-lazy-${stamp}`;
    const results: Record<string, { reportId: string; status: string }> = {};
    testCaseIds.forEach((tcId, i) => {
      results[tcId] = { reportId: reportIds[i], status: 'completed' };
    });
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [{
          id: runId,
          name: 'E2E Report Lazy Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results,
        }],
      },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    for (const id of reportIds) {
      await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    }
    for (const id of testCaseIds) {
      await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
    }
  });

  test('renders the case list promptly and never issues an unscoped test-cases fetch or N full-report fetches', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    const unscopedTestCaseFetches: string[] = [];
    const fullReportFetches: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      // Unscoped getAll(): /api/storage/test-cases with no ids= param.
      const tcMatch = /\/api\/storage\/test-cases(?:\?(.*))?$/.exec(url);
      if (tcMatch && !(tcMatch[1] || '').includes('ids=')) unscopedTestCaseFetches.push(url);
      // Full single-report fetch: /api/storage/runs/<id> (not a batch query).
      if (/\/api\/storage\/runs\/report-e2e-report-lazy-[^/?]+$/.test(url)) fullReportFetches.push(url);
    });

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);

    // Case list (sidebar) renders promptly — this is the page that used to
    // sit on a blank pane indefinitely. Assert an actual seeded test-case
    // name shows up, not just a badge count that could match anything.
    await expect(page.getByTestId('run-details-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/e2e-report-lazy-tc-0-/)).toBeVisible({ timeout: 15_000 });

    // Root-cause regression guards: no unscoped test-case corpus fetch, and
    // the initial (Summary-tab) load never fetches a full report body for
    // every case in the run.
    expect(unscopedTestCaseFetches).toHaveLength(0);
    expect(fullReportFetches.length).toBeLessThan(TC_COUNT / 4);
  });

  test('shows an explicit loading indicator while the run is in flight, never a silent void', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    // Slow the benchmark fetch down so the loading state is observable.
    await page.route(`**/api/storage/benchmarks/${benchmarkId}`, async (route) => {
      await new Promise(r => setTimeout(r, 800));
      await route.continue();
    });

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);
    await expect(page.getByTestId('run-details-loading-label')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('run-details-loading-label')).toContainText(/Loading/i);

    // ... and it resolves into real content, not a stuck skeleton.
    await expect(page.getByTestId('run-details-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('run-details-loading')).toHaveCount(0);
  });

  test('surfaces an inline error + Retry (never a blank pane) when the benchmark fetch genuinely fails', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    let shouldFail = true;
    await page.route(`**/api/storage/benchmarks/${benchmarkId}`, async (route) => {
      if (shouldFail) {
        await route.fulfill({ status: 500, body: JSON.stringify({ error: 'simulated failure' }) });
      } else {
        await route.continue();
      }
    });

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);
    await expect(page.getByTestId('run-details-error')).toBeVisible({ timeout: 15_000 });

    // Fix the failure and retry: the void must be recoverable, not permanent.
    shouldFail = false;
    await page.getByTestId('run-details-retry').click();
    await expect(page.getByTestId('run-details-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('run-details-error')).toHaveCount(0);
  });
});
