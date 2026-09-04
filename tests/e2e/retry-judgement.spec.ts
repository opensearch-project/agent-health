/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "Retry judgement" on the run inspector page — salvage a terminal
 * run's judge-failed cases (trace timeouts, judge errors, "evaluator could
 * not run") at judge cost only, without re-running the agent.
 *
 * Covers the UI-visible surface (server behavior is covered by
 * tests/integration/.../evaluationRuns.retryJudgement.integration.test.ts):
 *   - button renders with the judge-failed count and is enabled when N>0
 *   - button is disabled when there are no judge-failed cases
 *   - clicking opens a confirm dialog showing the count + judge model
 *   - confirming POSTs to the retry-judgement endpoint and shows a summary
 *
 * Seeds its own deterministic test-case / report / evaluation-run docs via
 * the storage API and cleans them up in afterAll.
 */

import { test, expect } from './fixtures/test-fixtures';

// Retry judgement lives in the header "…" kebab (owner papercut: the
// standalone header button was removed). Open the kebab and return the item.
async function openRetryJudgementItem(page: import('@playwright/test').Page, runId: string) {
  await expect(page.locator('[data-testid="inspector-retry-judgement-btn"]')).toHaveCount(0);
  await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
  const item = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
  await expect(item).toBeVisible({ timeout: 15000 });
  return item;
}

test.describe('Run inspector — Retry judgement (kebab item)', () => {
  let testCaseId: string | null = null;
  let runId: string | null = null;
  let erroredReportId: string | null = null;
  let passedReportId: string | null = null;
  let seeded = false;

  const RUN_NAME = 'E2E Retry Judgement Run';

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-retry-judgement-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'What is causing the outage?',
        expectedOutcomes: ['Identifies the root cause'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    erroredReportId = `report-e2e-retry-errored-${Date.now()}`;
    const erroredRes = await request.post('/api/storage/runs', {
      data: {
        id: erroredReportId,
        timestamp: new Date().toISOString(),
        agentName: 'Demo Agent',
        agentKey: 'demo',
        modelName: 'demo-model',
        modelId: 'demo-model',
        testCaseId,
        status: 'completed',
        metricsStatus: 'error',
        passFailStatus: null,
        traceError: 'Judge evaluation failed (kind=judge_failed): mock 400',
        llmJudgeReasoning: '**Evaluator could not run.**',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      },
    });
    if (!erroredRes.ok()) return;

    runId = `eval-run-e2e-retry-judgement-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        name: RUN_NAME,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e retry judgement tc' }],
        results: {
          [testCaseId]: { reportId: erroredReportId, status: 'completed' },
        },
        createdAt: new Date().toISOString(),
      },
    });
    seeded = runRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    if (erroredReportId) await request.delete(`/api/storage/runs/${erroredReportId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('kebab item renders with the judge-failed count and is enabled', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage not configured?)');

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const btn = await openRetryJudgementItem(page, runId!);
    await expect(btn).toContainText('Retry judgement (1)');
    await expect(btn).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
  });

  test('clicking opens a confirm dialog showing the count + judge model', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage not configured?)');

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    await (await openRetryJudgementItem(page, runId!)).click();

    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('1');
    await expect(dialog).toContainText('Judge model:');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('confirming POSTs to retry-judgement (202 + poll) and shows a succeeded/failed summary', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage not configured?)');

    // The route responds 202 immediately and the client polls
    // GET .../retry-judgement/status — see the "ASYNC JOB PATTERN" comment
    // on the POST handler in server/routes/storage/evaluationRuns.ts (real
    // incident: a 62-case run's judge pipeline ran 20-30+ minutes, so the
    // route can no longer hold the response open and return the summary
    // inline). This mock exercises exactly that client-side poll loop.
    let posted = false;
    let statusPolled = 0;
    await page.route(`**/api/storage/evaluation-runs/${runId}/retry-judgement*`, async route => {
      posted = true;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: runId, total: 1, status: 'running' }),
      });
    });
    await page.route(`**/api/storage/evaluation-runs/${runId}/retry-judgement/status`, async route => {
      statusPolled += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'completed',
          total: 1,
          completed: 1,
          summary: {
            retried: 1,
            succeeded: 1,
            failed: 0,
            results: [{ testCaseId, reportId: erroredReportId, outcome: 'succeeded', passFailStatus: 'passed' }],
          },
        }),
      });
    });

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await (await openRetryJudgementItem(page, runId!)).click();

    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await page.locator('[data-testid="retry-judgement-confirm-btn"]').click();

    // While polling (poll interval is 2s client-side), the dialog shows a
    // live progress row rather than sitting on a bare spinner.
    await expect(page.locator('[data-testid="retry-judgement-progress"]')).toBeVisible({ timeout: 5000 });

    const summary = page.locator('[data-testid="retry-judgement-summary"]');
    await expect(summary).toBeVisible({ timeout: 15000 });
    await expect(summary).toContainText('1 succeeded');
    expect(posted).toBe(true);
    expect(statusPolled).toBeGreaterThan(0);

    await page.locator('[data-testid="retry-judgement-done-btn"]').click();
    await expect(dialog).not.toBeVisible();
  });
});

test.describe('Run inspector — Retry judgement kebab item disabled when no judge failures', () => {
  let testCaseId: string | null = null;
  let runId: string | null = null;
  let passedReportId: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-retry-judgement-clean-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'q',
        expectedOutcomes: ['a'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    passedReportId = `report-e2e-retry-clean-${Date.now()}`;
    const passedRes = await request.post('/api/storage/runs', {
      data: {
        id: passedReportId,
        timestamp: new Date().toISOString(),
        agentName: 'Demo Agent',
        agentKey: 'demo',
        modelName: 'demo-model',
        modelId: 'demo-model',
        testCaseId,
        status: 'completed',
        metricsStatus: 'ready',
        passFailStatus: 'passed',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
      },
    });
    if (!passedRes.ok()) return;

    runId = `eval-run-e2e-retry-judgement-clean-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        name: 'E2E Retry Judgement Clean Run',
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e retry judgement clean tc' }],
        results: {
          [testCaseId]: { reportId: passedReportId, status: 'completed', passFailStatus: 'passed' },
        },
        createdAt: new Date().toISOString(),
      },
    });
    seeded = runRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    if (passedReportId) await request.delete(`/api/storage/runs/${passedReportId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('kebab item is present but disabled when there are no judge-failed cases', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage not configured?)');

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const btn = await openRetryJudgementItem(page, runId!);
    await expect(btn).toContainText('Retry judgement (0)');
    // Radix marks disabled items via aria-disabled / data-disabled.
    await expect(btn).toHaveAttribute('aria-disabled', 'true');
    await expect(btn).toHaveAttribute('title', 'No judge-failed cases to retry');
    await page.keyboard.press('Escape');
  });
});

/*
 * Regression (#462 live verification, 2026-09-01): the button was keyed on
 * route `mode` (derived purely from the URL's benchmarkId param) instead of
 * `run.docType`. An evaluation-run doc created with a benchmarkId is
 * dual-written — a first-class `evaluation-runs` doc AND a legacy-shaped
 * projection embedded in `benchmark.runs[]` (no docType) — so it's reachable
 * from BOTH /evaluations/runs/<runId>/inspect AND
 * /evaluations/benchmarks/<benchmarkId>/runs/<runId>/inspect. The button
 * never rendered on the second URL even though the underlying run is a
 * first-class evaluation run with judge-failed cases to salvage. Fixed by
 * having the benchmark-route load path prefer the first-class doc (which
 * carries docType) over the embedded projection when one exists — same class
 * of bug as the Re-run button fix (goyamegh/rerun-idspace-fix).
 */
test.describe('Run inspector — Retry judgement kebab item on the BENCHMARK-scoped route (regression)', () => {
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  let erroredReportId: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-retry-judgement-bmroute-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'What is causing the outage?',
        expectedOutcomes: ['Identifies the root cause'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    erroredReportId = `report-e2e-retry-bmroute-errored-${Date.now()}`;
    const erroredRes = await request.post('/api/storage/runs', {
      data: {
        id: erroredReportId,
        timestamp: new Date().toISOString(),
        agentName: 'Demo Agent',
        agentKey: 'demo',
        modelName: 'demo-model',
        modelId: 'demo-model',
        testCaseId,
        status: 'completed',
        metricsStatus: 'error',
        passFailStatus: null,
        traceError: 'Judge evaluation failed (kind=judge_failed): mock 400',
        llmJudgeReasoning: '**Evaluator could not run.**',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      },
    });
    if (!erroredRes.ok()) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `E2E Retry Judgement Benchmark Route ${Date.now()}`,
        description: 'Regression coverage for the docType-keyed Retry judgement fix',
        testCaseIds: [testCaseId],
      },
    });
    if (!bmRes.ok()) return;
    const bm = await bmRes.json();
    benchmarkId = bm.id;
    if (!benchmarkId) return;

    runId = `eval-run-e2e-retry-judgement-bmroute-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        name: 'E2E Retry Judgement Benchmark Route Run',
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        benchmarkId,
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'e2e retry judgement bmroute tc' }],
        results: {
          [testCaseId]: { reportId: erroredReportId, status: 'completed' },
        },
        createdAt: new Date().toISOString(),
      },
    });
    if (!runRes.ok()) return;

    // Embed the LEGACY-shaped (no docType) projection into benchmark.runs[]
    // — exactly what the live SSE /evaluation-runs execution path does when
    // a run carries a benchmarkId ("Link the terminal projection before
    // finalizing the first-class run"). This is the object the benchmark-
    // scoped inspector route resolves BEFORE the fix's first-class-doc
    // preference kicks in.
    const linkRes = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        runs: [{
          id: runId,
          name: 'E2E Retry Judgement Benchmark Route Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          judgeModelId: 'demo-model',
          status: 'completed',
          results: {
            [testCaseId]: { reportId: erroredReportId, status: 'completed' },
          },
        }],
      },
    });
    seeded = linkRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    if (erroredReportId) await request.delete(`/api/storage/runs/${erroredReportId}`).catch(() => {});
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('kebab item renders with the judge-failed count on the benchmark-scoped inspector route', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark-linked run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const btn = await openRetryJudgementItem(page, runId!);
    await expect(btn).toContainText('Retry judgement (1)');
    await expect(btn).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
  });

  test('clicking opens the confirm dialog on the benchmark-scoped route too', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark-linked run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    await (await openRetryJudgementItem(page, runId!)).click();

    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('1');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });
});
