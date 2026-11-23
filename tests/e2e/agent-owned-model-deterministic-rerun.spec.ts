/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E — three papercuts from evaluating agents that own their model with
 * deterministic (code-SDK) cases:
 *
 *  1. The Evaluation Runs list's Model column shows the model OBSERVED from the
 *     agent's traces (`<provider> · <model>`, `modelSource: 'observed'`) and
 *     `—` for a run whose agent reported none — never a catalog placeholder.
 *     The run report header says the model was observed from traces.
 *  2. Re-run of an all-deterministic run (`judgeProvider: 'none'`): the
 *     Evaluator and Judge Model pickers are disabled and empty ("Not used")
 *     with a one-line note; a mixed code-SDK run keeps them enabled and says
 *     they apply per case.
 *
 * Seeds its own runs via the storage API (PUT upserts) with synthetic names
 * and cleans them up through the tracker.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const OBSERVED_MODEL = 'example-model-v1';
const OBSERVED_LABEL = 'example-provider · example-model-v1';

test.describe('Agent-owned model (observed from traces) + deterministic re-run dialog', () => {
  const tracker = createTestDataTracker();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const observedRunId = `e2e-owned-model-observed-${tag}`;
  const blankRunId = `e2e-owned-model-blank-${tag}`;
  const deterministicRunId = `e2e-owned-model-det-${tag}`;
  const mixedRunId = `e2e-owned-model-mixed-${tag}`;
  const names = {
    observed: uniqueTestName('Search service run (observed model)'),
    blank: uniqueTestName('Search service run (no spans)'),
    deterministic: uniqueTestName('Retrieval checks (deterministic)'),
    mixed: uniqueTestName('Retrieval checks (mixed)'),
  };
  let seeded = false;

  async function seed(request: any, id: string, run: Record<string, unknown>) {
    const res = await request.put(`/api/storage/evaluation-runs/${id}`, {
      data: {
        status: 'completed', agentKey: 'demo', trigger: 'api', results: {}, createdAt: new Date().toISOString(),
        testCaseSnapshots: [{ id: 'tc-a', version: 1, name: 'case a' }, { id: 'tc-b', version: 1, name: 'case b' }],
        ...run, id,
      },
    });
    tracker.evaluationRun(id);
    return res.ok();
  }

  test.beforeAll(async ({ request }) => {
    const codeSources = [{ type: 'code-import', filenames: ['evals/retrieval.eval.ts'], testCaseIds: ['tc-a', 'tc-b'] }];
    const ok = await Promise.all([
      seed(request, observedRunId, { name: names.observed, sources: codeSources, modelId: OBSERVED_MODEL, modelName: OBSERVED_LABEL, modelSource: 'observed', judgeProvider: 'none' }),
      seed(request, blankRunId, { name: names.blank, sources: codeSources, judgeProvider: 'none' }),
      seed(request, deterministicRunId, { name: names.deterministic, sources: codeSources, judgeProvider: 'none' }),
      seed(request, mixedRunId, { name: names.mixed, sources: codeSources, judgeProvider: 'bedrock', judgeModelId: 'claude-sonnet-4.6', evaluatorId: 'system-rca-default' }),
    ]);
    seeded = ok.every(Boolean);
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  test('runs list: Model column shows the observed `provider · model`, and `—` when the agent reported none', async ({ page }) => {
    test.skip(!seeded, 'Could not seed runs (storage not configured?)');
    await page.goto('/evaluations/runs');
    await page.getByPlaceholder('Search runs...').fill(`e2e-owned-model-`);
    const rows = page.getByTestId('run-row');
    await expect(rows.filter({ hasText: names.observed })).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: names.observed }).getByTestId('run-row-model')).toHaveText(OBSERVED_LABEL);
    await expect(rows.filter({ hasText: names.blank }).getByTestId('run-row-model')).toHaveText('—');
    // The catalog placeholder never shows up for an agent-owned model.
    await expect(page.locator('body')).not.toContainText('mock://demo-model');
  });

  test('run report header names the observed model and says where it came from', async ({ page }) => {
    test.skip(!seeded, 'Could not seed runs (storage not configured?)');
    await page.goto(`/evaluations/runs/${observedRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(OBSERVED_LABEL, { timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText('Demo Model');
  });

  test('re-run of an all-deterministic run: evaluator + judge pickers disabled and empty, one-line note', async ({ page }) => {
    test.skip(!seeded, 'Could not seed runs (storage not configured?)');
    await page.goto(`/evaluations/runs/${deterministicRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${deterministicRunId}"]`).click();
    await page.locator(`[data-testid="run-action-rerun-${deterministicRunId}"]`).click();

    const dialog = page.locator('[data-testid="run-config-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const evaluator = page.locator('[data-testid="run-config-evaluator-trigger"]');
    await expect(evaluator).toBeDisabled();
    await expect(evaluator).toContainText('Not used');
    await expect(evaluator).not.toContainText('RCA Default');
    // The judge picker is the sibling Radix trigger in the same grid.
    const judge = dialog.locator('button[role="combobox"]').filter({ hasText: 'Not used' }).nth(1);
    await expect(judge).toBeDisabled();
    const note = page.locator('[data-testid="run-config-judge-applicability"]');
    await expect(note).toHaveAttribute('data-applicability', 'none');
    await expect(note).toContainText('Every case is deterministic');
    // Still a plain duplicate: Re-run enabled, nothing flagged as modified.
    await expect(page.locator('[data-testid="run-config-submit-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="run-config-modified-hint"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('re-run of a mixed code-SDK run: pickers enabled, note says evaluator/judge apply per case', async ({ page }) => {
    test.skip(!seeded, 'Could not seed runs (storage not configured?)');
    await page.goto(`/evaluations/runs/${mixedRunId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${mixedRunId}"]`).click();
    await page.locator(`[data-testid="run-action-rerun-${mixedRunId}"]`).click();

    const dialog = page.locator('[data-testid="run-config-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="run-config-evaluator-trigger"]')).toBeEnabled();
    await expect(dialog).toContainText('Claude Sonnet 4.6');
    const note = page.locator('[data-testid="run-config-judge-applicability"]');
    await expect(note).toHaveAttribute('data-applicability', 'per-case');
    await expect(note).toContainText('per case');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });
});
