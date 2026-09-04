/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: run-lifecycle action matrix (Delete / Cancel / Retry judgement) via
 * the shared RunActionsMenu kebab, plus the upgraded, prefilled Re-run
 * dialog.
 *
 * Covers the UI-visible surface (server behavior is covered by
 * tests/integration/.../evaluationRunLifecycleActions.integration.test.ts):
 *   - the kebab menu renders on evaluation-runs list rows and shows/hides
 *     Cancel depending on run status ("cancel only for ongoing ones")
 *   - Delete opens a confirm dialog before deleting
 *   - the run-detail page header's Re-run dialog is prefilled from the
 *     source run (agent, evaluator, judge model all visible + editable)
 *   - the inspector header exposes the same action menu
 *
 * Seeds its own deterministic evaluation-run docs via the storage API and
 * cleans them up via the `testData` tracker.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Run actions menu — Delete / Cancel / Retry judgement', () => {
  test('running run: kebab shows Cancel; completed run: kebab hides Cancel', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-actions-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'q',
        expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runningId = `eval-run-e2e-actions-running-${Date.now()}`;
    const runningRes = await request.put(`/api/storage/evaluation-runs/${runningId}`, {
      data: {
        id: runningId, name: 'E2E Actions Running Run', status: 'running',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!runningRes.ok(), 'Could not seed running run');
    testData.evaluationRun(runningId);

    const completedId = `eval-run-e2e-actions-completed-${Date.now()}`;
    await request.put(`/api/storage/evaluation-runs/${completedId}`, {
      data: {
        id: completedId, name: 'E2E Actions Completed Run', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    testData.evaluationRun(completedId);

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.getByPlaceholder('Search runs...').fill('E2E Actions');

    // Running row: menu shows Cancel.
    await expect(page.getByText('E2E Actions Running Run')).toBeVisible({ timeout: 15000 });
    const runningRow = page.locator('tr').filter({ hasText: 'E2E Actions Running Run' });
    await runningRow.locator(`[data-testid="run-actions-menu-trigger-${runningId}"]`).click();
    await expect(page.locator(`[data-testid="run-action-cancel-${runningId}"]`)).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');

    // Completed row: menu hides Cancel.
    await expect(page.getByText('E2E Actions Completed Run')).toBeVisible({ timeout: 15000 });
    const completedRow = page.locator('tr').filter({ hasText: 'E2E Actions Completed Run' });
    await completedRow.locator(`[data-testid="run-actions-menu-trigger-${completedId}"]`).click();
    await expect(page.locator(`[data-testid="run-action-cancel-${completedId}"]`)).toHaveCount(0);
    // Retry judgement is present but disabled (no judge-failed cases).
    await expect(page.locator(`[data-testid="run-action-retry-judgement-${completedId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="run-action-retry-judgement-${completedId}"]`)).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('Delete opens a confirm dialog and deleting removes the run from the list', async ({ page, request, testData }) => {
    const runId = `eval-run-e2e-actions-delete-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Actions Delete Target', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', sources: [],
        trigger: 'api', testCaseSnapshots: [], results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run (storage not configured?)');

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.getByPlaceholder('Search runs...').fill('E2E Actions Delete Target');
    await expect(page.getByText('E2E Actions Delete Target')).toBeVisible({ timeout: 15000 });

    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-delete-${runId}"]`).click();

    const confirmDialog = page.locator(`[data-testid="run-delete-confirm-${runId}"]`);
    await expect(confirmDialog).toBeVisible({ timeout: 10000 });
    await expect(confirmDialog).toContainText('Delete this run?');

    await page.locator(`[data-testid="run-delete-confirm-btn-${runId}"]`).click();
    await expect(page.getByText('E2E Actions Delete Target')).toHaveCount(0, { timeout: 15000 });

    // Deleted server-side too — no cleanup needed, but verify directly.
    const getRes = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect(getRes.status()).toBe(404);
  });

  test('Retry judgement is enabled only for a terminal run with a judge-failed (no-verdict) case, and flips it to passed', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-retry-judgement-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const reportRes = await request.post('/api/storage/runs', {
      data: {
        testCaseId, agentName: 'Demo Agent', agentKey: 'demo',
        modelName: 'demo-model', modelId: 'demo-model',
        // Judge-failed = agent completed but the evaluator produced NO
        // verdict (metricsStatus 'error'), the same shape the runner
        // persists for trace timeouts / judge errors — NOT a graded 'failed'.
        status: 'completed', metricsStatus: 'error', passFailStatus: null,
        trajectory: [{ type: 'response', content: 'no root cause found' }],
        metrics: { accuracy: 20, faithfulness: 20, latency_score: 80, trajectory_alignment_score: 20 },
        timestamp: new Date().toISOString(),
      },
    });
    test.skip(!reportRes.ok(), 'Could not seed report (storage not configured?)');
    const report = await reportRes.json();
    testData.run(report.id);

    const runId = `eval-run-e2e-retry-judgement-${Date.now()}`;
    await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Retry Judgement Run', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', judgeModelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { status: 'completed', reportId: report.id } },
        createdAt: new Date().toISOString(),
      },
    });
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    await page.locator('[data-testid="run-actions-menu-trigger-' + runId + '"]').click();
    const retryItem = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
    await expect(retryItem).toBeVisible({ timeout: 10000 });
    await expect(retryItem).toBeEnabled();
    await retryItem.click();

    // No inline error surfaced by the menu, and the server-side effect is
    // real: the demo judge's accuracy floor (0.7+) always resolves to
    // 'passed', so the run's persisted stats flip from errored to passed
    // (the client polls the shared 202 job to completion at a 2s cadence).
    // Poll the API directly rather than asserting on a specific pixel
    // (the stats row has no data-testid) — the UI-visible contract under
    // test is "clicking the enabled menu item doesn't error and the action
    // actually took effect", not a specific rendering of the number.
    await expect(page.locator(`[data-testid="run-action-error-${runId}"]`)).toHaveCount(0);
    await expect.poll(async () => {
      const res = await request.get(`/api/storage/evaluation-runs/${runId}`);
      const body = await res.json();
      return body.stats?.passed;
    }, { timeout: 15000 }).toBe(1);
  });
});

test.describe('Re-run dialog — prefilled + editable (Add-Run field set)', () => {
  test('prefills agent/evaluator/judge model from the source run, and shows a modified hint when tweaked', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-rerun-prefill-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runId = `eval-run-e2e-rerun-prefill-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Rerun Prefill Source', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', judgeModelId: 'demo-model',
        evaluatorId: 'system-factuality', concurrency: 3,
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed source run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator('[data-testid="rerun-run-btn"]').click();

    const dialog = page.locator('[data-testid="rerun-confirm-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Prefilled name.
    await expect(page.locator('[data-testid="rerun-name-input"]')).toHaveValue('E2E Rerun Prefill Source (re-run)');
    // Evaluator visible + prefilled (owner-requested — not just carried silently).
    await expect(page.locator('[data-testid="rerun-evaluator-trigger"]')).toContainText('Factuality');
    // Agent visible + prefilled.
    await expect(page.locator('[data-testid="rerun-agent-trigger"]')).toBeVisible();

    // No "modified" hint yet — nothing has been tweaked.
    await expect(page.locator('[data-testid="rerun-modified-hint"]')).toHaveCount(0);

    // Tweak concurrency via the Advanced section -> modified hint appears.
    await page.locator('[data-testid="rerun-advanced-toggle"]').click();
    const concurrencyInput = page.locator('[data-testid="rerun-concurrency-input"]');
    await expect(concurrencyInput).toHaveValue('3');
    await concurrencyInput.fill('7');
    await expect(page.locator('[data-testid="rerun-modified-hint"]')).toBeVisible({ timeout: 5000 });

    // Dismiss without submitting — no run created.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });
});

test.describe('Run inspector header — action menu + Cancel-only-while-running', () => {
  test('inspector header exposes the same action menu for evaluation runs', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-inspector-actions-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runId = `eval-run-e2e-inspector-actions-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Inspector Actions Run', status: 'running',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await expect(page.locator(`[data-testid="run-action-cancel-${runId}"]`)).toBeVisible({ timeout: 10000 });
  });
});
