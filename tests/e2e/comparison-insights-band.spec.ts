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

      // Chip filters the table: Split → exactly the 2 split cases.
      // Scoped to `table` (the Table Compare grid) — a 2-run selection also
      // renders the "What's actually different" deep-dive panel, whose footer
      // names its representative case (e.g. "· spans from case: q1 [basic]
      // both pass") outside any `<table>`, so an unscoped `text=` locator
      // would false-match there regardless of this filter (see PR #398
      // e2e-tests fix-up).
      const table = page.locator('table');
      await page.getByTestId('agreement-chip-split').click();
      await expect(table.getByText('q4 [semantic] split').first()).toBeVisible();
      await expect(table.getByText('q5 [semantic] split').first()).toBeVisible();
      await expect(table.getByText('q1 [basic] both pass')).toHaveCount(0);

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

  // Regression guard: categories must come from the real `subcategory:` tag
  // (settable via SDK labels / JSON-CLI import's `subcategory` field / the
  // Test Case editor), not just scraped from a "[bracket]" in the name.
  // These names carry NO bracket tag at all — if the matrix fell back to
  // name-parsing only, every row would be `(uncategorized)` and the matrix
  // would never render.
  test('category matrix groups by the subcategory: tag when the name has no [bracket]', async ({ page }) => {
    const api = page.request;
    const RUN_TAG_A = 'eval-run-e2e-ins-tag-aaaaaa';
    const RUN_TAG_B = 'eval-run-e2e-ins-tag-bbbbbb';
    const TAG_CASES = [
      { tc: 'tc-e2e-ins-tag-001', name: 'q1 how long is the certification valid', subcategory: 'basic', a: 'passed' as const, b: 'passed' as const },
      { tc: 'tc-e2e-ins-tag-002', name: 'q2 what is the renewal process', subcategory: 'basic', a: 'passed' as const, b: 'passed' as const },
      { tc: 'tc-e2e-ins-tag-003', name: 'q3 who authored the runbook', subcategory: 'basic', a: 'failed' as const, b: 'passed' as const },
      { tc: 'tc-e2e-ins-tag-004', name: 'q4 explain the rollback procedure', subcategory: 'semantic', a: 'failed' as const, b: 'failed' as const },
      { tc: 'tc-e2e-ins-tag-005', name: 'q5 summarize the incident timeline', subcategory: 'semantic', a: 'passed' as const, b: 'failed' as const },
      { tc: 'tc-e2e-ins-tag-006', name: 'q6 contrast the two runbooks', subcategory: 'semantic', a: 'passed' as const, b: 'passed' as const },
    ];
    const createdReports: string[] = [];
    try {
      for (const c of TAG_CASES) {
        const r = await api.post('/api/storage/test-cases', {
          data: {
            id: c.tc,
            name: c.name,
            description: 'e2e insights (tag-based category)',
            labels: ['category:RAG', `subcategory:${c.subcategory}`],
            initialPrompt: 'q',
            expectedOutcomes: { conclusions: ['x'] },
            currentVersion: 1,
          },
        });
        expect(r.ok()).toBeTruthy();
      }
      for (const c of TAG_CASES) {
        for (const [which, runId] of [['a', RUN_TAG_A], ['b', RUN_TAG_B]] as const) {
          const id = `report-${runId}-${c.tc}`;
          const r = await api.post('/api/storage/runs', { data: reportDoc(id, c.tc, c[which]) });
          expect(r.ok()).toBeTruthy();
          createdReports.push(id);
        }
      }
      const resultsFor = (which: 'a' | 'b') =>
        Object.fromEntries(
          TAG_CASES.map(c => [
            c.tc,
            {
              reportId: `report-${which === 'a' ? RUN_TAG_A : RUN_TAG_B}-${c.tc}`,
              status: 'completed',
              passFailStatus: c[which],
            },
          ])
        );
      await api.put(`/api/storage/evaluation-runs/${RUN_TAG_A}`, {
        data: {
          id: RUN_TAG_A, docType: 'evaluation-run', name: 'E2E Tag Run A', createdAt: new Date().toISOString(),
          status: 'completed', agentKey: 'agent-tag-alpha', modelId: 'e2e-model', sources: [], trigger: 'api',
          testCaseSnapshots: TAG_CASES.map(c => ({ id: c.tc, version: 1, name: c.name })),
          results: resultsFor('a'), stats: { passed: 0, failed: 0, total: TAG_CASES.length },
        },
      });
      await api.put(`/api/storage/evaluation-runs/${RUN_TAG_B}`, {
        data: {
          id: RUN_TAG_B, docType: 'evaluation-run', name: 'E2E Tag Run B', createdAt: new Date().toISOString(),
          status: 'completed', agentKey: 'agent-tag-beta', modelId: 'e2e-model', sources: [], trigger: 'api',
          testCaseSnapshots: TAG_CASES.map(c => ({ id: c.tc, version: 1, name: c.name })),
          results: resultsFor('b'), stats: { passed: 0, failed: 0, total: TAG_CASES.length },
        },
      });

      await page.goto(`/compare?runs=${RUN_TAG_A},${RUN_TAG_B}`);
      await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
      await page.waitForSelector('[data-testid="comparison-insights-band"]', { timeout: 30000 });

      const matrix = page.getByTestId('insights-category-matrix');
      await expect(matrix).toBeVisible({ timeout: 15000 });
      await expect(matrix).toContainText('basic');
      await expect(matrix).toContainText('semantic');

      // Clicking the tag-derived category column filters the table to
      // exactly the 3 cases with that subcategory tag. (Not `exact: true` —
      // the button's accessible name gains a trailing ⚠ when this category
      // is flagged as the shared weakness.)
      // Scoped to `table` (the Table Compare grid) — same reasoning as the
      // sibling test above (PR #398's deep-dive panel renders a test-case
      // name in its own header outside any `<table>`, so an unscoped `text=`
      // locator can false-match there).
      const table = page.locator('table');
      await matrix.getByRole('button', { name: /^semantic/ }).click();
      await expect(table.getByText('q4 explain the rollback procedure').first()).toBeVisible();
      await expect(table.getByText('q5 summarize the incident timeline').first()).toBeVisible();
      await expect(table.getByText('q6 contrast the two runbooks').first()).toBeVisible();
      await expect(table.getByText('q1 how long is the certification valid')).toHaveCount(0);
    } finally {
      await api.delete(`/api/storage/evaluation-runs/${RUN_TAG_A}`).catch(() => {});
      await api.delete(`/api/storage/evaluation-runs/${RUN_TAG_B}`).catch(() => {});
      for (const id of createdReports) await api.delete(`/api/storage/runs/${id}`).catch(() => {});
      for (const c of TAG_CASES) await api.delete(`/api/storage/test-cases/${c.tc}`).catch(() => {});
    }
  });
});
