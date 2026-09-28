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
  const stamp = Date.now();
  const reportId = `e2e-agent-failed-${stamp}`;
  const runId = `eval-run-e2e-agent-failed-${stamp}`;
  const testCaseId = `e2e-agent-failed-tc-${stamp}`;

  test.beforeAll(async ({ request }) => {
    // The run-report surface is the run inspector: seed a one-case
    // evaluation run whose report carries the agent-failure error shape.
    await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId,
        docType: 'evaluation-run',
        name: `E2E agent-failed run ${stamp}`,
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'plain-agent',
        modelId: 'claude-sonnet',
        sources: [],
        trigger: 'api',
        testCaseSnapshots: [],
        results: { [testCaseId]: { reportId, status: 'completed' } },
        stats: { passed: 0, failed: 0, pending: 0, errored: 1, total: 1 },
      },
    });
    await request.post('/api/storage/runs', {
      data: {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentKey: 'plain-agent',
        modelId: 'claude-sonnet',
        testCaseId,
        experimentRunId: runId,
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
    await request.delete(`/api/storage/evaluation-runs/${encodeURIComponent(runId)}`).catch(() => {});
  });

  test('run-detail shows the agent-failure label + message (not "Failed to fetch traces", not a pass)', async ({ page }) => {
    await page.goto(`/evaluations/runs/${runId}/inspect?reportId=${reportId}`);
    await expect(page.locator('body')).toBeVisible();

    // The error-card title is derived from the error-kind label.
    await expect(page.locator('text=Agent run did not complete').first()).toBeVisible({ timeout: 15000 });
    // The underlying timeout message is surfaced (not hidden).
    await expect(page.locator('text=Subprocess timed out after 600000ms').first()).toBeVisible();
    // It must NOT be mislabelled as a trace-fetch failure.
    await expect(page.locator('text=Failed to fetch traces')).toHaveCount(0);
  });
});
