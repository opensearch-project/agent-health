/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evals3 Benchmark Runs Page', () => {
  let benchmarkId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Create a benchmark with test cases so we have data to navigate to
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: 'E2E BM Runs TC',
        initialPrompt: 'What is 2+2?',
        expectedOutcomes: ['Agent responds with 4'],
      },
    });
    let testCaseId: string | null = null;
    if (tcRes.ok()) {
      const tcData = await tcRes.json();
      testCaseId = tcData.id || tcData.testCase?.id;
    }

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: 'E2E BM Runs Benchmark',
        description: 'Created for e2e benchmark runs test',
        testCaseIds: testCaseId ? [testCaseId] : [],
      },
    });
    if (bmRes.ok()) {
      const bmData = await bmRes.json();
      benchmarkId = bmData.id || bmData.benchmark?.id;
    }
  });

  test.afterAll(async ({ request }) => {
    // Cleanup
    const bmRes = await request.get('/api/storage/benchmarks').catch(() => null);
    if (bmRes?.ok()) {
      const data = await bmRes.json();
      const benchmarks = Array.isArray(data) ? data : data.benchmarks ?? [];
      for (const bm of benchmarks) {
        if (bm.name?.startsWith('E2E BM Runs')) {
          await request.delete(`/api/storage/benchmarks/${encodeURIComponent(bm.id)}`).catch(() => {});
        }
      }
    }
    const tcRes = await request.get('/api/storage/test-cases').catch(() => null);
    if (tcRes?.ok()) {
      const data = await tcRes.json();
      const tcs = Array.isArray(data) ? data : data.testCases ?? [];
      for (const tc of tcs) {
        if (tc.name?.startsWith('E2E BM Runs')) {
          await request.delete(`/api/storage/test-cases/${encodeURIComponent(tc.id)}`).catch(() => {});
        }
      }
    }
  });

  test('should display benchmark name as heading', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('h2:has-text("E2E BM Runs Benchmark")')).toBeVisible();
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

  test('should default to split layout (Test Cases left, Runs right)', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    // Wipe persisted layout pref so this asserts the *default*, not whatever the
    // user happens to have saved.
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });

    // Split container present — this is the regression check for restoring the
    // legacy two-panel layout (https://.../components/evals3/BenchmarkRunsPage.tsx).
    await expect(page.locator('[data-testid="benchmark-runs-split"]')).toBeVisible();

    // Both panel headers visible side-by-side.
    await expect(page.locator('h3:has-text("Test Cases")')).toBeVisible();
    await expect(page.locator('h3:has-text("Runs")')).toBeVisible();

    // Tabs (TabsList) should NOT exist in split mode.
    await expect(page.locator('[role="tablist"]')).toHaveCount(0);

    // Layout toggle visible with Split active.
    const splitToggle = page.locator('[data-testid="layout-mode-split"]');
    await expect(splitToggle).toBeVisible();
    await expect(splitToggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('should switch to tabs layout when toggled and persist the choice', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });

    // Click the tabs toggle.
    await page.click('[data-testid="layout-mode-tabs"]');

    // Tabs visible, split container gone.
    await expect(page.locator('[role="tab"]:has-text("Runs")')).toBeVisible();
    await expect(page.locator('[role="tab"]:has-text("Test Cases")')).toBeVisible();
    await expect(page.locator('[data-testid="benchmark-runs-split"]')).toHaveCount(0);

    // Toggle should be aria-pressed=true on the Tabs side.
    await expect(page.locator('[data-testid="layout-mode-tabs"]')).toHaveAttribute('aria-pressed', 'true');

    // Reload — the choice must persist via localStorage (`benchmark-runs:layoutMode`).
    await page.reload();
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator('[role="tab"]:has-text("Runs")')).toBeVisible();
    await expect(page.locator('[data-testid="benchmark-runs-split"]')).toHaveCount(0);
  });

  test('should show breadcrumbs with navigation', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30000 });
    // Breadcrumbs: Evaluations > Benchmarks > <name>
    await expect(page.locator('text=Evaluations').first()).toBeVisible();
    await expect(page.locator('a:has-text("Benchmarks")')).toBeVisible();
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

  test('should handle benchmark with undefined testCaseIds', async ({ page, request }) => {
    // Create benchmark without testCaseIds
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: 'E2E BM Runs No TcIds' },
    });
    let id: string | null = null;
    if (res.ok()) {
      const data = await res.json();
      id = data.id || data.benchmark?.id;
    }
    test.skip(!id, 'Failed to create benchmark');

    // Navigate — should NOT crash
    await page.goto(`/evaluations/benchmarks/${id}/runs`);
    await page.waitForTimeout(3000);

    // Page should render without "Cannot read properties of undefined" error
    const hasError = await page.locator('text=Cannot read properties').isVisible().catch(() => false);
    expect(hasError).toBeFalsy();

    // Cleanup
    if (id) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
    }
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
  let editBenchmarkId: string | null = null;
  const seededTestCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Two test cases so we can change the selection and trigger a version bump.
    for (let i = 0; i < 2; i++) {
      const res = await request.post('/api/storage/test-cases', {
        data: {
          name: `E2E Edit BM Runs TC ${i + 1} ${Date.now()}`,
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
        if (id) seededTestCaseIds.push(id);
      }
    }
    // Seed a benchmark with the first test case only, so editing can add the second.
    if (seededTestCaseIds.length > 0) {
      const bmRes = await request.post('/api/storage/benchmarks', {
        data: {
          name: `E2E Edit BM Runs ${Date.now()}`,
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
      }
    }
  });

  test.afterAll(async ({ request }) => {
    if (editBenchmarkId) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(editBenchmarkId)}`).catch(() => {});
    }
    for (const id of seededTestCaseIds) {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    }
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

  test('header shows current version badge', async ({ page }) => {
    test.skip(!editBenchmarkId, 'Seed benchmark unavailable');
    await page.goto(`/evaluations/benchmarks/${editBenchmarkId}/runs`);
    await page.waitForSelector('h2', { timeout: 30_000 });

    // The benchmark summary row shows e.g. "v1" as a badge — same source of
    // truth (`benchmark.currentVersion`) used by the list page badge.
    await expect(page.locator('text=/^v1$/').first()).toBeVisible();
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

    // Step 2 (Test Cases): toggle the second checkbox to add the second TC.
    await expect(page.locator('button[role="checkbox"]').nth(1)).toBeVisible({ timeout: 10_000 });
    await page.locator('button[role="checkbox"]').nth(1).click();
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

    // UI: header version badge should flip to v2 in place (no navigation).
    // The detail-page Edit flow reloads the benchmark on save, so the header
    // updates without a full page reload.
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
  let editBenchmarkId: string | null = null;
  const seededTestCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const res = await request.post('/api/storage/test-cases', {
        data: {
          name: `E2E Edit-no-run TC ${i + 1} ${Date.now()}`,
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
        if (id) seededTestCaseIds.push(id);
      }
    }
    if (seededTestCaseIds.length > 0) {
      const bmRes = await request.post('/api/storage/benchmarks', {
        data: {
          name: `E2E Edit-no-run BM ${Date.now()}`,
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
      }
    }
  });

  test.afterAll(async ({ request }) => {
    if (editBenchmarkId) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(editBenchmarkId)}`).catch(() => {});
    }
    for (const id of seededTestCaseIds) {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    }
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

    // Change the test-case set (toggle the second TC's checkbox).
    await expect(page.locator('button[role="checkbox"]').nth(1)).toBeVisible({ timeout: 10_000 });
    await page.locator('button[role="checkbox"]').nth(1).click();

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
    page.on('request', onRequest);

    await page.click('[data-testid="editor-save-without-run"]');

    const updateResp = await updatePromise;
    expect(updateResp.status()).toBeLessThan(400);

    // Editor must have closed (it's gone from the DOM).
    await expect(page.locator('text=Edit Benchmark')).toHaveCount(0, { timeout: 5_000 });

    // Give the page a beat to settle, then unhook.
    await page.waitForTimeout(500);
    page.off('request', onRequest);

    expect(executeRequested, 'no /execute POST should fire when saving without a run').toBe(false);

    // Server-side: version bumped, runs[] unchanged in length.
    const afterRes = await request.get(`/api/storage/benchmarks/${encodeURIComponent(editBenchmarkId!)}`);
    const after = await afterRes.json();
    expect(after.currentVersion).toBe(beforeVersion + 1);
    expect((after.runs || []).length).toBe(beforeRunCount);
    expect(after.testCaseIds).toEqual(expect.arrayContaining(seededTestCaseIds.slice(0, 2)));
  });
});
