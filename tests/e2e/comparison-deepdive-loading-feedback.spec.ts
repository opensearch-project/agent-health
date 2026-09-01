/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison deep-dive ("What's actually different") \u2014 async job pattern
 * (iteration 5) + loading feedback / error / retry (bug #1, iteration 4).
 *
 * Iteration 4 found the deep-dive request itself completes (~50s for a large
 * comparison-wide analysis) but the UI gave zero feedback while waiting.
 * Iteration 5's owner report: the PUBLIC TUNNEL PROXY enforces a gateway
 * timeout SHORTER than that generation time, so holding the whole generation
 * inside one long-lived POST dies with a 524 for tunnel users even though
 * localhost works fine \u2014 an in-request deadline can't fix a proxy timing
 * out the connection out from under it. Fixed by converting the endpoint to
 * an async job:
 *   - POST /api/comparison/deep-dive validates + kicks off generation
 *     in-process, returns { jobId } in well under a second \u2014 no connection
 *     is ever held open for the actual generation.
 *   - GET /api/comparison/deep-dive/jobs/:jobId is polled every ~2.5s until
 *     status is 'done' (result) or 'error'.
 *   - The elapsed-seconds counter next to the spinner (iteration 4) is
 *     unchanged \u2014 it just now ticks across POST + however many polls a
 *     generation takes, instead of across one long fetch.
 *   - Regenerate cancels/ignores any still-in-flight poll loop from a
 *     previous generation.
 *
 * Deterministic: /api/comparison/deep-dive (+ /jobs/:jobId) mocked via the
 * shared mockDeepDiveJob() fixture helper, no LLM/AWS creds required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
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

test.describe('Comparison deep-dive \u2014 async job pattern + loading feedback + error/retry', () => {
  test.beforeEach(async ({ page }) => { await setupRoutes(page); });

  test('POST returns fast (well under a second) and never holds a connection open across the full generation', async ({ page }) => {
    await mockDeepDiveJob(page, {
      result: { markdown: 'Both runs handled the case correctly.', modelId: 'stub/model', durationMs: 2500, runs: [] },
      runningPolls: 1,
    });

    let postTimeMs = -1;
    page.on('response', (res) => {
      if (res.url().endsWith('/api/comparison/deep-dive') && res.request().method() === 'POST') {
        postTimeMs = Date.now();
      }
    });
    const t0 = Date.now();
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect.poll(() => postTimeMs).toBeGreaterThan(0);
    // The whole point of the async-job conversion: POST settles almost
    // immediately (jobId only) -- nowhere near the ~2.5s+ the mocked
    // generation itself simulates via runningPolls.
    expect(postTimeMs - t0).toBeLessThan(2000);
  });

  test('polls across multiple "running" responses, ticking the elapsed-seconds counter, and reaches the rendered result', async ({ page }) => {
    await mockDeepDiveJob(page, {
      result: { markdown: 'Both runs handled the case correctly.', modelId: 'stub/model', durationMs: 2500, runs: [] },
      // 2 'running' ticks before 'done' -- proves this is genuinely polling,
      // not a single-shot response dressed up as a job.
      runningPolls: 2,
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const loading = page.locator('[data-testid="deep-dive-loading"]');
    await expect(loading).toBeVisible({ timeout: 10000 });
    const elapsed = page.locator('[data-testid="deep-dive-loading-elapsed"]');
    await expect(elapsed).toBeVisible();
    const firstReading = await elapsed.textContent();

    // The counter genuinely ticks forward across polls, not a static "(0s)" placeholder.
    await page.waitForTimeout(1200);
    await expect(elapsed).not.toHaveText(firstReading || '');

    // Then the panel settles on the real markdown -- not stuck loading forever.
    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText('Both runs handled the case correctly.', { timeout: 15000 });
    await expect(loading).toHaveCount(0);
  });

  test('a job that settles in the error state surfaces a retryable error (never an indefinite spinner), and Try again starts a fresh job', async ({ page }) => {
    await mockDeepDiveJob(page, { errorMessage: 'agent session crashed' });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    await expect(page.getByText(/Couldn't generate the deep-dive/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/agent session crashed/i)).toBeVisible();
    await expect(page.locator('[data-testid="deep-dive-loading"]')).toHaveCount(0);

    // Re-mock a successful job for the retry.
    await mockDeepDiveJob(page, { result: { markdown: 'Recovered on retry.', modelId: 'stub/model', durationMs: 100, runs: [] } });

    const retryBtn = page.getByRole('button', { name: /try again/i });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText('Recovered on retry.', { timeout: 10000 });
  });

  test('a synchronous POST failure (before any job is created) surfaces immediately, never issuing a poll', async ({ page }) => {
    let jobsPolled = false;
    await page.route('**/api/comparison/deep-dive/jobs/**', (r) => { jobsPolled = true; return r.abort(); });
    await page.route('**/api/comparison/deep-dive', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'storage lookup failed' }) })
    );

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    await expect(page.getByText(/Couldn't generate the deep-dive/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/storage lookup failed/i)).toBeVisible();
    expect(jobsPolled).toBe(false);
  });

  test('a 404 on GET .../jobs/:jobId mid-poll (job evicted / server restarted) surfaces a visible, retryable error — never an infinite poll (hardening round, codex review of PR #460)', async ({ page }) => {
    let pollCount = 0;
    await page.route('**/api/comparison/deep-dive', (r) =>
      r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'evicted-job' }) })
    );
    await page.route('**/api/comparison/deep-dive/jobs/evicted-job', (r) => {
      pollCount++;
      if (pollCount === 1) {
        // First poll: genuinely still running.
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running', elapsedMs: 2500 }) });
      }
      // Every poll after that: the job is GONE (TTL/retained-cap eviction,
      // or the server restarted mid-poll and lost all in-memory jobs) —
      // exactly what server/routes/comparison.ts's GET handler returns for
      // an unknown jobId.
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'job not found: evicted-job' }) });
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // Loading first (the first poll said "running")...
    await expect(page.locator('[data-testid="deep-dive-loading"]')).toBeVisible({ timeout: 10000 });

    // ...then a VISIBLE error, not an infinite spinner — the very next poll
    // 404s and the client must treat that as terminal, not just retry
    // forever silently.
    await expect(page.getByText(/Couldn't generate the deep-dive/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/job not found/i)).toBeVisible();
    await expect(page.locator('[data-testid="deep-dive-loading"]')).toHaveCount(0);

    // And it's genuinely retryable: Try again starts a FRESH job (new jobId),
    // which is polled independently of the evicted one.
    await page.route('**/api/comparison/deep-dive', (r) =>
      r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'fresh-job' }) })
    );
    await page.route('**/api/comparison/deep-dive/jobs/fresh-job', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'done', elapsedMs: 100, result: { markdown: 'Recovered after eviction.', modelId: 'stub/model', durationMs: 100, runs: [] } }) })
    );

    await page.getByRole('button', { name: /try again/i }).click();
    await expect(page.locator('[data-testid="comparison-deep-dive"]')).toContainText('Recovered after eviction.', { timeout: 10000 });
  });
});
