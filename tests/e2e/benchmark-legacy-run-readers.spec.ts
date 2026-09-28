/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: historical runs created by the REMOVED legacy `POST
 * /api/storage/benchmarks/:id/execute` runner still open in the UI.
 *
 * That runner minted `run-<ts>-<rand>` ids, embedded the run directly in
 * `benchmark.runs[]` (no first-class evaluation-run document, no
 * `benchmarkVersion` / `testCaseSnapshots` on the oldest docs) and stamped
 * each per-test-case report with `experimentRunId = <run id>`. Shared storage
 * is full of such runs; deleting the runner must not orphan them. This spec
 * seeds exactly that shape and asserts the two read surfaces a user hits:
 *   - the benchmark Runs tab lists the run with its verdict counts, and
 *   - the run inspector opens it (falls back to the embedded projection when
 *     `GET /api/storage/evaluation-runs/:id` is a 404) and resolves each
 *     case's report by id.
 * Deleting a legacy embedded row is covered by
 * tests/e2e/benchmark-runs-delete-all-rows.spec.ts.
 *
 * Everything is tracked by id and cleaned up.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Legacy /execute-era runs embedded in benchmark.runs[] still render', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  const stamp = Date.now();
  const LEGACY_RUN_ID = `run-${stamp}-lgcy01`;
  const LEGACY_RUN_NAME = uniqueTestName('legacy-execute-run');
  const testCaseIds: string[] = [];
  const testCaseNames: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const name = uniqueTestName(`legacy-run-tc-${i}`);
      const r = await request.post('/api/storage/test-cases', {
        data: { name, category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
      testCaseNames.push(name);
    }
    if (testCaseIds.length !== 2) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: { name: uniqueTestName('legacy-run-benchmark'), description: 'legacy embedded run E2E', testCaseIds },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    // Per-test-case reports exactly as the legacy runner persisted them:
    // keyed by experimentId (benchmark) + experimentRunId (the legacy run id).
    const verdicts: Array<'passed' | 'failed'> = ['passed', 'failed'];
    const reportIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const rep = await request.post('/api/storage/runs', {
        data: {
          testCaseId: testCaseIds[i],
          experimentId: benchmarkId,
          experimentRunId: LEGACY_RUN_ID,
          agentName: 'demo',
          modelName: 'demo-model',
          status: 'completed',
          passFailStatus: verdicts[i],
          metricsStatus: 'completed',
          metrics: { accuracy: verdicts[i] === 'passed' ? 100 : 0, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
          trajectory: [{ type: 'response', content: `legacy answer ${i}`, timestamp: new Date(stamp).toISOString() }],
          llmJudgeReasoning: `legacy verdict ${i}`,
          timestamp: new Date(stamp - 60_000).toISOString(),
        },
      });
      if (!rep.ok()) return;
      const id = (await rep.json()).id;
      tracker.run(id);
      reportIds.push(id);
    }

    // Embed the legacy run: no benchmarkVersion / testCaseSnapshots, a
    // `run-<ts>-<rand>` id, results keyed by test case → report id.
    const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
        runs: [{
          id: LEGACY_RUN_ID,
          name: LEGACY_RUN_NAME,
          agentKey: 'demo',
          modelId: 'demo-model',
          status: 'completed',
          createdAt: new Date(stamp - 120_000).toISOString(),
          completedAt: new Date(stamp - 60_000).toISOString(),
          results: {
            [testCaseIds[0]]: { reportId: reportIds[0], status: 'completed' },
            [testCaseIds[1]]: { reportId: reportIds[1], status: 'completed' },
          },
        }],
      },
    });
    if (!put.ok()) { benchmarkId = null; }
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('the Runs tab lists the legacy embedded run', async ({ page, request }) => {
    test.skip(!benchmarkId, 'Could not seed the legacy run (storage not configured?)');

    // The run exists ONLY as an embedded projection — the exact legacy shape.
    expect((await request.get(`/api/storage/evaluation-runs/${LEGACY_RUN_ID}`)).status()).toBe(404);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const row = page.locator('[data-testid="run-row"]', { hasText: LEGACY_RUN_NAME });
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Verdicts come from the report docs resolved by id (1 passed / 1 failed → 50%).
    await expect(row).toContainText(/50/);
  });

  test('the run inspector opens the legacy run and resolves each case report', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed the legacy run (storage not configured?)');

    // The page's loader bounces to the benchmarks LIST when
    // `GET /api/storage/benchmarks/:id` times out (pre-existing behaviour;
    // seen under parallel e2e workers right after seeding) — one retry keeps
    // this spec about the legacy-run readers, not backend latency.
    const inspectUrl = new RegExp(`/runs/${LEGACY_RUN_ID}/inspect$`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${LEGACY_RUN_ID}/inspect`);
      await Promise.race([
        page.locator('[data-testid="test-case-row"]').first().waitFor({ state: 'visible', timeout: 30_000 }),
        page.waitForURL(/\/evaluations\/benchmarks\/?$/, { timeout: 30_000 }).catch(() => {}),
      ]).catch(() => {});
      if (inspectUrl.test(page.url())) break;
    }
    await expect(page).toHaveURL(inspectUrl, { timeout: 15_000 });
    await expect(page.locator('[data-testid="run-inspector-not-found"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-inspector-error"]')).toHaveCount(0);
    // A legacy embedded run has no first-class document, so the header is the
    // plain (non-renameable) title — exactly the legacy shape's affordance.
    await expect(page.getByRole('heading', { name: LEGACY_RUN_NAME })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('run-inspector-rename-text')).toHaveCount(0);

    const rows = page.locator('[data-testid="test-case-row"]');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(`[data-testid="test-case-row"][data-test-case-id="${testCaseIds[0]}"]`)).toHaveAttribute('data-status', 'passed');
    await expect(page.locator(`[data-testid="test-case-row"][data-test-case-id="${testCaseIds[1]}"]`)).toHaveAttribute('data-status', 'failed');
    await expect(rows.first()).toContainText(testCaseNames[0]);
  });
});
