/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Regression: the Evaluation Run detail page must display stats derived
 * from the persisted per-test-case verdicts (`run.results[*].passFailStatus`),
 * NOT the denormalized `run.stats` blob.
 *
 * Root cause (trace-judged path bug): `waitForTracesAndJudge` wrote the real
 * judge verdict to storage but returned void, so the caller in
 * `services/evaluationRunner.ts` never saw it and recorded every trace-judged
 * test case as a bare 'completed' with no verdict. The run-completion stats
 * loop then counted every 'completed' result as "passed" regardless of the
 * real verdict — a run with (say) 66/84 real "passed" judgments displayed as
 * 84/84 passed.
 *
 * This spec seeds an evaluation-run doc where `run.stats` still has the OLD
 * buggy shape (every case counted as passed) but `run.results` (and the
 * per-case report docs) carry the real verdicts (2 passed / 2 failed). The
 * run-report surface is the run inspector (`/evaluations/runs/:id/inspect`;
 * the older detail page is retired and redirects there) — if it ever
 * regresses to trusting `run.stats` directly, this test fails by asserting
 * the buggy numbers are NOT shown and the real numbers ARE.
 */

const RUN_ID = 'eval-run-e2e-trace-judge-stats';
const TC_PASS_1 = 'tc-e2e-tjs-pass-1';
const TC_PASS_2 = 'tc-e2e-tjs-pass-2';
const TC_FAIL_1 = 'tc-e2e-tjs-fail-1';
const TC_FAIL_2 = 'tc-e2e-tjs-fail-2';

function evalRunDoc() {
  return {
    id: RUN_ID,
    docType: 'evaluation-run',
    name: 'E2E Trace-Judged Stats Run',
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    // Real per-test-case verdicts (what the trace judge actually decided,
    // persisted correctly on each report AND — post-fix — on run.results).
    results: {
      [TC_PASS_1]: { reportId: `report-${TC_PASS_1}`, status: 'completed', passFailStatus: 'passed' },
      [TC_PASS_2]: { reportId: `report-${TC_PASS_2}`, status: 'completed', passFailStatus: 'passed' },
      [TC_FAIL_1]: { reportId: `report-${TC_FAIL_1}`, status: 'completed', passFailStatus: 'failed' },
      [TC_FAIL_2]: { reportId: `report-${TC_FAIL_2}`, status: 'completed', passFailStatus: 'failed' },
    },
    // The OLD buggy denormalized stats: every 'completed' result counted as
    // passed regardless of verdict (pre-fix `evaluationRunner.ts` behavior).
    // A regression that goes back to trusting this blob directly would show
    // 4/4 passed here instead of the real 2/2.
    stats: { passed: 4, failed: 0, pending: 0, errored: 0, total: 4 },
  };
}

function reportDoc(testCaseId: string, passFailStatus: 'passed' | 'failed') {
  return {
    id: `report-${testCaseId}`,
    timestamp: new Date().toISOString(),
    testCaseId,
    experimentRunId: RUN_ID,
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    status: 'completed',
    passFailStatus,
    metricsStatus: 'ready',
    evaluationType: 'deterministic',
    trajectory: [],
    metrics: { accuracy: passFailStatus === 'passed' ? 1 : 0 },
  };
}

test.describe('Run inspector — stats reflect real verdicts, not stale run.stats', () => {
  test('shows passed/failed computed from the per-case verdicts, not the buggy denormalized run.stats', async ({ page }) => {
    const api = page.request;
    const cases: Array<[string, 'passed' | 'failed']> = [
      [TC_PASS_1, 'passed'], [TC_PASS_2, 'passed'], [TC_FAIL_1, 'failed'], [TC_FAIL_2, 'failed'],
    ];
    try {
      for (const [tc, verdict] of cases) {
        const r = await api.post('/api/storage/runs', { data: reportDoc(tc, verdict) });
        expect(r.ok(), `seed report for ${tc}`).toBeTruthy();
      }
      const seeded = await api.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: evalRunDoc() });
      expect(seeded.ok()).toBeTruthy();

      // The retired detail URL redirects to the inspector.
      await page.goto(`/evaluations/runs/${RUN_ID}`);
      await page.waitForURL(`**/evaluations/runs/${RUN_ID}/inspect`, { timeout: 15000 });
      await expect(page.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`)).toBeVisible({ timeout: 15000 });

      // Real verdicts: 2 passed, 2 failed, 4 total, 50% — NOT the buggy 4/4.
      // Assert the REAL numbers are shown — this is what regresses to '4✓'/'0✗'
      // if the page ever goes back to trusting the stale run.stats blob.
      const header = page.locator('.text-green-500.font-semibold', { hasText: /✓$/ });
      await expect(header).toHaveText('2✓', { timeout: 15000 });
      await expect(page.locator('.text-red-500.font-semibold', { hasText: /✗$/ })).toHaveText('2✗');
      await expect(page.getByText('/ 4', { exact: true })).toBeVisible();
      await expect(page.getByText('50%', { exact: true })).toBeVisible();
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
      for (const [tc] of cases) {
        await api.delete(`/api/storage/runs/report-${tc}`).catch(() => {});
      }
    }
  });
});
