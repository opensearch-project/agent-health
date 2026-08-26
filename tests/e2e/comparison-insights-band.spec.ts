/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

// Comparison insights band: agreement chips (Both pass / Both fail / Split)
// + category × run pass-rate matrix parsed from the "[tag]" in test-case
// names, with click-to-filter into Table Compare. Deterministic — no LLM.

const RUN_A = 'eval-run-e2e-ins-aaaaaa';
const RUN_B = 'eval-run-e2e-ins-bbbbbb';

// 6 cases: 2 both-pass, 1 both-fail, 2 split, 1 covered-by-A-only.
// Categories: [semantic] ×3 (weak for both), [basic] ×3.
const CASES = [
  { tc: 'tc-e2e-ins-001', name: 'q1 [basic] both pass', a: 'passed', b: 'passed' },
  { tc: 'tc-e2e-ins-002', name: 'q2 [basic] both pass', a: 'passed', b: 'passed' },
  { tc: 'tc-e2e-ins-003', name: 'q3 [semantic] both fail', a: 'failed', b: 'failed' },
  { tc: 'tc-e2e-ins-004', name: 'q4 [semantic] split', a: 'passed', b: 'failed' },
  { tc: 'tc-e2e-ins-005', name: 'q5 [semantic] split', a: 'failed', b: 'passed' },
  { tc: 'tc-e2e-ins-006', name: 'q6 [basic] partial', a: 'passed', b: null },
] as const;

function reportDoc(id: string, testCaseId: string, passFail: string) {
  return {
    id,
    docType: 'run',
    timestamp: new Date().toISOString(),
    testCaseId,
    agentName: 'e2e-agent',
    agentKey: 'e2e-agent',
    modelName: 'e2e-model',
    modelId: 'e2e-model',
    status: 'completed',
    passFailStatus: passFail,
    metricsStatus: 'ready',
    trajectory: [],
    metrics: { accuracy: passFail === 'passed' ? 100 : 0 },
    llmJudgeReasoning: 'e2e',
  };
}

function evalRunDoc(runId: string, name: string, agentKey: string, which: 'a' | 'b') {
  const results: Record<string, any> = {};
  for (const c of CASES) {
    const verdict = c[which];
    if (!verdict) continue; // partial coverage for the last case
    results[c.tc] = { reportId: `report-${runId}-${c.tc}`, status: 'completed', passFailStatus: verdict };
  }
  return {
    id: runId,
    docType: 'evaluation-run',
    name,
    createdAt: new Date().toISOString(),
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: CASES.map(c => ({ id: c.tc, version: 1, name: c.name })),
    results,
    stats: { passed: 0, failed: 0, total: Object.keys(results).length },
  };
}

test.describe('Comparison insights band', () => {
  test('agreement chips + category matrix render and filter the table', async ({ page }) => {
    const api = page.request;
    const createdReports: string[] = [];
    try {
      // Seed test cases (names carry the [tag] the category parser reads).
      // POST creates with an explicit id (PUT is update-only).
      for (const c of CASES) {
        const r = await api.post('/api/storage/test-cases', {
          data: {
            id: c.tc,
            name: c.name,
            description: 'e2e insights',
            labels: ['category:RAG'],
            initialPrompt: 'q',
            expectedOutcomes: { conclusions: ['x'] },
            currentVersion: 1,
          },
        });
        if (!r.ok()) console.log('TC CREATE FAILED', r.status(), await r.text());
        expect(r.ok()).toBeTruthy();
      }
      // Seed report docs carrying the verdicts
      for (const c of CASES) {
        for (const [which, runId] of [['a', RUN_A], ['b', RUN_B]] as const) {
          const verdict = c[which];
          if (!verdict) continue;
          const id = `report-${runId}-${c.tc}`;
          const r = await api.post('/api/storage/runs', { data: reportDoc(id, c.tc, verdict) });
          expect(r.ok()).toBeTruthy();
          createdReports.push(id);
        }
      }
      // Seed the two eval runs (different agents → Compare mode)
      await api.put(`/api/storage/evaluation-runs/${RUN_A}`, { data: evalRunDoc(RUN_A, 'E2E Insights Run A', 'agent-alpha', 'a') });
      await api.put(`/api/storage/evaluation-runs/${RUN_B}`, { data: evalRunDoc(RUN_B, 'E2E Insights Run B', 'agent-beta', 'b') });

      await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
      await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
      await page.waitForSelector('[data-testid="comparison-insights-band"]', { timeout: 30000 });

      // Agreement chips with the right counts (2-run labels use "Both")
      await expect(page.getByTestId('agreement-chip-allPass')).toContainText('Both pass 2');
      await expect(page.getByTestId('agreement-chip-allFail')).toContainText('Both fail 1');
      await expect(page.getByTestId('agreement-chip-split')).toContainText('Split 2');

      // Category matrix open by default with parsed categories
      const matrix = page.getByTestId('insights-category-matrix');
      await expect(matrix).toBeVisible();
      await expect(matrix).toContainText('semantic');
      await expect(matrix).toContainText('basic');

      // Chip filters the table: Split → exactly the 2 split cases
      await page.getByTestId('agreement-chip-split').click();
      await expect(page.locator('text=q4 [semantic] split').first()).toBeVisible();
      await expect(page.locator('text=q5 [semantic] split').first()).toBeVisible();
      await expect(page.locator('text=q1 [basic] both pass')).toHaveCount(0);

      // Toggle the chip off → default view returns
      await page.getByTestId('agreement-chip-split').click();

      // Collapsing the category section keeps the band but hides the matrix
      await page.getByTestId('insights-categories-toggle').click();
      await expect(page.getByTestId('insights-category-matrix')).toHaveCount(0);
      await page.getByTestId('insights-categories-toggle').click();
      await expect(page.getByTestId('insights-category-matrix')).toBeVisible();
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_A}`).catch(() => {});
      await api.delete(`/api/storage/evaluation-runs/${RUN_B}`).catch(() => {});
      for (const id of createdReports) await api.delete(`/api/storage/runs/${id}`).catch(() => {});
      for (const c of CASES) await api.delete(`/api/storage/test-cases/${c.tc}`).catch(() => {});
    }
  });
});
