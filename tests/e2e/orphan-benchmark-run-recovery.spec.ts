/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for orphan-benchmark-run boot recovery.
 *
 * Exercises the user-visible side of the production hotfix: a benchmark run
 * stuck at `BenchmarkRun.status === 'running'` for hours with two unstarted
 * test cases (`runResult.status === 'pending'`, no `reportId`) is recovered
 * after the boot hook fires. The user navigates to the inspect URL and sees
 * FAILED rows + correct totals instead of an indefinite PENDING.
 *
 * The test goes through the same admin endpoint the integration test uses to
 * invoke recovery on demand, so it doesn't need to actually restart the dev
 * server. The endpoint is gated by `AGENT_HEALTH_TEST_ENDPOINTS=1`; if not
 * enabled in the running server, the test is skipped (similar to how E2Es
 * skip when storage is not configured).
 *
 * Selectors anchored on `data-testid="test-case-row"` and its
 * `data-status="<resultStatus>"` attribute so the assertion is robust to
 * label / styling changes.
 */

import { test, expect } from './fixtures/test-fixtures';

const STALE_AGE_MS = 60 * 60 * 1000 + 1; // 1h + 1ms past the 1h default

test.describe('Inspect page — orphan benchmark run recovery', () => {
  let testCaseIds: string[] = [];
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  let endpointsEnabled = false;

  test.beforeAll(async ({ request }) => {
    // Probe the test-only admin endpoint. 404 → not enabled, skip suite.
    const probe = await request.post('/api/storage/admin/recover-orphan-benchmark-runs').catch(() => null);
    endpointsEnabled = !!(probe && probe.status() !== 404);
    if (!endpointsEnabled) return;

    // Create three test cases so the inspect page has a non-trivial table.
    for (let i = 0; i < 3; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: `e2e-orphan-tc-${i}-${Date.now()}`,
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
    if (testCaseIds.length !== 3) return;

    // Create benchmark.
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `E2E Orphan Benchmark ${Date.now()}`,
        description: 'orphan-run E2E',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;

    // Inject an orphan run by PUT-ing the benchmark with a runs[] array
    // shaped exactly like the production bug.
    runId = `run-orphan-e2e-${Date.now()}`;
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [{
          id: runId,
          name: 'Orphan E2E Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date(Date.now() - STALE_AGE_MS).toISOString(),
          status: 'running',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {
            // 2 unstarted (the production-bug shape) + 1 already completed
            // by simulating a successful test (no real report; recovery
            // counts results-without-reportId-but-already-completed as
            // failed, which is fine — the assertion below only checks the
            // pending ones flip to failed and the completed-with-reportId
            // case is covered by integration tests).
            [testCaseIds[0]]: { reportId: '', status: 'pending' },
            [testCaseIds[1]]: { reportId: '', status: 'pending' },
            [testCaseIds[2]]: { reportId: '', status: 'pending' },
          },
        }],
      },
    });
    if (!put.ok()) {
      benchmarkId = null;
      return;
    }

    // Trigger the same recovery hook the server runs on boot.
    const rec = await request.post('/api/storage/admin/recover-orphan-benchmark-runs');
    if (!rec.ok()) {
      benchmarkId = null;
      return;
    }
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) {
      await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    }
    for (const id of testCaseIds) {
      await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
    }
  });

  test('inspect page shows FAILED rows after boot recovery (was PENDING before fix)', async ({ page }) => {
    test.skip(!endpointsEnabled, 'Server not started with AGENT_HEALTH_TEST_ENDPOINTS=1');
    test.skip(!benchmarkId || !runId, 'Could not seed orphan benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);

    // Wait for the row list to render.
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });

    // All three test-case rows are present.
    const rows = page.locator('[data-testid="test-case-row"]');
    await expect(rows).toHaveCount(3);

    // Each row's `data-status` is `failed` (NOT `pending`). This is the
    // key regression check: pre-fix these would have stayed `pending`.
    for (let i = 0; i < 3; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-status', 'failed');
    }

    // No row should be in any pending state.
    await expect(page.locator('[data-testid="test-case-row"][data-status^="pending"]'))
      .toHaveCount(0);

    // Header pass/fail counter reflects the recovery: 0 passed, 3 failed.
    // The header renders separate badges; match each.
    await expect(page.getByText('3✗', { exact: false })).toBeVisible();
    await expect(page.getByText('0✓', { exact: false })).toBeVisible();
  });

  test('row click selects the test case and the inspector panel mounts without showing PENDING', async ({ page }) => {
    test.skip(!endpointsEnabled, 'Server not started with AGENT_HEALTH_TEST_ENDPOINTS=1');
    test.skip(!benchmarkId || !runId, 'Could not seed orphan benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });

    // Click the second row to verify selection works for any row, not just
    // the auto-selected first one (this was the path that left users stuck
    // pre-fix because RunDetailsContent's recovery only ran for the
    // currently-selected row).
    await page.locator('[data-testid="test-case-row"]').nth(1).click();

    // The inspector panel header should not say PENDING / AWAITING TRACES /
    // JUDGING — those statuses are gone after recovery. We expect FAILED.
    // The TestCaseInspectorPanel renders the badge text per ResultStatus.tsx.
    await expect(page.getByText('FAILED').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/AWAITING TRACES|JUDGING/)).toHaveCount(0);
  });
});
