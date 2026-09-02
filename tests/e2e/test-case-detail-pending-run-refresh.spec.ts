/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E spec — Test Case Detail page: a run pending judgment must appear
 * correctly (not as a false "Failed") and must resolve to its real
 * verdict live, without a manual page reload.
 *
 * Regression covered: the owner ran "Run Test" (with a trace judge) twice
 * on a test case and the page appeared not to show the new runs. Root
 * cause — /api/evaluate (UI mode) returns its SSE 'completed' event with
 * `metricsStatus: 'pending'` for trace-mode agents *before* the
 * background trace-judge finishes (server/routes/evaluation.ts uses
 * `awaitTraces: false`). TestCaseDetailPage:
 *   (a) classified any non-'passed' run as "Failed" — a fresh pending run
 *       rendered with a red XCircle, indistinguishable from a real
 *       failure, and
 *   (b) fetched the run list exactly once after the run finished
 *       streaming, so it never picked up the real verdict once the judge
 *       completed in the background — the row just sat there wrong until
 *       a manual reload.
 *
 * This spec drives the real page: it intercepts only `POST /api/evaluate`
 * (to avoid depending on a real trace-mode agent + OTel round trip, which
 * is slow/flaky in CI) so it can return the exact 'pending' shape the real
 * endpoint sends, then updates the underlying report via the real storage
 * API (simulating the background judge) and asserts the page picks up the
 * new verdict on its own — no reload.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';

const TEST_TIMEOUT = 60_000;

async function createTestCase(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name,
      description: 'Created by e2e/test-case-detail-pending-run-refresh.spec.ts',
      labels: [],
      category: 'Custom',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt: 'What is 2+2?',
      context: [],
      expectedOutcomes: ['Agent identifies the answer is 4'],
    },
  });
  expect(res.ok(), 'creating test case via storage API').toBe(true);
  const tc = await res.json();
  return tc.id;
}

// Pre-create the placeholder report /api/evaluate would have pre-created,
// at the exact 'pending' shape it persists for a trace-mode agent's
// completed-but-not-yet-judged run.
async function createPendingRun(
  request: APIRequestContext,
  testCaseId: string,
  name: string,
): Promise<string> {
  const res = await request.post('/api/storage/runs', {
    data: {
      name,
      testCaseId,
      testCaseVersionId: `${testCaseId}-v1`,
      agentId: 'test-agent',
      agentName: 'Test agent',
      modelId: 'test-model',
      modelName: 'Test model',
      status: 'completed',
      metricsStatus: 'pending',
      trajectory: [],
    },
  });
  expect(res.ok(), 'creating placeholder run via storage API').toBe(true);
  const run = await res.json();
  return run.id;
}

test.describe('Test Case Detail — pending run renders correctly and self-refreshes', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) test.skip(true, 'Backend storage not available');
  });

  test('Run Test → new run shows as pending-judgment (not Failed) then flips to Passed on its own', async ({
    page,
    request,
    testData,
  }) => {
    const runName = `E2E-Pending-${Date.now()}`;
    const tcId = await createTestCase(request, `e2e-pending-run-${Date.now()}`);
    testData.testCase(tcId);
    const pendingRunId = await createPendingRun(request, tcId, runName);
    testData.run(pendingRunId);

    // Stand in for the real /api/evaluate: the server would send exactly
    // this shape for a trace-mode agent (status 'completed', metricsStatus
    // 'pending', no passFailStatus yet) — see server/routes/evaluation.ts.
    await page.route('**/api/evaluate', async (route) => {
      const body =
        `data: ${JSON.stringify({ type: 'started', reportId: pendingRunId })}\n\n` +
        `data: ${JSON.stringify({
          type: 'completed',
          reportId: pendingRunId,
          report: { id: pendingRunId, status: 'completed', metricsStatus: 'pending' },
        })}\n\n`;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body,
      });
    });

    await page.goto(`/evaluations/test-cases/${tcId}`);
    await expect(page.getByRole('heading', { level: 2 })).toContainText('e2e-pending-run-');

    await page.getByRole('button', { name: /^run test$/i }).first().click();
    await expect(page.getByText('Configure Run', { exact: true })).toBeVisible();
    await page.getByLabel(/run name/i).fill(runName);
    await page.getByRole('button', { name: /^start run$/i }).click();
    await expect(page.getByText('Configure Run', { exact: true })).toBeHidden();

    // The run history disclosure defaults to closed, but `handleStartRun`
    // force-opens it as soon as a run starts — only click if it's still
    // closed (avoids accidentally toggling an already-open disclosure shut).
    const runHistory = page.getByRole('button', { name: /Run history/i });
    if ((await runHistory.getAttribute('aria-expanded')) === 'false') {
      await runHistory.click();
    }

    // The new run appears (loadData() ran after the SSE 'completed' event)
    // — and, pre-fix, it would have shown as a red "Failed" icon.
    await expect(page.getByText(runName).first()).toBeVisible({ timeout: 15_000 });
    // shows as a spinner tied to the granular reason it's pending (see
    // ResultStatus.tsx's `getStatusDescription`) — not a red "Failed".
    await expect(page.getByTitle('Agent done — waiting for traces...').first()).toBeVisible();
    await expect(page.getByTitle('Failed')).toHaveCount(0);

    // Simulate the background trace-judge completing — exactly what
    // startTracePollingForReportWithModule's onTracesFound update does.
    const patchRes = await request.patch(`/api/storage/runs/${encodeURIComponent(pendingRunId)}`, {
      data: { metricsStatus: 'ready', passFailStatus: 'passed', metrics: { accuracy: 1 } },
    });
    expect(patchRes.ok(), 'simulating background judge completion').toBe(true);

    // Without any reload/interaction, the page's poll (every 5s while a
    // run is pending/running) must pick up the real verdict.
    await expect(page.getByTitle('Passed').first()).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTitle('Agent done — waiting for traces...')).toHaveCount(0);
  });
});
