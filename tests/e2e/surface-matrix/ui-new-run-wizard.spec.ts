/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · New Run wizard → ad-hoc run (no benchmark) → run detail
 *
 * The UI's ad-hoc path (the "Quick Run" prompt modal is only reachable from a
 * test case; a benchmark-free run of chosen cases goes through the New Run
 * wizard). Pinned:
 *   - `/evaluations/runs/new`: tick a test case → "Add 1 selected" → "Next:
 *     Configure" → pick the REST agent + the Demo Model judge, keep
 *     "None (ad-hoc run)" → "Launch Run";
 *   - the wizard navigates to `/evaluations/runs/<id>`; the run completes
 *     there (no running badge, a Completed status, N/N verdicts) and via the
 *     API it is an ad-hoc evaluation run (no `benchmarkId`) with every report
 *     judged.
 */

import { test, expect } from '../fixtures/test-fixtures';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { describeResolvedReports, reportIdsOf, waitForReportsResolved, waitForTerminalRun } from '../../helpers/surfaceMatrix';
import { seedAgent, seedCases, selectRadixOption, type SeededAgent } from './helpers';

test.describe('surface-matrix · UI · New Run wizard (ad hoc)', () => {
  test.setTimeout(180_000);
  let seeded: SeededAgent;

  test.afterEach(async () => { await seeded?.agent.close(); });

  test('wizard → Launch Run → run detail shows the completed ad-hoc run', async ({ page, testData }) => {
    seeded = await seedAgent(testData);
    const [tc] = await seedCases(testData, 'ui-wizard', 1);
    const runName = uniqueTestName('ui-wizard-run');

    await page.goto('/evaluations/runs/new');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    const caseRow = page.locator('label').filter({ hasText: tc.name });
    await expect(caseRow).toBeVisible({ timeout: 30_000 });
    await caseRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Add 1 selected/ }).click();
    await expect(page.getByText('Selected Sources (1)')).toBeVisible();
    await page.getByRole('button', { name: /Next: Configure/ }).click();

    await page.getByPlaceholder('My evaluation run').fill(runName);
    const combos = page.getByRole('combobox');
    await selectRadixOption(page, combos.nth(0), seeded.name); // Agent
    await selectRadixOption(page, combos.filter({ hasText: 'Use evaluator default' }), 'Demo Model'); // Judge
    await expect(page.getByRole('combobox').filter({ hasText: 'None (ad-hoc run)' })).toBeVisible();
    await page.getByRole('button', { name: /Launch Run/ }).click();

    await expect(page).toHaveURL(/\/evaluations\/runs\/eval-run-[^/]+$/, { timeout: 30_000 });
    const runId = /\/evaluations\/runs\/(eval-run-[^/?#]+)/.exec(page.url())![1];
    testData.evaluationRun(runId);

    const run = await waitForTerminalRun(runId);
    for (const id of reportIdsOf(run)) testData.run(id);
    expect(run.status).toBe('completed');
    expect(run.benchmarkId).toBeFalsy();
    expect(run.name).toBe(runName);
    expect(run.agentKey).toBe(seeded.key);
    expect(Object.keys(run.results)).toEqual([tc.id]);
    expect(describeResolvedReports(await waitForReportsResolved(reportIdsOf(run)), seeded.agent)).toEqual([]);

    // The detail page reflects completion.
    await expect(page.getByText(runName).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('run-row-status-running')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(/^Completed$/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(tc.name).first()).toBeVisible();
  });
});
