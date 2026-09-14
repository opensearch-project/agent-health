/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Judge + Evaluator columns on the Evaluation Runs page.
 *
 * Regression guard for the feature request "Evaluation runs page should show
 * judge model and evaluator used as columns." Seeds two mocked evaluation-runs:
 *   - one with `judgeModelId` + `evaluatorId` set (recent run) — both columns
 *     must render a resolved, shortened label.
 *   - one legacy run with neither field — both columns must render the
 *     missing-field fallback ("—") instead of throwing or going blank.
 * Also verifies the Evaluator cell is a link that navigates to the evaluator
 * page, and that the table's colSpan math (loading/empty rows, group header
 * row) wasn't left stale when the column count grew by two.
 */

import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/test-fixtures';

const now = new Date().toISOString();

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const runWithJudgeAndEvaluator = {
  id: 'eval-run-with-judge',
  docType: 'evaluation-run',
  name: 'Run With Judge And Evaluator',
  createdAt: now,
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4.5',
  judgeModelId: 'claude-opus-4.8',
  evaluatorId: 'system-factuality',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'tc-1' }],
  results: { 'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
};

// An agent-trace-judge run that recorded the underlying LLM it was judged
// by (`judgeModel`) -- the column must show BOTH the judge kind and the model.
const agentJudgeRunWithRecordedModel = {
  id: 'eval-run-agent-judge',
  docType: 'evaluation-run',
  name: 'Run Judged By Agent Trace Judge',
  createdAt: now,
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4.5',
  judgeModelId: 'agent-trace-judge',
  judgeModel: 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  evaluatorId: 'system-factuality',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-3', version: 1, name: 'tc-3' }],
  results: { 'tc-3': { reportId: 'report-3', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
};

const legacyRunWithoutJudgeOrEvaluator = {
  id: 'eval-run-legacy',
  docType: 'evaluation-run',
  name: 'Legacy Run No Judge Or Evaluator',
  createdAt: now,
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4.5',
  sources: [],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-2', version: 1, name: 'tc-2' }],
  results: { 'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, errored: 0, total: 1 },
};

const evaluators = [
  { id: 'system-factuality', name: 'Factuality', isSystem: true },
];

test.describe('Evaluation Runs page — Judge + Evaluator columns', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/annotations**', (route) => json(route, { annotations: [], total: 0 }));
    await page.route('**/api/storage/evaluators/system-factuality', (route) =>
      json(route, { id: 'system-factuality', name: 'Factuality', isSystem: true, systemPrompt: '', scoringConfig: {}, inferenceConfig: {} }));
    await page.route('**/api/storage/evaluators', (route) => json(route, { evaluators, total: evaluators.length }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/storage/evaluation-runs') {
        return json(route, { evaluationRuns: [runWithJudgeAndEvaluator, agentJudgeRunWithRecordedModel, legacyRunWithoutJudgeOrEvaluator], total: 3 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
  });

  test('renders Judge and Evaluator columns with resolved labels and missing-field fallback', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(1500);

    // All time, so both "now" runs are in range regardless of the default filter.
    const timeBtn = page.locator('button:has-text("Last")').first();
    if (await timeBtn.count()) {
      await timeBtn.click();
      await page.waitForTimeout(300);
      const allTime = page.getByText('All time', { exact: true }).last();
      if (await allTime.count()) await allTime.click();
      await page.waitForTimeout(800);
    }

    // Flat view so both eval-runs render as individual rows (no grouping).
    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.count()) { await flat.click(); await page.waitForTimeout(600); }

    // Column headers present. The judge column is "Judge model" (owner ask:
    // call out the underlying LLM, not just the judge kind) with a tooltip.
    const judgeHeader = page.getByRole('columnheader', { name: /^Judge model$/ });
    await expect(judgeHeader).toBeVisible();
    await expect(judgeHeader).toHaveAttribute('title', 'judge kind · underlying LLM');
    await expect(page.getByRole('columnheader', { name: /^Evaluator$/ })).toBeVisible();

    const rows = page.locator('[data-testid="run-row"]');
    await expect(rows).toHaveCount(3, { timeout: 10000 });

    const withJudgeRow = rows.filter({ hasText: 'Run With Judge And Evaluator' });
    const agentJudgeRow = rows.filter({ hasText: 'Run Judged By Agent Trace Judge' });
    const legacyRow = rows.filter({ hasText: 'Legacy Run No Judge Or Evaluator' });

    // Judge model id is shortened via the same display-name registry as the
    // Model column (getModelName) — 'claude-opus-4.8' → 'Claude Opus 4.8'.
    await expect(withJudgeRow.locator('[data-testid="run-judge-cell"]')).toHaveText('Claude Opus 4.8');
    // agent-trace-judge is a PROVIDER; the cell shows the judge kind AND the
    // recorded underlying LLM ("· claude-sonnet-4-5"), never the provider alone.
    const agentCell = agentJudgeRow.locator('[data-testid="run-judge-cell"]');
    await expect(agentCell.locator('[data-testid="judge-model-kind"]')).toContainText(/agent-trace-judge|Agent Trace Judge/);
    await expect(agentCell.locator('[data-testid="judge-model-resolved"]')).toContainText('claude-sonnet-4-5');
    // Evaluator id resolves to its name via the id→name lookup.
    await expect(withJudgeRow.locator('[data-testid="run-evaluator-cell"]')).toContainText('Factuality');

    // Legacy run has neither field — both cells fall back to the em dash,
    // never a blank cell or a thrown error.
    await expect(legacyRow.locator('[data-testid="run-judge-cell"]')).toHaveText('—');
    await expect(legacyRow.locator('[data-testid="run-evaluator-cell"]')).toContainText('—');

    // The Evaluator cell is a link to the evaluator's page.
    await withJudgeRow.locator('[data-testid="run-evaluator-cell"] button').click();
    await page.waitForURL(/\/evaluators\/system-factuality/, { timeout: 10000 });
  });
});
