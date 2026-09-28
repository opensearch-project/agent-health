/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retired pre-evals3 pages (`/benchmarks`, `/benchmarks/:id/runs`,
 * `/benchmarks/:id/runs/:runId`, `/runs/:reportId`, `/test-cases`,
 * `/test-cases/:id/runs`) and the older evals3 run-detail page
 * (`/evaluations/runs/:runId`) are gone: every one of those deep links must
 * land on its evals3 twin with the ids carried over, and the evals3 page
 * must actually render. The `/runs/:reportId` route took a per-test-case
 * REPORT id, so it is resolved through the report to the owning run's
 * inspector (`?reportId=` preselects the case) or, for a standalone
 * single-case report, to the test case's detail page (`?run=` preselects
 * the run).
 *
 * Also pins the in-app link generators that used to point at the retired
 * pages: re-running from the inspector must land on the NEW run's inspector.
 */
import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Retired legacy routes redirect to their evals3 twin', () => {
  const tracker = createTestDataTracker();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const RUN_ID = `eval-run-legacy-redirect-${stamp}`;
  const RUN_REPORT_ID = `report-legacy-redirect-run-${stamp}`;
  const STANDALONE_REPORT_ID = `report-legacy-redirect-standalone-${stamp}`;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const health = await request.get('/api/storage/health');
    if (!health.ok()) return;

    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('legacy-redirect-tc'),
        category: 'Synthetic', difficulty: 'Easy',
        initialPrompt: 'Synthetic prompt', expectedOutcomes: ['Synthetic outcome'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    tracker.testCase(testCaseId!);

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('legacy-redirect-benchmark'),
        description: 'legacy-redirect E2E',
        testCaseIds: [testCaseId], runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId] }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId!);

    // A report that belongs to the benchmark run below …
    const runReport = await request.post('/api/storage/runs', {
      data: {
        id: RUN_REPORT_ID, timestamp: new Date().toISOString(), testCaseId,
        experimentId: benchmarkId, experimentRunId: RUN_ID,
        agentKey: 'demo', modelId: 'demo-model', status: 'completed', passFailStatus: 'passed',
        metricsStatus: 'ready', evaluationType: 'deterministic',
        trajectory: [{ type: 'assistant', content: 'synthetic step' }], metrics: { accuracy: 1 },
      },
    });
    if (!runReport.ok()) return;
    tracker.run(RUN_REPORT_ID);

    // … and a standalone single-case report (no run) for the same test case.
    const standalone = await request.post('/api/storage/runs', {
      data: {
        id: STANDALONE_REPORT_ID, timestamp: new Date(Date.now() - 60_000).toISOString(), testCaseId,
        agentKey: 'demo', modelId: 'demo-model', status: 'completed', passFailStatus: 'failed',
        metricsStatus: 'ready', evaluationType: 'deterministic',
        trajectory: [{ type: 'assistant', content: 'synthetic step' }], metrics: { accuracy: 0 },
      },
    });
    if (!standalone.ok()) return;
    tracker.run(STANDALONE_REPORT_ID);

    // A first-class evaluation-run doc associated with the benchmark (the
    // shape every UI/CLI-started benchmark run has today).
    const runRes = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID, docType: 'evaluation-run', name: uniqueTestName('legacy-redirect-run'),
        benchmarkId, createdAt: new Date().toISOString(), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', sources: [{ type: 'benchmark', benchmarkId }], trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'legacy-redirect-tc' }],
        results: { [testCaseId!]: { reportId: RUN_REPORT_ID, status: 'completed', passFailStatus: 'passed' } },
        stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
      },
    });
    if (!runRes.ok()) return;
    tracker.evaluationRun(RUN_ID);
    seeded = true;
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  test('/benchmarks → /evaluations/benchmarks', async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForURL(/\/evaluations\/benchmarks$/, { timeout: 15000 });
    await expect(page.locator('[data-testid="benchmarks-page"]')).toBeVisible({ timeout: 30000 });
  });

  test('/benchmarks/:id/runs → /evaluations/benchmarks/:id/runs', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/benchmarks/${benchmarkId}/runs`);
    await page.waitForURL(`**/evaluations/benchmarks/${benchmarkId}/runs`, { timeout: 15000 });
    await expect(page.locator('[data-testid="benchmark-runs-page"]')).toBeVisible({ timeout: 30000 });
  });

  test('/benchmarks/:id/runs/:runId → the benchmark-scoped run inspector', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/benchmarks/${benchmarkId}/runs/${RUN_ID}`);
    await page.waitForURL(`**/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect`, { timeout: 15000 });
    await expect(page.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`)).toBeVisible({ timeout: 30000 });
  });

  test('/benchmarks/:id/runs/:runId?testCase=<id> (retired page\'s case selector) → inspector with that case preselected', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/benchmarks/${benchmarkId}/runs/${RUN_ID}?testCase=${testCaseId}`);
    await page.waitForURL(`**/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect?testCase=${testCaseId}`, { timeout: 15000 });
    await expect(page.getByRole('tab', { name: /Judge Evaluation/ })).toBeVisible({ timeout: 30000 });
  });

  test('/evaluations/runs/:runId (older detail page) → the run inspector, query string preserved', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/evaluations/runs/${RUN_ID}?reportId=${RUN_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/runs/${RUN_ID}/inspect?reportId=${RUN_REPORT_ID}`, { timeout: 15000 });
    await expect(page.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`)).toBeVisible({ timeout: 30000 });
    // `?reportId=` preselected the case: the right-hand inspector panel shows its trajectory.
    await expect(page.getByRole('tab', { name: /Judge Evaluation/ })).toBeVisible({ timeout: 30000 });
  });

  test('/test-cases → /evaluations/test-cases', async ({ page }) => {
    await page.goto('/test-cases');
    await page.waitForURL(/\/evaluations\/test-cases$/, { timeout: 15000 });
    await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible({ timeout: 30000 });
  });

  test('/test-cases/:id/runs → /evaluations/test-cases/:id', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/test-cases/${testCaseId}/runs`);
    await page.waitForURL(`**/evaluations/test-cases/${testCaseId}`, { timeout: 15000 });
    await expect(page.locator('[data-testid="test-case-detail-page"]')).toBeVisible({ timeout: 30000 });
  });

  test('/runs/:reportId for a report of a run → that run\'s inspector with the case preselected', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/runs/${RUN_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect?reportId=${RUN_REPORT_ID}`, { timeout: 15000 });
    await expect(page.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('tab', { name: /Judge Evaluation/ })).toBeVisible({ timeout: 30000 });
  });

  test('/runs/:reportId for a standalone single-case report → the test case detail page with that run selected', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/runs/${STANDALONE_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/test-cases/${testCaseId}?run=${STANDALONE_REPORT_ID}`, { timeout: 15000 });
    await expect(page.locator('[data-testid="test-case-detail-page"]')).toBeVisible({ timeout: 30000 });
    const row = page.locator(`[data-testid="test-case-run-row-${STANDALONE_REPORT_ID}"]`);
    await expect(row).toBeVisible({ timeout: 30000 });
    await expect(row).toHaveAttribute('aria-selected', 'true');
    // The newer run (the one that belongs to the benchmark run) is NOT the selected one.
    await expect(page.locator(`[data-testid="test-case-run-row-${RUN_REPORT_ID}"]`)).toHaveAttribute('aria-selected', 'false');
  });

  test('/runs/:reportId for an unknown report → the evaluation runs list (never a blank page)', async ({ page }) => {
    await page.goto(`/runs/does-not-exist-${stamp}`);
    await page.waitForURL(/\/evaluations\/runs\/?$/, { timeout: 15000 });
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 30000 });
  });

  test('re-running from the inspector lands on the NEW run\'s inspector (not the retired detail page)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    const NEW_RUN_ID = `eval-run-legacy-redirect-child-${stamp}`;
    // Intercept the rerun POST so no agent is actually invoked; the client
    // only needs the new run's id back.
    await page.route(`**/api/storage/evaluation-runs/${RUN_ID}/rerun`, route =>
      route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ runId: NEW_RUN_ID, run: { id: NEW_RUN_ID, name: "child", rerunOf: RUN_ID }, defaultsApplied: [] }),
      }),
    );
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect`);
    await page.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`).click();
    await page.locator(`[data-testid="run-action-rerun-${RUN_ID}"]`).click();
    await expect(page.locator('[data-testid="run-config-dialog"]')).toBeVisible({ timeout: 10000 });
    await page.locator('[data-testid="run-config-submit-btn"]').click();
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${NEW_RUN_ID}/inspect$`), { timeout: 15000 });
  });
});
