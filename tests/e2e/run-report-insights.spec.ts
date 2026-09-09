/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for RunInsightsPane — the right-side pane shown on the
 * redesigned legacy run-report page (/benchmarks/:benchmarkId/runs/:runId,
 * RunDetailsPage.tsx) when no test case is selected.
 *
 * Owner feedback: "I liked the split view ... if no test case is selected,
 * the right side can show an aggregated view ... why did the failing tests
 * been failing." This seeds a run whose failing cases mostly share a
 * paraphrased "OpenSearch MCP connectivity" judge reasoning (modeled on the
 * real production 418-verify run — see lib/runInsights.ts and
 * tests/unit/fixtures/mcpConnectivityReasonings.ts) plus a couple of
 * unrelated failures, and asserts:
 *   - the bare URL shows the split view (list + RunInsightsPane) directly
 *   - the dominant connectivity theme surfaces with its case count
 *   - clicking the theme filters the left list to just those cases
 *   - selecting a case shows its detail; deselecting (Overview) returns to
 *     the insights pane with the filter cleared
 */

import { test, expect } from './fixtures/test-fixtures';

const TC_COUNT = 20;
// First 6 cases fail with paraphrased "OpenSearch MCP connectivity" judge
// reasoning (same family as the real 418-verify run) - the dominant theme.
const CONNECTIVITY_FAIL_COUNT = 6;
const CONNECTIVITY_REASONINGS = [
  'The agent was unable to retrieve any information from the OpenSearch index due to tool connectivity issues.',
  'The agent failed to retrieve any information from the corpus due to tool connectivity issues, resulting in an incomplete answer.',
  'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools were unavailable during the session.',
  'The agent failed to retrieve any information from the knowledge base due to the OpenSearch MCP server not being available during the session.',
  'The agent was unable to access the OpenSearch index due to tool connectivity issues, resulting in zero required facts being stated.',
  'The agent was unable to retrieve any information from the OpenSearch index due to MCP server connectivity issues.',
];
// One unrelated failure - must NOT be swept into the connectivity theme.
const UNRELATED_FAIL_INDEX = 6;
const UNRELATED_REASONING = 'The agent exceeded the configured rate limit while calling the downstream pricing API.';

test.describe('RunInsightsPane (run-report-insights) — always-split layout, no selection', () => {
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
          name: `e2e-report-insights-tc-${i}-${stamp}`,
          category: i % 2 === 0 ? 'RAG' : 'Tools',
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
      const id = `report-e2e-report-insights-${stamp}-${i}`;
      reportIds.push(id);
      const failed = i < CONNECTIVITY_FAIL_COUNT || i === UNRELATED_FAIL_INDEX;
      const reasoning = i < CONNECTIVITY_FAIL_COUNT
        ? CONNECTIVITY_REASONINGS[i]
        : i === UNRELATED_FAIL_INDEX
          ? UNRELATED_REASONING
          : 'The agent answered correctly.';
      return {
        id,
        testCaseId: tcId,
        testCaseVersionId: `${tcId}-v1`,
        agentId: 'demo',
        modelId: 'demo-model',
        iteration: 1,
        status: 'completed',
        passFailStatus: failed ? 'failed' : 'passed',
        metricsStatus: 'ready',
        llmJudgeReasoning: reasoning,
        trajectory: [{ type: 'assistant', content: `step for ${tcId}` }],
      };
    });
    const bulkRes = await request.post('/api/storage/runs/bulk', { data: { runs: runsPayload } });
    if (!bulkRes.ok()) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `E2E Report Insights Benchmark ${stamp}`,
        description: 'run-report-insights E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;

    runId = `run-e2e-report-insights-${stamp}`;
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
          name: 'E2E Report Insights Run',
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

  test('bare URL shows the split view directly, with RunInsightsPane surfacing the dominant connectivity theme', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);

    // Never redirected off the bare route, split view renders directly.
    await expect(page).toHaveURL(new RegExp(`/benchmarks/${benchmarkId}/runs/${runId}$`));
    await expect(page.getByTestId('run-test-case-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('run-insights-pane')).toBeVisible({ timeout: 15_000 });

    // Category bars render (RAG / Tools).
    await expect(page.getByTestId('run-insights-category-bars')).toBeVisible();

    // The dominant "why runs failed" theme surfaces with the connectivity
    // cluster's case count, and the unrelated failure is NOT folded into it
    // (themes list has more than one entry).
    const themes = page.getByTestId('run-insights-theme');
    await expect(themes.first()).toBeVisible({ timeout: 15_000 });
    await expect(themes.first()).toContainText(`${CONNECTIVITY_FAIL_COUNT} cases`);
    await expect(themes.first()).toContainText(/opensearch/i);
    await expect(themes).toHaveCount(2, { timeout: 15_000 });
  });

  test('clicking the dominant theme filters the left list to just those cases', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);
    const themes = page.getByTestId('run-insights-theme');
    await expect(themes.first()).toBeVisible({ timeout: 15_000 });
    await expect(themes.first()).toContainText(`${CONNECTIVITY_FAIL_COUNT} cases`);

    await themes.first().click();

    // Left list narrows to the theme's case count and shows a clear-filter chip.
    await expect(page.getByTestId('test-case-list-clear-filter')).toBeVisible({ timeout: 15_000 });
    const rows = page.getByTestId('test-case-row');
    await expect(rows).toHaveCount(CONNECTIVITY_FAIL_COUNT, { timeout: 15_000 });

    // Every visible row is one of the first CONNECTIVITY_FAIL_COUNT cases.
    const expectedIds = new Set(testCaseIds.slice(0, CONNECTIVITY_FAIL_COUNT));
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const id = await rows.nth(i).getAttribute('data-test-case-id');
      expect(expectedIds.has(id || '')).toBe(true);
    }

    // Clearing the filter restores the full list.
    await page.getByTestId('test-case-list-clear-filter').click();
    await expect(page.getByTestId('test-case-row')).toHaveCount(TC_COUNT, { timeout: 15_000 });
  });

  test('selecting a case shows its detail; Overview returns to the insights pane with the filter cleared', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/benchmarks/${benchmarkId}/runs/${runId}`);
    const themes = page.getByTestId('run-insights-theme');
    await expect(themes.first()).toBeVisible({ timeout: 15_000 });
    await themes.first().click();
    await expect(page.getByTestId('test-case-list-clear-filter')).toBeVisible({ timeout: 15_000 });

    // Select the first (filtered) case.
    await page.getByTestId('test-case-row').first().click();
    await expect(page).toHaveURL(/testCase=/);
    await expect(page.getByTestId('run-insights-pane')).toHaveCount(0);
    await expect(page.getByText(`step for ${testCaseIds[0]}`)).toBeVisible({ timeout: 15_000 });

    // Overview returns to the insights pane, clears both selection and filter.
    await page.getByTestId('test-case-list-overview').click();
    await expect(page).not.toHaveURL(/testCase=/);
    await expect(page.getByTestId('run-insights-pane')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('test-case-list-clear-filter')).toHaveCount(0);
    await expect(page.getByTestId('test-case-row')).toHaveCount(TC_COUNT, { timeout: 15_000 });
  });
});
