/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cancel by lease (#612): a run executing in ANOTHER process (no cancel
 * token in this server, a live executor lease on the document) is cancelled
 * from the Evaluation Runs page. The row shows "Cancelling…" while the
 * executor drains, then "Cancelled" once the executor — played here by the
 * test through the run-ingestion API with the run's own fencing token —
 * finalizes with explicit markers.
 *
 * Red on the previous behaviour: with no in-memory token the cancel route
 * either 409'd ("executor may not have started yet") or took the zombie
 * fallback and flipped the doc to `cancelled` directly — never "Cancelling…".
 *
 * Hits the real backend (file-storage test server) — no mocking.
 */

import { test, expect } from './fixtures/test-fixtures';

const RUN_ID = `eval-run-e2e-lease-cancel-${Date.now()}`;
const RUN_NAME = `E2E Lease Cancel ${Date.now()}`;
// The fencing token the "other process" holds; 128-bit hex like the server mints.
const TOKEN = 'e2e0' + Date.now().toString(16).padStart(12, '0') + 'cafe'.repeat(4);
const CASES = ['tc-lease-1', 'tc-lease-2', 'tc-lease-3', 'tc-lease-4'];

function leasedRunningRunDoc() {
  return {
    id: RUN_ID,
    docType: 'evaluation-run',
    name: RUN_NAME,
    createdAt: new Date().toISOString(),
    status: 'running',
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'cli',
    testCaseSnapshots: CASES.map((id, i) => ({ id, version: 1, name: `lease case ${i + 1}` })),
    // One case finished before the cancel; the others never start.
    results: { [CASES[0]]: { reportId: `report-${RUN_ID}-1`, status: 'completed', passFailStatus: 'passed' } },
    executor: { id: TOKEN, kind: 'cli', version: 'e2e' },
    lease: { generation: 1, heartbeatAt: new Date().toISOString(), ttlMs: 5 * 60 * 1000 },
  };
}

test.describe('Evaluation Runs page — cancel by lease renders Cancelling… then Cancelled (#612)', () => {
  test.beforeAll(async ({ request }) => {
    const r = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: leasedRunningRunDoc() });
    expect(r.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
  });

  test('Cancel on a lease-held run shows "Cancelling…"; the executor finalizes and the row shows "Cancelled"', async ({ page, request }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const row = page.locator('tr', { hasText: RUN_NAME }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('[data-testid="run-row-status-running"]')).toBeVisible();

    // Cancel from the row's actions menu — the only executor is "elsewhere".
    await row.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`).click();
    await page.locator(`[data-testid="run-action-cancel-${RUN_ID}"]`).click();

    // Cancelling…: cancelRequestedAt stamped, status still running (the executor drains).
    await expect(row.locator('[data-testid="run-row-status-cancelling"]')).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('[data-testid="run-row-status-cancelling"]')).toContainText('Cancelling');
    const mid = await (await request.get(`/api/storage/evaluation-runs/${RUN_ID}`)).json();
    const midRun = mid.evaluationRun ?? mid;
    expect(midRun.status).toBe('running');
    expect(typeof midRun.cancelRequestedAt).toBe('string');

    // The executor sees cancelRequestedAt on its next heartbeat (what the runner does) …
    const beat = await request.post(`/api/runs/ingest/${RUN_ID}/heartbeat`, { headers: { 'x-ah-executor': TOKEN }, data: { startedCount: 1, completedCount: 1, totalTestCases: 4 } });
    expect(beat.ok()).toBeTruthy();
    expect(await beat.json()).toEqual({ generation: 1, cancelRequestedAt: midRun.cancelRequestedAt });
    // … and finalizes `cancelled`; never-started cases get explicit markers.
    const finalize = await request.post(`/api/runs/ingest/${RUN_ID}/finalize`, {
      headers: { 'x-ah-executor': TOKEN },
      data: { status: 'cancelled', completedRun: { results: leasedRunningRunDoc().results, testCaseSnapshots: leasedRunningRunDoc().testCaseSnapshots } },
    });
    expect(finalize.ok()).toBeTruthy();
    const finalized = await finalize.json();
    expect(finalized.status).toBe('cancelled');
    expect(finalized.stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 3, total: 4 });

    // The page polls every 5 s: Cancelled, with the never-ran count in the badge tooltip.
    const cancelled = row.locator('[data-testid="run-row-status-cancelled"]');
    await expect(cancelled).toBeVisible({ timeout: 20_000 });
    await expect(cancelled).toContainText('Cancelled');
    await expect(cancelled).toHaveAttribute('title', /3 planned cases never ran/);
    await expect(row.locator('[data-testid="run-row-status-cancelling"]')).toHaveCount(0);

    // A late write from the old executor is fenced out (409 lease-lost) and changes nothing.
    const late = await request.post(`/api/runs/ingest/${RUN_ID}/finalize`, {
      headers: { 'x-ah-executor': TOKEN },
      data: { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } },
    });
    expect(late.status()).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'lease-lost', runId: RUN_ID, status: 'cancelled' });
  });
});
