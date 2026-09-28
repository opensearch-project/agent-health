/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E — empty agent responses are agent failures, never judged.
 *
 * Owner incident: an HTTP agent answered 200 with an empty payload; the
 * placeholder text rendered for it was sent to the LLM judge, which PASSED it
 * ("Any reply at all — fully achieved"). A response with no agent activity and
 * no content must never reach the judge as a candidate answer.
 *
 * This spec runs REAL evaluation runs (real runner, real REST connector) against
 * a local stub that answers `200 {}` through the API, then asserts the rendered
 * surfaces:
 *   - runs list: the row counts the cases as errored (not passed), with the
 *     "Empty responses" badge — count form (2-case run, breaker not tripped)
 *     and breaker form whose tooltip says "3 consecutive empty responses"
 *     (5-case run, breaker tripped);
 *   - run inspector: banner with the reason, every row ERRORED, and the
 *     selected case's panel shows "Agent returned an empty response … Not judged.";
 *   - per-case report page: the failure card titled "Agent returned an empty
 *     response" with the EMPTY_RESPONSE reason, and no PASSED verdict.
 */

import { createServer, type Server } from 'http';
import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_NAME_SMALL = `E2E Empty Body ${STAMP}`;
const RUN_NAME_TRIPPED = `E2E Empty Body Tripped ${STAMP}`;

test.describe('Empty agent response → agent failure, never judged', () => {
  let stub: Server;
  let port: number;
  let smallRunId: string;
  let trippedRunId: string;
  let smallReportId: string;
  let smallSummary: string;
  let trippedSummary: string;
  const created = { agentKey: '', testCaseIds: [] as string[], reportIds: [] as string[], runIds: [] as string[] };

  test.beforeAll(async ({ request }) => {
    stub = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    });
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', () => resolve()));
    port = (stub.address() as any).port as number;
    smallSummary = '2 cases returned an empty response (no steps, no answer, no results) — not judged';
    trippedSummary = `Agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, 127.0.0.1:${port}); 2 further cases were not attempted`;

    const agentRes = await request.post('/api/agents/custom', {
      data: { name: `e2e-empty-rest-${STAMP}`, endpoint: `http://127.0.0.1:${port}/agent`, connectorType: 'rest', useTraces: false },
    });
    expect(agentRes.ok()).toBeTruthy();
    created.agentKey = (await agentRes.json()).agent.key as string;

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: `e2e-empty-case-${STAMP}-${i}`, category: 'Test', difficulty: 'Easy',
          initialPrompt: `search products ${i}`, context: [], expectedTrajectory: [], expectedOutcomes: ['Any reply at all.'], labels: ['@e2e-test'],
        },
      });
      expect(r.ok()).toBeTruthy();
      ids.push((await r.json()).id);
    }
    created.testCaseIds = ids;

    const startRun = async (name: string, caseIds: string[]) => {
      const runRes = await request.post('/api/storage/evaluation-runs', {
        data: { agentKey: created.agentKey, judgeModelId: 'demo-model', trigger: 'api', concurrency: 1, name, sources: [{ type: 'test-case-ids', ids: caseIds }] },
      });
      expect(runRes.ok()).toBeTruthy();
      const sse = await runRes.text();
      const runId = JSON.parse(sse.match(/event: started\ndata: (.*)\n/)![1]).runId as string;
      created.runIds.push(runId);
      const run = await (await request.get(`/api/storage/evaluation-runs/${runId}`)).json();
      expect(run.status).toBe('completed');
      created.reportIds.push(...Object.values(run.results).map((r: any) => r.reportId).filter(Boolean));
      return run;
    };

    const small = await startRun(RUN_NAME_SMALL, ids.slice(0, 2));
    smallRunId = small.id;
    expect(small.agentFailureSummary).toBe(smallSummary);
    expect(small.stats).toMatchObject({ passed: 0, failed: 0, errored: 2 });
    smallReportId = small.results[ids[0]].reportId;

    const tripped = await startRun(RUN_NAME_TRIPPED, ids);
    trippedRunId = tripped.id;
    expect(tripped.agentFailureSummary).toBe(trippedSummary);
    expect(tripped.stats).toMatchObject({ passed: 0, failed: 0, errored: 5 });
  });

  test.afterAll(async ({ request }) => {
    // Only ids this spec created (AGENTS.md: never delete by name).
    for (const id of created.reportIds) await request.delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    for (const id of created.runIds) await request.delete(`/api/storage/evaluation-runs/${id}`).catch(() => {});
    for (const id of created.testCaseIds) await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    if (created.agentKey) await request.delete(`/api/agents/custom/${encodeURIComponent(created.agentKey)}`).catch(() => {});
    await new Promise<void>(resolve => stub.close(() => resolve()));
  });

  test('runs list: empty-body runs are counted errored (never passed) with the "Empty responses" / "Agent unreachable" badge and the reason as tooltip', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');
    const search = page.locator('input[placeholder*="Search" i]').first();
    if (await search.isVisible({ timeout: 2000 }).catch(() => false)) await search.fill(`E2E Empty Body`);

    const small = page.locator('[data-testid="run-row"]', { hasText: RUN_NAME_SMALL }).filter({ hasNotText: 'Tripped' });
    await expect(small).toBeVisible({ timeout: 15000 });
    const smallBadge = small.locator('[data-testid="run-row-agent-unreachable"]');
    await expect(smallBadge).toContainText('Empty responses');
    await expect(smallBadge).toHaveAttribute('title', smallSummary);
    await expect(small.locator('[data-testid="run-row-errored-badge"]')).toContainText('2');
    await expect(small.locator('[data-testid="run-row-status-running"]')).toHaveCount(0);
    await expect(small.locator('.animate-spin')).toHaveCount(0);

    const tripped = page.locator('[data-testid="run-row"]', { hasText: RUN_NAME_TRIPPED });
    await expect(tripped).toBeVisible();
    // The breaker opened on empty responses alone: the endpoint answers, so the
    // badge still says "Empty responses" (not "unreachable"); the tooltip carries the breaker summary.
    const trippedBadge = tripped.locator('[data-testid="run-row-agent-unreachable"]');
    await expect(trippedBadge).toContainText('Empty responses');
    await expect(trippedBadge).toHaveAttribute('title', trippedSummary);
    await expect(tripped.locator('[data-testid="run-row-errored-badge"]')).toContainText('5');
  });

  test('run inspector: banner with the reason, every row ERRORED, selected case shows "Agent returned an empty response … Not judged."', async ({ page }) => {
    await page.goto(`/evaluations/runs/${smallRunId}/inspect`);
    const banner = page.locator('[data-testid="run-agent-unreachable-banner"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText(smallSummary);
    await expect(banner).toContainText('nothing to judge on these cases');

    const rows = page.locator('[data-testid="test-case-row"]');
    await expect(rows).toHaveCount(2);
    await expect(page.locator('[data-testid="test-case-row"][data-status="errored"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="test-case-row"][data-status="passed"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="test-case-row"][data-status="pending_traces"]')).toHaveCount(0);

    await rows.first().click();
    const reason = page.locator('[data-testid="inspector-agent-failure"]');
    await expect(reason).toBeVisible({ timeout: 15000 });
    await expect(reason).toHaveAttribute('data-kind', 'empty-response');
    await expect(reason).toContainText('Agent returned an empty response');
    await expect(reason).toContainText(`EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint 127.0.0.1:${port}`);
    await expect(reason).toContainText('Not judged.');
    await expect(page.locator('text=PASSED')).toHaveCount(0);
  });

  test('run inspector (breaker tripped): banner names 3 consecutive empty responses; refused cases are errored too', async ({ page }) => {
    await page.goto(`/evaluations/runs/${trippedRunId}/inspect`);
    const banner = page.locator('[data-testid="run-agent-unreachable-banner"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText(trippedSummary);
    await expect(page.locator('[data-testid="test-case-row"][data-status="errored"]')).toHaveCount(5);
  });

  test('per-case report page: failure card "Agent returned an empty response" with the EMPTY_RESPONSE reason; no verdict', async ({ page }) => {
    await page.goto(`/runs/${smallReportId}`);
    await expect(page.locator('text=Agent returned an empty response').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`text=EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint 127.0.0.1:${port}`).first()).toBeVisible();
    await expect(page.locator('text=Evaluator could not run')).toHaveCount(0);
    await expect(page.locator('text=Agent run did not complete')).toHaveCount(0);
    await expect(page.locator('text=PASSED')).toHaveCount(0);
  });
});
