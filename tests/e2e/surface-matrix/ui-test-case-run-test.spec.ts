/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · test case page → Run Test → run history grows
 *
 * A REAL single-case run from the Test Case detail page against the REST
 * agent (no mocked routes). Pinned:
 *   - "Run Test" opens the Configure Run dialog; the REST agent is selectable;
 *   - Start Run executes inline; the header's "Running…" pill clears;
 *   - the Run history badge goes from "0 runs" to "1 run" and the new run's
 *     name is listed; opening it renders the inspector tabs (Test Case
 *     Output / Traces / Judge Evaluation);
 *   - the report exists via `GET /api/storage/runs/by-test-case/:id` with a
 *     verdict and resolved trace metrics.
 */

import { test, expect } from '../fixtures/test-fixtures';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { api, describeResolvedReports, settleStorage, waitForReportsResolved } from '../../helpers/surfaceMatrix';
import { seedAgent, seedCases, selectRadixOption, type SeededAgent } from './helpers';

test.describe('surface-matrix · UI · test case Run Test', () => {
  test.setTimeout(180_000);
  let seeded: SeededAgent;

  test.afterEach(async () => { await seeded?.agent.close(); });

  test('Run Test → Start Run → Run history shows the new run; report is judged', async ({ page, testData }) => {
    seeded = await seedAgent(testData);
    const [tc] = await seedCases(testData, 'ui-run-test', 1);
    const runName = uniqueTestName('ui-run-test');

    await page.goto(`/evaluations/test-cases/${tc.id}`);
    await expect(page.getByRole('heading', { level: 2 })).toContainText(tc.name, { timeout: 30_000 });
    const historyToggle = page.getByRole('button', { name: /Run history/i });
    await expect(historyToggle).toContainText('0 runs');

    await page.getByRole('button', { name: /^run test$/i }).first().click();
    await expect(page.getByText('Configure Run', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByLabel(/run name/i).fill(runName);
    // The agent select is the first combobox in the dialog (Agent → Evaluator → Judge Model).
    const dialog = page.locator('div.fixed').filter({ hasText: 'Configure Run' });
    await selectRadixOption(page, dialog.getByRole('combobox').first(), seeded.name);
    await page.getByRole('button', { name: /^start run$/i }).click();

    // Inline running state clears, history grows to 1.
    await expect(page.getByRole('button', { name: /^run test$/i }).first()).toBeEnabled({ timeout: 60_000 });
    await expect(historyToggle).toContainText('1 run', { timeout: 60_000 });
    if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') await historyToggle.click();
    await expect(page.getByText(runName).first()).toBeVisible({ timeout: 15_000 });
    await page.getByText(runName).first().click();
    for (const tab of [/^Test Case Output/, /^Traces$/, /^Judge Evaluation$/]) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible({ timeout: 15_000 });
    }

    // API view of the same report.
    await settleStorage();
    const { runs } = await api<{ runs: any[] }>('GET', `/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}`);
    const mine = runs.filter((r) => r.name === runName);
    for (const r of runs) testData.run(r.id);
    expect(mine).toHaveLength(1);
    const [report] = await waitForReportsResolved([mine[0].id]);
    expect(report.agentKey).toBe(seeded.key);
    expect(describeResolvedReports([report], seeded.agent)).toEqual([]);
    expect(seeded.agent.invocations).toHaveLength(1);
  });
});
