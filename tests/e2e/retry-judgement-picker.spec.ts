/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the Retry-judgement PICKER (owner follow-up to #468):
 * "Retry judgement should be a retryable step all the time. We only preserve
 * the last one, but the judgement should allow for evaluator type and prompt
 * evaluator when retrying; defaults will be the last selected ones."
 *
 * Against the real server + the built-in demo judge (no network mocks):
 *   1. a COMPLETED run whose only case is already judged fine → the kebab's
 *      "Retry judgement" is ENABLED (count = all cases)
 *   2. the dialog opens with the run's evaluator / judge model preselected
 *      and "All cases" checked (no judge-failed cases)
 *   3. pick a different evaluator → submit → progress → summary
 *   4. the report now shows the "Re-judged … with <evaluator> · <model>"
 *      line on its Judge tab, carrying the NEW evaluator
 *   5. reopening the dialog preselects the LAST selection
 *
 * Seeds its own docs via the storage API; cleaned up by id via `testData`.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Retry judgement picker — always available, evaluator/model choice, last-selected defaults', () => {
  test('clean run → pick another evaluator → re-judged line → defaults = last selected', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-rejudge-picker-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy',
        initialPrompt: 'What is causing the outage?',
        expectedOutcomes: ['Identifies the root cause'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const reportId = `report-e2e-rejudge-picker-${Date.now()}`;
    const reportRes = await request.post('/api/storage/runs', {
      data: {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
        judgeModelId: 'demo-model', evaluatorId: 'system-rca-default',
        testCaseId,
        status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }, { type: 'assistant', content: 'root cause: X' }],
        metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
        llmJudgeReasoning: 'Original verdict.',
      },
    });
    test.skip(!reportRes.ok(), 'Could not seed report');
    testData.run(reportId);

    const runId = `eval-run-e2e-rejudge-picker-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Retry Judgement Picker Run', status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'demo-model', evaluatorId: 'system-rca-default',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'picker tc' }],
        results: { [testCaseId]: { reportId, status: 'completed', passFailStatus: 'passed' } },
        createdAt: new Date().toISOString(),
      },
    });
    test.skip(!runRes.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    // 1. ENABLED although every case is judged fine.
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    const item = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
    await expect(item).toContainText('Retry judgement (1)', { timeout: 15000 });
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await item.click();

    // 2. Defaults = the run's evaluator / judge model; scope = All cases.
    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    const evaluatorTrigger = page.locator('[data-testid="retry-judgement-evaluator-trigger"]');
    await expect(evaluatorTrigger).toContainText('RCA Default', { timeout: 10000 });
    await expect(dialog).toContainText('Demo'); // judge model select shows the demo model's display name
    await expect(page.locator('[data-testid="retry-judgement-scope-all"]')).toBeChecked();
    await expect(page.locator('[data-testid="retry-judgement-scope-errored"]')).toBeDisabled();
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('1');

    // 3. Pick another (system) evaluator and submit.
    await evaluatorTrigger.click();
    await page.locator('[data-testid="retry-judgement-evaluator-system-factuality"]').click();
    await expect(evaluatorTrigger).toContainText('Factuality');
    await page.locator('[data-testid="retry-judgement-confirm-btn"]').click();
    await expect(page.locator('[data-testid="retry-judgement-progress"]')).toBeVisible({ timeout: 5000 });
    const summary = page.locator('[data-testid="retry-judgement-summary"]');
    await expect(summary).toBeVisible({ timeout: 20000 });
    await expect(summary).toContainText('1 succeeded');
    await page.locator('[data-testid="retry-judgement-done-btn"]').click();
    await expect(dialog).not.toBeVisible();

    // Server-side truth: report re-judged with the picked evaluator, run remembers the selection.
    const persistedReport = await (await request.get(`/api/storage/runs/${reportId}`)).json();
    expect(persistedReport.evaluatorId).toBe('system-factuality');
    expect(persistedReport.judgementRetryCount).toBe(1);
    expect(persistedReport.llmJudgeReasoning).not.toBe('Original verdict.');
    const persistedRun = await (await request.get(`/api/storage/evaluation-runs/${runId}`)).json();
    expect(persistedRun.lastJudgementRetry).toMatchObject({ scope: 'all', evaluatorId: 'system-factuality', judgeModelId: 'demo-model' });

    // 4. The report's Judge tab says it was re-judged, and with what.
    await page.locator('[data-testid="test-case-row"]').first().click();
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    const line = page.locator('[data-testid="judgement-retried-line"]');
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toContainText('Re-judged');
    await expect(line).toContainText('Factuality', { timeout: 10000 });
    await expect(line).toContainText('Demo');

    // 5. Reopen → defaults are now the LAST selection.
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`).click();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(evaluatorTrigger).toContainText('Factuality', { timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-scope-all"]')).toBeChecked();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('runs list row: the kebab item opens the same picker (no fire-and-forget POST) and a running run stays disabled', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: { name: `e2e-rejudge-picker-list-tc-${Date.now()}`, category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'] },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const reportId = `report-e2e-rejudge-picker-list-${Date.now()}`;
    const reportRes = await request.post('/api/storage/runs', {
      data: {
        id: reportId, timestamp: new Date().toISOString(),
        agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
        testCaseId, status: 'completed', metricsStatus: 'ready', passFailStatus: 'failed',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 10, faithfulness: 10, latency_score: 10, trajectory_alignment_score: 10 },
      },
    });
    test.skip(!reportRes.ok(), 'Could not seed report');
    testData.run(reportId);

    const stamp = Date.now();
    const completedId = `eval-run-e2e-rejudge-picker-list-${stamp}`;
    await request.put(`/api/storage/evaluation-runs/${completedId}`, {
      data: {
        id: completedId, name: `E2E Picker List Completed ${stamp}`, status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }], trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { reportId, status: 'completed', passFailStatus: 'failed' } },
        createdAt: new Date().toISOString(),
      },
    });
    testData.evaluationRun(completedId);
    const runningId = `eval-run-e2e-rejudge-picker-list-running-${stamp}`;
    await request.put(`/api/storage/evaluation-runs/${runningId}`, {
      data: {
        id: runningId, name: `E2E Picker List Running ${stamp}`, status: 'running',
        agentKey: 'demo', modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }], trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { reportId, status: 'completed', passFailStatus: 'failed' } },
        createdAt: new Date().toISOString(),
      },
    });
    testData.evaluationRun(runningId);

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.getByPlaceholder('Search runs...').fill(`E2E Picker List`);

    // Running: disabled with the "finished" reason (existing gate).
    await expect(page.getByText(`E2E Picker List Running ${stamp}`)).toBeVisible({ timeout: 15000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${runningId}"]`).click();
    const runningItem = page.locator(`[data-testid="run-action-retry-judgement-${runningId}"]`);
    await expect(runningItem).toHaveAttribute('aria-disabled', 'true');
    await expect(runningItem).toHaveAttribute('title', 'Retry judgement is only available once the run finishes');
    await page.keyboard.press('Escape');

    // Completed (graded 'failed', no judge failures): ENABLED, opens the picker with All cases.
    let posted = 0;
    page.on('request', req => { if (req.method() === 'POST' && req.url().includes(`/evaluation-runs/${completedId}/retry-judgement`)) posted += 1; });
    await page.locator(`[data-testid="run-actions-menu-trigger-${completedId}"]`).click();
    const item = page.locator(`[data-testid="run-action-retry-judgement-${completedId}"]`);
    await expect(item).toContainText('Retry judgement (1)');
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await item.click();
    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-scope-all"]')).toBeChecked();
    expect(posted).toBe(0); // nothing fired until the user confirms
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    expect(posted).toBe(0);
  });
});
