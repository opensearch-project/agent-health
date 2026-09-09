/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * #335 — an agent subprocess timeout / crash must render on the run-detail page
 * as a clearly-labelled error (the kind label + the underlying message), NOT a
 * silent `failed` and NOT the generic "Failed to fetch traces" (which is wrong
 * for an agent failure). We seed the exact report shape that
 * `buildEvaluatorErrorPatch('agent_failed', …)` persists, then assert the UI.
 */
test.describe('#335 — agent failure renders as a labelled errored run', () => {
  const reportId = `e2e-agent-failed-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    await request.post('/api/storage/runs', {
      data: {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentKey: 'plain-agent',
        modelId: 'claude-sonnet',
        testCaseId: 'e2e-agent-failed-tc',
        trajectory: [],
        status: 'completed',
        evaluationType: 'deterministic',
        metricsStatus: 'error',
        passFailStatus: null,
        traceError:
          'Agent run did not complete (kind=agent_failed): Subprocess timed out after 600000ms',
        llmJudgeReasoning:
          '**Agent run did not complete.**\n\nThe agent failed to produce a result ' +
          '(e.g. a subprocess timeout or crash) before the evaluation could run.\n\n' +
          '**Reason (agent_failed):** Subprocess timed out after 600000ms',
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      },
    });
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/runs/${encodeURIComponent(reportId)}`).catch(() => {});
  });

  test('run-detail shows the agent-failure label + message (not "Failed to fetch traces", not a pass)', async ({ page }) => {
    await page.goto(`/runs/${reportId}`);
    await expect(page.locator('body')).toBeVisible();

    // The stage-aware failure card (RunFailureCard) derives the AGENT stage
    // from the legacy `kind=agent_failed` token even though this pre-fix
    // report carries no `failureStage` — and titles it as an agent-request
    // failure (post agent-error-surfacing wording).
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveAttribute('data-stage', 'agent');
    await expect(card).toContainText('Agent request failed');
    // The underlying timeout message is surfaced (not hidden).
    await expect(card.getByTestId('run-failure-cause')).toContainText('Subprocess timed out after 600000ms');
    // Row/summary badge says AGENT ERROR, not a failed verdict.
    await expect(page.getByTestId('status-label').first()).toHaveText('AGENT ERROR');
    // It must NOT be mislabelled as a trace-fetch failure.
    await expect(page.locator('text=Failed to fetch traces')).toHaveCount(0);
  });
});
