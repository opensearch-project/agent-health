/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the editable deep-dive system prompt (Change 4).
 *
 * Owner request: a collapsible "System prompt" disclosure in the "What's
 * actually different" panel, collapsed by default, prefilled from
 * GET /api/comparison/deep-dive/system-prompt (or the localStorage override
 * when present), editable, and persisted ONLY in the browser (localStorage
 * key `agent-health:deepdive:system-prompt`) — nothing server-side.
 *
 * Deterministic: storage, the deep-dive POST, and the new system-prompt GET
 * are all mocked via page.route() — no LLM/AWS creds required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-sysprompt-a';
const RUN_B = 'eval-run-sysprompt-b';
const TC = 'tc-sysprompt-shared';
const DEFAULT_SYSTEM_PROMPT = 'DEFAULT SYSTEM PROMPT: compare the two runs and cite spans.';
const LS_KEY = 'agent-health:deepdive:system-prompt';

const evalRun = (id: string, agentKey: string, reportId: string) => ({
  id,
  docType: 'evaluation-run',
  name: `SysPrompt Run ${agentKey}`,
  createdAt: '2026-03-06T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'SysPrompt Shared Case' }],
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
    if (url.pathname.endsWith(`/evaluation-runs/${RUN_A}`)) return json(route, evalRun(RUN_A, 'demo', 'rep-sp-a'));
    if (url.pathname.endsWith(`/evaluation-runs/${RUN_B}`)) return json(route, evalRun(RUN_B, 'pulsar', 'rep-sp-b'));
    if (url.pathname.endsWith('/evaluation-runs')) {
      return json(route, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-sp-a'), evalRun(RUN_B, 'pulsar', 'rep-sp-b')], total: 2 });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-sp-a'))) runs.push(report('rep-sp-a', 'demo'));
    if (ids.some((id) => id.includes('rep-sp-b'))) runs.push(report('rep-sp-b', 'pulsar'));
    return json(route, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (route) => {
    const url = route.request().url();
    if (url.includes('rep-sp-a')) return json(route, report('rep-sp-a', 'demo'));
    if (url.includes('rep-sp-b')) return json(route, report('rep-sp-b', 'pulsar'));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive/system-prompt', (route) =>
    json(route, { systemPrompt: DEFAULT_SYSTEM_PROMPT })
  );
  await mockDeepDiveJob(page, { result: { markdown: 'stub deep-dive markdown', modelId: 'stub/model', durationMs: 1, runs: [] } });
}

test.describe('Comparison deep-dive — editable system prompt (browser-cache only)', () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
  });

  test('disclosure is collapsed by default, opens on click, and prefills the real default', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });

    const toggle = page.locator('[data-testid="deep-dive-system-prompt-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(page.locator('[data-testid="deep-dive-system-prompt-textarea"]')).toHaveCount(0);

    await toggle.click();
    const textarea = page.locator('[data-testid="deep-dive-system-prompt-textarea"]');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(DEFAULT_SYSTEM_PROMPT, { timeout: 10000 });
  });

  test('editing the prompt persists to localStorage and survives a reload', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });

    await page.locator('[data-testid="deep-dive-system-prompt-toggle"]').click();
    const textarea = page.locator('[data-testid="deep-dive-system-prompt-textarea"]');
    await expect(textarea).toHaveValue(DEFAULT_SYSTEM_PROMPT, { timeout: 10000 });

    const custom = 'CUSTOM: only talk about token usage differences.';
    await textarea.fill(custom);

    // Persisted immediately (browser-cache only — nothing server-side).
    const stored = await page.evaluate((key) => localStorage.getItem(key), LS_KEY);
    expect(stored).toBe(custom);

    await page.reload();
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });
    await page.locator('[data-testid="deep-dive-system-prompt-toggle"]').click();
    await expect(page.locator('[data-testid="deep-dive-system-prompt-textarea"]')).toHaveValue(custom);
  });

  test('Reset to default clears localStorage and restores the fetched default', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });

    await page.locator('[data-testid="deep-dive-system-prompt-toggle"]').click();
    const textarea = page.locator('[data-testid="deep-dive-system-prompt-textarea"]');
    await expect(textarea).toHaveValue(DEFAULT_SYSTEM_PROMPT, { timeout: 10000 });

    await textarea.fill('something totally different');
    await expect(page.locator('[data-testid="deep-dive-system-prompt-reset"]')).toBeEnabled();

    await page.locator('[data-testid="deep-dive-system-prompt-reset"]').click();
    await expect(textarea).toHaveValue(DEFAULT_SYSTEM_PROMPT);

    const stored = await page.evaluate((key) => localStorage.getItem(key), LS_KEY);
    expect(stored).toBeNull();
  });

  test('regenerating with an edited prompt sends it to the server as systemPrompt', async ({ page }) => {
    let capturedBody: any = null;
    await mockDeepDiveJob(page, {
      result: { markdown: 'regenerated with custom prompt', modelId: 'stub/model', durationMs: 1, runs: [] },
      onPost: (body) => { capturedBody = body; },
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });
    await page.waitForSelector('text=Regenerate', { timeout: 15000 });

    await page.locator('[data-testid="deep-dive-system-prompt-toggle"]').click();
    const textarea = page.locator('[data-testid="deep-dive-system-prompt-textarea"]');
    await expect(textarea).toHaveValue(DEFAULT_SYSTEM_PROMPT, { timeout: 10000 });
    const custom = 'CUSTOM PROMPT FOR REGENERATE TEST';
    await textarea.fill(custom);

    await page.locator('button:has-text("Regenerate")').click();
    await expect.poll(() => capturedBody?.systemPrompt).toBe(custom);
  });
});
