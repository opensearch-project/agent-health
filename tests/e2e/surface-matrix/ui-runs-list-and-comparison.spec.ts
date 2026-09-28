/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · Evaluation Runs list + comparison of two runs
 *
 * Two REAL completed runs (two REST agents, same benchmark), pinned:
 *   - `/evaluations/runs` lists both runs (searchable by name) with a
 *     completed status (no running/failed/cancelled badge) and their judge;
 *   - `/compare?runs=<a>,<b>` renders the comparison scoreboard with both run
 *     names, a pass-rate cell per run (100%) and NOT the "select a benchmark"
 *     empty state.
 */

import { test, expect } from '../fixtures/test-fixtures';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { seedAgent, seedBenchmark, seedCases, seedCompletedRun, type SeededAgent } from './helpers';

const CASES = 2;

test.describe('surface-matrix · UI · runs list + comparison', () => {
  test.setTimeout(180_000);
  const agents: SeededAgent[] = [];

  test.afterEach(async () => { for (const a of agents.splice(0)) await a.agent.close(); });

  test('two completed runs are listed on Evaluation Runs and compare on the scoreboard', async ({ page, testData }) => {
    const a = await seedAgent(testData);
    const b = await seedAgent(testData);
    agents.push(a, b);
    const cases = await seedCases(testData, 'ui-compare', CASES);
    const bench = await seedBenchmark(testData, 'ui-compare-bench', cases.map((c) => c.id));
    const nameA = uniqueTestName('ui-compare-run-a');
    const nameB = uniqueTestName('ui-compare-run-b');
    const { run: runA } = await seedCompletedRun(testData, { agentKey: a.key, benchmarkId: bench.id, name: nameA });
    const { run: runB } = await seedCompletedRun(testData, { agentKey: b.key, benchmarkId: bench.id, name: nameB });

    // ── Runs list ──────────────────────────────────────────────────────────
    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    for (const [name, run] of [[nameA, runA], [nameB, runB]] as const) {
      await page.getByPlaceholder('Search runs...').fill(name);
      const row = page.getByTestId('run-row').filter({ hasText: name });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      for (const bad of ['run-row-status-running', 'run-row-status-failed', 'run-row-status-cancelled', 'run-row-errored-badge']) {
        await expect(row.getByTestId(bad)).toHaveCount(0);
      }
      await expect(row.getByTestId('run-judge-cell')).toContainText('Demo Model');
      await expect(row.getByTestId(`run-actions-menu-trigger-${run.id}`)).toBeVisible();
    }

    // ── Comparison ─────────────────────────────────────────────────────────
    await page.goto(`/compare?runs=${runA.id},${runB.id}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30_000 });
    await expect(page.getByText('Select a benchmark to start comparing runs')).toHaveCount(0);
    const scoreboard = page.getByTestId('comparison-scoreboard').first();
    await expect(scoreboard).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(nameA).first()).toBeVisible();
    await expect(page.getByText(nameB).first()).toBeVisible();
    await expect(page.getByTestId(`run-passrate-${runA.id}`)).toContainText('100%');
    await expect(page.getByTestId(`run-passrate-${runB.id}`)).toContainText('100%');
  });
});
