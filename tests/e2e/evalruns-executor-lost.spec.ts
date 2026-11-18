/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A run the lease sweeper failed (#612: its executor stopped heartbeating —
 * crashed server, killed CLI) is rendered as "Failed · executor lost" on the
 * Evaluation Runs page, with the "no heartbeat since …" reason as the badge
 * title, and its never-started cases count as not run. The document is the
 * exact shape `server/services/runLeaseSweeper.ts` writes.
 *
 * Hits the real backend (file-storage test server) — no mocking.
 */

import { test, expect } from './fixtures/test-fixtures';

const RUN_ID = `eval-run-e2e-executor-lost-${Date.now()}`;
const RUN_NAME = `E2E Executor Lost ${Date.now()}`;
const HEARTBEAT_AT = new Date(Date.now() - 20 * 60 * 1000).toISOString();

function sweptRunDoc() {
  return {
    id: RUN_ID,
    docType: 'evaluation-run',
    name: RUN_NAME,
    createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    completedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    status: 'failed',
    error: `executor lost (no heartbeat since ${HEARTBEAT_AT}; lease TTL 300s)`,
    agentKey: 'agent-alpha',
    modelId: 'e2e-model',
    sources: [],
    trigger: 'ui',
    testCaseSnapshots: [1, 2, 3, 4, 5].map(i => ({ id: `tc-lost-${i}`, version: 1, name: `lost case ${i}` })),
    results: {
      'tc-lost-1': { reportId: `report-${RUN_ID}-1`, status: 'completed', passFailStatus: 'passed' },
      'tc-lost-2': { reportId: `report-${RUN_ID}-2`, status: 'running' },
      'tc-lost-3': { reportId: '', status: 'cancelled' },
      'tc-lost-4': { reportId: '', status: 'cancelled' },
      'tc-lost-5': { reportId: '', status: 'cancelled' },
    },
    stats: { passed: 1, failed: 0, errored: 0, pending: 0, notRun: 4, total: 5 },
    executor: { id: null, kind: 'server', version: 'e2e' },
    lease: { generation: 2, heartbeatAt: HEARTBEAT_AT, ttlMs: 300_000 },
  };
}

test.describe('Evaluation Runs page — a run whose executor was lost (#612)', () => {
  test.beforeAll(async ({ request }) => {
    const r = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, { data: sweptRunDoc() });
    expect(r.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
  });

  test('renders "Failed · executor lost" with the heartbeat reason as title; it is not in flight and cannot be cancelled', async ({ page, request }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const row = page.locator('tr', { hasText: RUN_NAME }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    const badge = row.locator('[data-testid="run-row-status-failed"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/Failed · executor lost/);
    await expect(badge).toHaveAttribute('title', new RegExp(`no heartbeat since ${HEARTBEAT_AT.replace(/[.]/g, '\\.')}; lease TTL 300s`));
    await expect(row.locator('[data-testid="run-row-status-running"]')).toHaveCount(0);
    await expect(row.locator('[data-testid="run-row-status-cancelling"]')).toHaveCount(0);

    // Not in flight any more (its lease was taken over) …
    const inFlight = await (await request.get('/api/runs/in-flight')).json();
    expect(inFlight.runs.map((r: { id: string }) => r.id)).not.toContain(RUN_ID);
    // … and a late write from the lost executor is fenced out.
    const late = await request.post(`/api/runs/ingest/${RUN_ID}/heartbeat`, { headers: { 'x-ah-executor': 'deadbeefdeadbeefdeadbeefdeadbeef' }, data: {} });
    expect(late.status()).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'lease-lost', runId: RUN_ID, generation: 2, status: 'failed' });
  });
});
