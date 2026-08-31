/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression for bug #6 (iteration 4, 2026-09-01): the benchmark-scoped Runs
 * page (/evaluations/benchmarks/:id/runs) never showed evaluation-runs that
 * are associated with the benchmark via `evaluationRun.benchmarkId` but not
 * embedded in `benchmark.runs[]` (e.g. runs created via CLI/API/scheduler,
 * or — the live repro — 3 in-flight runs kicked off outside the "Add Run"
 * embedded-run path). Fixed in components/evals3/BenchmarkRunsPage.tsx by
 * merging `GET /api/storage/evaluation-runs?benchmarkId=X` into the rendered
 * run list, deduped against benchmark.runs[], with Delete/Cancel disabled on
 * the merged-in (non-embedded) rows.
 *
 * Hits the real backend (file-storage test server) — no mocking.
 */

import { test, expect } from './fixtures/test-fixtures';

const suffix = `${Date.now()}`;
const RUNNING_RUN_ID = `eval-run-e2e-bmassoc-running-${suffix}`;
const RUNNING_RUN_NAME = `E2E BM-associated running ${suffix}`;

let benchmarkId = '';

test.describe('Benchmark-scoped Runs page — associated (non-embedded) eval-runs (bug #6)', () => {
  test.beforeAll(async ({ request }) => {
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: { name: `E2E bm-assoc benchmark ${suffix}`, testCaseIds: [] },
    });
    expect(bmRes.ok()).toBeTruthy();
    benchmarkId = (await bmRes.json()).id;

    const runRes = await request.put(`/api/storage/evaluation-runs/${RUNNING_RUN_ID}`, {
      data: {
        id: RUNNING_RUN_ID,
        docType: 'evaluation-run',
        name: RUNNING_RUN_NAME,
        createdAt: new Date().toISOString(),
        status: 'running',
        agentKey: 'agent-alpha',
        modelId: 'e2e-model',
        benchmarkId,
        sources: [{ type: 'benchmark', benchmarkId }],
        trigger: 'api',
        testCaseSnapshots: Array.from({ length: 10 }, (_, i) => ({ id: `tc-${i}`, version: 1, name: `tc-${i}` })),
        results: { 'tc-0': { reportId: `report-${RUNNING_RUN_ID}`, status: 'failed' } },
      },
    });
    expect(runRes.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUNNING_RUN_ID}`).catch(() => {});
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`).catch(() => {});
  });

  test('renders the associated running eval-run (not embedded in benchmark.runs) with a Running badge, and its planned total', async ({ page }) => {
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);

    const runCard = page.locator('.rounded-xl', { hasText: RUNNING_RUN_NAME });
    await expect(runCard).toBeVisible({ timeout: 15000 });
    await expect(runCard).toContainText('Running');
    await expect(runCard).toContainText('10');

    // Delete is NOT offered for a merged-in (non-embedded) row — it would
    // call the benchmark-embedded-run-specific delete API, which doesn't
    // apply to a standalone evaluation-run doc.
    await expect(runCard.locator('[title="Delete run"]')).toHaveCount(0);
  });
});
