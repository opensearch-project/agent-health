/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * These tests used to click "the first [class*=card] element containing the
 * text 'runs'" on whatever data happened to be in storage — nondeterministic
 * under fullyParallel (other suites create/delete test cases concurrently,
 * and the first matching element can be a non-navigable wrapper Card), and
 * vacuously green when no data existed at all.
 *
 * Every test now seeds its OWN uniquely-named test case via the storage API,
 * isolates it with the page's search box, and clicks exactly that row.
 * The seed is deleted (by id — never by name sweep) in afterEach.
 */

interface SeededTestCase {
  id: string;
  name: string;
}

async function seedTestCase(request: APIRequestContext): Promise<SeededTestCase | null> {
  const name = `E2E TC Runs Seed ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await request
    .post('/api/storage/test-cases', {
      data: {
        name,
        description: 'Seed for test-case-runs e2e',
        category: 'E2E',
        difficulty: 'Easy',
        initialPrompt: 'What is 2+2?',
        context: [],
        expectedOutcomes: ['Agent responds with 4'],
        expectedTrajectory: [],
      },
    })
    .catch(() => null);
  if (!res?.ok()) return null;
  const tc = await res.json().catch(() => null);
  const id = tc?.id || tc?.testCase?.id;
  return id ? { id, name } : null;
}

async function deleteSeededTestCase(request: APIRequestContext, seeded: SeededTestCase | null): Promise<void> {
  if (!seeded) return;
  await request.delete(`/api/storage/test-cases/${encodeURIComponent(seeded.id)}`).catch(() => {});
}

/**
 * From /test-cases, isolate the seeded row via the search box and click it,
 * landing on the test-case-runs page.
 */
async function openSeededTestCase(page: Page, seeded: SeededTestCase): Promise<void> {
  await page.goto('/test-cases');
  await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

  // Search by the unique seed name so exactly one row remains. The search
  // box filters CLIENT-side over the loaded pages (100 newest by createdAt),
  // and a zero-match filter swaps the list (and its "Load More" button) for
  // the no-results state. Under fullyParallel a sibling suite bulk-seeding
  // many cases between our seed and this navigation (benchmark-cases-scroll
  // seeds 90 at once) can push our row past page 1 — so if the filter finds
  // nothing, clear it, page through "Load More" (bounded) until the row is
  // loaded, then re-apply the filter to isolate it.
  const search = page.locator('[data-testid="search-test-cases"]');
  const row = page.locator(`text=${seeded.name}`).first();
  await search.fill(seeded.name);
  const foundOnFirstPage = await row.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  if (!foundOnFirstPage) {
    await search.fill('');
    for (let attempt = 0; attempt < 10 && !(await row.isVisible().catch(() => false)); attempt++) {
      const loadMore = page.getByRole('button', { name: 'Load More' });
      if (!(await loadMore.isVisible().catch(() => false))) break;
      await loadMore.click();
      await page.waitForTimeout(500);
    }
    await search.fill(seeded.name);
  }
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();

  await expect(page.locator('[data-testid="test-case-runs-page"]')).toBeVisible({ timeout: 10000 });
}

test.describe('Test Case Runs Page', () => {
  let seeded: SeededTestCase | null = null;

  test.beforeEach(async ({ request }) => {
    seeded = await seedTestCase(request);
  });

  test.afterEach(async ({ request }) => {
    await deleteSeededTestCase(request, seeded);
    seeded = null;
  });

  test('should navigate to test case runs page on card click', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);
    // openSeededTestCase already asserted the runs page rendered.
    await expect(page.locator('[data-testid="test-case-runs-page"]')).toBeVisible();
  });

  test('should display test case name in header when navigated', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    await expect(page.locator('[data-testid="test-case-name"]')).toBeAttached();
    await expect(page.locator('[data-testid="test-case-name"]')).toHaveText(seeded!.name);
  });

  test('should have back button to return to test cases', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const backButton = page.locator('[data-testid="back-button"]');
    await expect(backButton).toBeVisible();

    await backButton.click();
    await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible();
  });

  test('should have Run Test button when on runs page', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const runButton = page.locator('button:has-text("Run Test")').first();
    await expect(runButton).toBeVisible();
  });

  test('should have Edit button when on runs page', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const editButton = page.locator('button:has-text("Edit")');
    await expect(editButton).toBeVisible();
  });

  test('should display test case details panel', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    // Should show labels, prompt, or expected outcomes
    await expect(page.locator('text=/Labels|Prompt|Expected Outcomes|Context/').first()).toBeVisible();
  });

  test('should show runs list or empty state', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    // A freshly-seeded test case has no runs — the empty state must render.
    // (Run-populated states are covered by the Run Cards describe below.)
    await expect(page.locator('text=/PASSED|FAILED|No runs yet/').first()).toBeVisible();
  });
});

test.describe('Test Case Runs - Run Actions', () => {
  let seeded: SeededTestCase | null = null;

  test.beforeEach(async ({ request }) => {
    seeded = await seedTestCase(request);
  });

  test.afterEach(async ({ request }) => {
    await deleteSeededTestCase(request, seeded);
    seeded = null;
  });

  test('should open run modal when clicking Run Test', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const runButton = page.locator('button:has-text("Run Test")').first();
    await expect(runButton).toBeVisible();
    await runButton.click();

    // Run modal should open with agent/model selection
    await expect(page.locator('text=/Agent|Model|Run/').first()).toBeVisible({ timeout: 5000 });
  });

  test('should open editor when clicking Edit', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const editButton = page.locator('button:has-text("Edit")').first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    // Editor should open
    await expect(page.locator('text=/Save|Cancel|Name|Prompt/').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Test Case Runs - Run Cards', () => {
  // These tests need REAL run cards, so each one seeds two report docs for its
  // own freshly-created test case (one passed, one failed — the failed one is
  // older so the passed one is "Latest"). No conditional empty-state
  // fallbacks: if the cards don't render, the test fails.
  let seeded: SeededTestCase | null = null;
  let reportIds: string[] = [];

  async function seedReports(request: APIRequestContext, testCaseId: string): Promise<string[]> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = (id: string, passFailStatus: 'passed' | 'failed', ageMs: number, accuracy: number) => ({
      id,
      testCaseId,
      testCaseVersionId: `${testCaseId}-v1`,
      agentId: 'demo',
      agentName: 'Demo Agent',
      modelId: 'demo-model',
      modelName: 'demo-model',
      iteration: 1,
      status: 'completed',
      passFailStatus,
      metricsStatus: 'ready',
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      trajectory: [{ type: 'assistant', content: 'answer text' }],
      metrics: { accuracy, faithfulness: accuracy },
    });
    const ids = [`report-e2e-tcruns-pass-${stamp}`, `report-e2e-tcruns-fail-${stamp}`];
    const res = await request.post('/api/storage/runs/bulk', {
      data: { runs: [base(ids[0], 'passed', 1_000, 90), base(ids[1], 'failed', 60_000, 20)] },
    });
    expect(res.ok()).toBeTruthy();
    return ids;
  }

  test.beforeEach(async ({ request }) => {
    seeded = await seedTestCase(request);
    if (seeded) reportIds = await seedReports(request, seeded.id);
  });

  test.afterEach(async ({ request }) => {
    for (const id of reportIds) {
      await request.delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    reportIds = [];
    await deleteSeededTestCase(request, seeded);
    seeded = null;
  });

  test('should show run status (PASSED/FAILED) on run cards', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    await expect(page.getByText('PASSED', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('FAILED', { exact: true })).toBeVisible();
    await expect(page.locator('text=No runs yet')).toHaveCount(0);
  });

  test('should show Latest badge on most recent run only', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const latest = page.getByText('Latest', { exact: true });
    await expect(latest).toHaveCount(1, { timeout: 15000 });
    // The newest seeded report is the PASSED one, so the badge sits on it.
    const latestCard = page.locator('[class*="card"]').filter({ has: latest }).first();
    await expect(latestCard).toContainText('PASSED');
    await expect(latestCard).not.toContainText('FAILED');
  });

  test('should show a score on run cards', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    // Each RunCard renders a RunScore (mean of the run's metrics) with a
    // "Score" label — one per seeded report.
    await expect(page.getByText('Score', { exact: true })).toHaveCount(2, { timeout: 15000 });
    await expect(page.getByText('90%', { exact: true })).toBeVisible();
    await expect(page.getByText('20%', { exact: true })).toBeVisible();
  });

  test('should navigate to run details on run card click', async ({ page }) => {
    test.skip(!seeded, 'Seed test case unavailable');
    await openSeededTestCase(page, seeded!);

    const passedCard = page.locator('[class*="card"]').filter({ hasText: 'PASSED' }).first();
    await expect(passedCard).toBeVisible({ timeout: 15000 });
    await passedCard.click();

    // RunCard onClick navigates to /runs/:reportId (the report detail page).
    await expect(page).toHaveURL(new RegExp(`/runs/${reportIds[0]}$`), { timeout: 15000 });
    await expect(page.locator('[data-testid="test-case-runs-page"]')).toHaveCount(0);
  });
});
