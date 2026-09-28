/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Judge failures are now CLASSIFIED (server/services/judgeErrors.ts): a
 * Bedrock "Input is too long for requested model" overflow is reported as a
 * context overflow (non-retryable, one attempt) instead of the blanket
 * "Failed to parse Pi judge response. The CLI may have returned invalid JSON."
 * after 10 attempts. This spec seeds the exact report shape
 * `buildEvaluatorErrorPatch('judge_failed', …)` persists for such a case and
 * asserts the run-detail page shows the real cause (class + provider message)
 * and none of the old misleading wording.
 */
test.describe('classified judge failure renders its real cause on the run-detail page', () => {
  const reportId = `e2e-judge-overflow-${Date.now()}`;
  const REASON =
    'Judge failed (context_overflow, not retryable): Judge evaluation failed: Judge context overflow — ' +
    "the evaluation prompt (plus any trace-tool results) exceeds the judge model's context window: " +
    'Validation error: The model returned the following errors: Input is too long for requested model.';

  test.beforeAll(async ({ request }) => {
    await request.post('/api/storage/runs', {
      data: {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentKey: 'retrieval-agent',
        modelId: 'claude-sonnet',
        judgeModelId: 'agent-trace-judge',
        testCaseId: 'e2e-judge-overflow-tc',
        trajectory: [
          { type: 'action', toolName: 'search', content: '{"q":"red trail bike"}' },
          { type: 'response', content: 'Ranked results (3, results_source=return_results):\n1. id 11 — Trail Bike\n2. id 12 — Road Bike\n3. id 13 — BMX' },
        ],
        status: 'completed',
        metricsStatus: 'error',
        passFailStatus: null,
        traceError: `Judge evaluation failed (kind=judge_failed): ${REASON}`,
        llmJudgeReasoning:
          '**Evaluator could not run.**\n\nThe agent may have completed normally, but the evaluator ' +
          '(judge or trace pipeline) failed before it could produce a verdict. This run is excluded ' +
          `from pass-rate aggregation.\n\n**Reason (judge_failed):** ${REASON}`,
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      },
    });
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/runs/${encodeURIComponent(reportId)}`).catch(() => {});
  });

  test('shows the judge-failure label, the failure class and the provider message — never "invalid JSON"', async ({ page }) => {
    await page.goto(`/runs/${reportId}`);
    await expect(page.locator('body')).toBeVisible();

    // The error card (title derived from the error kind) carries the classified reason.
    await expect(page.locator('text=kind=judge_failed').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=context_overflow, not retryable').first()).toBeVisible();
    await expect(page.locator('text=Input is too long for requested model').first()).toBeVisible();
    await expect(page.locator('text=may have returned invalid JSON')).toHaveCount(0);
    await expect(page.locator('text=after 10 attempts')).toHaveCount(0);
  });
});
