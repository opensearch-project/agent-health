/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression for the owner papercut (2026-09-04): terminal runs with partial
 * results rendered misleadingly on the runs list.
 *
 *   S1 — status 'cancelled' at 34/62: a "Cancelled" badge next to a pending
 *        spinner and "/28 ⟳" — the never-started remainder was bucketed as
 *        `pending` regardless of the run's TERMINAL status
 *        (lib/runStats.bucketRunResults).
 *   S2 — status 'failed' at 37/62 (executor crashed on a storage race): same
 *        phantom "25 ⟳".
 *
 * Fixed: terminal-aware bucketing (`notRun`), explicit `status: 'cancelled'`
 * markers for never-started cases, and a Cancelled/Failed badge + "n not run"
 * annotation on the row, with NO spinner. Hits the real backend — the run
 * docs are seeded via PUT (no execution), exactly the persisted shapes the
 * live cluster showed.
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const CANCELLED_ID = `eval-run-e2e-cancelled-partial-${STAMP}`;
const CANCELLED_NAME = `E2E Cancelled Partial ${STAMP}`;
const CANCELLED_MARKERS_ID = `eval-run-e2e-cancelled-markers-${STAMP}`;
const CANCELLED_MARKERS_NAME = `E2E Cancelled Markers ${STAMP}`;
const FAILED_ID = `eval-run-e2e-failed-partial-${STAMP}`;
const FAILED_NAME = `E2E Failed Partial ${STAMP}`;

const PLANNED = 62;
const snapshots = Array.from({ length: PLANNED }, (_, i) => ({ id: `tc-${STAMP}-${i}`, version: 1, name: `tc-${i}` }));

function baseDoc(id: string, name: string, status: string) {
  return {
    id, name, status,
    docType: 'evaluation-run',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
    agentKey: 'agent-alpha', modelId: 'e2e-model',
    sources: [], trigger: 'api',
    testCaseSnapshots: snapshots,
  };
}

/** S1: 34 executed (17 passed / 17 failed), 28 never started and ABSENT from results. */
function cancelledPartialDoc() {
  const results: Record<string, unknown> = {};
  for (let i = 0; i < 34; i++) {
    results[snapshots[i].id] = { reportId: `report-${CANCELLED_ID}-${i}`, status: 'completed', passFailStatus: i % 2 === 0 ? 'passed' : 'failed' };
  }
  return { ...baseDoc(CANCELLED_ID, CANCELLED_NAME, 'cancelled'), results };
}

/** Same as S1 but with the new explicit `cancelled` markers for the 28 never-started cases. */
function cancelledWithMarkersDoc() {
  const results: Record<string, unknown> = {};
  for (let i = 0; i < 34; i++) {
    results[snapshots[i].id] = { reportId: `report-${CANCELLED_MARKERS_ID}-${i}`, status: 'completed', passFailStatus: i % 2 === 0 ? 'passed' : 'failed' };
  }
  for (let i = 34; i < PLANNED; i++) results[snapshots[i].id] = { reportId: '', status: 'cancelled' };
  return { ...baseDoc(CANCELLED_MARKERS_ID, CANCELLED_MARKERS_NAME, 'cancelled'), results };
}

/** S2: 37 executed (32 without verdict, 5 execution failures), run failed. */
function failedPartialDoc() {
  const results: Record<string, unknown> = {};
  for (let i = 0; i < 32; i++) results[snapshots[i].id] = { reportId: `report-${FAILED_ID}-${i}`, status: 'completed' };
  for (let i = 32; i < 37; i++) results[snapshots[i].id] = { reportId: `report-${FAILED_ID}-${i}`, status: 'failed', error: 'Evaluation error: storage write conflict' };
  return { ...baseDoc(FAILED_ID, FAILED_NAME, 'failed'), results, error: 'storage write conflict' };
}

test.describe('Evaluation Runs page — terminal runs with partial results (no phantom pending)', () => {
  test.beforeAll(async ({ request }) => {
    for (const doc of [cancelledPartialDoc(), cancelledWithMarkersDoc(), failedPartialDoc()]) {
      const r = await request.put(`/api/storage/evaluation-runs/${doc.id}`, { data: doc });
      expect(r.ok()).toBeTruthy();
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of [CANCELLED_ID, CANCELLED_MARKERS_ID, FAILED_ID]) {
      await request.delete(`/api/storage/evaluation-runs/${id}`).catch(() => {});
    }
  });

  async function findRow(page: import('@playwright/test').Page, name: string) {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const search = page.locator('input[placeholder*="Search" i]').first();
    if (await search.isVisible({ timeout: 2000 }).catch(() => false)) await search.fill(name);
    const row = page.locator('[data-testid="run-row"]', { hasText: name });
    await expect(row).toBeVisible({ timeout: 15000 });
    return row;
  }

  test('S1 cancelled run (34/62, never-started cases absent): Cancelled badge, "28 not run", planned total, NO spinner', async ({ page }) => {
    const row = await findRow(page, CANCELLED_NAME);

    await expect(row.locator('[data-testid="run-row-status-cancelled"]')).toBeVisible();
    await expect(row.locator('[data-testid="run-row-status-running"]')).toHaveCount(0);
    await expect(row.locator('.animate-spin')).toHaveCount(0);
    await expect(row.locator('[data-testid="run-row-not-run"]')).toContainText('28 not run');
    await expect(row).toContainText('17');
    await expect(row).toContainText(String(PLANNED));
  });

  test('cancelled run with explicit `cancelled` markers renders identically (markers are not failures, not pending)', async ({ page }) => {
    const row = await findRow(page, CANCELLED_MARKERS_NAME);

    await expect(row.locator('[data-testid="run-row-status-cancelled"]')).toBeVisible();
    await expect(row.locator('.animate-spin')).toHaveCount(0);
    await expect(row.locator('[data-testid="run-row-not-run"]')).toContainText('28 not run');
    // 17 passed / 17 failed — the 28 markers do not inflate the failed count.
    await expect(row.locator('.text-red-500').first()).toHaveText('17');
  });

  test('S2 failed run (37/62): Failed badge, "25 not run", NO spinner', async ({ page }) => {
    const row = await findRow(page, FAILED_NAME);

    await expect(row.locator('[data-testid="run-row-status-failed"]')).toBeVisible();
    await expect(row.locator('[data-testid="run-row-status-running"]')).toHaveCount(0);
    await expect(row.locator('.animate-spin')).toHaveCount(0);
    await expect(row.locator('[data-testid="run-row-not-run"]')).toContainText('25 not run');
  });

  test('run detail page for the cancelled run shows a "Not run" stat and a pass rate over executed cases only', async ({ page }) => {
    await page.goto(`/evaluations/runs/${CANCELLED_ID}`);
    const notRun = page.locator('[data-testid="run-detail-not-run"]');
    await expect(notRun).toBeVisible({ timeout: 15000 });
    await expect(notRun).toContainText('28');
    // 17 passed of 34 executed = 50% — not 17/62 (27%).
    await expect(page.getByText('50%')).toBeVisible();
    await expect(page.locator('.animate-spin')).toHaveCount(0);
  });
});
