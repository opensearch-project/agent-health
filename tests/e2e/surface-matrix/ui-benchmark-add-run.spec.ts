/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · benchmark page → Add Run → completes → appears in Runs tab
 *
 * A REAL run from the browser (no mocked routes): the customer opens a
 * benchmark, clicks "Add Run", picks the REST agent, starts the run and sees
 * it finish. Pinned:
 *   - "Add Run" opens the Configure Run dialog with the agent selectable;
 *   - Start Run triggers the run; when it completes the Runs tab lists a row
 *     with the run's name, a passed count of N/N and no failed/errored state;
 *   - the same run is visible through the API as a completed, benchmark-
 *     associated evaluation run with every report judged.
 */

import { test, expect } from '../fixtures/test-fixtures';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { describeResolvedReports, listTerminalRunsForBenchmark, reportIdsOf, waitForReportsResolved } from '../../helpers/surfaceMatrix';
import { seedAgent, seedBenchmark, seedCases, selectRadixOption, type SeededAgent } from './helpers';

const CASES = 2;

test.describe('surface-matrix · UI · benchmark Add Run', () => {
  test.setTimeout(180_000);
  let seeded: SeededAgent;

  test.afterEach(async () => { await seeded?.agent.close(); });

  test('Add Run → Start Run → the completed run appears in the Runs tab and via the API', async ({ page, testData }) => {
    seeded = await seedAgent(testData);
    const cases = await seedCases(testData, 'ui-add-run', CASES);
    const bench = await seedBenchmark(testData, 'ui-add-run-bench', cases.map((c) => c.id));
    const runName = uniqueTestName('ui-add-run');

    await page.goto(`/evaluations/benchmarks/${bench.id}/runs`);
    await expect(page.locator('h2', { hasText: bench.name })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Add Run/ }).click();
    const dialog = page.getByTestId('run-config-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByTestId('run-config-name-input').fill(runName);
    await selectRadixOption(page, dialog.getByTestId('run-config-agent-trigger'), seeded.name);
    await expect(dialog.getByTestId('run-config-agent-trigger')).toContainText(seeded.name);
    await dialog.getByTestId('run-config-submit-btn').click();

    // The run row shows up in the Runs tab with N/N passed once complete.
    const row = page.getByTestId('run-row').filter({ hasText: runName });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByTestId('run-status-running')).toHaveCount(0, { timeout: 60_000 });
    await expect(row.getByTestId('run-status-failed')).toHaveCount(0);
    await expect(row.getByTestId('run-status-cancelled')).toHaveCount(0);
    await expect(row.getByTestId('run-passrate-cell')).toContainText('100%', { timeout: 30_000 });
    await expect(row.getByTestId('run-size-cell')).toContainText(String(CASES));

    // Same run through the API.
    const runs = await listTerminalRunsForBenchmark(bench.id);
    const run = runs.find((r) => r.name === runName);
    expect(run, 'the UI-started run is an evaluation-run doc').toBeDefined();
    testData.evaluationRun(run.id);
    for (const id of reportIdsOf(run)) testData.run(id);
    expect(run.status).toBe('completed');
    expect(run.benchmarkId).toBe(bench.id);
    expect(run.agentKey).toBe(seeded.key);
    expect(Object.keys(run.results)).toHaveLength(CASES);
    expect(describeResolvedReports(await waitForReportsResolved(reportIdsOf(run)), seeded.agent)).toEqual([]);
    expect(seeded.agent.invocations).toHaveLength(CASES);
  });
});
