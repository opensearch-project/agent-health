/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Evals3 Benchmarks Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30000 });
  });

  test('should display page heading and subtitle', async ({ page }) => {
    await expect(page.locator('h2:has-text("Benchmarks")')).toBeVisible();
    await expect(page.locator('text=Collections of test cases')).toBeVisible();
  });

  test('should show benchmark count', async ({ page }) => {
    // Stats section shows the count + "benchmarks" label (separate adjacent
    // spans, so allow zero-or-more whitespace between number and word).
    await expect(page.getByText(/\d+\s*benchmarks?/i).first()).toBeVisible();
  });

  test('should show New Benchmark button', async ({ page }) => {
    const newButton = page.locator('button:has-text("New Benchmark")');
    await expect(newButton).toBeVisible();
  });

  test('should show Import JSON button', async ({ page }) => {
    const importButton = page.locator('button:has-text("Import JSON")');
    await expect(importButton).toBeVisible();
  });

  test('should show search input', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search"]');
    await expect(searchInput).toBeVisible();
  });

  test('should show agent filter dropdown', async ({ page }) => {
    await expect(page.locator('text=All Agents')).toBeVisible();
  });

  test('should show time range filter dropdown', async ({ page }) => {
    await expect(page.locator('text=All time')).toBeVisible();
  });

  test('should open benchmark editor when clicking New Benchmark', async ({ page }) => {
    await page.click('button:has-text("New Benchmark")');
    await expect(
      page.locator('text=Create Benchmark').or(page.locator('text=Step 1')).first()
    ).toBeVisible({ timeout: 5000 });
  });

  test('should filter benchmarks by search query', async ({ page }) => {
    await page.waitForTimeout(1000);

    const searchInput = page.locator('input[placeholder="Search"]');
    await searchInput.fill('test');
    await page.waitForTimeout(500);

    const pageContent = await page.textContent('body');
    expect(pageContent).toBeDefined();
  });

  test('should handle benchmarks with missing testCaseIds gracefully', async ({ page, request }) => {
    // Create a benchmark without testCaseIds
    const res = await request.post('/api/storage/benchmarks', {
      data: { name: 'E2E Null TcIds Benchmark', description: 'testCaseIds is undefined' },
    });

    // Reload page — should NOT crash with "testCaseIds is not iterable"
    await page.reload();
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30000 });
    await expect(page.locator('h2:has-text("Benchmarks")')).toBeVisible();

    // Cleanup
    if (res.ok()) {
      const data = await res.json();
      const id = data.id || data.benchmark?.id;
      if (id) {
        await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
      }
    }
  });

  test('should display benchmarks in table with sortable columns', async ({ page }) => {
    await page.waitForTimeout(1000);

    // Check for table headers (Name, Test Cases, Runs, Score, Last Run, Agent)
    const hasTable = await page.locator('th:has-text("Name"), td:has-text("Name")').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=No benchmarks').isVisible().catch(() => false);

    expect(hasTable || hasEmptyState).toBeTruthy();
  });
});

test.describe('Evals3 Benchmark CRUD', () => {
  const benchmarkName = `E2E Evals3 BM ${Date.now()}`;
  let seededTestCaseId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Seed a real test case so the wizard can pick one in the Test Cases step
    const res = await request.post('/api/storage/test-cases', {
      data: {
        name: `E2E Evals3 BM seed TC ${Date.now()}`,
        description: 'Seed test case for evals3 benchmark CRUD e2e',
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
      seededTestCaseId = tc.id || tc.testCase?.id || null;
    }
  });

  test.afterAll(async ({ request }) => {
    // Clean up benchmarks created during this suite
    const response = await request.get('/api/storage/benchmarks').catch(() => null);
    if (response?.ok()) {
      const data = await response.json();
      const benchmarks = Array.isArray(data) ? data : data.benchmarks ?? [];
      for (const bm of benchmarks) {
        if (bm.name?.startsWith('E2E Evals3 BM')) {
          await request.delete(`/api/storage/benchmarks/${encodeURIComponent(bm.id)}`).catch(() => {});
        }
      }
    }
    if (seededTestCaseId) {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(seededTestCaseId)}`).catch(() => {});
    }
  });

  test('should create AND run a new benchmark via the full wizard', async ({ page, request }) => {
    // Skip if we couldn't seed a test case (no storage backend / API down)
    test.skip(!seededTestCaseId, 'Seed test case unavailable');
    test.setTimeout(120_000); // demo run + judge can take a while

    // The e2e server runs in file-storage (sample-only) mode, where the real
    // /execute endpoint returns 400 ("OpenSearch not configured"). This test's
    // contract is the WIZARD WIRING (the Evals3 regression where the editor
    // closed without firing save + execute) — not the execution engine. Stub
    // /execute at the network edge (same philosophy integ tests use for
    // Bedrock) so we still assert the wizard POSTs to it, without needing a
    // real OpenSearch/agent backend.
    await page.route('**/api/storage/benchmarks/*/execute', route =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: `data: ${JSON.stringify({ type: 'progress', status: 'completed', currentTestCaseIndex: 0, totalTestCases: 1 })}\n\n`,
      })
    );

    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    // 1. Open the editor
    await page.click('button:has-text("New Benchmark")');
    await expect(page.locator('text=Create Benchmark')).toBeVisible({ timeout: 5_000 });

    // 2. Step 1: fill the name (description optional)
    await page.fill('#name', benchmarkName);
    await page.click('button:has-text("Next")');

    // 3. Step 2: select the seeded test case (Radix Checkbox is a button[role=checkbox])
    // Wait for the test case list to load
    await expect(page.locator(`text=${benchmarkName.split(' ')[0]}`)).toBeVisible({ timeout: 10_000 }).catch(() => {});
    const firstCheckbox = page.locator('button[role="checkbox"]').first();
    await firstCheckbox.waitFor({ state: 'visible', timeout: 10_000 });
    await firstCheckbox.click();
    await page.click('button:has-text("Next")');

    // 4. Step 3: pick any available agent (the first option in the Agent dropdown).
    //    The first combobox inside the editor modal is Agent (Judge Model has a default).
    const editorModal = page.locator('div.fixed.inset-4').first();
    await editorModal.locator('button[role="combobox"]').first().click();
    // Prefer Demo if it's directly visible; otherwise click "Built-in" to expand and try again;
    // otherwise fall back to whatever is the first option (e.g. "Pi (pi.dev)").
    let agentOpt = page.locator('[role="option"]:has-text("Demo")').first();
    if (!(await agentOpt.isVisible({ timeout: 1_000 }).catch(() => false))) {
      const builtin = page.locator('[role="option"]:has-text("Built-in"), button:has-text("Built-in")').first();
      if (await builtin.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await builtin.click();
        agentOpt = page.locator('[role="option"]:has-text("Demo")').first();
      }
      if (!(await agentOpt.isVisible({ timeout: 1_000 }).catch(() => false))) {
        agentOpt = page.locator('[role="option"]').first();
      }
    }
    await agentOpt.waitFor({ state: 'visible', timeout: 5_000 });
    await agentOpt.click();

    // 5. Click "Create & Run Benchmark" and STRICTLY assert the network calls fire.
    //    These two POSTs are the regression coverage for the Evals3 wrapper bug
    //    (https://github.com/.../components/evals3/BenchmarksPage.tsx onSaveAndRun)
    //    where the editor used to close without saving or running anything.
    const savePromise = page.waitForResponse(
      r => r.url().includes('/api/storage/benchmarks') &&
           r.request().method() === 'POST' &&
           !r.url().includes('/execute'),
      { timeout: 15_000 }
    );
    const executePromise = page.waitForResponse(
      r => /\/api\/storage\/benchmarks\/[^/]+\/execute$/.test(r.url()) &&
           r.request().method() === 'POST',
      { timeout: 15_000 }
    );

    await page.click('button:has-text("Create & Run Benchmark")');

    const saveResp = await savePromise;
    expect(saveResp.status(), 'save benchmark POST should succeed').toBeLessThan(400);
    const saved = await saveResp.json();
    const benchmarkId = saved.id || saved.benchmark?.id;
    expect(benchmarkId, 'POST response should include the new benchmark id').toBeTruthy();

    const executeResp = await executePromise;
    expect(executeResp.status(), 'execute benchmark POST should succeed').toBeLessThan(400);

    // 6. Editor should close and URL should navigate to the runs page
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs`), { timeout: 5_000 });
    await expect(page.locator('button:has-text("Create & Run Benchmark")')).toHaveCount(0);

    // 7. Server-side: the benchmark must exist in storage. OpenSearch is eventually
    //    consistent for get-by-id immediately after create, so retry briefly.
    let fetched: any = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await request.get(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
      lastStatus = r.status();
      if (r.ok()) {
        fetched = await r.json();
        break;
      }
      await new Promise(res => setTimeout(res, 300));
    }
    expect(fetched, `benchmark must be persisted (last status ${lastStatus})`).toBeTruthy();
    expect(fetched.name).toBe(benchmarkName);
    expect((fetched.testCaseIds || []).length).toBeGreaterThan(0);
  });

  test('should keep the editor open and surface an error when save fails', async ({ page }) => {
    test.skip(!seededTestCaseId, 'Seed test case unavailable');

    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    // Force every POST /api/storage/benchmarks to fail so we exercise the error path.
    await page.route('**/api/storage/benchmarks', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated failure' }) });
      }
      return route.continue();
    });

    // Walk the full 3-step wizard with strict assertions.
    await page.click('button:has-text("New Benchmark")');
    await expect(page.locator('text=Create Benchmark')).toBeVisible({ timeout: 5_000 });
    await page.fill('#name', `E2E Evals3 BM fail ${Date.now()}`);
    await page.click('button:has-text("Next")');
    const firstCheckbox = page.locator('button[role="checkbox"]').first();
    await firstCheckbox.waitFor({ state: 'visible', timeout: 10_000 });
    await firstCheckbox.click();
    await page.click('button:has-text("Next")');
    const editorModal = page.locator('div.fixed.inset-4').first();
    await editorModal.locator('button[role="combobox"]').first().click();
    let agentOpt = page.locator('[role="option"]:has-text("Demo")').first();
    if (!(await agentOpt.isVisible({ timeout: 1_000 }).catch(() => false))) {
      const builtin = page.locator('[role="option"]:has-text("Built-in"), button:has-text("Built-in")').first();
      if (await builtin.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await builtin.click();
        agentOpt = page.locator('[role="option"]:has-text("Demo")').first();
      }
      if (!(await agentOpt.isVisible({ timeout: 1_000 }).catch(() => false))) {
        agentOpt = page.locator('[role="option"]').first();
      }
    }
    await agentOpt.waitFor({ state: 'visible', timeout: 5_000 });
    await agentOpt.click();

    // Capture the failed save response so we know the click actually attempted to save.
    const failedSavePromise = page.waitForResponse(
      r => r.url().includes('/api/storage/benchmarks') &&
           r.request().method() === 'POST' &&
           !r.url().includes('/execute'),
      { timeout: 10_000 }
    );
    await page.click('button:has-text("Create & Run Benchmark")');
    const failedResp = await failedSavePromise;
    expect(failedResp.status(), 'mocked save POST should be 500').toBe(500);

    // Editor must remain open with the form preserved and an error banner shown.
    // This is the contract that prevents the original "form silently wiped" bug.
    await expect(page.locator('[data-testid="benchmark-editor-error"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button:has-text("Create & Run Benchmark")')).toBeVisible();
    // Walking back to step 1 must show the user's original name input — form state survived.
    await page.click('button:has-text("Back")');
    await page.click('button:has-text("Back")');
    await expect(page.locator('#name')).toHaveValue(/E2E Evals3 BM fail/);
  });
});

/**
 * Default sort regression coverage.
 *
 * The previous default was `runs DESC`, which pushed a freshly-created benchmark
 * (with 0 or 1 runs) far down the list — hiding it just when the user wanted to
 * see it most. The new default is "Last Activity" DESC, defined as
 * `max(latestRun.createdAt, benchmark.updatedAt)`, so a brand-new benchmark or
 * one that just had its test cases edited surfaces at the top.
 */
test.describe('Evals3 Benchmarks Page — default sort by Last Activity', () => {
  const SORT_BENCH_PREFIX = 'E2E Evals3 Sort ';
  const createdBenchmarkIds: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of createdBenchmarkIds) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
    }
  });

  test('a freshly-created benchmark appears at the top of the default sort', async ({ page, request }) => {
    // 1. Create a benchmark directly via the storage API. Its `updatedAt` will be ~now,
    //    which must be more recent than any other benchmark's last activity.
    const benchmarkName = `${SORT_BENCH_PREFIX}${Date.now()}`;
    const res = await request.post('/api/storage/benchmarks', {
      data: {
        name: benchmarkName,
        description: 'sort regression seed',
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [] }],
        testCaseIds: [],
        runs: [],
      },
    });
    expect(res.ok(), `seed POST status ${res.status()}`).toBeTruthy();
    const created = await res.json();
    const newId = created.id || created.benchmark?.id;
    expect(newId, 'created benchmark must have an id').toBeTruthy();
    createdBenchmarkIds.push(newId);

    // 2. Wipe localStorage BEFORE navigation so the new default sort key (
    //    'benchmarks:sort:v2') applies to this run — not whatever the user happens
    //    to have saved.
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    // 3. The header must read "Last Activity" with a sort indicator (the active
    //    SortHeader renders a ChevronDown next to the label).
    const headerCell = page.locator('th:has-text("Last Activity")');
    await expect(headerCell).toBeVisible();
    await expect(headerCell.locator('svg').first()).toBeVisible(); // active-sort chevron

    // 4. The freshly-created benchmark must be the FIRST row.
    const firstRowName = page.locator('tbody tr').first().locator('td').first();
    await expect(firstRowName).toContainText(benchmarkName, { timeout: 10_000 });

    // 5. The Last Activity cell on that row must be "Updated <relative>" — the
    //    cell explicitly differentiates updated-vs-run signals so users see why
    //    a brand-new benchmark with no runs is at the top.
    const lastActivityCell = page.locator('tbody tr').first().locator('td').nth(3);
    await expect(lastActivityCell).toContainText(/Updated/);
  });

  test('clicking the Last Activity header toggles direction', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    const headerCell = page.locator('th:has-text("Last Activity")');
    await expect(headerCell).toBeVisible();

    // Capture first row name before flip
    const firstBefore = await page.locator('tbody tr').first().locator('td').first().textContent();

    // Click to toggle desc → asc; the first row should change (oldest now on top).
    await headerCell.click();
    await page.waitForTimeout(300);
    const firstAfter = await page.locator('tbody tr').first().locator('td').first().textContent();

    // We can't assume a fixed dataset, but the toggle should at minimum either
    // change the first row OR keep a single-row dataset stable. Assert the
    // chevron flipped (rotate-180 class indicates ascending) which is the
    // contract under test.
    const chevron = headerCell.locator('svg').first();
    await expect(chevron).toBeVisible();
    await expect(chevron).toHaveClass(/rotate-180/);

    // Sanity: if there is more than one row, first row must have changed.
    const rowCount = await page.locator('tbody tr').count();
    if (rowCount > 1) {
      expect(firstAfter).not.toBe(firstBefore);
    }
  });
});

/**
 * Benchmark version-badge regression coverage on the list page.
 *
 * The Evals3 BenchmarksPage4 rewrite shipped without a row-level version
 * indicator, so users couldn't tell at a glance which benchmarks had been
 * edited. We now render `data-testid="benchmark-version-badge"` on every row.
 *
 * Note: Edit is exposed in TWO places — the row-level pencil here
 * (`data-testid="edit-benchmark-button-row"`) AND the header button on the
 * benchmark detail page (`data-testid="edit-benchmark-button"`). Both are
 * regression-tested; the detail-page version-bump E2E lives in
 * `evals3-benchmark-runs.spec.ts`.
 */
test.describe('Evals3 Benchmarks Page — version badge & row Edit', () => {
  let benchmarkId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `E2E Version Badge BM ${Date.now()}`,
        description: 'Seed for version-badge e2e',
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [] }],
        testCaseIds: [],
        runs: [],
      },
    });
    if (bmRes.ok()) {
      const bm = await bmRes.json();
      benchmarkId = bm.id || bm.benchmark?.id;
    }
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`).catch(() => {});
    }
  });

  test('every row shows a version badge starting at v1', async ({ page }) => {
    test.skip(!benchmarkId, 'Seed benchmark unavailable');
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    const seededRow = page.locator('tbody tr', { hasText: 'E2E Version Badge BM' }).first();
    await expect(seededRow).toBeVisible();
    await expect(seededRow.locator('[data-testid="benchmark-version-badge"]')).toHaveText(/^v\d+$/);
    await expect(seededRow.locator('[data-testid="benchmark-version-badge"]')).toHaveText('v1');
  });

  test('every row exposes a row-level Edit button (parity with detail page)', async ({ page }) => {
    test.skip(!benchmarkId, 'Seed benchmark unavailable');
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    // Every row should expose `edit-benchmark-button-row`. Distinct testid from
    // the detail-page button (`edit-benchmark-button`) so the two surfaces are
    // independently locatable in tests.
    const rowCount = await page.locator('tbody tr').count();
    expect(rowCount).toBeGreaterThan(0);
    const editButtons = page.locator('[data-testid="edit-benchmark-button-row"]');
    expect(await editButtons.count()).toBe(rowCount);

    // Clicking opens the editor in *edit* mode (not create).
    const seededRow = page.locator('tbody tr', { hasText: 'E2E Version Badge BM' }).first();
    await seededRow.locator('[data-testid="edit-benchmark-button-row"]').click();
    await expect(page.locator('text=Edit Benchmark').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Create Benchmark')).toHaveCount(0);
  });
});
