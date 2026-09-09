/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Delete from INSIDE a run (inspector kebab) actually deletes it — on
 * the benchmark-scoped route too.
 *
 * Owner report: "the run doesn't get deleted when I go inside the run page
 * and try it myself." Root cause: on
 * /evaluations/benchmarks/:bid/runs/:rid/inspect the kebab's Delete dispatched
 * on the ROUTE and called the benchmark nested-run DELETE, which 404s for a
 * run that is not embedded in benchmark.runs[] (every in-flight run and most
 * dual-write-era runs); the client swallowed the 404 and navigated away with
 * the run intact. The page now dispatches on the run's kind.
 *
 * Seeds a benchmark + a standalone evaluation-run doc linked to it (NOT
 * embedded — the common case), opens the benchmark-scoped inspector, deletes
 * via the kebab, and asserts: the evaluation-runs DELETE was the call made,
 * navigation to the benchmark runs list, the run is gone from that list, and
 * GET on the doc is 404. (Removing a dual-written run's embedded projection
 * as well is a server-side concern with its own coverage —
 * tests/e2e/run-delete-no-ghost.spec.ts.)
 */

import { test, expect } from './fixtures/test-fixtures';

async function seedBenchmark(request: import('@playwright/test').APIRequestContext, testData: any, tag: string) {
  const bmRes = await request.post('/api/storage/benchmarks', {
    data: { name: `e2e-run-delete-${tag}-${Date.now()}`, testCaseIds: [], runs: [] },
  });
  if (!bmRes.ok()) return null;
  const bm = await bmRes.json();
  testData.benchmark(bm.id);
  return bm.id as string;
}

async function seedLinkedRun(request: import('@playwright/test').APIRequestContext, testData: any, benchmarkId: string, runId: string, name: string, status = 'completed') {
  const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
    data: {
      id: runId, docType: 'evaluation-run', name, status,
      agentKey: 'demo', modelId: 'claude-sonnet', benchmarkId,
      sources: [{ type: 'benchmark', benchmarkId }],
      trigger: 'api', testCaseSnapshots: [], results: {},
      createdAt: new Date().toISOString(),
      ...(status !== 'running' ? { completedAt: new Date().toISOString() } : {}),
    },
  });
  if (res.ok()) testData.evaluationRun(runId);
  return res.ok();
}

test.describe('Delete a run from inside the inspector (benchmark-scoped route)', () => {
  test('standalone (non-embedded) run: kebab → Delete → confirm → back on the benchmark runs list, run gone', async ({ page, request, testData }) => {
    const benchmarkId = await seedBenchmark(request, testData, 'standalone');
    test.skip(!benchmarkId, 'Could not create benchmark (storage not configured?)');

    const runId = `eval-run-e2e-inspector-delete-${Date.now()}`;
    const runName = `E2E inspector delete ${Date.now()}`;
    test.skip(!(await seedLinkedRun(request, testData, benchmarkId!, runId, runName)), 'Could not seed run');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await expect(page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`)).toBeVisible({ timeout: 30000 });

    // Observe which API the Delete actually hits.
    const deleteCalls: string[] = [];
    page.on('request', req => {
      if (req.method() === 'DELETE' && req.url().includes('/api/storage/')) deleteCalls.push(new URL(req.url()).pathname);
    });

    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-delete-${runId}"]`).click();
    const confirm = page.locator(`[data-testid="run-delete-confirm-${runId}"]`);
    await expect(confirm).toBeVisible({ timeout: 10000 });
    // The copy states the (intentional) non-cascade to reports.
    await expect(confirm.locator(`[data-testid="run-delete-confirm-copy-${runId}"]`)).toContainText(/reports are kept/i);
    await page.locator(`[data-testid="run-delete-confirm-btn-${runId}"]`).click();

    await page.waitForURL(`**/evaluations/benchmarks/${benchmarkId}/runs`, { timeout: 15000 });
    await expect(page.locator(`[data-testid="run-action-error-${runId}"]`)).toHaveCount(0);

    // Server-side truth: the doc is gone (this used to stay 200 — the 404
    // from the wrong endpoint was swallowed).
    const getRes = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect(getRes.status()).toBe(404);
    expect(deleteCalls).toEqual([`/api/storage/evaluation-runs/${runId}`]);

    // And the benchmark runs list no longer shows it.
    await expect(page.locator('[data-testid="run-row"]', { hasText: runName })).toHaveCount(0);
  });
});
