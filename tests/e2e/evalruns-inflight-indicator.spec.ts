/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression for bug #5 (iteration 4, 2026-09-01): the Evaluation Runs page
 * showed NOTHING in-flight while a run was genuinely `status: 'running'`.
 *
 * Root cause (lib/runStats.ts + components/evals3/EvalRunsPage.tsx): the row
 * had no visual "running" indicator at all, AND `total` was derived purely
 * from `Object.keys(run.results).length` \u2014 the count of test cases that
 * have STARTED \u2014 not the run's planned size (`testCaseSnapshots.length`).
 * A run 9 cases into a planned 62 rendered identically to a tiny,
 * already-finished 9-case run with a bad score.
 *
 * Hits the real backend (file-storage test server) \u2014 no mocking \u2014 to catch
 * wiring bugs the unit-level mocks can't.
 */

import { test, expect } from './fixtures/test-fixtures';

const RUN_ID = `eval-run-e2e-inflight-${Date.now()}`;
const RUN_NAME = `E2E In-flight Run ${Date.now()}`;

function runningEvalRunDoc() {
  const results: Record<string, unknown> = {};
  for (let i = 0; i < 9; i++) {
    results[`tc-${i}`] = { reportId: `report-${RUN_ID}-${i}`, status: 'failed' };
  }
  return {
    id: RUN_ID,
    docType: 'evaluation-run',
    name: RUN_NAME,
    createdAt: new Date().toISOString(),
    status: 'running',
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    // Planned 62 cases; only 9 have results so far \u2014 the exact live-repro shape.
    testCaseSnapshots: Array.from({ length: 62 }, (_, i) => ({ id: `tc-${i}`, version: 1, name: `tc-${i}` })),
    results,
  };
}

test.describe('Evaluation Runs page \u2014 in-flight (running) run indication (bug #5)', () => {
  test.beforeAll(async ({ request }) => {
    const r = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: runningEvalRunDoc() });
    expect(r.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
  });

  test('shows a "Running" badge and the PLANNED total (62), not just the started count (9)', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');

    const row = page.locator('[data-testid="run-row"]', { hasText: RUN_NAME });
    await expect(row).toBeVisible({ timeout: 15000 });

    await expect(row.locator('[data-testid="run-row-status-running"]')).toBeVisible();
    await expect(row).toContainText('62');
  });
});
