/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E spec for the inline live-run UX on the Test Case Detail page.
 *
 * The page used to launch a full-screen `QuickRunModal` that locked body
 * scroll and disabled its own close button while running — users were
 * stuck staring at a popup until the agent finished. This PR replaces
 * that with an inline run that mirrors `BenchmarkRunsPage`'s pill +
 * progress UX, and follow-up tweaks made the Definition section always
 * open and removed the redundant Overview tab from the live panel.
 *
 * What we verify here:
 *   1. `Run Test` opens a small `Configure Run` dialog (NOT the legacy
 *      blocking `QuickRunModal`). The page is still scrollable behind
 *      it (no `body { overflow: hidden }`) and the dialog has the
 *      expected fields plus Cancel + Start Run.
 *   2. The Definition section is always rendered above the runs list —
 *      no toggle, no chevron, no click required to see the prompt and
 *      expected outcomes.
 *   3. Once `Start Run` is clicked, the dialog closes immediately and
 *      the page transitions to the inline running state:
 *        - The header `Run Test` button becomes a disabled `Running…`
 *          pill, and `Edit` is also disabled.
 *        - A synthetic `RUNNING` row with a `Live` badge is pinned at
 *          the top of the runs list.
 *        - The right pane shows a `LiveRunPanel` with the *same* tab
 *          strip as the saved-run inspector — Test Case Output
 *          (active by default), Traces, Judge Evaluation, Annotations — but
 *          *no Overview tab*, since the Definition section to the left
 *          already covers that information.
 *        - The left sidebar remains clickable: the page is fully
 *          interactive, never covered by a modal backdrop.
 *   4. Each placeholder tab on the live panel renders a meaningful
 *      empty-state explaining when its data will arrive.
 *
 * Each test creates its own test case via the storage API and cleans
 * up (test case + every run it spawned) in a `finally` block.
 *
 * The running-state tests intercept `POST /api/evaluate` and hold the
 * SSE stream open. Without that, the demo agent finishes in under a
 * second and the page transitions to the saved-run inspector before
 * any live-state assertion can fire.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const TEST_TIMEOUT = 120_000;

// ── /api/evaluate interceptor ───────────────────────────────────────────────

/**
 * Intercept POST /api/evaluate so it streams a long-lived SSE response
 * that never reaches the `completed` event. This holds the page in the
 * inline running state long enough for LiveRunPanel assertions.
 *
 * Returns a `release()` callback that emits a synthetic `error` event
 * and closes the connection so the page exits the running state cleanly.
 *
 * The route is registered on `page` *before* navigation; once the
 * request fires, the handler dispatches a single `started` event (so
 * the client records `reportId` for its polling-fallback path) and then
 * keeps the response body open until `release()` is called.
 *
 * We don't bother sending `completed` — the only thing we'd lose is a
 * saved-run row, and the test's `cleanup()` deletes the test case
 * anyway. The synthetic `reportId` doesn't need to map to anything in
 * storage during the live state; the page only uses it as an opaque
 * label and for the (unused) reconnect path.
 */
async function holdEvaluateOpen(page: Page): Promise<() => Promise<void>> {
  const enc = new TextEncoder();
  const synthReportId = `report-e2e-${Date.now()}`;
  const startedFrame = enc.encode(
    `data: ${JSON.stringify({ type: 'started', reportId: synthReportId })}\n\n`,
  );
  const errorFrame = enc.encode(
    `data: ${JSON.stringify({ type: 'error', error: 'released by test' })}\n\n`,
  );

  // Track all stream controllers we've handed to Playwright so the teardown
  // function can flush+close every one of them. We *must* create a fresh
  // ReadableStream per intercepted request: a single shared stream gets
  // closed after the first request consumes it, so any retry / parallel
  // request (which Playwright + the SPA's reconnect logic can both
  // produce) would receive an already-closed body and the test would hang
  // on the started frame that never arrived. Move construction into the
  // route handler.
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];

  await page.route('**/api/evaluate', async (route) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controllers.push(c);
        // Send the started frame as soon as the stream is consumed; the
        // route handler below provides the response shell.
        c.enqueue(startedFrame);
      },
    });
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: body as unknown as Buffer,
    });
  });

  return async () => {
    for (const controller of controllers) {
      try {
        controller.enqueue(errorFrame);
        controller.close();
      } catch {
        // Already closed — best-effort, the test is tearing down anyway.
      }
    }
    await page.unroute('**/api/evaluate').catch(() => {});
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

interface TestCaseFixture {
  id: string;
  initialPrompt: string;
  expectedOutcome: string;
  cleanup: () => Promise<void>;
}

async function createTestCase(
  request: APIRequestContext,
  name: string,
): Promise<TestCaseFixture> {
  // Embed a unique marker in the prompt + outcome so DOM assertions can't
  // false-positive on copy that happens to live elsewhere on the page.
  const stamp = Date.now();
  const initialPrompt = `live-run-input-${stamp}: what is 2+2?`;
  const expectedOutcome = `live-run-expected-${stamp}: agent answers 4`;
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name,
      description: 'Created by e2e/test-case-detail-live-run.spec.ts',
      labels: [],
      category: 'Custom',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt,
      context: [],
      expectedOutcomes: [expectedOutcome],
    },
  });
  expect(res.ok(), 'creating test case via storage API').toBe(true);
  const tc = await res.json();
  const id: string = tc.id;
  return {
    id,
    initialPrompt,
    expectedOutcome,
    cleanup: async () => {
      const runsRes = await request.get(`/api/storage/runs/by-test-case/${encodeURIComponent(id)}`);
      if (runsRes.ok()) {
        const data = await runsRes.json();
        for (const r of data.runs || []) {
          if (typeof r.id === 'string' && r.id.startsWith('report-')) {
            await request.delete(`/api/storage/runs/${encodeURIComponent(r.id)}`).catch(() => {});
          }
        }
      }
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    },
  };
}

// Trigger an evaluation through /api/evaluate (skipping the dialog) so
// we can pre-seed runs deterministically. Uses the demo agent + demo
// judge so it works without external creds. Returns the saved reportId.
async function runEvaluation(
  request: APIRequestContext,
  testCaseId: string,
  runName: string,
): Promise<string> {
  const res = await request.post('/api/evaluate', {
    data: { testCaseId, agentKey: 'demo', modelId: 'demo-model', runName },
  });
  expect(res.ok(), `POST /api/evaluate (runName=${runName})`).toBe(true);
  const text = await res.text();
  const completedLine = text
    .split('\n')
    .find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
  expect(completedLine, 'evaluation should produce a completed SSE event').toBeTruthy();
  const parsed = JSON.parse(completedLine!.slice('data: '.length));
  expect(parsed.reportId).toBeTruthy();
  return parsed.reportId;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe('Test Case Detail — inline live-run UX (PR #228)', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) {
      test.skip(true, 'Backend storage not available');
    }
  });

  test('Definition section is always rendered above the runs list (no toggle)', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-definition-open-${Date.now()}`);
    try {
      // Pre-seed a run so the page renders the split-pane layout (the
      // Definition was always-open in the empty-state full-width layout
      // already; the regression we care about is the split-pane left
      // column, where the toggle used to live).
      await runEvaluation(request, tc.id, `E2E-Seed-${Date.now()}`);

      await page.goto(`/evaluations/test-cases/${tc.id}`);
      await expect(page.getByRole('heading', { level: 2 })).toContainText('e2e-definition-open-');

      // The runs list header confirms we're in the split-pane layout.
      await expect(page.getByText(/^Test Case Runs/i).first()).toBeVisible();

      // The Definition heading must be present without any click. CSS
      // applies `uppercase`, so the visual is `DEFINITION` but the DOM
      // text is `Definition`. Match case-insensitively.
      const definitionHeading = page.getByText(/^Definition$/i).first();
      await expect(definitionHeading).toBeVisible();

      // Regression: it must NOT be inside a `<button>` (the chevron
      // toggle was removed; clicking the heading no longer collapses
      // anything).
      const isInsideButton = await definitionHeading.evaluate(
        (el) => !!el.closest('button'),
      );
      expect(isInsideButton, 'Definition heading should not be inside a <button>').toBe(false);

      // The Input prompt + Expected outcome are visible without clicking.
      // Both were seeded with unique markers above. Use `.first()` because
      // the right-side inspector — mounted because we pre-seeded a run —
      // also renders these strings in its Overview tab.
      await expect(page.getByText(tc.initialPrompt).first()).toBeVisible();
      await expect(page.getByText(tc.expectedOutcome).first()).toBeVisible();

      // Sanity: the Definition heading appears *above* the runs list.
      const order = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
        const def = all.find(
          (el) => el.children.length === 0 && /^Definition$/i.test((el.textContent || '').trim()),
        );
        const runs = all.find(
          (el) => el.children.length === 0 && /^Test Case Runs/i.test((el.textContent || '').trim()),
        );
        if (!def || !runs) return 'missing';
        // eslint-disable-next-line no-bitwise
        return def.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING
          ? 'def-before-runs'
          : 'runs-before-def';
      });
      expect(order).toBe('def-before-runs');
    } finally {
      await tc.cleanup();
    }
  });

  test('Run Test opens an inline Configure Run dialog (not the legacy QuickRunModal)', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-config-dialog-${Date.now()}`);
    try {
      await page.goto(`/evaluations/test-cases/${tc.id}`);
      await expect(page.getByRole('heading', { level: 2 })).toContainText('e2e-config-dialog-');

      await page.getByRole('button', { name: /^run test$/i }).first().click();

      // Configure Run dialog is visible with all expected fields.
      await expect(page.getByText('Configure Run', { exact: true })).toBeVisible();
      const nameInput = page.getByLabel(/run name/i);
      await expect(nameInput).toBeVisible();
      // Auto-populated default is `Run <N>` where N is `runs.length + 1`.
      const seededName = await nameInput.inputValue();
      expect(seededName).toMatch(/^Run\s+\d+$/);

      await expect(page.getByLabel(/description/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /^cancel$/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^start run$/i })).toBeVisible();

      // Critical regression: the body must NOT have its overflow locked.
      // QuickRunModal used to set `body.style.overflow = 'hidden'`, which
      // prevented users from scrolling the page underneath. Empty / `auto`
      // / `visible` are all OK; `hidden` would mean we regressed.
      const bodyOverflow = await page.evaluate(() => document.body.style.overflow);
      expect(bodyOverflow, 'body overflow must not be locked while dialog is open').not.toBe('hidden');

      // Cancel dismisses the dialog cleanly.
      await page.getByRole('button', { name: /^cancel$/i }).click();
      await expect(page.getByText('Configure Run', { exact: true })).toBeHidden();
    } finally {
      await tc.cleanup();
    }
  });

  test('Start Run transitions to inline running state with the right tab strip', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-live-tabs-${Date.now()}`);
    // Hold the SSE stream open so the page stays in the running state
    // long enough to inspect. Without this, the demo agent finishes in
    // ~1s and the page jumps to the saved-run inspector.
    const releaseStream = await holdEvaluateOpen(page);
    try {
      await page.goto(`/evaluations/test-cases/${tc.id}`);
      await expect(page.getByRole('heading', { level: 2 })).toContainText('e2e-live-tabs-');

      await page.getByRole('button', { name: /^run test$/i }).first().click();
      await expect(page.getByText('Configure Run', { exact: true })).toBeVisible();
      await page.getByLabel(/run name/i).fill(`E2E-Live-${Date.now()}`);
      await page.getByRole('button', { name: /^start run$/i }).click();

      // Dialog closes immediately.
      await expect(page.getByText('Configure Run', { exact: true })).toBeHidden();

      // Header pill replaces the `Run Test` button. The Unicode ellipsis
      // is a single character; match it with `/running/i`.
      const runningPill = page.getByRole('button', { name: /running/i });
      await expect(runningPill).toBeVisible({ timeout: 15_000 });
      await expect(runningPill).toBeDisabled();
      await expect(page.getByRole('button', { name: /^edit$/i })).toBeDisabled();

      // The synthetic `Live` row is pinned at the top of the runs list.
      await expect(page.getByText('Live', { exact: true }).first()).toBeVisible();

      // ── LiveRunPanel tab strip assertions ──────────────────────────
      // The right pane mounts a Tabs component with exactly four tabs:
      // Test Case Output (active), Traces, Judge Evaluation, Annotations.
      // The Overview tab was deliberately removed because the Definition
      // section to the left already covers that information.
      //
      // We assert this against the page's tabs directly: in the running
      // state, only the LiveRunPanel tablist is mounted on the page, so
      // `page.getByRole('tab')` resolves to exactly its four tabs.
      // (The saved-run inspector — which has its own Overview tab — only
      // mounts after the run completes; for in-flight runs we know the
      // page can't have one.)
      const testCaseOutputTab = page.getByRole('tab', {
        selected: true,
        name: /^Test Case Output/,
      });
      await expect(testCaseOutputTab).toBeVisible({ timeout: 10_000 });

      // The four tabs the LiveRunPanel renders.
      await expect(page.getByRole('tab', { name: /^Test Case Output/ })).toHaveCount(1);
      await expect(page.getByRole('tab', { name: /^Traces$/ })).toHaveCount(1);
      await expect(page.getByRole('tab', { name: /^Judge Evaluation$/ })).toHaveCount(1);
      await expect(page.getByRole('tab', { name: /^Annotations$/ })).toHaveCount(1);

      // Critical regression: the LiveRunPanel must NOT render an Overview
      // tab. (Saved-run inspectors elsewhere have one; in this test we've
      // asserted we're in the live state via the selected Conversation
      // History tab, so if Overview is anywhere it'd be a real regression.)
      await expect(page.getByRole('tab', { name: /^Overview$/ })).toHaveCount(0);

      // Sanity: the sidebar nav is still interactive — the page is not
      // covered by a modal backdrop. Use the stable nav testid (the sidebar
      // item's role/label varies with collapsed state).
      await expect(page.locator('[data-testid="nav-skills"]').first()).toBeVisible();
    } finally {
      await releaseStream();
      await tc.cleanup();
    }
  });

  test('LiveRunPanel placeholder tabs explain when their data will arrive', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-live-placeholders-${Date.now()}`);
    const releaseStream = await holdEvaluateOpen(page);
    try {
      await page.goto(`/evaluations/test-cases/${tc.id}`);
      await expect(page.getByRole('heading', { level: 2 })).toContainText('e2e-live-placeholders-');

      await page.getByRole('button', { name: /^run test$/i }).first().click();
      await expect(page.getByText('Configure Run', { exact: true })).toBeVisible();
      await page.getByLabel(/run name/i).fill(`E2E-Placeholders-${Date.now()}`);
      await page.getByRole('button', { name: /^start run$/i }).click();

      // Wait for the LiveRunPanel to mount (Test Case Output is
      // selected by default while running).
      await expect(
        page.getByRole('tab', { selected: true, name: /^Test Case Output/ }),
      ).toBeVisible({ timeout: 15_000 });

      // Traces tab placeholder.
      await page.getByRole('tab', { name: /^Traces$/ }).click();
      await expect(
        page.getByText(/Traces will appear here when the run completes/i),
      ).toBeVisible();

      // Judge Evaluation tab placeholder.
      await page.getByRole('tab', { name: /^Judge Evaluation$/ }).click();
      await expect(
        page.getByText(/Judge evaluation will appear here once judging completes/i),
      ).toBeVisible();

      // Annotations tab placeholder.
      await page.getByRole('tab', { name: /^Annotations$/ }).click();
      await expect(
        page.getByText(/Annotations are available after the run is saved/i),
      ).toBeVisible();

      // Going back to Test Case Output shows the live trajectory
      // chrome (INPUT prompt + TEST CASE OUTPUT heading).
      await page.getByRole('tab', { name: /^Test Case Output/ }).click();
      await expect(page.getByText(/^INPUT$/i).first()).toBeVisible();
      await expect(page.getByText(/^TEST CASE OUTPUT$/i).first()).toBeVisible();
    } finally {
      await releaseStream();
      await tc.cleanup();
    }
  });
});
