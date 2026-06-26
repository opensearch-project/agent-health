/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression e2e for the comparison pass-rate / accuracy bug.
 *
 * `calculateRunAggregates` used to divide passed-count by the TOTAL number of
 * test cases — including evaluator-error (#242) cases that carry placeholder
 * zero metrics and are neither a pass nor a fail. A run with 1 pass + 1 errored
 * therefore rendered 50% in the Compare view while the run report / benchmark
 * overview (which use lib/runStats, dividing by `total - errored`) showed 100%.
 *
 * This seeds exactly that shape via the storage API and asserts the Compare
 * view's Detailed-metrics summary renders 100% / Acc 90% (the evaluable set),
 * not the deflated 50% / Acc 45%.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Comparison — errored runs excluded from pass rate', () => {
  let benchmarkId: string | null = null;
  const testCaseIds: string[] = [];
  const reportIds: string[] = [];
  const runId = `run-passrate-e2e-${Date.now()}`;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    // Two test cases.
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: `e2e-passrate-tc-${i}-${Date.now()}`,
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        },
      });
      if (!r.ok()) return;
      const j = await r.json();
      testCaseIds.push(j.id || j.testCase?.id);
    }
    if (testCaseIds.length !== 2) return;

    // One PASSED report (accuracy 90) and one ERRORED report (#242 shape:
    // metricsStatus 'error', no real verdict, placeholder zero metrics).
    const mkReport = async (data: Record<string, unknown>): Promise<string | null> => {
      const r = await request.post('/api/storage/runs', { data });
      if (!r.ok()) return null;
      return (await r.json()).id;
    };
    const passId = await mkReport({
      testCaseId: testCaseIds[0],
      agentId: 'demo',
      modelId: 'demo-model',
      status: 'completed',
      passFailStatus: 'passed',
      metricsStatus: 'ready',
      metrics: { accuracy: 90, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
    });
    const errId = await mkReport({
      testCaseId: testCaseIds[1],
      agentId: 'demo',
      modelId: 'demo-model',
      status: 'completed',
      passFailStatus: null,
      metricsStatus: 'error',
      traceError: 'Judge evaluation failed (kind=judge_failed): seeded for e2e',
      metrics: { accuracy: 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
    });
    if (!passId || !errId) return;
    reportIds.push(passId, errId);

    // Benchmark carrying one run that references both reports, with
    // denormalized stats that exclude the errored case (passed:1, errored:1).
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `E2E PassRate Benchmark ${Date.now()}`,
        description: 'errored-passrate e2e',
        testCaseIds,
        runs: [{
          id: runId,
          name: 'PassRate E2E Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {
            [testCaseIds[0]]: { reportId: passId, status: 'completed' },
            [testCaseIds[1]]: { reportId: errId, status: 'completed' },
          },
          stats: { passed: 1, failed: 0, pending: 0, errored: 1, total: 2 },
        }],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    seeded = true;
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    for (const id of reportIds) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of testCaseIds) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  test('renders 100% pass rate and Acc 90% (errored case excluded, not 50% / 45%)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark/run/reports (storage not configured?)');

    await page.goto(`/compare/${benchmarkId}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // The summary table lives in the collapsed "Detailed metrics" panel.
    const detailed = page.locator('button:has-text("Detailed metrics")');
    await detailed.waitFor({ timeout: 15000 });
    await detailed.click();

    const passRate = page.locator(`[data-testid="run-passrate-${runId}"]`);
    await expect(passRate).toBeVisible({ timeout: 15000 });
    // The fix: 1 passed / (2 total - 1 errored) = 100%, NOT 1/2 = 50%.
    await expect(passRate).toHaveText('100%');

    const accuracy = page.locator(`[data-testid="run-accuracy-${runId}"]`);
    // Accuracy averaged over the evaluable case only: 90, NOT (90+0)/2 = 45.
    await expect(accuracy).toHaveText('Acc 90%');
  });
});
