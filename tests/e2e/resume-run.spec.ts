// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * E2E: "Resume" continues an interrupted evaluation run in place —
 * re-executing only the test cases without a persisted report, never
 * creating a new run. Distinct from "Re-run" (fresh run via composer).
 *
 * Seeds an interrupted run through the real backend (PUT upsert, no
 * execution), asserts the Resume button renders with the correct remaining
 * count, and that clicking it POSTs to the /resume endpoint. The resume
 * execution itself is exercised by the integration test; here we pin the
 * UI contract.
 */
import { test, expect } from './fixtures/test-fixtures';

test.describe('Resume interrupted evaluation run', () => {
  const runId = `eval-run-resume-e2e-${Date.now()}`;
  const tcIds = [`tc-resume-e2e-a-${Date.now()}`, `tc-resume-e2e-b-${Date.now()}`, `tc-resume-e2e-c-${Date.now()}`];

  test.beforeAll(async ({ request }) => {
    // Seed: 1 completed (has reportId), 1 pending, 1 missing → 2 resumable.
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        name: 'resume-e2e-run',
        sources: [{ type: 'test-case-ids', ids: tcIds }],
        agentKey: 'demo',
        modelId: 'demo-model',
        trigger: 'api',
        status: 'failed',
        error: 'simulated interruption',
        createdAt: new Date().toISOString(),
        testCaseSnapshots: tcIds.map((id, i) => ({ id, version: 1, name: `resume-e2e-tc${i + 1}` })),
        results: {
          [tcIds[0]]: { reportId: 'e2e-preserved-report', status: 'completed' },
          [tcIds[1]]: { reportId: '', status: 'pending' },
        },
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
  });

  test('Resume button shows remaining count and POSTs to /resume', async ({ page }) => {
    await page.goto(`/evaluations/runs/${runId}`);

    // Button is visible with the resumable count (tc2 pending + tc3 missing = 2).
    const resumeBtn = page.locator('[data-testid="resume-run-btn"]');
    await expect(resumeBtn).toBeVisible({ timeout: 30000 });
    await expect(resumeBtn).toContainText('Resume (2 left)');

    // Re-run stays available too — Resume complements, not replaces, it.
    await expect(page.locator('[data-testid="rerun-run-btn"]')).toBeVisible();

    // Intercept the resume POST so the e2e test doesn't launch a real agent run.
    let resumeCalled = false;
    await page.route(`**/api/storage/evaluation-runs/${runId}/resume`, async (route) => {
      resumeCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: completed\ndata: {"id":"' + runId + '","status":"completed"}\n\n',
      });
    });

    await resumeBtn.click();
    await expect.poll(() => resumeCalled, { timeout: 10000 }).toBe(true);
  });

  test('Resume button hidden when every test case has a report', async ({ page, request }) => {
    const doneRunId = `${runId}-done`;
    const res = await request.put(`/api/storage/evaluation-runs/${doneRunId}`, {
      data: {
        name: 'resume-e2e-run-done',
        sources: [{ type: 'test-case-ids', ids: [tcIds[0]] }],
        agentKey: 'demo',
        modelId: 'demo-model',
        trigger: 'api',
        status: 'completed',
        createdAt: new Date().toISOString(),
        testCaseSnapshots: [{ id: tcIds[0], version: 1, name: 'resume-e2e-tc1' }],
        results: { [tcIds[0]]: { reportId: 'e2e-done-report', status: 'completed' } },
      },
    });
    expect(res.ok()).toBeTruthy();

    await page.goto(`/evaluations/runs/${doneRunId}`);
    await expect(page.locator('[data-testid="rerun-run-btn"]')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="resume-run-btn"]')).toHaveCount(0);

    await request.delete(`/api/storage/evaluation-runs/${doneRunId}`).catch(() => {});
  });
});
