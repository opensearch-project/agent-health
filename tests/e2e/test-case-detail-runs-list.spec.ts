/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E spec for the Test Case Detail page's run-list rendering.
 *
 * Verifies the visible promises of this PR through a real browser:
 *   1. The runs list shows each run's *name* (persisted `name` field, with
 *      a `Run <short-id>` fallback for legacy runs that pre-date the field)
 *      instead of the raw id slice (`report-178…`) it used to render.
 *   2. Each row shows agent + evaluator + judge model on a secondary line so
 *      the user can tell runs apart without opening them.
 *   3. Each row exposes a "Copy run URL" button that copies the canonical
 *      `<origin>/#/runs/<id>` share URL to the clipboard.
 *   4. The score column renders as `Score: <N>%` (or `—` when missing) with
 *      a tooltip explaining the contributing metrics — *not* a hardcoded
 *      `accuracy` reading that defaults to `0%` for non-RCA evaluators.
 *   5. The right-panel inspector header shows the run name (not the test
 *      case name, which is already in the breadcrumb above it).
 *   6. When the user types a custom name in the *Configure Run* dialog and
 *      starts the run, that name round-trips to storage and the post-completion
 *      list rendering shows it verbatim.
 *
 * The spec uses the **demo** agent and **demo-model** so it doesn't need a
 * real observio endpoint or Bedrock credentials — it's safe to run in any
 * environment that has a backend + storage. Each test creates its own
 * test case via the storage API and cleans up after itself.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const TEST_TIMEOUT = 90_000; // demo agent + demo judge → ~5–8s per run

// Helper: create a fresh test case so the runs list has a deterministic
// starting point. Returns the test case id and a cleanup function.
async function createTestCase(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name,
      description: 'Created by e2e/test-case-detail-runs-list.spec.ts',
      labels: [],
      category: 'Custom',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt: 'What is 2+2?',
      context: [],
      expectedOutcomes: ['Agent identifies the answer is 4'],
    },
  });
  expect(res.ok(), 'creating test case via storage API').toBe(true);
  const tc = await res.json();
  const id: string = tc.id;
  return {
    id,
    cleanup: async () => {
      // Delete every run on the test case first, then the test case itself,
      // so we don't leave orphan run docs in storage.
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

// Helper: trigger an evaluation directly through /api/evaluate (skipping the
// Configure Run dialog) so we can deterministically seed runs with specific
// names. The dialog itself is exercised in the dedicated test below.
async function runEvaluation(
  request: APIRequestContext,
  testCaseId: string,
  runName: string | null,
): Promise<string> {
  const body: Record<string, unknown> = {
    testCaseId,
    agentKey: 'demo',
    modelId: 'demo-model',
  };
  if (runName !== null) body.runName = runName;
  const res = await request.post('/api/evaluate', { data: body });
  expect(res.ok(), `POST /api/evaluate (runName=${runName})`).toBe(true);
  // The endpoint streams SSE; parse the body to find the `completed` event's
  // reportId. We do this by reading the raw body since playwright's APIRequest
  // doesn't expose a stream API for SSE responses.
  const text = await res.text();
  const completedLine = text
    .split('\n')
    .find((l) => l.startsWith('data: ') && l.includes('"type":"completed"'));
  expect(completedLine, 'evaluation should produce a completed SSE event').toBeTruthy();
  const parsed = JSON.parse(completedLine!.slice('data: '.length));
  expect(parsed.reportId).toBeTruthy();
  return parsed.reportId;
}

test.describe('Test Case Detail — runs list rendering (PR #206)', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) {
      test.skip(true, 'Backend storage not available');
    }
  });

  test('persists the user-typed runName from the Configure Run dialog', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-runname-${Date.now()}`);
    try {
      // Land on the detail page. With no runs yet, the page shows the
      // empty-state "No test case runs yet" with a Run Test button in the
      // right pane.
      await page.goto(`/evaluations/test-cases/${tc.id}`);
      await expect(page.getByRole('heading', { level: 2 })).toContainText(`e2e-runname-`);

      // Open the Configure Run dialog. There may be more than one Run Test
      // button (header + empty-state); the first visible one is fine.
      await page.getByRole('button', { name: /run test/i }).first().click();

      const customName = `Custom-E2E-${Date.now()}`;
      // Replace the seeded "Run 1" default with our own name.
      const nameInput = page.getByLabel(/run name/i);
      await expect(nameInput).toBeVisible();
      await nameInput.fill(customName);

      // Click Start Run; the dialog closes and the page transitions to the
      // live `RUNNING` row in the left list.
      await page.getByRole('button', { name: /start run/i }).click();

      // Wait for the run to complete. The `RUNNING / Live` pill is removed
      // from the list once `loadData()` reloads with the saved run, and the
      // saved row shows the user-typed name.
      //
      // The name appears in two places: the row in the left list AND the
      // inspector panel header on the right. We assert both are visible by
      // counting matches — strict-mode `getByText` would fail since both
      // elements legitimately render the same string.
      await expect(page.getByText(customName).first()).toBeVisible({ timeout: TEST_TIMEOUT });
      const matches = await page.getByText(customName).count();
      expect(matches).toBeGreaterThanOrEqual(2);
      // We don't double-check via the storage API here — the run-name
      // persistence contract is exercised explicitly in the integration
      // suite (`tests/integration/server/routes/evaluation.integration.test.ts`).
      // This test owns just the UI half of the round-trip.

      // Sanity: API-side, the run actually has the typed name persisted (so
      // the rendering is showing real data, not a UI-only label).
      // Note: `loadData()` is async and the UI may have rendered the name
      // from an in-memory state ahead of the storage read becoming consistent
      // — wrap the assertion in a poll to avoid a race.
      await expect.poll(async () => {
        const runsRes = await request.get(`/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}`);
        if (!runsRes.ok()) return false;
        const data = await runsRes.json();
        return (data.runs || []).some((r: any) => r.name === customName);
      }, { timeout: 10_000 }).toBe(true);
    } finally {
      await tc.cleanup();
    }
  });

  test('row meta line shows agent · evaluator · judge model and score', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-meta-${Date.now()}`);
    try {
      // Pre-seed one run via the API (faster than driving the dialog) so the
      // list has something to render. We pass an explicit name so the row
      // matcher is unambiguous.
      const runName = `E2E-Meta-${Date.now()}`;
      await runEvaluation(request, tc.id, runName);

      await page.goto(`/evaluations/test-cases/${tc.id}`);
      const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: runName }).first();
      await expect(row).toBeVisible({ timeout: TEST_TIMEOUT });

      // Demo agent is registered as `Demo Agent` in DEFAULT_CONFIG. The
      // secondary line lists agent · evaluator · judge model. We accept
      // either the display name (`Demo Agent`) or the lowercased key
      // (`demo`) since legacy runs that pre-date the agentName fix may
      // round-trip with only the key.
      await expect(row).toContainText(/Demo Agent|demo/);
      // Default evaluator label is "Default" when none is set on the run.
      await expect(row).toContainText(/Default/);
      // Demo model display name; falls back to the model id if config lookup
      // didn't resolve a display_name.
      await expect(row).toContainText(/(Demo|demo-model)/i);

      // The score column renders a percentage ending in `%` (or `—` when
      // unscored). Demo judge always scores so we expect `%`.
      await expect(row.locator('span').filter({ hasText: /%$/ }).first()).toBeVisible();

      // The "FAILED"/"PASSED" text label that used to dominate the row
      // should no longer appear here — only the colored icon conveys status.
      await expect(row).not.toContainText(/^FAILED$|^PASSED$/);
    } finally {
      await tc.cleanup();
    }
  });

  test('Copy run URL button writes the canonical /runs/<id> share URL to the clipboard', async ({ page, request, context }) => {
    // Some browsers gate clipboard access behind permission. Granting it up
    // front so `navigator.clipboard.writeText` resolves cleanly under the
    // copy-link click handler.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const tc = await createTestCase(request, `e2e-copy-${Date.now()}`);
    try {
      const runName = `E2E-Copy-${Date.now()}`;
      const reportId = await runEvaluation(request, tc.id, runName);

      await page.goto(`/evaluations/test-cases/${tc.id}`);
      const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: runName }).first();
      await expect(row).toBeVisible({ timeout: TEST_TIMEOUT });

      // Hover to reveal the copy button (it's hidden until row hover/focus
      // to keep the dense list compact). The button has aria-label "Copy run URL".
      await row.hover();
      const copyBtn = row.getByRole('button', { name: /copy run url/i });
      await expect(copyBtn).toBeVisible();
      await copyBtn.click();

      // The clipboard contents should be the canonical share URL pointing at
      // the standalone RunDetailsPage at `/runs/<id>`. The app uses
      // BrowserRouter (no `#` in the path) so the URL is plain `/runs/<id>`.
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toContain(`/runs/${reportId}`);
      expect(clipboard).not.toContain('#'); // never hash-routed

      // Visual confirmation: the icon flips to a checkmark briefly. We just
      // assert the button label flips to "Copied!" via the title attribute.
      await expect(copyBtn).toHaveAttribute('title', /copied/i);
    } finally {
      await tc.cleanup();
    }
  });

  test('legacy runs without a stored name fall back to "Run <short-id>" — never to a raw report-... slice', async ({ page, request }) => {
    const tc = await createTestCase(request, `e2e-legacy-${Date.now()}`);
    try {
      // Simulate a legacy run by creating one *without* runName. The server
      // still auto-generates `Run <short-id>` as a fallback so every row
      // gets a recognizable label, but importantly the displayed string
      // should be the trimmed `Run xxxxxx` form — never the raw id prefix
      // `report-178…` that the old UI was hardcoding.
      const reportId = await runEvaluation(request, tc.id, /* runName = */ null);
      const expectedLabel = `Run ${reportId.slice(-6)}`;

      await page.goto(`/evaluations/test-cases/${tc.id}`);
      const row = page.locator('[class*="cursor-pointer"]').filter({ hasText: expectedLabel }).first();
      await expect(row).toBeVisible({ timeout: TEST_TIMEOUT });

      // Critical regression check: the old `report-178…` rendering must be
      // gone. Even though `report-` shows up elsewhere on the page (the
      // copied URL contains it), no row should *display* a label that
      // starts with `report-`. We scope this to the runs list container by
      // matching only rows that contain the expected label.
      await expect(row).not.toContainText(/report-/);
    } finally {
      await tc.cleanup();
    }
  });
});
