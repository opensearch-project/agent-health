/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

// Regression: comparing EVALUATION runs that don't belong to a benchmark.
// The comparison page used to be benchmark-scoped — /compare?runs=<eval-run
// ids> (no :benchmarkId) bailed to the "Select a benchmark" empty state, so a
// standalone evaluation comparison was impossible. The page now loads runs by
// id directly (evaluation-run docs, with or without a benchmark).

const RUN_A = 'eval-run-e2e-cmp-aaaaaa';
const RUN_B = 'eval-run-e2e-cmp-bbbbbb';
const TC = 'tc-e2e-cmp-001';

function evalRunDoc(id: string, name: string, agentKey: string) {
  return {
    id,
    docType: 'evaluation-run',
    name,
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    // References a report id that need not exist — the loader skips missing
    // reports; the row still renders from results.status.
    results: { [TC]: { reportId: `report-${id}`, status: 'completed' } },
    stats: { passed: 1, failed: 0, total: 1 },
  };
}

test.describe('Comparison Page — evaluation runs (benchmark-free)', () => {
  test('/compare?runs= loads standalone eval runs (no benchmark) and renders the comparison', async ({ page }) => {
    const api = page.request;
    try {
      // Seed two eval runs with DIFFERENT agents (→ Compare mode). PUT upserts.
      const a = await api.put(`/api/storage/evaluation-runs/${RUN_A}`, { data: evalRunDoc(RUN_A, 'E2E Compare Run A', 'agent-alpha') });
      const b = await api.put(`/api/storage/evaluation-runs/${RUN_B}`, { data: evalRunDoc(RUN_B, 'E2E Compare Run B', 'agent-beta') });
      expect(a.ok()).toBeTruthy();
      expect(b.ok()).toBeTruthy();

      await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
      await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
      await page.waitForTimeout(2500);

      // NOT the benchmark empty-state.
      await expect(page.locator('text=Select a benchmark to start comparing runs')).toHaveCount(0);
      // Both run names rendered (header / chips).
      await expect(page.locator('text=E2E Compare Run A').first()).toBeVisible();
      await expect(page.locator('text=E2E Compare Run B').first()).toBeVisible();
      // Run-centric breadcrumb points at Evaluation Runs (not Benchmarks).
      await expect(page.locator('text=Evaluation Runs').first()).toBeVisible();
      // The comparison content rendered — the scoreboard's "All metrics"
      // expander (which replaced the standalone "Detailed metrics" section)
      // exists for any ≥2-run view.
      await expect(page.locator('text=All metrics').first()).toBeVisible();
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_A}`).catch(() => {});
      await api.delete(`/api/storage/evaluation-runs/${RUN_B}`).catch(() => {});
    }
  });
});
