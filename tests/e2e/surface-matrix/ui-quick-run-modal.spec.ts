/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · Quick Run modal (Test Cases list → ▶ Run) → report renders
 *
 * The one-click "run this case now" modal, driven for real against a plain
 * (non-traced) REST agent so the verdict is immediate. Pinned:
 *   - the ▶ button on a test-case row opens "Run: <name>" with an Agent and a
 *     Judge Model select (the built-in Demo Model is offered);
 *   - Run streams the evaluation and the modal renders the report: a
 *     PASSED/FAILED badge (never ERRORED/PENDING), a Score and the Trajectory;
 *   - the report is persisted under the test case (API).
 */

import { test, expect } from '../fixtures/test-fixtures';
import { api, settleStorage } from '../../helpers/surfaceMatrix';
import { seedAgent, seedCases, selectRadixOption, type SeededAgent } from './helpers';

test.describe('surface-matrix · UI · Quick Run modal', () => {
  test.setTimeout(180_000);
  let seeded: SeededAgent;

  test.afterEach(async () => { await seeded?.agent.close(); });

  test('▶ Run on a test case → modal → Run → PASSED/FAILED report with trajectory', async ({ page, testData }) => {
    seeded = await seedAgent(testData, { useTraces: false });
    const [tc] = await seedCases(testData, 'ui-quick-run', 1);

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });
    await page.getByTestId('test-cases-page').getByPlaceholder('Search', { exact: true }).fill(tc.name);
    const row = page.locator('tr').filter({ hasText: tc.name });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.hover();
    await row.getByTestId('test-case-run-button').click();

    await expect(page.getByText(`Run: ${tc.name}`)).toBeVisible({ timeout: 10_000 });
    await selectRadixOption(page, page.getByTestId('quickrun-agent-select'), seeded.name);
    // Judge Model: pick the built-in Demo Model explicitly (the default —
    // "Use evaluator default" — is the server's Bedrock judge, which needs
    // credentials; a customer without them picks a judge here).
    await selectRadixOption(page, page.getByRole('combobox').filter({ hasText: 'Use evaluator default' }), 'Demo Model');
    // The modal's Run button (the row's ▶ icon button has no text).
    await page.getByText('Run', { exact: true }).click();

    const verdict = page.getByText(/^(PASSED|FAILED)$/);
    await expect(verdict).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('ERRORED')).toHaveCount(0);
    await expect(page.getByText(/^Score: \d+%$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Trajectory' })).toBeVisible();

    await settleStorage();
    const { runs } = await api<{ runs: any[] }>('GET', `/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}`);
    for (const r of runs) testData.run(r.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', agentKey: seeded.key });
    expect(['passed', 'failed']).toContain(runs[0].passFailStatus);
    expect(seeded.agent.invocations).toHaveLength(1);
  });
});
