/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression test for the Evals3 run inspector page
 * (/evaluations/benchmarks/:benchmarkId/runs/:runId, redirects to
 * .../inspect, RunInspectorPage.tsx).
 *
 * Repro (live tunnel, 84-case completed run): opening the BARE run URL
 * (no `?reportId=`) auto-opened the first test case's detail pane instead
 * of landing on a verdict-first overview. This is the same class of bug
 * #443 fixed on the legacy /benchmarks/:id/runs/:id page (RunDetailsPage.tsx)
 * — RunInspectorPage.tsx (the page most in-app links actually navigate to)
 * still auto-selected `resultRows[0]` unconditionally.
 *
 * Covers:
 *   - bare run URL never auto-opens a test case's detail pane
 *   - the "Select a test case" empty state is shown instead
 *   - the header verdict counts (pass/fail/total) are visible regardless
 *   - `?reportId=<id>` deep links still preselect that case's detail (must
 *     keep working — only the *unconditional* fallback-to-first-row is gone)
 */

import { test, expect } from './fixtures/test-fixtures';

const TC_COUNT = 5;

test.describe('Run inspector page (/evaluations/.../runs/:id) — no auto-select on bare URL', () => {
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
          name: `e2e-inspector-noauto-tc-${i}-${stamp}`,
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
      const id = `report-e2e-inspector-noauto-${stamp}-${i}`;
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
        name: `E2E Inspector No-Autoselect Benchmark ${stamp}`,
        description: 'run-inspector-no-autoselect E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;

    runId = `run-e2e-inspector-noauto-${stamp}`;
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
          name: 'E2E Inspector No-Autoselect Run',
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

  test('bare run URL lands on verdict-first overview — no test case auto-opened', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}`);

    // Redirects to the inspect sub-route, but stays on the bare (no reportId) URL.
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect$`));

    // Header verdict counts are visible immediately (verdict-first).
    await expect(page.getByText(`/ ${TC_COUNT}`)).toBeVisible({ timeout: 15_000 });

    // The list of cases is rendered.
    const rows = page.getByTestId('test-case-row');
    await expect(rows).toHaveCount(TC_COUNT, { timeout: 15_000 });

    // No row is pre-selected...
    for (const id of testCaseIds) {
      await expect(page.locator(`[data-test-case-id="${id}"]`)).not.toHaveClass(/bg-blue-500/);
    }
    // ...and the right pane shows the empty state, NOT a case's detail
    // (this is the exact regression: it used to auto-open testCaseIds[0]).
    await expect(page.getByText(/Select a test case/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`step for ${testCaseIds[0]}`)).toHaveCount(0);
  });

  test('clicking a row opens its detail; ?reportId= deep link still preselects', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}`);
    await expect(page.getByText(/e2e-inspector-noauto-tc-1-/)).toBeVisible({ timeout: 15_000 });
    await page.getByText(/e2e-inspector-noauto-tc-1-/).click();
    await expect(page.getByText(`step for ${testCaseIds[1]}`)).toBeVisible({ timeout: 15_000 });

    // Deep link with ?reportId= (the actual navigation shape used by
    // EvalRunDetailPage's 'View' button — direct to .../inspect, not the
    // bare redirecting route) still preselects that case on a fresh load.
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect?reportId=${reportIds[2]}`);
    await expect(page.getByText(`step for ${testCaseIds[2]}`)).toBeVisible({ timeout: 15_000 });
  });
});
