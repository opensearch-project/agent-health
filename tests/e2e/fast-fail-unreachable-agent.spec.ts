/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E — fast-fail for unreachable agent endpoints.
 *
 * Owner incident: a run against a DOWN endpoint took minutes per case (trace
 * polling for a request that never happened) and the UI ended up saying
 * "Evaluator could not run … trace_timeout" with the real cause lost.
 *
 * This spec runs a REAL evaluation run (real runner, real REST connector)
 * against a closed local port through the API, then asserts the rendered
 * surfaces:
 *   - runs list: the "Agent unreachable" badge with the reason (host + code);
 *   - run detail page + run inspector: the banner with the same reason, and
 *     every inspector row ERRORED;
 *   - per-case report page: "Agent run did not complete" + ECONNREFUSED.
 */

import { createServer } from 'http';
import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_NAME = `E2E Dead Endpoint ${STAMP}`;

/** A port nothing listens on: bind an ephemeral port, close it, reuse the number. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port as number;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

test.describe('Fast-fail for an unreachable agent endpoint', () => {
  let port: number;
  let runId: string;
  let firstReportId: string;
  let refusedReportId: string;
  let expectedSummary: string;
  // Created entities, deleted in afterAll (the per-test `testData` fixture is
  // not available in beforeAll, and the run is shared by the three tests).
  const created = { agentKey: '', testCaseIds: [] as string[], reportIds: [] as string[] };

  test.beforeAll(async ({ request }) => {
    port = await closedPort();
    expectedSummary = `Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, 127.0.0.1:${port}); 2 further cases were not attempted`;

    const agentRes = await request.post('/api/agents/custom', {
      data: { name: `e2e-dead-rest-${STAMP}`, endpoint: `http://127.0.0.1:${port}/agent`, connectorType: 'rest', useTraces: true },
    });
    expect(agentRes.ok()).toBeTruthy();
    const agentKey = (await agentRes.json()).agent.key as string;
    created.agentKey = agentKey;

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: `e2e-dead-case-${STAMP}-${i}`, category: 'Test', difficulty: 'Easy',
          initialPrompt: `search products ${i}`, context: [], expectedTrajectory: [], expectedOutcomes: ['ok'], labels: ['@e2e-test'],
        },
      });
      expect(r.ok()).toBeTruthy();
      ids.push((await r.json()).id);
    }
    created.testCaseIds = ids;

    const started = Date.now();
    const runRes = await request.post('/api/storage/evaluation-runs', {
      data: {
        agentKey, judgeModelId: 'demo-model', trigger: 'api', concurrency: 1, name: RUN_NAME,
        sources: [{ type: 'test-case-ids', ids }],
      },
    });
    expect(runRes.ok()).toBeTruthy();
    const sse = await runRes.text();
    runId = JSON.parse(sse.match(/event: started\ndata: (.*)\n/)![1]).runId;
    // The whole 5-case run must finish in seconds, not minutes.
    expect(Date.now() - started).toBeLessThan(30_000);

    const run = await (await request.get(`/api/storage/evaluation-runs/${runId}`)).json();
    expect(run.status).toBe('completed');
    expect(run.agentFailureSummary).toBe(expectedSummary);
    firstReportId = run.results[ids[0]].reportId;
    refusedReportId = run.results[ids[4]].reportId;
    created.reportIds = Object.values(run.results).map((r: any) => r.reportId).filter(Boolean);
  });

  test.afterAll(async ({ request }) => {
    // Only ids this spec created (AGENTS.md: never delete by name).
    for (const id of created.reportIds) await request.delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    for (const id of created.testCaseIds) await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    if (created.agentKey) await request.delete(`/api/agents/custom/${encodeURIComponent(created.agentKey)}`).catch(() => {});
  });

  test('runs list: the row shows an "Agent unreachable" badge whose tooltip is the reason, 5 errored, no spinner', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const search = page.locator('input[placeholder*="Search" i]').first();
    if (await search.isVisible({ timeout: 2000 }).catch(() => false)) await search.fill(RUN_NAME);
    const row = page.locator('[data-testid="run-row"]', { hasText: RUN_NAME });
    await expect(row).toBeVisible({ timeout: 15000 });

    const badge = row.locator('[data-testid="run-row-agent-unreachable"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Agent unreachable');
    await expect(badge).toHaveAttribute('title', expectedSummary);
    await expect(row.locator('[data-testid="run-row-errored-badge"]')).toContainText('5');
    await expect(row.locator('[data-testid="run-row-errored-badge"]')).toHaveAttribute('title', expectedSummary);
    await expect(row.locator('[data-testid="run-row-status-running"]')).toHaveCount(0);
    await expect(row.locator('.animate-spin')).toHaveCount(0);
  });

  test('run detail page: banner with the reason under the stats', async ({ page }) => {
    await page.goto(`/evaluations/runs/${runId}`);
    const banner = page.locator('[data-testid="run-detail-agent-unreachable-banner"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText(expectedSummary);
    await expect(page.locator('.animate-spin')).toHaveCount(0);
  });

  test('run inspector: banner with the reason; every case row is errored (not failed, not pending)', async ({ page }) => {
    await page.goto(`/evaluations/runs/${runId}/inspect`);
    const banner = page.locator('[data-testid="run-agent-unreachable-banner"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText(expectedSummary);
    await expect(banner).toContainText('check the agent endpoint and re-run');

    const rows = page.locator('[data-testid="test-case-row"]');
    await expect(rows).toHaveCount(5);
    await expect(page.locator('[data-testid="test-case-row"][data-status="errored"]')).toHaveCount(5);
    await expect(page.locator('[data-testid="test-case-row"][data-status="pending_traces"]')).toHaveCount(0);
  });

  test('per-case report: a dialled case names ECONNREFUSED + host; a refused case says it was not attempted', async ({ page }) => {
    await page.goto(`/runs/${firstReportId}`);
    await expect(page.locator('text=Agent run did not complete').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`text=ECONNREFUSED — connection refused while calling agent endpoint 127.0.0.1:${port}`).first()).toBeVisible();
    await expect(page.locator('text=Evaluator could not run')).toHaveCount(0);
    await expect(page.locator('text=trace_timeout')).toHaveCount(0);

    await page.goto(`/runs/${refusedReportId}`);
    await expect(page.locator('text=Agent run did not complete').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=this case was not attempted').first()).toBeVisible();
  });
});
