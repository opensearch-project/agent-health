/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: with THREE runs selected the compare page header read "3 of N
 * runs" and the table compare showed three columns, but the scoreboard at the
 * top listed only rows A and B — the third run silently disappeared from pass
 * rate / avg duration / cost / tokens / calls / coverage. The component
 * hard-capped to `runs.slice(0, 2)`.
 *
 * Seeds three ad-hoc evaluation runs over the same two test cases (file
 * storage, no OpenSearch / AWS needed) with distinct pass rates and durations,
 * lands on `/compare?runs=a,b,c` and asserts the rendered scoreboard:
 *   - three lettered rows (A, B, C) with the third run's metrics present;
 *   - one Δ row per non-baseline run ("Δ A−B", "Δ A−C") with A-minus-run values;
 *   - the coverage cell says "in all 3";
 *   - the table compare below still shows all three run columns.
 * A two-run compare keeps its single "Delta" row (pinned in the second test).
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_A = `eval-run-e2e-nruns-a-${STAMP}`;
const RUN_B = `eval-run-e2e-nruns-b-${STAMP}`;
const RUN_C = `eval-run-e2e-nruns-c-${STAMP}`;
const TC_1 = `tc-e2e-nruns-1-${STAMP}`;
const TC_2 = `tc-e2e-nruns-2-${STAMP}`;

// The compare page orders rows by the run list order (createdAt desc), so each
// seeded run gets a distinct, descending timestamp: A newest → row A, etc.
function evalRunDoc(id: string, name: string, agentKey: string, verdicts: [string, string], avgDurationMs: number, ageMinutes: number) {
  return {
    id,
    docType: 'evaluation-run',
    name,
    createdAt: new Date(STAMP - ageMinutes * 60_000).toISOString(),
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [{ type: 'test-case-ids', ids: [TC_1, TC_2] }],
    trigger: 'api',
    testCaseSnapshots: [
      { id: TC_1, version: 1, name: 'E2E n-runs case 1' },
      { id: TC_2, version: 1, name: 'E2E n-runs case 2' },
    ],
    results: {
      [TC_1]: { reportId: `report-${id}-1`, status: 'completed', passFailStatus: verdicts[0] },
      [TC_2]: { reportId: `report-${id}-2`, status: 'completed', passFailStatus: verdicts[1] },
    },
    stats: {
      passed: verdicts.filter(v => v === 'passed').length,
      failed: verdicts.filter(v => v === 'failed').length,
      total: 2,
    },
    performanceMetrics: {
      durationMs: avgDurationMs * 2,
      concurrency: 1,
      avgTestCaseDurationMs: avgDurationMs,
      maxTestCaseDurationMs: avgDurationMs,
      minTestCaseDurationMs: avgDurationMs,
    },
  };
}

test.describe('Comparison scoreboard — every selected run gets a row', () => {
  test('three runs: three scoreboard rows, a Δ row per run vs A, three table columns', async ({ page }) => {
    const api = page.request;
    try {
      // A 100% / B 50% / C 0% pass rate; A fastest, C slowest.
      const docs = [
        evalRunDoc(RUN_A, 'E2E N-runs A', 'agent-alpha', ['passed', 'passed'], 1000, 0),
        evalRunDoc(RUN_B, 'E2E N-runs B', 'agent-beta', ['passed', 'failed'], 2000, 10),
        evalRunDoc(RUN_C, 'E2E N-runs C', 'agent-gamma', ['failed', 'failed'], 3000, 20),
      ];
      for (const doc of docs) {
        const res = await api.put(`/api/storage/evaluation-runs/${doc.id}`, { data: doc });
        expect(res.ok()).toBeTruthy();
      }

      await page.goto(`/compare?runs=${RUN_A},${RUN_B},${RUN_C}`);
      await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
      const board = page.locator('[data-testid="comparison-scoreboard"]');
      await expect(board).toBeVisible({ timeout: 30000 });

      // Header agrees that three runs are selected …
      await expect(page.locator('[data-testid="comparison-search"]')).toContainText(/^3 of \d+ runs/);

      // … and so does the scoreboard: A, B AND C rows, no fourth.
      await expect(board.locator('[data-testid="scoreboard-row-A"]')).toBeVisible();
      await expect(board.locator('[data-testid="scoreboard-row-B"]')).toBeVisible();
      await expect(board.locator('[data-testid="scoreboard-row-C"]')).toBeVisible();
      await expect(board.locator('[data-testid^="scoreboard-row-"]')).toHaveCount(3);
      await expect(board.locator('[data-testid="scoreboard-row-A"]')).toContainText('E2E N-runs A');
      await expect(board.locator('[data-testid="scoreboard-row-B"]')).toContainText('E2E N-runs B');
      await expect(board.locator('[data-testid="scoreboard-row-C"]')).toContainText('E2E N-runs C');
      await expect(board.locator(`[data-testid="run-passrate-${RUN_C}"]`)).toHaveText('0%');
      await expect(board.locator(`[data-testid="run-duration-${RUN_C}"]`)).not.toHaveText('--');

      // One Δ row per compared run, each "A minus that run".
      await expect(board.locator('[data-testid="scoreboard-delta-row-B"]')).toBeVisible();
      await expect(board.locator('[data-testid="scoreboard-delta-row-C"]')).toBeVisible();
      await expect(board.locator('[data-testid="scoreboard-delta-label"]')).toHaveText('Δ A−B');
      await expect(board.locator('[data-testid="scoreboard-delta-label-C"]')).toHaveText('Δ A−C');
      await expect(board.locator('[data-testid="scoreboard-delta-passrate"]')).toHaveText('+50pp');
      await expect(board.locator('[data-testid="scoreboard-delta-passrate-C"]')).toHaveText('+100pp');
      // A is faster than C → negative duration Δ → green (improvement).
      const durC = board.locator('[data-testid="scoreboard-delta-duration-C"]');
      await expect(durC).toHaveText(/^-/);
      await expect(durC).toHaveClass(/text-green-400/);

      // Coverage wording for three runs.
      await expect(board.locator('[data-testid="comparison-overlap-banner"]')).toContainText('2 in all 3');

      // The table compare below still has all three run columns.
      for (const id of [RUN_A, RUN_B, RUN_C]) {
        await expect(page.locator(`[data-testid="case-table-run-link-${id}"]`)).toBeVisible();
      }
    } finally {
      for (const id of [RUN_A, RUN_B, RUN_C]) {
        await api.delete(`/api/storage/evaluation-runs/${id}`).catch(() => {});
      }
    }
  });

  test('two runs: the single "Delta" row and "in both" wording are unchanged', async ({ page }) => {
    const api = page.request;
    const runA = `${RUN_A}-pair`;
    const runB = `${RUN_B}-pair`;
    try {
      for (const doc of [
        evalRunDoc(runA, 'E2E pair A', 'agent-alpha', ['passed', 'passed'], 1000, 0),
        evalRunDoc(runB, 'E2E pair B', 'agent-beta', ['passed', 'failed'], 2000, 10),
      ]) {
        const res = await api.put(`/api/storage/evaluation-runs/${doc.id}`, { data: doc });
        expect(res.ok()).toBeTruthy();
      }

      await page.goto(`/compare?runs=${runA},${runB}`);
      const board = page.locator('[data-testid="comparison-scoreboard"]');
      await expect(board).toBeVisible({ timeout: 30000 });
      await expect(board.locator('[data-testid^="scoreboard-row-"]')).toHaveCount(2);
      await expect(board.locator('[data-testid="scoreboard-delta-label"]')).toHaveText('Delta');
      await expect(board.locator('[data-testid^="scoreboard-delta-row-"]')).toHaveCount(1);
      await expect(board.locator('[data-testid="scoreboard-delta-passrate"]')).toHaveText('+50pp');
      await expect(board.locator('[data-testid="comparison-overlap-banner"]')).toContainText('2 in both');
    } finally {
      for (const id of [runA, runB]) {
        await api.delete(`/api/storage/evaluation-runs/${id}`).catch(() => {});
      }
    }
  });
});
