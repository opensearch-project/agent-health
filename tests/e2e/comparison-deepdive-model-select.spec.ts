/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the deep-dive MODEL SELECTOR (owner: "What model is run
 * for What's actually different? I want it to be Fable 5.1.") and the lifted
 * client-side deadline ("My comparison times out after 180 seconds, remove
 * this limit.").
 *
 * Asserts on the REAL rendered surface of the compare page:
 *  - the selector is visible in the panel header, defaults to the server's
 *    `defaultId` (Fable 5.1), and the first POST already carries that modelId
 *  - the footer reports the model the server actually used
 *  - a persisted choice (localStorage `agent-health:deepdive:model`) wins
 *  - changing the model starts a new generation with the new modelId
 *  - the spinner shows the model + elapsed time and does NOT time out while
 *    the job keeps reporting `running`
 *
 * Deterministic: storage, the models endpoint and the deep-dive job are all
 * mocked via page.route() — no LLM/AWS creds required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-modelsel-a';
const RUN_B = 'eval-run-modelsel-b';
const TC = 'tc-modelsel-shared';
const LS_KEY = 'agent-health:deepdive:model';
const FABLE = 'us.anthropic.claude-fable-5-1';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const MODELS = {
  models: [
    { provider: 'amazon-bedrock', id: FABLE, name: 'Claude Fable 5.1 (US)' },
    { provider: 'amazon-bedrock', id: SONNET, name: 'Claude Sonnet 4.6 (US)' },
  ],
  defaultId: FABLE,
};

const evalRun = (id: string, agentKey: string, reportId: string) => ({
  id,
  docType: 'evaluation-run',
  name: `ModelSel Run ${agentKey}`,
  createdAt: '2026-03-06T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'ModelSel Shared Case' }],
  results: { [TC]: { reportId, status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});

const report = (id: string, agentKey: string) => ({
  id,
  createdAt: '2026-03-06T10:00:00Z',
  testCaseId: TC,
  agentId: agentKey,
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 90 },
  performanceMetrics: { durationMs: 30000 },
  trajectory: [],
});

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/evaluation-runs/${RUN_A}`)) return json(route, evalRun(RUN_A, 'demo', 'rep-ms-a'));
    if (url.pathname.endsWith(`/evaluation-runs/${RUN_B}`)) return json(route, evalRun(RUN_B, 'pulsar', 'rep-ms-b'));
    if (url.pathname.endsWith('/evaluation-runs')) {
      return json(route, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-ms-a'), evalRun(RUN_B, 'pulsar', 'rep-ms-b')], total: 2 });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-ms-a'))) runs.push(report('rep-ms-a', 'demo'));
    if (ids.some((id) => id.includes('rep-ms-b'))) runs.push(report('rep-ms-b', 'pulsar'));
    return json(route, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (route) => {
    const url = route.request().url();
    if (url.includes('rep-ms-a')) return json(route, report('rep-ms-a', 'demo'));
    if (url.includes('rep-ms-b')) return json(route, report('rep-ms-b', 'pulsar'));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive/system-prompt', (route) => json(route, { systemPrompt: 'DEFAULT PROMPT' }));
  await page.route('**/api/comparison/deep-dive/models', (route) => json(route, MODELS));
}

test.describe('Comparison deep-dive — model selector (default Claude Fable 5.1) + no client deadline', () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
  });

  test('selector is visible, defaults to Fable 5.1, the first POST carries it, and the footer names the model used', async ({ page }) => {
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: (body) => ({ markdown: `narrative by ${body.modelId}`, modelId: `amazon-bedrock/${body.modelId}`, durationMs: 412_000, runs: [] }),
      onPost: (body) => bodies.push(body),
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });

    const select = page.locator('[data-testid="deep-dive-model-select"]');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue(FABLE);
    await expect(select.locator('option')).toHaveText(['Claude Fable 5.1 (US)', 'Claude Sonnet 4.6 (US)']);

    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText(`narrative by ${FABLE}`, { timeout: 15000 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].modelId).toBe(FABLE);
    // Footer: "Generated by us.anthropic.claude-fable-5-1 in 412s" — a
    // ~7-minute generation is a normal result, not a timeout.
    await expect(page.locator('[data-testid="deep-dive-footer"]')).toContainText('us.anthropic.claude-fable-5-1');
    await expect(page.locator('[data-testid="deep-dive-footer"]')).toContainText('412s');
  });

  test('a persisted choice wins over the default; changing the model persists and regenerates with the new modelId', async ({ page }) => {
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: (body) => ({ markdown: `narrative by ${body.modelId}`, modelId: `amazon-bedrock/${body.modelId}`, durationMs: 1, runs: [] }),
      onPost: (body) => bodies.push(body),
    });
    await page.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } }, [LS_KEY, SONNET]);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });
    const select = page.locator('[data-testid="deep-dive-model-select"]');
    await expect(select).toHaveValue(SONNET);
    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText(`narrative by ${SONNET}`, { timeout: 15000 });
    expect(bodies[0].modelId).toBe(SONNET);

    await select.selectOption(FABLE);
    expect(await page.evaluate((key) => localStorage.getItem(key), LS_KEY)).toBe(FABLE);
    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText(`narrative by ${FABLE}`, { timeout: 15000 });
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1].modelId).toBe(FABLE);
  });

  test('while the job keeps running the spinner shows the model + elapsed time and there is no client-side timeout', async ({ page }) => {
    // The job NEVER settles during this test — the client must keep polling
    // (no "Timed out" error), showing which model is working and for how long.
    await page.route('**/api/comparison/deep-dive', (r) =>
      r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'forever-running' }) })
    );
    let polls = 0;
    await page.route('**/api/comparison/deep-dive/jobs/forever-running', (r) => {
      polls++;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running', elapsedMs: polls * 2500 }) });
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="deep-dive-loading"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="deep-dive-loading-model"]')).toContainText('Claude Fable 5.1 (US)');
    await expect(page.locator('[data-testid="deep-dive-model-select"]')).toBeDisabled();
    await expect(page.locator('[data-testid="deep-dive-loading-elapsed"]')).toHaveText(/\(\ds\)/);

    // Still polling, still loading, after several poll cycles.
    await expect.poll(() => polls, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    await expect(page.locator('[data-testid="deep-dive-loading"]')).toBeVisible();
    await expect(page.getByText(/Timed out/)).toHaveCount(0);
    await expect(page.getByText(/Couldn't generate/)).toHaveCount(0);
  });
});
