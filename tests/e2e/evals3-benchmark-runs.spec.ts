/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Evals3 Benchmark Runs Page', () => {
  // beforeAll fixtures outlive single tests, so the per-test testData fixture
  // cannot own them — this tracker does (afterAll + crash ledger). Ids are
  // tracked AT CREATION so a died worker can never strand them (5 leaked
  // 'E2E BM Runs TC' test cases were measured on the shared cluster).
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let testCaseId: string | null = null;
  // uniqueTestName gives run-unique, sweeper-recognisable names — collisions
  // with other runs/sessions on the shared backend are impossible.
  const TC_NAME = uniqueTestName('bm-runs-tc');
  const BM_NAME = uniqueTestName('bm-runs-benchmark');

  test.beforeAll(async ({ request }) => {
    // Create a benchmark with test cases so we have data to navigate to
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: TC_NAME,
        initialPrompt: 'What is 2+2?',
        expectedOutcomes: ['Agent responds with 4'],
      },
    });
    if (tcRes.ok()) {
      const tcData = await tcRes.json();
      testCaseId = tcData.id || tcData.testCase?.id;
      tracker.testCase(testCaseId);
    }

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: BM_NAME,
        description: 'Created for e2e benchmark runs test',
        testCaseIds: testCaseId ? [testCaseId] : [],
      },
    });
    if (bmRes.ok()) {
      const bmData = await bmRes.json();
      benchmarkId = bmData.id || bmData.benchmark?.id;
      tracker.benchmark(benchmarkId);
    }
  });

  test.afterAll(async () => {
    // Cleanup by tracked id ONLY — never list-and-delete by name/prefix:
    // "name looks test-ish" is not proof of ownership on a shared backend
    // (this exact prefix sweep used to delete other sessions' data). The
    // tracker is 404-tolerant, ledger-backed, and deletes children first.
    await tracker.cleanup();
  });

  test('should display benchmark name as heading', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator(`h2:has-text("${BM_NAME}")`)).toBeVisible();
  });

  test('should show run count in subtitle', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('text=/\\d+ runs?/')).toBeVisible();
  });

  test('should show Add Run button', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('button:has-text("Add Run")')).toBeVisible();
  });

  test('should show the Runs tab active (heat-strip run list) via the legacy /runs deep link', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    // PR #447 superseded #399's split/tabs layout toggle with a fixed two-tab
    // (Cases | Runs) layout, so the split container / layout-mode toggle no
    // longer exist; the legacy `.../benchmarks/:id/runs` deep link now maps to
    // the Runs tab being the active tab instead.
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });

    const runsTab = page.locator('[role="tab"]:has-text("Runs")');
    await expect(runsTab).toBeVisible();
    await expect(runsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tab"]:has-text("Cases")')).toBeVisible();
    await expect(page.locator('[data-testid="benchmark-runs-split"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="layout-mode-tabs"]')).toHaveCount(0);

    // Reload — the tab reflects the URL (not a stale layout preference).
    await page.reload();
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('[role="tab"]:has-text("Runs")')).toHaveAttribute('aria-selected', 'true');
  });

  test('should show breadcrumbs with navigation', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    // Breadcrumbs: Evaluations > Benchmarks > <name>. Scope to the breadcrumb
    // nav — the sidebar also has a "Benchmarks" link, so an unscoped
    // a:has-text("Benchmarks") matches 2 elements (strict-mode violation).
    const crumb = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumb).toBeVisible();
    await expect(crumb.locator('a:has-text("Benchmarks")')).toBeVisible();
  });

  test('should open run config when clicking Add Run', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await page.click('button:has-text("Add Run")');
    await page.waitForTimeout(500);

    // Should see agent/model selection or run configuration UI
    const hasRunConfig = await page.locator('text=Agent').or(page.locator('text=Model')).first().isVisible().catch(() => false);
    expect(hasRunConfig).toBeTruthy();
  });

  // ── Evaluator + Judge Model dropdowns in the Configure Run dialog ──────────
  // Pinning the contract that the dialog actually surfaces evaluator and
  // judge-model selection. Pre-PR the dialog only had Agent + a mislabelled
  // "Judge Model" wired to `modelId` (the agent's LLM), so users had no UI
  // way to drive the run-level evaluatorId / judgeModelId that the server
  // already accepted on POST /api/storage/benchmarks/:id/execute.

  test('Configure Run dialog renders Agent, Evaluator, Judge Model and Concurrency fields', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });
    await page.click('button:has-text("Add Run")');
    // Wait for the dialog (CardTitle text) — distinct from page heading.
    await expect(page.locator('text=Configure Run')).toBeVisible({ timeout: 10_000 });

    // Scope every label assertion to the dialog container. The page behind
    // the modal can also contain "Agent"/"Judge Model" text (run cards,
    // column headers), so an unscoped getByText could pass even if the
    // dialog regressed. The dialog is tagged data-testid="run-config-dialog"
    // in both BenchmarkRunsPage variants for exactly this reason.
    const dialog = page.getByTestId('run-config-dialog');
    await expect(dialog).toBeVisible();

    // The four labels are unique inside the open dialog. Strict-match ensures
    // we'd catch a duplicate "Judge Model" coming back (the legacy wiring).
    await expect(dialog.getByText('Agent', { exact: true })).toBeVisible();
    // The agent-model concept was removed — the agent owns its model via
    // agent-health.config.ts, so there is NO 'Agent Model' picker anymore.
    await expect(dialog.getByText('Agent Model', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Evaluator', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Judge Model', { exact: true })).toBeVisible();

    // The Evaluator dropdown is uniquely identified by data-testid so the
    // assertion doesn't depend on which evaluators the test backend has
    // loaded (the placeholder "RCA Default" is always present).
    await expect(dialog.locator('[data-testid="run-config-evaluator-trigger"]')).toBeVisible();

    // Concurrency is a first-class field of the Add-Run dialog (owner:
    // "Concurrency is also missing in the Run dialog box"). Empty means the
    // server default, shown as the placeholder; the create-mode dialog is
    // the SAME component Re-run opens (data-mode distinguishes them).
    await expect(dialog).toHaveAttribute('data-mode', 'create');
    await expect(dialog.getByText('Concurrency', { exact: true })).toBeVisible();
    const concurrency = dialog.locator('[data-testid="run-config-concurrency-input"]');
    await expect(concurrency).toHaveValue('');
    await expect(concurrency).toHaveAttribute('placeholder', '1 (default)');
  });

  test('Start Run posts evaluatorId from the dialog through to the unified runner', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');

    // Capture the unified evaluation-run request so we assert both the dialog
    // selection and benchmark source survive the UI adapter. Fulfill a complete
    // SSE exchange: this test owns UI wiring, while runner persistence is
    // covered by the storage route integration tests.
    let executeBody: any = null;
    await page.route('**/api/storage/evaluation-runs', async route => {
      try {
        executeBody = JSON.parse(route.request().postData() || '{}');
      } catch {
        /* ignore parse errors */
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: [
          `event: started\ndata: ${JSON.stringify({ runId: 'e2e-eval-run', testCases: [] })}\n\n`,
          `event: completed\ndata: ${JSON.stringify({ id: 'e2e-eval-run', status: 'completed', results: [] })}\n\n`,
        ].join(''),
      });
    });

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });
    await page.click('button:has-text("Add Run")');
    await expect(page.locator('text=Configure Run')).toBeVisible({ timeout: 10_000 });

    // Open the Evaluator dropdown and pick the first non-"RCA Default"
    // option if any exist; otherwise pick the default explicitly so we
    // still verify the body shape is right.
    await page.click('[data-testid="run-config-evaluator-trigger"]');
    // Radix renders the listbox in a portal. Wait for it before clicking.
    await page.waitForSelector('[role="listbox"]', { timeout: 5_000 });
    const items = page.locator('[role="option"]');
    const itemCount = await items.count();
    expect(itemCount).toBeGreaterThanOrEqual(1);
    // First item is always "RCA Default" — pick the next one if present.
    if (itemCount >= 2) {
      await items.nth(1).click();
    } else {
      await items.nth(0).click();
    }

    // Set a concurrency so we can assert it rides along to the runner.
    await page.locator('[data-testid="run-config-concurrency-input"]').fill('3');

    await page.click('button:has-text("Start Run")');

    // Wait for the route handler to capture the unified SSE request body.
    for (let i = 0; i < 40 && executeBody === null; i++) {
      await page.waitForTimeout(100);
    }

    expect(executeBody, 'evaluation-runs POST body should have been captured').toBeTruthy();
    expect(executeBody.sources).toEqual([{ type: 'benchmark', benchmarkId }]);
    expect(executeBody.benchmarkId).toBe(benchmarkId);
    expect(executeBody.agentKey).toBeTruthy();
    expect(executeBody.modelId).toBeTruthy();
    expect(executeBody.name).toBeTruthy();
    expect(executeBody.concurrency).toBe(3);
    // What this assertion actually proves: the dialog never leaks the
    // internal '__default__' sentinel into the request body. After
    // JSON.parse(), an omitted field and an explicit `undefined` are
    // indistinguishable (both read back as `undefined`), so we deliberately
    // do NOT claim to catch "field omitted" here — only that whatever is
    // sent is a real evaluator id (string) or absent (undefined), and never
    // the client-only sentinel. The persisted-field contract (evaluatorId
    // actually round-trips onto the BenchmarkRun) is pinned server-side in
    // tests/integration/server/routes/storage/benchmarkExecuteEvaluator.integration.test.ts.
    expect(['undefined', 'string']).toContain(typeof executeBody.evaluatorId);
    expect(executeBody.evaluatorId).not.toBe('__default__');
  });

  test('should handle benchmark with undefined testCaseIds', async ({ page, request, testData }) => {
    // Create benchmark without testCaseIds. Tracked via the per-test testData
    // fixture, so it is deleted even when an assertion below fails.
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: uniqueTestName('bm-runs-no-tcids') },
    });
    let id: string | null = null;
    if (res.ok()) {
      const data = await res.json();
      id = data.id || data.benchmark?.id;
      testData.benchmark(id);
    }
    test.skip(!id, 'Failed to create benchmark');

    // Navigate — should NOT crash
    await page.goto(`/evaluations/benchmarks/${id}/runs`);
    await page.waitForTimeout(3000);

    // Page should render without "Cannot read properties of undefined" error
    const hasError = await page.locator('text=Cannot read properties').isVisible().catch(() => false);
    expect(hasError).toBeFalsy();
  });
});

/**
 * Edit benchmark + version-bump regression coverage.
 *
 * Edit lives on the benchmark detail page (`/evaluations/benchmarks/:id/runs`),
 * not on the list page. Per user feedback the row-level pencil on the list page
 * was unexpected — users land on the detail page when they want to add or
 * remove test cases.
 *
 * The legacy `/benchmarks` page supported editing and the Evals3 rewrite
 * shipped without it, so for a stretch of releases there was no UI path that
 * could create a new benchmark version (v2, v3, ...), even though the data
 * model and `server/routes/storage/benchmarks.ts` fully supported it.
 *
 * These tests pin the contract: header exposes Edit, opening it shows the
 * existing benchmark in edit mode, saving with a different test-case selection
 * produces a new version, and the header badge reflects v2 in place.
 */
test.describe('Evals3 Benchmark Runs Page — Edit & versioning', () => {
  const editTracker = createTestDataTracker();
  let editBenchmarkId: string | null = null;
  const seededTestCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Two test cases so we can change the selection and trigger a version bump.
    for (let i = 0; i < 2; i++) {
      const res = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`edit-bm-runs-tc-${i + 1}`),
          description: 'Seed for edit-on-detail-page e2e',
          category: 'E2E',
          difficulty: 'Easy',
          initialPrompt: 'What is 2+2?',
          context: [],
          expectedOutcomes: ['Agent responds with 4'],
          expectedTrajectory: [],
        },
      }).catch(() => null);
      if (res?.ok()) {
        const tc = await res.json();
        const id = tc.id || tc.testCase?.id;
        if (id) {
          seededTestCaseIds.push(id);
          editTracker.testCase(id);
        }
      }
    }
    // Seed a benchmark with the first test case only, so editing can add the second.
    if (seededTestCaseIds.length > 0) {
      const bmRes = await request.post('/api/storage/benchmarks', {
        data: {
          name: uniqueTestName('edit-bm-runs'),
          description: 'Seed for edit-on-detail-page e2e',
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [seededTestCaseIds[0]] }],
          testCaseIds: [seededTestCaseIds[0]],
          runs: [],
        },
      });
      if (bmRes.ok()) {
        const bm = await bmRes.json();
        editBenchmarkId = bm.id || bm.benchmark?.id;
        editTracker.benchmark(editBenchmarkId);
      }
    }
  });

  test.afterAll(async () => {
    await editTracker.cleanup();
  });

  test('detail page exposes an Edit button in the header', async ({ page }) => {
    test.skip(!editBenchmarkId, 'Seed benchmark unavailable');
    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });

    // The Edit button must exist exactly once in the header (not in any row).
    const editBtn = page.locator('[data-testid="edit-benchmark-button"]');
    await expect(editBtn).toBeVisible();
    await expect(editBtn).toHaveCount(1);
  });

  test('header shows no version badge for a single-version benchmark', async ({ page }) => {
    test.skip(!editBenchmarkId, 'Seed benchmark unavailable');
    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });

    // The version badge (v{currentVersion}) is intentionally shown ONLY for
    // multi-version benchmarks — a freshly-seeded single-version benchmark has
    // a clean header with no vN badge. (The multi-version case, where the
    // badge flips to v2 after an edit, is covered by the edit test below.)
    await expect(page.locator('text=/^v[0-9]+$/')).toHaveCount(0);
  });

  test('Edit opens the editor in edit mode (not create mode)', async ({ page }) => {
    test.skip(!editBenchmarkId, 'Seed benchmark unavailable');
    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });

    await page.click('[data-testid="edit-benchmark-button"]');

    // The editor opens with "Edit Benchmark" title (not "Create Benchmark").
    // This is the contract that proves BenchmarkEditor received a non-null
    // `benchmark` prop — the original regression hard-coded `benchmark={null}`.
    await expect(page.locator('text=Edit Benchmark').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Create Benchmark')).toHaveCount(0);
  });

  test('saving an edit with changed test cases bumps currentVersion in place', async ({ page, request }) => {
    test.skip(!editBenchmarkId || seededTestCaseIds.length < 2, 'Seed data unavailable');

    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });

    await page.click('[data-testid="edit-benchmark-button"]');
    await expect(page.locator('text=Edit Benchmark').first()).toBeVisible({ timeout: 5_000 });

    // Step 1 (Info) → Next.
    await page.click('button:has-text("Next")');

    // Step 2 (Test Cases): add a currently-unselected test case to change the
    // selection (which triggers the version bump). Toggling by nth index is
    // fragile — the list contains every backend test case, so a fixed index
    // can land on the already-selected one and deselect it, leaving zero
    // selected and Next disabled. Check the first UNCHECKED box instead.
    const addBox = page.locator('button[role="checkbox"][data-state="unchecked"]').first();
    await expect(addBox).toBeVisible({ timeout: 10_000 });
    await addBox.click();
    await page.click('button:has-text("Next")');

    // Step 3: footer should advertise a version bump (v2).
    await expect(page.locator('text=/v2/')).toBeVisible({ timeout: 5_000 });

    // Capture the PUT/PATCH that performs the version bump.
    const updatePromise = page.waitForResponse(
      r => r.url().includes(`/api/storage/benchmarks/${editBenchmarkId}`) &&
           ['PUT', 'PATCH'].includes(r.request().method()),
      { timeout: 15_000 },
    );

    const saveBtn = page.locator('button:has-text("Save & Run v2"), button:has-text("Save Changes")').last();
    await saveBtn.click();

    const updateResp = await updatePromise;
    expect(updateResp.status(), 'update PUT/PATCH should succeed').toBeLessThan(400);

    // Server-side: currentVersion must reach 2 and versions must contain v2.
    let fetched: any = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await request.get(`/api/storage/benchmarks/${encodeURIComponent(editBenchmarkId!)}`);
      if (r.ok()) {
        const data = await r.json();
        if ((data.currentVersion || 1) >= 2) { fetched = data; break; }
      }
      await new Promise(res => setTimeout(res, 300));
    }
    expect(fetched, 'currentVersion must reach 2 after editing test cases').toBeTruthy();
    expect(fetched.currentVersion).toBe(2);
    expect(Array.isArray(fetched.versions) ? fetched.versions.length : 0).toBeGreaterThanOrEqual(2);
    expect(fetched.testCaseIds).toContain(seededTestCaseIds[0]);
    expect(fetched.testCaseIds).toContain(seededTestCaseIds[1]);

    // UI: after the edit persists (v2 confirmed above), the header shows the
    // version badge (now multi-version). Reload so the header reflects the
    // persisted state rather than relying on in-place refresh timing.
    await page.reload();
    await page.waitForSelector('h2', { timeout: 30_000 });
    await expect(page.locator('text=/^v2$/').first()).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * Edit-without-forced-run regression coverage.
 *
 * The original BenchmarkEditor required `runs.length > 0` to enable the Save
 * button on Step 3 ("Define Runs"). That meant any edit which changed test
 * cases (which legitimately bumps the version) ALSO forced the user to
 * configure and start a run before they could save — there was no way to
 * just "save the new version, I'll run it later from the detail page".
 *
 * Per user feedback this was wrong: editing should not force a run. We now:
 *   - relax `canSave` so edit mode no longer requires `runs.length > 0`
 *   - on Step 2 (test cases changed), offer BOTH "Save Changes (v{n+1})"
 *     and "Next: Define Runs" — same affordance, two outcomes
 *   - on Step 3 in edit mode with 0 run configs, the primary button reads
 *     "Save Changes (v{n+1})" instead of "Save & Run v{n+1}"
 *
 * This test pins the contract: from the detail page, click Edit, change the
 * test-case selection, click "Save Changes (vN)" on Step 2, and verify
 *   - server `currentVersion` bumps to 2,
 *   - NO new BenchmarkRun was created (`runs.length` stays at 0),
 *   - the editor closes and the detail-page header reflects v2 in place.
 */
test.describe('Evals3 Benchmark Runs Page — Edit without forced run', () => {
  const noRunTracker = createTestDataTracker();
  let editBenchmarkId: string | null = null;
  const seededTestCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const res = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`edit-no-run-tc-${i + 1}`),
          category: 'E2E',
          difficulty: 'Easy',
          initialPrompt: 'What is 2+2?',
          context: [],
          expectedOutcomes: ['4'],
          expectedTrajectory: [],
        },
      }).catch(() => null);
      if (res?.ok()) {
        const tc = await res.json();
        const id = tc.id || tc.testCase?.id;
        if (id) {
          seededTestCaseIds.push(id);
          noRunTracker.testCase(id);
        }
      }
    }
    if (seededTestCaseIds.length > 0) {
      const bmRes = await request.post('/api/storage/benchmarks', {
        data: {
          name: uniqueTestName('edit-no-run-bm'),
          description: 'Seed for edit-without-forced-run e2e',
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [seededTestCaseIds[0]] }],
          testCaseIds: [seededTestCaseIds[0]],
          runs: [],
        },
      });
      if (bmRes.ok()) {
        const bm = await bmRes.json();
        editBenchmarkId = bm.id || bm.benchmark?.id;
        noRunTracker.benchmark(editBenchmarkId);
      }
    }
  });

  test.afterAll(async () => {
    await noRunTracker.cleanup();
  });

  test('Step 2 with test-case changes offers a "Save without running" path', async ({ page }) => {
    test.skip(!editBenchmarkId || seededTestCaseIds.length < 2, 'Seed data unavailable');

    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });
    await page.click('[data-testid="edit-benchmark-button"]');
    await expect(page.locator('text=Edit Benchmark').first()).toBeVisible({ timeout: 5_000 });

    // Step 1 → Step 2.
    await page.click('button:has-text("Next")');

    // Toggle the second checkbox to change the test-case set.
    await expect(page.locator('button[role="checkbox"]').nth(1)).toBeVisible({ timeout: 10_000 });
    await page.locator('button[role="checkbox"]').nth(1).click();

    // Both buttons must be present on Step 2 once test cases changed: an
    // explicit "Save without running" path AND the legacy "Next: Define Runs".
    await expect(page.locator('[data-testid="editor-save-without-run"]')).toBeVisible();
    await expect(page.locator('button:has-text("Next: Define Runs")')).toBeVisible();
  });

  test('Save without running bumps version, creates NO new run, closes editor', async ({ page, request }) => {
    test.skip(!editBenchmarkId || seededTestCaseIds.length < 2, 'Seed data unavailable');

    // Snapshot run count before — we'll assert it does not grow.
    const beforeRes = await request.get(`/api/storage/benchmarks/${encodeURIComponent(editBenchmarkId!)}`);
    const before = await beforeRes.json();
    const beforeRunCount = (before.runs || []).length;
    const beforeVersion = before.currentVersion ?? 1;

    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });
    await page.click('[data-testid="edit-benchmark-button"]');
    await expect(page.locator('text=Edit Benchmark').first()).toBeVisible({ timeout: 5_000 });
    await page.click('button:has-text("Next")');

    // Change the test-case set by adding a currently-unselected test case
    // (see the note on the versioning test above — a fixed nth index can
    // deselect the only-selected TC and disable Save).
    const addBox2 = page.locator('button[role="checkbox"][data-state="unchecked"]').first();
    await expect(addBox2).toBeVisible({ timeout: 10_000 });
    await addBox2.click();

    // Capture the PUT/PATCH (the version bump) AND assert NO POST to the
    // /execute endpoint is made — that's the contract under test.
    const updatePromise = page.waitForResponse(
      r => r.url().includes(`/api/storage/benchmarks/${editBenchmarkId}`) &&
           ['PUT', 'PATCH'].includes(r.request().method()),
      { timeout: 15_000 },
    );
    let executeRequested = false;
    const onRequest = (req: any) => {
      if (req.method() === 'POST' && /\/api\/storage\/benchmarks\/[^/]+\/execute$/.test(req.url())) {
        executeRequested = true;
      }
    };
    // try/finally guarantees the listener is removed even if any of the
    // assertions inside this block throw. Without it, a failing test would
    // leak the listener onto the Page for the rest of the suite — every
    // subsequent network request in this same Page would still fire
    // executeRequested = true and could pollute later assertions or slow
    // the suite down. Test isolation > test brevity.
    page.on('request', onRequest);
    try {
      await page.click('[data-testid="editor-save-without-run"]');

      const updateResp = await updatePromise;
      expect(updateResp.status()).toBeLessThan(400);

      // Editor must have closed (it's gone from the DOM).
      await expect(page.locator('text=Edit Benchmark')).toHaveCount(0, { timeout: 5_000 });

      // Give the page a beat to settle so any straggling /execute would have
      // had time to fire.
      await page.waitForTimeout(500);
    } finally {
      page.off('request', onRequest);
    }

    expect(executeRequested, 'no /execute POST should fire when saving without a run').toBe(false);

    // Server-side: version bumped, runs[] unchanged in length.
    const afterRes = await request.get(`/api/storage/benchmarks/${encodeURIComponent(editBenchmarkId!)}`);
    const after = await afterRes.json();
    expect(after.currentVersion).toBe(beforeVersion + 1);
    expect((after.runs || []).length).toBe(beforeRunCount);
    expect(after.testCaseIds).toEqual(expect.arrayContaining(seededTestCaseIds.slice(0, 2)));
  });
});
