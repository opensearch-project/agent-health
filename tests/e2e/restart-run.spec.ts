// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * E2E: "Re-run" restarts any run by opening the New-Run composer pre-filled
 * from the source run's stored config (sources, agent, evaluator, judge model,
 * benchmark). The agent's model is resolved from the agent config (there is no
 * agent-model picker).
 *
 * Runs against a backend that actually has the run (e.g. ah-main). Set
 * AH_DEMO_RUN to a known eval-run id; otherwise it discovers the first run row
 * on /evaluations/runs and skips gracefully if there are none.
 */
import { test, expect } from './fixtures/test-fixtures';

test.describe('Re-run (restart any run)', () => {
  test('Re-run opens the composer pre-filled from the source run', async ({ page }) => {
    const demoRun = process.env.AH_DEMO_RUN;

    if (demoRun) {
      await page.goto(`/evaluations/runs/${demoRun}`);
    } else {
      // Discover a run from the list; skip if the backend has none.
      await page.goto('/evaluations/runs');
      await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
      const firstRow = page.locator('[data-testid^="run-row-"], a[href*="/evaluations/runs/"]').first();
      if ((await firstRow.count()) === 0) {
        test.skip(true, 'no runs in this backend to re-run');
        return;
      }
      await firstRow.click();
    }

    // The Re-run button is present for any non-running run.
    const rerun = page.locator('[data-testid="rerun-run-btn"]');
    await expect(rerun).toBeVisible({ timeout: 30000 });
    await rerun.click();

    // Lands on the New-Run composer, pre-filled: run name starts "Re-run:".
    await expect(page).toHaveURL(/\/evaluations\/runs\/new$/);
    await expect(page.locator('input[placeholder="My evaluation run"]')).toHaveValue(/^Re-run:/, { timeout: 10000 });

    // There is NO agent-model picker in the composer (agent owns its model).
    await expect(page.getByText('Agent Model', { exact: true })).toHaveCount(0);
  });
});
