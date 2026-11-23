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
 * the run). Deleting a run or a test case keeps the report documents, so a
 * report can outlive both: (a) test case deleted / run kept, (b) run deleted
 * / test case kept and (c) both deleted each still open the REPORT (the
 * retired page rendered the report from its own document and never
 * consulted the run) — (c) on the standalone report page
 * `/evaluations/reports/:reportId`.
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
  // A report whose run AND test case were both deleted afterwards (deleting
  // either keeps the report documents — no cascade).
  const ORPHAN_REPORT_ID = `report-legacy-redirect-orphan-${stamp}`;
  // (a) a kept run whose test case was deleted afterwards …
  const DELETED_TC_RUN_ID = `eval-run-legacy-redirect-deleted-tc-${stamp}`;
  const DELETED_TC_REPORT_ID = `report-legacy-redirect-deleted-tc-${stamp}`;
  // … and (b) a deleted run whose test case was kept.
  const DELETED_RUN_ID = `eval-run-legacy-redirect-deleted-run-${stamp}`;
  const DELETED_RUN_REPORT_ID = `report-legacy-redirect-deleted-run-${stamp}`;
  // The agent's final answer — what a reader opens a report for. Every
  // orphan scenario asserts THIS text is on screen, not just some page.
  const AGENT_ANSWER = 'Root cause: node-3 ran out of JVM heap (synthetic answer)';
  // The Agent Response block of the Test Case Output tab (the TL;DR card
  // quotes the same text, so the assertion is scoped to the answer body).
  const agentAnswer = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="final-answer-body"]').getByText(AGENT_ANSWER);
  const reportTrajectory = [
    { id: 'step-1', type: 'assistant', content: 'Checking cluster health first.', timestamp: 1 },
    { id: 'step-2', type: 'response', content: AGENT_ANSWER, timestamp: 2 },
  ];
  // A run whose benchmark was deleted afterwards (the run doc survives).
  const DELETED_BM_RUN_ID = `eval-run-legacy-redirect-deleted-bm-${stamp}`;
  const DELETED_BM_REPORT_ID = `report-legacy-redirect-deleted-bm-${stamp}`;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  let seeded = false;

  // Storage not configured → every fixture-backed test skips. Once storage is
  // healthy, a failing fixture request FAILS the suite instead of silently
  // leaving `seeded` false and skipping the very tests it feeds.
  const must = async (res: import('@playwright/test').APIResponse, what: string) => {
    if (!res.ok()) throw new Error(`fixture: ${what} → HTTP ${res.status()} ${await res.text()}`);
    return res;
  };

  test.beforeAll(async ({ request }) => {
    const health = await request.get('/api/storage/health');
    await must(health, 'health');

    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('legacy-redirect-tc'),
        category: 'Synthetic', difficulty: 'Easy',
        initialPrompt: 'Synthetic prompt', expectedOutcomes: ['Synthetic outcome'],
      },
    });
    await must(tcRes, 'tcRes');
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
    await must(bmRes, 'bmRes');
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
    await must(runReport, 'runReport');
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
    await must(standalone, 'standalone');
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
    await must(runRes, 'runRes');
    tracker.evaluationRun(RUN_ID);

    // Orphan: a report for a run + test case that are deleted right after
    // (the two deletes are the real, supported operations that orphan reports).
    const orphanTc = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('legacy-redirect-orphan-tc'),
        category: 'Synthetic', difficulty: 'Easy',
        initialPrompt: 'Synthetic prompt', expectedOutcomes: ['Synthetic outcome'],
      },
    });
    await must(orphanTc, 'orphanTc');
    const orphanTcId = ((await orphanTc.json()).id as string);
    tracker.testCase(orphanTcId);
    const ORPHAN_RUN_ID = `eval-run-legacy-redirect-orphan-${stamp}`;
    const orphanReport = await request.post('/api/storage/runs', {
      data: {
        id: ORPHAN_REPORT_ID, timestamp: new Date().toISOString(), testCaseId: orphanTcId,
        experimentRunId: ORPHAN_RUN_ID,
        agentKey: 'demo', agentName: 'Demo Agent', modelId: 'demo-model', status: 'completed', passFailStatus: 'passed',
        metricsStatus: 'ready', evaluationType: 'deterministic',
        trajectory: reportTrajectory, metrics: { accuracy: 1 },
      },
    });
    await must(orphanReport, 'orphanReport');
    tracker.run(ORPHAN_REPORT_ID);
    const orphanRun = await request.put(`/api/storage/evaluation-runs/${ORPHAN_RUN_ID}`, {
      data: {
        id: ORPHAN_RUN_ID, docType: 'evaluation-run', name: uniqueTestName('legacy-redirect-orphan-run'),
        createdAt: new Date().toISOString(), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', sources: [{ type: 'test-case-ids', ids: [orphanTcId] }], trigger: 'api',
        testCaseSnapshots: [{ id: orphanTcId, version: 1, name: 'legacy-redirect-orphan-tc' }],
        results: { [orphanTcId]: { reportId: ORPHAN_REPORT_ID, status: 'completed', passFailStatus: 'passed' } },
        stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
      },
    });
    await must(orphanRun, 'orphanRun');
    tracker.evaluationRun(ORPHAN_RUN_ID);
    await must(await request.delete(`/api/storage/evaluation-runs/${ORPHAN_RUN_ID}`), 'delete');
    await must(await request.delete(`/api/storage/test-cases/${orphanTcId}`), 'delete');

    // (a) Deleted test case, kept run: a run over [kept test case, deleted
    // test case] — the second case's report must still open from the run.
    const deletedTc = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('legacy-redirect-deleted-tc'),
        category: 'Synthetic', difficulty: 'Easy',
        initialPrompt: 'Synthetic prompt', expectedOutcomes: ['Synthetic outcome'],
      },
    });
    await must(deletedTc, 'deletedTc');
    const deletedTcId = ((await deletedTc.json()).id as string);
    tracker.testCase(deletedTcId);
    const deletedTcReport = await request.post('/api/storage/runs', {
      data: {
        id: DELETED_TC_REPORT_ID, timestamp: new Date().toISOString(), testCaseId: deletedTcId,
        experimentRunId: DELETED_TC_RUN_ID,
        agentKey: 'demo', agentName: 'Demo Agent', modelId: 'demo-model', status: 'completed', passFailStatus: 'passed',
        metricsStatus: 'ready', evaluationType: 'deterministic',
        trajectory: reportTrajectory, metrics: { accuracy: 1 },
      },
    });
    await must(deletedTcReport, 'deletedTcReport');
    tracker.run(DELETED_TC_REPORT_ID);
    const deletedTcRun = await request.put(`/api/storage/evaluation-runs/${DELETED_TC_RUN_ID}`, {
      data: {
        id: DELETED_TC_RUN_ID, docType: 'evaluation-run', name: uniqueTestName('legacy-redirect-deleted-tc-run'),
        createdAt: new Date().toISOString(), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', sources: [{ type: 'test-case-ids', ids: [testCaseId, deletedTcId] }], trigger: 'api',
        testCaseSnapshots: [
          { id: testCaseId, version: 1, name: 'legacy-redirect-tc' },
          { id: deletedTcId, version: 1, name: 'legacy-redirect-deleted-tc' },
        ],
        results: {
          [testCaseId!]: { reportId: RUN_REPORT_ID, status: 'completed', passFailStatus: 'passed' },
          [deletedTcId]: { reportId: DELETED_TC_REPORT_ID, status: 'completed', passFailStatus: 'passed' },
        },
        stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 },
      },
    });
    await must(deletedTcRun, 'deletedTcRun');
    tracker.evaluationRun(DELETED_TC_RUN_ID);
    await must(await request.delete(`/api/storage/test-cases/${deletedTcId}`), 'delete');

    // (b) Deleted run, kept test case.
    const deletedRunReport = await request.post('/api/storage/runs', {
      data: {
        id: DELETED_RUN_REPORT_ID, timestamp: new Date(Date.now() - 120_000).toISOString(), testCaseId,
        experimentId: benchmarkId, experimentRunId: DELETED_RUN_ID,
        agentKey: 'demo', agentName: 'Demo Agent', modelId: 'demo-model', status: 'completed', passFailStatus: 'passed',
        metricsStatus: 'ready', evaluationType: 'deterministic',
        trajectory: reportTrajectory, metrics: { accuracy: 1 },
      },
    });
    await must(deletedRunReport, 'deletedRunReport');
    tracker.run(DELETED_RUN_REPORT_ID);
    const deletedRun = await request.put(`/api/storage/evaluation-runs/${DELETED_RUN_ID}`, {
      data: {
        id: DELETED_RUN_ID, docType: 'evaluation-run', name: uniqueTestName('legacy-redirect-deleted-run'),
        benchmarkId, createdAt: new Date().toISOString(), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', sources: [{ type: 'benchmark', benchmarkId }], trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'legacy-redirect-tc' }],
        results: { [testCaseId!]: { reportId: DELETED_RUN_REPORT_ID, status: 'completed', passFailStatus: 'passed' } },
        stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
      },
    });
    await must(deletedRun, 'deletedRun');
    tracker.evaluationRun(DELETED_RUN_ID);
    await must(await request.delete(`/api/storage/evaluation-runs/${DELETED_RUN_ID}`), 'delete');

    // Deleted benchmark: a benchmark-associated run + report, then the benchmark is deleted.
    const bm2Res = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('legacy-redirect-deleted-benchmark'),
        description: 'legacy-redirect E2E (deleted afterwards)',
        testCaseIds: [testCaseId], runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId] }],
      },
    });
    await must(bm2Res, 'bm2Res');
    const deletedBenchmarkId = (await bm2Res.json()).id as string;
    tracker.benchmark(deletedBenchmarkId);
    const bm2Report = await request.post('/api/storage/runs', {
      data: {
        id: DELETED_BM_REPORT_ID, timestamp: new Date().toISOString(), testCaseId,
        experimentId: deletedBenchmarkId, experimentRunId: DELETED_BM_RUN_ID,
        agentKey: 'demo', modelId: 'demo-model', status: 'completed', passFailStatus: 'passed',
        metricsStatus: 'ready', evaluationType: 'deterministic',
        trajectory: [{ type: 'assistant', content: 'synthetic step' }], metrics: { accuracy: 1 },
      },
    });
    await must(bm2Report, 'bm2Report');
    tracker.run(DELETED_BM_REPORT_ID);
    const bm2Run = await request.put(`/api/storage/evaluation-runs/${DELETED_BM_RUN_ID}`, {
      data: {
        id: DELETED_BM_RUN_ID, docType: 'evaluation-run', name: uniqueTestName('legacy-redirect-deleted-bm-run'),
        benchmarkId: deletedBenchmarkId, createdAt: new Date().toISOString(), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', sources: [{ type: 'benchmark', benchmarkId: deletedBenchmarkId }], trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'legacy-redirect-tc' }],
        results: { [testCaseId!]: { reportId: DELETED_BM_REPORT_ID, status: 'completed', passFailStatus: 'passed' } },
        stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
      },
    });
    await must(bm2Run, 'bm2Run');
    tracker.evaluationRun(DELETED_BM_RUN_ID);
    await must(await request.delete(`/api/storage/benchmarks/${deletedBenchmarkId}`), 'delete');
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

  // ── Reports that outlived their run and/or test case ──────────────────
  // Each scenario is opened from the legacy link AND from the evals3 URL it
  // lands on, and asserts the agent's answer is on screen: a page that merely
  // explains why the report "has nowhere to open" would fail these.

  test('(a) test case deleted, run kept — legacy link → the run inspector shows the report, labelled "Test case deleted"', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/runs/${DELETED_TC_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/runs/${DELETED_TC_RUN_ID}/inspect?reportId=${DELETED_TC_REPORT_ID}`, { timeout: 15000 });
    await expect(agentAnswer(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="inspector-test-case-deleted"]')).toContainText('Test case deleted');
    await expect(page.getByText(/nowhere to open/)).toHaveCount(0);
  });

  test('(a) direct evals3 URL: the inspector of a kept run opens a case whose test case was deleted', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/evaluations/runs/${DELETED_TC_RUN_ID}/inspect?reportId=${DELETED_TC_REPORT_ID}`);
    await expect(agentAnswer(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="inspector-test-case-deleted"]')).toBeVisible();
    // Both rows are listed — the deleted case too (by id, since its name is gone).
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(2);
  });

  test('(b) run deleted, test case kept — legacy link → the test case page with that run selected and the report shown', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/runs/${DELETED_RUN_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/test-cases/${testCaseId}?run=${DELETED_RUN_REPORT_ID}`, { timeout: 15000 });
    await expect(page.locator(`[data-testid="test-case-run-row-${DELETED_RUN_REPORT_ID}"]`)).toHaveAttribute('aria-selected', 'true', { timeout: 30000 });
    await expect(agentAnswer(page)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/nowhere to open/)).toHaveCount(0);
  });

  test('(b) direct evals3 URL: the standalone report page shows a deleted run\'s report, labelled "Run deleted", linking to the test case', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/evaluations/reports/${DELETED_RUN_REPORT_ID}`);
    await expect(page.locator('[data-testid="report-page"]')).toBeVisible({ timeout: 30000 });
    await expect(agentAnswer(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="report-page-run-deleted"]')).toContainText('Run deleted');
    await expect(page.locator('[data-testid="report-page-test-case-deleted"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="report-page-open-test-case"]')).toHaveAttribute('href', `/evaluations/test-cases/${testCaseId}?run=${DELETED_RUN_REPORT_ID}`);
  });

  test('(c) run AND test case deleted — legacy link → the standalone report page renders the report (never an explanation page)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/runs/${ORPHAN_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/reports/${ORPHAN_REPORT_ID}`, { timeout: 15000 });
    await expect(page.locator('[data-testid="report-page"]')).toBeVisible({ timeout: 30000 });
    await expect(agentAnswer(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="report-page-run-deleted"]')).toContainText('Run deleted');
    await expect(page.locator('[data-testid="report-page-test-case-deleted"]')).toContainText('Test case deleted');
    await expect(page.locator('[data-testid="inspector-status-badge"]')).toHaveText('PASSED');
    await expect(page.getByText(/nowhere to open/)).toHaveCount(0);
    // Nothing to link to: both pages would bounce to a list.
    await expect(page.locator('[data-testid="report-page-open-run"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="report-page-open-test-case"]')).toHaveCount(0);
  });

  test('(c) direct evals3 URL: /evaluations/reports/:reportId renders the orphan report and its Judge Evaluation tab', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/evaluations/reports/${ORPHAN_REPORT_ID}`);
    await expect(agentAnswer(page)).toBeVisible({ timeout: 30000 });
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    await expect(page.getByRole('tab', { name: /Judge Evaluation/ })).toHaveAttribute('data-state', 'active');
  });

  test('/evaluations/reports/:reportId for a report id that does not exist → "Report not found" with a way out', async ({ page }) => {
    await page.goto(`/evaluations/reports/does-not-exist-${stamp}`);
    const nf = page.locator('[data-testid="report-page-not-found"]');
    await expect(nf).toBeVisible({ timeout: 30000 });
    await expect(nf).toContainText(`does-not-exist-${stamp}`);
    await nf.getByRole('link', { name: /Go to Evaluation Runs/ }).click();
    await page.waitForURL(/\/evaluations\/runs\/?$/, { timeout: 15000 });
  });

  test('/runs/:reportId for a run whose benchmark was deleted → the bare run inspector (the benchmark-scoped one would bounce to the Benchmarks list)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await page.goto(`/runs/${DELETED_BM_REPORT_ID}`);
    await page.waitForURL(`**/evaluations/runs/${DELETED_BM_RUN_ID}/inspect?reportId=${DELETED_BM_REPORT_ID}`, { timeout: 15000 });
    await expect(page.locator(`[data-testid="run-actions-menu-trigger-${DELETED_BM_RUN_ID}"]`)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('tab', { name: /Judge Evaluation/ })).toBeVisible({ timeout: 30000 });
  });

  test('/runs/:reportId for an unknown report → the evaluation runs list (never a blank page)', async ({ page }) => {
    await page.goto(`/runs/does-not-exist-${stamp}`);
    await page.waitForURL(/\/evaluations\/runs\/?$/, { timeout: 15000 });
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 30000 });
  });

  // The redirects are REPLACEs: a legacy deep link must not leave a history
  // entry behind, or Back would bounce the user between the legacy URL and the
  // evals3 page forever. Proven through the browser's own history: coming from
  // a known page, the redirect adds exactly ONE entry and Back returns to the
  // page the user came from — never to the legacy URL.
  const legacyLinksWithoutFixtures: Array<[from: string, to: RegExp]> = [
    ['/benchmarks', /\/evaluations\/benchmarks$/],
    ['/test-cases', /\/evaluations\/test-cases$/],
    ['/evals', /\/evaluations\/test-cases$/],
    ['/run', /\/evaluations\/test-cases$/],
    ['/reports', /\/evaluations\/benchmarks$/],
    ['/experiments', /\/evaluations\/benchmarks$/],
    ['/benchmarks/some-id/not-a-page', /\/evaluations\/benchmarks$/],
    ['/test-cases/some-id/not-a-page', /\/evaluations\/test-cases$/],
  ];
  for (const [from, to] of legacyLinksWithoutFixtures) {
    test(`${from} redirects with a REPLACE (no history entry, Back skips the legacy URL)`, async ({ page }) => {
      await page.goto('/settings');
      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 30000 });
      const before = await page.evaluate(() => window.history.length);

      await page.goto(from);
      await page.waitForURL(to, { timeout: 15000 });
      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 30000 });
      expect(await page.evaluate(() => window.history.length)).toBe(before + 1);

      await page.goBack();
      await page.waitForURL(/\/settings$/, { timeout: 15000 });
      expect(new URL(page.url()).pathname).toBe('/settings');
    });
  }

  // Same REPLACE property for the fixture-backed redirects. Only the Back
  // sentinel is asserted here (not `history.length`): once a page has gone
  // back, the next forward navigation truncates the stack, so the length
  // arithmetic is only meaningful on a fresh page.
  async function expectReplaceRedirect(page: import('@playwright/test').Page, from: string, to: string | RegExp) {
    await page.goto('/settings');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 30000 });

    await page.goto(from);
    await page.waitForURL(to, { timeout: 15000 });

    await page.goBack();
    await page.waitForURL(/\/settings$/, { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe('/settings');
  }

  test('/benchmarks/:id/runs/:runId redirects with a REPLACE', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await expectReplaceRedirect(page, `/benchmarks/${benchmarkId}/runs/${RUN_ID}`,
      `**/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect`);
  });

  test('/runs/:reportId (resolved through storage) redirects with a REPLACE', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await expectReplaceRedirect(page, `/runs/${RUN_REPORT_ID}`,
      `**/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect?reportId=${RUN_REPORT_ID}`);
  });

  test('/test-cases/:id/runs redirects with a REPLACE', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await expectReplaceRedirect(page, `/test-cases/${testCaseId}/runs`, `**/evaluations/test-cases/${testCaseId}`);
  });

  test('/benchmarks/:id/runs and /experiments/:id/runs redirect with a REPLACE', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await expectReplaceRedirect(page, `/benchmarks/${benchmarkId}/runs`, `**/evaluations/benchmarks/${benchmarkId}/runs`);
    await expectReplaceRedirect(page, `/experiments/${benchmarkId}/runs`, `**/evaluations/benchmarks/${benchmarkId}/runs`);
  });

  test('/evaluations/runs/:runId (older detail page) and the bare /evaluations/benchmarks/:id/runs/:runId redirect with a REPLACE', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await expectReplaceRedirect(page, `/evaluations/runs/${RUN_ID}?reportId=${RUN_REPORT_ID}`,
      `**/evaluations/runs/${RUN_ID}/inspect?reportId=${RUN_REPORT_ID}`);
    await expectReplaceRedirect(page, `/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}`,
      `**/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID}/inspect`);
  });

  test('/runs/:reportId for a standalone report and for an unknown report redirect with a REPLACE', async ({ page }) => {
    test.skip(!seeded, 'Could not seed fixtures (storage not configured?)');
    await expectReplaceRedirect(page, `/runs/${STANDALONE_REPORT_ID}`, `**/evaluations/test-cases/${testCaseId}?run=${STANDALONE_REPORT_ID}`);
    await expectReplaceRedirect(page, `/runs/does-not-exist-${stamp}`, /\/evaluations\/runs\/?$/);
    await expectReplaceRedirect(page, `/runs/${ORPHAN_REPORT_ID}`, `**/evaluations/reports/${ORPHAN_REPORT_ID}`);
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
