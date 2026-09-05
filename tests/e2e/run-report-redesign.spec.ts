/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for the redesigned legacy run-report page
 * (/benchmarks/:benchmarkId/runs/:runId, RunDetailsPage.tsx).
 *
 * Product direction: the bare route (no `?testCase`) must directly render
 * the run summary band + full test-case list - no "Select a test case"
 * empty pane, no redirect. Clicking a case updates the URL to
 * `?testCase=<id>` (shareable, back/forward-friendly); a deep link with
 * `?testCase=<id>` already set preselects that case's detail on load.
 *
 * Builds on the run-report-lazy-load regression test (large-run summary
 * fetch): reuses the same 84-case seeding shape.
 */

import { test, expect } from './fixtures/test-fixtures';

const TC_COUNT = 84;

test.describe('Run report page redesign (legacy /benchmarks/:id/runs/:id) — large run', () => {
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
          name: `e2e-report-redesign-tc-${i}-${stamp}`,
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
      const id = `report-e2e-report-redesign-${stamp}-${i}`;
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
        name: `E2E Report Redesign Benchmark ${stamp}`,
        description: 'run-report-redesign E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;

    runId = `run-e2e-report-redesign-${stamp}`;
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
          name: 'E2E Report Redesign Run',
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

  test('bare URL renders the summary band and the full test-case list directly - no click-through, no redirect', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);

    // Never redirected off the bare route.
    await expect(page).toHaveURL(new RegExp(`/benchmarks/${benchmarkId}/runs/${runId}$`));

    // Summary band renders directly, with verdict counts, no click needed.
    await expect(page.getByTestId('run-summary-band')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('run-summary-band-verdicts')).toContainText(`/ ${TC_COUNT}`);

    // The full test-case list is rendered directly below the band.
    await expect(page.getByText(/e2e-report-redesign-tc-0-/)).toBeVisible({ timeout: 15_000 });
    const rows = page.getByTestId('test-case-row');
    await expect(rows).toHaveCount(TC_COUNT, { timeout: 15_000 });

    // No "Select a test case" empty pane and no case detail rendered yet.
    await expect(page.getByText(/Select a test case/i)).toHaveCount(0);
  });

  test('clicking a case row updates the URL to ?testCase=<id> and shows the case detail', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);
    await expect(page.getByText(/e2e-report-redesign-tc-1-/)).toBeVisible({ timeout: 15_000 });

    await page.getByText(/e2e-report-redesign-tc-1-/).click();

    await expect(page).toHaveURL(new RegExp(`testCase=${testCaseIds[1]}`));
    // Case detail (existing RunDetailsContent rendering) shows up.
    await expect(page.getByText(`step for ${testCaseIds[1]}`)).toBeVisible({ timeout: 15_000 });

    // Back/forward: browser back returns to the un-selected list view.
    await page.goBack();
    await expect(page).not.toHaveURL(/testCase=/);
    await expect(page.getByTestId('run-summary-band')).toBeVisible();
  });

  test('deep-linking with ?testCase=<id> preselects and scrolls to that case', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    const targetTcId = testCaseIds[TC_COUNT - 1]; // last row - requires scroll
    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}?testCase=${targetTcId}`);

    // Preselected case's detail renders immediately, without a click.
    await expect(page.getByText(`step for ${targetTcId}`)).toBeVisible({ timeout: 15_000 });

    // The corresponding row is scrolled into view and visible.
    const row = page.locator(`[data-test-case-id="${targetTcId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Summary band is still present alongside the detail view.
    await expect(page.getByTestId('run-summary-band')).toBeVisible();
  });
});
