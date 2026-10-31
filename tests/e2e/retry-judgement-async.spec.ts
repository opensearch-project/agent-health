/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: retry judgement is NON-BLOCKING (owner: "the retry button is not
 * async in nature"). Starting a retry from the confirm dialog, then closing
 * the dialog immediately, must NOT cancel the job: the run header shows a
 * "Re-judging n/N…" pill while the server-side job runs, a toast announces
 * the summary when it finishes, and re-opening the dialog mid-flight shows
 * the live progress instead of a fresh form.
 *
 * The server job is mocked at the network layer (202 + a status endpoint
 * that reports running twice, then completed) so the timing is
 * deterministic; the client-side job store polls it every 2s.
 */

import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

test.describe('Retry judgement — non-blocking job (pill + toast)', () => {
  test('close the dialog right after Confirm → pill on the run, live progress on re-open, toast with the summary', async ({ page, request, testData }) => {
    // Seed: one judge-failed case on a completed evaluation run.
    const tcRes = await request.post('/api/storage/test-cases', {
      data: { name: uniqueTestName('e2e-retry-async-tc'), category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'] },
    });
    test.skip(!tcRes.ok(), 'Could not seed test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId: string = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const reportId = `report-e2e-retry-async-${Date.now()}`;
    const repRes = await request.post('/api/storage/runs', {
      data: {
        id: reportId, timestamp: new Date().toISOString(), agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
        testCaseId, status: 'completed', metricsStatus: 'error', passFailStatus: null,
        traceError: 'Judge evaluation failed (kind=judge_failed): mock 400', llmJudgeReasoning: '**Evaluator could not run.**',
        trajectory: [{ type: 'action', toolName: 'search', content: 'looking' }],
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      },
    });
    test.skip(!repRes.ok(), 'Could not seed report');
    testData.run(reportId);

    const runId = `eval-run-e2e-retry-async-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: uniqueTestName('E2E async retry run'), status: 'completed', agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }], trigger: 'api',
        testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { reportId, status: 'completed' } },
        createdAt: new Date().toISOString(),
      },
    });
    test.skip(!runRes.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    // Mock the job: pre-flight is real (LLM evaluator → no banner); POST → 202; status → running ×2 → completed.
    let statusPolls = 0;
    let posted = 0;
    const summary = { retried: 1, succeeded: 1, failed: 0, notEvaluable: 0, abstain: 0, results: [{ testCaseId, reportId, outcome: 'succeeded', passFailStatus: 'passed' }] };
    await page.route(`**/api/storage/evaluation-runs/${runId}/retry-judgement?scope=*`, async route => {
      posted += 1;
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: runId, status: 'running', total: 1 }) });
    });
    await page.route(`**/api/storage/evaluation-runs/${runId}/retry-judgement/status`, async route => {
      // The pill's mount-time adopt() also asks here before any job exists → 404 (no job yet).
      if (posted === 0) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No retry-judgement job found for this run' }) });
        return;
      }
      statusPolls += 1;
      const body = statusPolls <= 2
        ? { status: 'running', total: 1, completed: 0 }
        : { status: 'completed', total: 1, completed: 1, summary };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator(`[data-testid="retry-judgement-pill-${runId}"]`)).toHaveCount(0);

    // Open the kebab → Retry judgement → Confirm.
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`).click();
    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    const confirm = page.locator('[data-testid="retry-judgement-confirm-btn"]');
    await expect(confirm).toBeEnabled({ timeout: 10000 }); // pre-flight settled
    await confirm.click();

    // Live progress, then CLOSE immediately — the job keeps running.
    await expect(page.locator('[data-testid="retry-judgement-progress"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="retry-judgement-close-btn"]').click();
    await expect(dialog).not.toBeVisible();

    // The run header shows the pill while the job runs.
    const pill = page.locator(`[data-testid="retry-judgement-pill-${runId}"]`);
    await expect(pill).toBeVisible({ timeout: 5000 });
    await expect(pill).toContainText('Re-judging');

    // Re-open mid-flight: live progress, no form / no Confirm.
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`).click();
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-progress-text"]')).toContainText('Re-judging', { timeout: 5000 });
    await expect(page.locator('[data-testid="retry-judgement-confirm-btn"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Completion (3rd poll, ~6s): pill gone, toast with the summary + "Open run".
    const toast = page.locator(`[data-testid="retry-judgement-toast-${runId}"]`);
    await expect(toast).toBeVisible({ timeout: 20000 });
    await expect(page.locator(`[data-testid="retry-judgement-toast-summary-${runId}"]`)).toHaveText('Retried 1 · 1 scored');
    await expect(toast).toContainText('Retry judgement finished');
    await expect(toast.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', `/evaluations/runs/${runId}`);
    await expect(pill).toHaveCount(0);
    expect(posted).toBe(1); // exactly one job started, never re-POSTed on re-open
    expect(statusPolls).toBeGreaterThanOrEqual(3);

    // Dismiss the toast.
    await page.locator(`[data-testid="retry-judgement-toast-dismiss-${runId}"]`).click();
    await expect(toast).toHaveCount(0);
  });
});
