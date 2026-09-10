/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark detail → Runs tab → "Add Run" header button.
 *
 * Owner report (2026-09-09): launching a run from Add Run left the header
 * button spinning "Running…" indefinitely on long (30–60+ min) runs. The run
 * itself completed server-side, but the button was bound to the lifetime of
 * the launching SSE connection, which idle proxies / tunnels / browsers close
 * without ever delivering the `completed` event — so the only way out was a
 * page refresh. The button must derive from the polled RUN DOCUMENT instead.
 *
 * Both tests mock the network at the browser edge (`page.route`) so they are
 * deterministic and never execute a real agent:
 *   (1) THE regression — the POST's SSE body sends `started` for a runId and
 *       then CLOSES without `completed`; the polled evaluation-runs list serves
 *       that run as `running`, then flips to `completed`. The header must read
 *       "Running…" while the doc is running and return to an ENABLED "Add Run"
 *       within a poll interval once the doc is terminal — no reload.
 *   (2) The live-tunnel manifestation — the SSE connection stays OPEN but
 *       never delivers anything after `started` (a proxy that stops relaying
 *       without closing the socket). With the old connection-bound state this
 *       spun forever; the header must still reset once the polled doc is
 *       terminal. `route.fulfill` can only send complete bodies, so this one
 *       patches `window.fetch` for that single POST to hand back a Response
 *       whose ReadableStream emits `started` and then never closes.
 *   (3) Happy path — the SSE body includes `completed`; the header resets.
 *
 * The seeded benchmark + test case are real (tracked by id, deleted after).
 * The launched run only ever exists inside the mocks.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Runs — Add Run header tracks the run document, not the SSE connection', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let testCaseId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const tc = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('addrun-reset-tc'),
        category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
      },
    });
    if (!tc.ok()) return;
    const tcJson = await tc.json();
    testCaseId = tcJson.id || tcJson.testCase?.id;
    tracker.testCase(testCaseId);

    const bm = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('addrun-reset-benchmark'),
        description: 'Add Run header reset E2E',
        testCaseIds: [testCaseId], runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId] }],
      },
    });
    if (!bm.ok()) return;
    benchmarkId = (await bm.json()).id;
    tracker.benchmark(benchmarkId);
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  /** A synthetic evaluation-run doc for the mocked list endpoint. */
  function launchedRunDoc(runId: string, status: 'running' | 'completed' | 'cancelled') {
    return {
      id: runId, docType: 'evaluation-run', name: 'Mocked launched run', benchmarkId,
      status, agentKey: 'demo', modelId: 'demo-model', trigger: 'ui',
      createdAt: new Date().toISOString(),
      ...(status !== 'running' ? { completedAt: new Date().toISOString() } : {}),
      sources: [{ type: 'benchmark', benchmarkId }],
      testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'case' }],
      results: status === 'running'
        ? { [testCaseId!]: { reportId: '', status: 'running' } }
        : { [testCaseId!]: { reportId: `report-${runId}`, status: 'completed', passFailStatus: 'passed' } },
    };
  }

  /**
   * Route the polled list endpoint (`GET /api/storage/evaluation-runs?benchmarkId=…`)
   * through a mutable status so the test can flip the run to terminal on
   * demand. The POST to the same path (the launch) is handled separately.
   */
  async function mockPolledList(page: import('@playwright/test').Page, runId: string, state: { status: 'running' | 'completed' | 'cancelled' }) {
    await page.route(/\/api\/storage\/evaluation-runs(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ evaluationRuns: [launchedRunDoc(runId, state.status)], total: 1 }),
      });
    });
  }

  async function openRunsTabAndLaunch(page: import('@playwright/test').Page) {
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const addRun = page.getByTestId('add-run-button');
    await expect(addRun).toBeVisible({ timeout: 30_000 });
    await expect(addRun).toHaveAttribute('data-run-state', 'idle');
    await expect(addRun).toBeEnabled();
    await addRun.click();
    await expect(page.getByTestId('run-config-dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Start Run/ }).click();
  }

  test('SSE stream closes without `completed` → header stays "Running…" while the polled doc is running, then returns to an enabled "Add Run" once it is terminal (no reload)', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const runId = `eval-run-e2e-dropped-${Date.now()}`;
    const polled = { status: 'running' as 'running' | 'completed' | 'cancelled' };
    await mockPolledList(page, runId, polled);

    // The launch: `started` for our runId, then the stream ENDS with no
    // `completed` — exactly what an idle proxy closing the socket looks like
    // to the browser.
    let postCount = 0;
    await page.route(/\/api\/storage\/evaluation-runs$/, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      postCount += 1;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          `event: started\ndata: ${JSON.stringify({ runId, testCases: [{ id: testCaseId, version: 1, name: 'case' }] })}\n\n`,
          ': ping\n\n',
          `event: progress\ndata: ${JSON.stringify({ runId, testCaseId, startedCount: 1, completedCount: 0, totalTestCases: 1, status: 'running' })}\n\n`,
        ].join(''),
      });
    });

    await openRunsTabAndLaunch(page);
    expect(postCount).toBe(1);
    // From here on, any `load` would be a reload — the bug's only workaround.
    const reloads: string[] = [];
    page.on('load', () => reloads.push(page.url()));

    const addRun = page.getByTestId('add-run-button');
    // Stream is gone, doc is running → truthfully "Running…", disabled.
    await expect(addRun).toHaveAttribute('data-run-state', 'running', { timeout: 10_000 });
    await expect(addRun).toContainText('Running');
    await expect(addRun).toBeDisabled();
    await expect(page.getByTestId('run-progress-panel')).toBeVisible();
    // The row for the launched run renders from the polled doc as running.
    await expect(page.locator('[data-testid="run-row"]', { hasText: 'Mocked launched run' }).getByTestId('run-status-running')).toBeVisible();

    // Hold for a few poll cycles: with the OLD code this is where the button
    // would already be stuck forever (nothing else ever reset it).
    await page.waitForTimeout(4_500);
    await expect(addRun).toHaveAttribute('data-run-state', 'running');
    await expect(addRun).toBeDisabled();

    // The server finishes the run: the polled doc turns terminal.
    polled.status = 'completed';
    await expect(addRun).toHaveAttribute('data-run-state', 'idle', { timeout: 10_000 });
    await expect(addRun).toContainText('Add Run');
    await expect(addRun).toBeEnabled();
    await expect(page.getByTestId('run-progress-panel')).toHaveCount(0);
    // The row reflects the terminal doc too.
    await expect(page.locator('[data-testid="run-row"]', { hasText: 'Mocked launched run' }).getByTestId('run-status-running')).toHaveCount(0);
    // …and all of that happened without a navigation/reload.
    expect(reloads).toHaveLength(0);

    // Add Run is usable again: it opens the dialog rather than alerting.
    await addRun.click();
    await expect(page.getByTestId('run-config-dialog')).toBeVisible();
  });

  test('SSE connection stays open but goes silent after `started` (tunnel stops relaying) → header still resets when the polled doc is terminal', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const runId = `eval-run-e2e-hung-${Date.now()}`;
    const polled = { status: 'running' as 'running' | 'completed' | 'cancelled' };
    await mockPolledList(page, runId, polled);

    // A never-ending SSE response for the launch POST: `started`, then
    // silence with the stream held open. Everything else uses real fetch.
    await page.addInitScript(({ runId, testCaseId }) => {
      const realFetch = window.fetch.bind(window);
      (window as any).__hungSseOpen = false;
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'POST' && /\/api\/storage\/evaluation-runs$/.test(url)) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                `event: started\ndata: ${JSON.stringify({ runId, testCases: [{ id: testCaseId, version: 1, name: 'case' }] })}\n\n`
              ));
              (window as any).__hungSseOpen = true;
              // …and never close.
            },
            cancel() { (window as any).__hungSseOpen = false; },
          });
          return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        }
        return realFetch(input as any, init);
      };
    }, { runId, testCaseId });

    await openRunsTabAndLaunch(page);
    const addRun = page.getByTestId('add-run-button');
    await expect(addRun).toHaveAttribute('data-run-state', 'running', { timeout: 10_000 });
    await expect(addRun).toBeDisabled();
    // The launching stream really is still open.
    await expect.poll(() => page.evaluate(() => (window as any).__hungSseOpen)).toBe(true);

    await page.waitForTimeout(4_500);
    await expect(addRun).toHaveAttribute('data-run-state', 'running');

    polled.status = 'completed';
    await expect(addRun).toHaveAttribute('data-run-state', 'idle', { timeout: 10_000 });
    await expect(addRun).toContainText('Add Run');
    await expect(addRun).toBeEnabled();
    // …while the stale stream is STILL open — proof the header no longer
    // depends on it.
    expect(await page.evaluate(() => (window as any).__hungSseOpen)).toBe(true);
  });

  test('happy path: SSE delivers `completed` → header returns to "Add Run"', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const runId = `eval-run-e2e-completed-${Date.now()}`;
    // The polled list already sees the run as terminal (the server persists
    // the terminal doc before it emits `completed`).
    await mockPolledList(page, runId, { status: 'completed' });

    await page.route(/\/api\/storage\/evaluation-runs$/, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          `event: started\ndata: ${JSON.stringify({ runId, testCases: [{ id: testCaseId, version: 1, name: 'case' }] })}\n\n`,
          ': ping\n\n',
          `event: completed\ndata: ${JSON.stringify(launchedRunDoc(runId, 'completed'))}\n\n`,
        ].join(''),
      });
    });

    await openRunsTabAndLaunch(page);

    const addRun = page.getByTestId('add-run-button');
    await expect(addRun).toHaveAttribute('data-run-state', 'idle', { timeout: 10_000 });
    await expect(addRun).toContainText('Add Run');
    await expect(addRun).toBeEnabled();
    await expect(page.getByTestId('run-progress-panel')).toHaveCount(0);
  });
});
