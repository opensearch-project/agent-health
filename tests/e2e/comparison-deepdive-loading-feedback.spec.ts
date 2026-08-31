/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison deep-dive ("What's actually different") \u2014 loading feedback and
 * error/retry (bug #1, iteration 4, 2026-09-01).
 *
 * Owner report from the live tunnel: the panel "never loads" \u2014 investigation
 * found the request itself completes (~50s for a large comparison-wide
 * analysis), but the UI gave zero feedback while waiting (a bare spinner,
 * indistinguishable from a genuine hang) and no error/retry surface if it
 * ever DID fail or time out. Fixed:
 *   - client: an elapsed-seconds counter next to the spinner, plus a
 *     reassuring hint after 30s (components/comparison/ComparisonDeepDive.tsx).
 *   - client: a bounded AbortController timeout (200s) so a stuck request
 *     surfaces a clear, retryable error instead of hanging forever.
 *   - server: comparisonDeepDiveService.ts wraps the agent call in a 180s
 *     deadline for the same reason server-side.
 *
 * Deterministic: /api/comparison/deep-dive is mocked via page.route() with a
 * controllable delay/failure, no LLM/AWS creds required.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-ddloadA';
const RUN_B = 'eval-run-ddloadB';
const TC = 'tc-ddload';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const evalRun = (id: string, agent: string, repId: string) => ({
  id, docType: 'evaluation-run', name: `Run ${agent}`, createdAt: '2026-03-01T10:00:00Z',
  status: 'completed', agentKey: agent, modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: [TC] }], trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Shared Case' }],
  results: { [TC]: { reportId: repId, status: 'completed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});
const report = (id: string, agent: string) => ({
  id, createdAt: '2026-03-01T10:00:00Z', testCaseId: TC, agentId: agent,
  modelId: 'claude-opus-4-8', status: 'completed', passFailStatus: 'passed',
  metrics: { accuracy: 100 }, performanceMetrics: { durationMs: 1000 }, trajectory: [],
});

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const u = r.request().url();
    if (u.endsWith(`/evaluation-runs/${RUN_A}`)) return json(r, evalRun(RUN_A, 'demo', 'rep-a'));
    if (u.endsWith(`/evaluation-runs/${RUN_B}`)) return json(r, evalRun(RUN_B, 'pulsar', 'rep-b'));
    if (u.endsWith('/evaluation-runs')) return json(r, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-a'), evalRun(RUN_B, 'pulsar', 'rep-b')], total: 2 });
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (r) => {
    const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-a'))) runs.push(report('rep-a', 'demo'));
    if (ids.some((id) => id.includes('rep-b'))) runs.push(report('rep-b', 'pulsar'));
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    if (u.includes('rep-a')) return json(r, report('rep-a', 'demo'));
    if (u.includes('rep-b')) return json(r, report('rep-b', 'pulsar'));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans: [], total: 0 }));
}

test.describe('Comparison deep-dive \u2014 loading feedback + error/retry (bug #1)', () => {
  test.beforeEach(async ({ page }) => { await setupRoutes(page); });

  test('shows an incrementing elapsed-seconds counter while the request is in flight, then renders the result', async ({ page }) => {
    let deepDiveCalls = 0;
    await page.route('**/api/comparison/deep-dive', async (r) => {
      deepDiveCalls++;
      await new Promise((res) => setTimeout(res, 2500));
      return json(r, { markdown: 'Both runs handled the case correctly.', modelId: 'stub/model', durationMs: 2500, runs: [] });
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const loading = page.locator('[data-testid="deep-dive-loading"]');
    await expect(loading).toBeVisible({ timeout: 10000 });
    const elapsed = page.locator('[data-testid="deep-dive-loading-elapsed"]');
    await expect(elapsed).toBeVisible();
    const firstReading = await elapsed.textContent();

    // The counter genuinely ticks forward, not a static "(0s)" placeholder.
    await page.waitForTimeout(1200);
    await expect(elapsed).not.toHaveText(firstReading || '');

    // Then the panel settles on the real markdown \u2014 not stuck loading forever.
    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText('Both runs handled the case correctly.', { timeout: 10000 });
    await expect(loading).toHaveCount(0);
    expect(deepDiveCalls).toBe(1);
  });

  test('surfaces a retryable error (never an indefinite spinner) when the deep-dive request fails, and Try again re-fires it', async ({ page }) => {
    let deepDiveCalls = 0;
    await page.route('**/api/comparison/deep-dive', async (r) => {
      deepDiveCalls++;
      if (deepDiveCalls === 1) {
        return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'agent session crashed' }) });
      }
      return json(r, { markdown: 'Recovered on retry.', modelId: 'stub/model', durationMs: 100, runs: [] });
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    await expect(page.getByText(/Couldn't generate the deep-dive/i)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="deep-dive-loading"]')).toHaveCount(0);

    const retryBtn = page.getByRole('button', { name: /try again/i });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText('Recovered on retry.', { timeout: 10000 });
    expect(deepDiveCalls).toBe(2);
  });
});
