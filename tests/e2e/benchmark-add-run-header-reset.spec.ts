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
 * page refresh. Launched runs must be tracked by their polled RUN DOCUMENT.
 *
 * Owner clarification (2026-09-13): the real pain was that ANY in-flight run
 * turned "Add Run" into a disabled "Running…" button — the owner launches 2–4
 * arms on the same benchmark back-to-back and had to refresh between them.
 * Add Run must NEVER be blocked by running runs: the header shows a
 * non-blocking `● N running` pill and one progress block per launched run.
 *
 * All tests mock the network at the browser edge (`page.route`) so they are
 * deterministic and never execute a real agent:
 *   (1) THE regression — one run in flight (POST SSE sends `started`, polled
 *       list serves it `running`): the header button is ENABLED and reads
 *       "Add Run", the pill reads "● 1 running"; clicking Add Run opens the
 *       dialog and launching a SECOND run yields "● 2 running" and two
 *       progress blocks — the first one untouched.
 *   (2) The POST's SSE body sends `started` and then CLOSES without
 *       `completed`; the polled list serves the run as `running`, then flips
 *       to `completed`. The progress block must stay (driven by polling) and
 *       disappear once the doc is terminal — no reload.
 *   (3) The live-tunnel manifestation — the SSE connection stays OPEN but
 *       never delivers anything after `started`. `route.fulfill` can only send
 *       complete bodies, so this one patches `window.fetch` for that single
 *       POST to hand back a Response whose ReadableStream never closes.
 *   (4) Happy path — the SSE body includes `completed`; the block goes away.
 *
 * The seeded benchmark + test case are real (tracked by id, deleted after).
 * The launched runs only ever exist inside the mocks.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

type DocStatus = 'running' | 'completed' | 'cancelled';

test.describe('Benchmark Runs — Add Run is never blocked by running runs; launched runs track their polled docs', () => {
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
        description: 'Add Run header E2E',
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
  function launchedRunDoc(runId: string, status: DocStatus, name = 'Mocked launched run') {
    return {
      id: runId, docType: 'evaluation-run', name, benchmarkId,
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
   * through a mutable doc table so a test can add runs / flip them terminal
   * on demand. The POST to the same path (the launch) is handled separately.
   */
  async function mockPolledList(page: import('@playwright/test').Page, docs: Record<string, { status: DocStatus; name?: string }>) {
    await page.route(/\/api\/storage\/evaluation-runs(\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const evaluationRuns = Object.entries(docs).map(([id, d]) => launchedRunDoc(id, d.status, d.name));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ evaluationRuns, total: evaluationRuns.length }),
      });
    });
  }

  function sseStarted(runId: string) {
    return `event: started\ndata: ${JSON.stringify({ runId, testCases: [{ id: testCaseId, version: 1, name: 'case' }] })}\n\n`;
  }

  async function openRunsTab(page: import('@playwright/test').Page) {
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const addRun = page.getByTestId('add-run-button');
    await expect(addRun).toBeVisible({ timeout: 30_000 });
    await expect(addRun).toHaveAttribute('data-run-state', 'idle');
    await expect(addRun).toBeEnabled();
  }

  async function launchViaDialog(page: import('@playwright/test').Page) {
    await page.getByTestId('add-run-button').click();
    await expect(page.getByTestId('run-config-dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Start Run/ }).click();
  }

  test('THE REGRESSION: with a run in flight the header stays an ENABLED "Add Run" with a "● 1 running" pill; launching a second run → "● 2 running" and two progress blocks, the first untouched', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const firstId = `eval-run-e2e-arm-a-${Date.now()}`;
    const secondId = `eval-run-e2e-arm-b-${Date.now()}`;
    const docs: Record<string, { status: DocStatus; name?: string }> = {};
    await mockPolledList(page, docs);

    // Each launch POST: `started` for the next arm, then the stream closes
    // (the run keeps executing server-side; the doc appears in the list).
    const launchIds = [firstId, secondId];
    let postCount = 0;
    await page.route(/\/api\/storage\/evaluation-runs$/, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const runId = launchIds[Math.min(postCount, launchIds.length - 1)];
      postCount += 1;
      docs[runId] = { status: 'running', name: runId === firstId ? 'Arm A' : 'Arm B' };
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: sseStarted(runId) + ': ping\n\n',
      });
    });

    await openRunsTab(page);
    await expect(page.getByTestId('runs-in-flight-pill')).toHaveCount(0);
    await launchViaDialog(page);
    expect(postCount).toBe(1);

    const addRun = page.getByTestId('add-run-button');
    const pill = page.getByTestId('runs-in-flight-pill');
    const panels = page.getByTestId('run-progress-panel');

    // One run in flight: the button is NOT blocked, the pill counts it.
    await expect(panels).toHaveCount(1);
    await expect(pill).toHaveText(/●\s*1 running/, { timeout: 10_000 });
    await expect(addRun).toHaveAttribute('data-run-state', 'idle');
    await expect(addRun).toBeEnabled();
    await expect(addRun).toContainText('Add Run');
    await expect(addRun).not.toContainText('Running');
    await expect(panels.first()).toHaveAttribute('data-run-id', firstId);
    await expect(panels.first().getByTestId('run-progress-name')).toHaveText('Arm A');

    // A couple of poll cycles later it is still free (with the old code the
    // button was disabled "Running…" for the entire run).
    await page.waitForTimeout(4_500);
    await expect(addRun).toBeEnabled();
    await expect(addRun).toContainText('Add Run');

    // Launch the second arm WITHOUT any reload.
    const reloads: string[] = [];
    page.on('load', () => reloads.push(page.url()));
    await launchViaDialog(page);
    expect(postCount).toBe(2);

    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toHaveAttribute('data-run-id', firstId); // first block not reset/hidden
    await expect(panels.nth(1)).toHaveAttribute('data-run-id', secondId);
    await expect(pill).toHaveText(/●\s*2 running/, { timeout: 10_000 });
    await expect(addRun).toBeEnabled();
    await expect(addRun).toContainText('Add Run');
    expect(reloads).toHaveLength(0);

    // The pill links to the table narrowed to running rows.
    await pill.click();
    await expect(page.getByTestId('run-filter-pills')).toBeVisible();
    await expect(page.getByTestId('run-filter-pill')).toHaveCount(1);
    await expect(page.getByTestId('run-filter-pill')).toContainText('running');
    await expect(page.getByTestId('run-row')).toHaveCount(2);

    // Arm A finishes: only its block leaves; the pill drops to 1.
    docs[firstId] = { status: 'completed', name: 'Arm A' };
    await expect(panels).toHaveCount(1, { timeout: 10_000 });
    await expect(panels.first()).toHaveAttribute('data-run-id', secondId);
    await expect(pill).toHaveText(/●\s*1 running/, { timeout: 10_000 });

    docs[secondId] = { status: 'completed', name: 'Arm B' };
    await expect(panels).toHaveCount(0, { timeout: 10_000 });
    await expect(pill).toHaveCount(0, { timeout: 10_000 });
    await expect(addRun).toBeEnabled();
  });

  test('SSE stream closes without `completed` → the progress block stays while the polled doc is running (not flipped to failed), then leaves once it is terminal (no reload)', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const runId = `eval-run-e2e-dropped-${Date.now()}`;
    const docs: Record<string, { status: DocStatus }> = { [runId]: { status: 'running' } };
    await mockPolledList(page, docs);

    let postCount = 0;
    await page.route(/\/api\/storage\/evaluation-runs$/, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      postCount += 1;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          sseStarted(runId),
          ': ping\n\n',
          `event: progress\ndata: ${JSON.stringify({ runId, testCaseId, startedCount: 1, completedCount: 0, totalTestCases: 1, status: 'running' })}\n\n`,
        ].join(''),
      });
    });

    await openRunsTab(page);
    await launchViaDialog(page);
    expect(postCount).toBe(1);
    const reloads: string[] = [];
    page.on('load', () => reloads.push(page.url()));

    const addRun = page.getByTestId('add-run-button');
    const panel = page.getByTestId('run-progress-panel');
    await expect(panel).toHaveCount(1, { timeout: 10_000 });
    await expect(panel).toHaveAttribute('data-run-id', runId);
    await expect(page.getByTestId('run-launch-error')).toHaveCount(0);
    await expect(addRun).toBeEnabled();
    // The row for the launched run renders from the polled doc as running.
    await expect(page.locator('[data-testid="run-row"]', { hasText: 'Mocked launched run' }).getByTestId('run-status-running')).toBeVisible();

    // Hold for a few poll cycles: the block is driven by polling now.
    await page.waitForTimeout(4_500);
    await expect(panel).toHaveCount(1);
    await expect(page.getByTestId('runs-in-flight-pill')).toHaveText(/1 running/);

    // The server finishes the run: the polled doc turns terminal.
    docs[runId] = { status: 'completed' };
    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('runs-in-flight-pill')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-row"]', { hasText: 'Mocked launched run' }).getByTestId('run-status-running')).toHaveCount(0);
    expect(reloads).toHaveLength(0);
    await expect(addRun).toBeEnabled();
  });

  test('SSE connection stays open but goes silent after `started` (tunnel stops relaying) → block still leaves when the polled doc is terminal', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const runId = `eval-run-e2e-hung-${Date.now()}`;
    const docs: Record<string, { status: DocStatus }> = { [runId]: { status: 'running' } };
    await mockPolledList(page, docs);

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

    await openRunsTab(page);
    await launchViaDialog(page);
    const addRun = page.getByTestId('add-run-button');
    const panel = page.getByTestId('run-progress-panel');
    await expect(panel).toHaveCount(1, { timeout: 10_000 });
    // The header is free even though the launching stream is still open.
    await expect(addRun).toBeEnabled();
    await expect(addRun).toHaveAttribute('data-run-state', 'idle');
    await expect.poll(() => page.evaluate(() => (window as any).__hungSseOpen)).toBe(true);

    await page.waitForTimeout(4_500);
    await expect(panel).toHaveCount(1);

    docs[runId] = { status: 'completed' };
    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(addRun).toBeEnabled();
    // …while the stale stream is STILL open — proof the page no longer
    // depends on it.
    expect(await page.evaluate(() => (window as any).__hungSseOpen)).toBe(true);
  });

  test('happy path: SSE delivers `completed` → the progress block goes away; Add Run was never disabled', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark (storage not configured?)');
    const runId = `eval-run-e2e-completed-${Date.now()}`;
    // The polled list already sees the run as terminal (the server persists
    // the terminal doc before it emits `completed`).
    await mockPolledList(page, { [runId]: { status: 'completed' } });

    await page.route(/\/api\/storage\/evaluation-runs$/, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          sseStarted(runId),
          ': ping\n\n',
          `event: completed\ndata: ${JSON.stringify(launchedRunDoc(runId, 'completed'))}\n\n`,
        ].join(''),
      });
    });

    await openRunsTab(page);
    await launchViaDialog(page);

    const addRun = page.getByTestId('add-run-button');
    await expect(addRun).toHaveAttribute('data-run-state', 'idle', { timeout: 10_000 });
    await expect(addRun).toContainText('Add Run');
    await expect(addRun).toBeEnabled();
    await expect(page.getByTestId('run-progress-panel')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('runs-in-flight-pill')).toHaveCount(0);
  });
});
