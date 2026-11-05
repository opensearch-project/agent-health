/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation Runs list — background polling must stay in the background.
 *
 * Owner report (2026-10-22): "Runs list page seems to be refreshing
 * constantly." Root cause: while any run is `running`, the page polled every
 * 5 s through the NON-silent loader, which flipped `loading` and swapped the
 * whole table for the full-page spinner for as long as the three list
 * requests took (seconds against a cluster with hundreds of runs). Rows
 * flashed in and out, scroll reset, per-row mounts re-fired their requests.
 *
 * Real-shaped fixture: one run stuck in `running` (a leaked fixture on a
 * shared cluster does exactly this) and list responses HELD for ~1.2 s so
 * the in-flight window is observable, as it is on a real cluster.
 *
 * Asserts, over a ~12 s window:
 *   - the <table> is never removed from the DOM (MutationObserver count 0);
 *   - the row's DOM node survives (no unmount/remount);
 *   - the list requests stay bounded: 1 initial + at most ceil(window/5 s)+1.
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_RUNNING = `eval-run-e2e-poll-running-${STAMP}`;
const RUN_DONE = `eval-run-e2e-poll-done-${STAMP}`;
const TC = `tc-e2e-poll-${STAMP}`;

function evalRunDoc(id: string, name: string, status: 'running' | 'completed') {
  return {
    id,
    docType: 'evaluation-run',
    name,
    createdAt: new Date().toISOString(),
    status,
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [{ id: TC, version: 1, name: TC }, { id: `${TC}-2`, version: 1, name: `${TC}-2` }],
    results: status === 'completed'
      ? { [TC]: { reportId: `report-${id}`, status: 'completed', passFailStatus: 'passed' } }
      : { [TC]: { reportId: `report-${id}`, status: 'running' } },
  };
}

test.describe('Evaluation Runs list — silent, bounded polling while a run is in flight', () => {
  test.beforeAll(async ({ request }) => {
    for (const doc of [evalRunDoc(RUN_RUNNING, `E2E Poll In-Flight ${STAMP}`, 'running'), evalRunDoc(RUN_DONE, `E2E Poll Done ${STAMP}`, 'completed')]) {
      const r = await request.put(`/api/storage/evaluation-runs/${doc.id}`, { data: doc });
      expect(r.ok()).toBeTruthy();
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of [RUN_RUNNING, RUN_DONE]) {
      await request.delete(`/api/storage/evaluation-runs/${id}`).catch(() => {});
    }
  });

  test('a slow poll never replaces the table with the page spinner, and the request count stays bounded', async ({ page }) => {
    // Count table removals precisely, from inside the page.
    await page.addInitScript(() => {
      (window as any).__tableRemovals = 0;
      let hadTable = false;
      const mo = new MutationObserver(() => {
        const has = !!document.querySelector('table');
        if (hadTable && !has) (window as any).__tableRemovals++;
        hadTable = has;
      });
      document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));
    });

    // Hold every list response ~1.2 s (the deck's multi-MB payloads take that long).
    const HOLD_MS = 1200;
    let listRequests = 0;
    await page.route(/\/api\/storage\/(evaluation-runs\?|benchmarks(\?|$))/, async (route) => {
      listRequests++;
      await new Promise(r => setTimeout(r, HOLD_MS));
      await route.continue();
    });

    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const row = page.locator('[data-testid="run-row"]', { hasText: `E2E Poll In-Flight ${STAMP}` });
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row.locator('[data-testid="run-row-status-running"]')).toBeVisible();

    const rowHandle = await row.elementHandle();
    const requestsAfterLoad = listRequests;

    const WINDOW_MS = 12000;
    await page.waitForTimeout(WINDOW_MS);

    // Polling DID happen (the running run keeps the list fresh)…
    const pollRequests = listRequests - requestsAfterLoad;
    expect(pollRequests).toBeGreaterThan(0);
    // …but stayed bounded: two list endpoints per tick, one tick per 5 s (+1 slack).
    expect(pollRequests).toBeLessThanOrEqual(2 * (Math.ceil(WINDOW_MS / 5000) + 1));

    // …and never as a visible reload.
    expect(await page.evaluate(() => (window as any).__tableRemovals)).toBe(0);
    expect(await rowHandle!.evaluate(el => el.isConnected)).toBe(true);
    await expect(row).toBeVisible();
    await expect(page.locator('[data-testid="run-row"]', { hasText: `E2E Poll Done ${STAMP}` })).toBeVisible();
  });
});
