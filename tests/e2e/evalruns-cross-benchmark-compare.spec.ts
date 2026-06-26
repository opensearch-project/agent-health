/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: cross-benchmark Compare from the Evaluation Runs page.
 *
 * Regression guard for two coupled behaviors that used to block benchmark-free
 * comparison:
 *
 *   1. The "Compare" action was DISABLED when the selected runs spanned more
 *      than one benchmark, and an amber banner said "Compare requires runs from
 *      the same benchmark." Comparison is now a test-case-level primitive, so
 *      cross-benchmark selection is valid.
 *   2. Clicking Compare with a multi-benchmark selection must route to the
 *      benchmark-free `/compare?runs=a,b` URL (never `/compare/undefined`).
 *
 * This spec mocks two benchmarks (each with one run) so the selection spans two
 * benchmarks, selects both runs, and asserts: the banner is the new
 * informational (non-blocking) copy, Compare is enabled, and it navigates to
 * `/compare?runs=…`.
 */

import { test, expect, type Route } from '@playwright/test';

const now = new Date().toISOString();

function run(id: string, name: string, agentKey: string, tcIds: string[]) {
  return {
    id,
    name,
    createdAt: now,
    status: 'completed',
    agentKey,
    modelId: 'claude-sonnet-4-20250514',
    results: Object.fromEntries(tcIds.map(tc => [tc, { reportId: `${id}-${tc}`, status: 'completed' }])),
    stats: { passed: tcIds.length, failed: 0, errored: 0, total: tcIds.length },
  };
}

function benchmark(id: string, name: string, tcIds: string[], r: ReturnType<typeof run>) {
  return {
    id, name, description: '', createdAt: now, updatedAt: now,
    currentVersion: 1,
    versions: [{ version: 1, createdAt: now, testCaseIds: tcIds }],
    testCaseIds: tcIds,
    runs: [r],
  };
}

const benchA = benchmark('bm-alpha', 'Alpha Benchmark', ['tc-1', 'tc-2'], run('run-alpha', 'Alpha Run', 'demo', ['tc-1', 'tc-2']));
const benchB = benchmark('bm-beta', 'Beta Benchmark', ['tc-2', 'tc-3'], run('run-beta', 'Beta Run', 'pulsar', ['tc-2', 'tc-3']));

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Cross-benchmark Compare from Evaluation Runs', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [benchA, benchB], total: 2 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/evaluation-runs')) return json(route, { evaluationRuns: [], total: 0 });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/storage/annotations**', (route) => json(route, { annotations: [], total: 0 }));
  });

  test('multi-benchmark selection enables Compare and routes to /compare?runs=…', async ({ page }) => {
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(1500);

    // All time (mocked runs are "now", but be deterministic regardless of default).
    const timeBtn = page.locator('button:has-text("Last")').first();
    if (await timeBtn.count()) {
      await timeBtn.click();
      await page.waitForTimeout(300);
      const allTime = page.getByText('All time', { exact: true }).last();
      if (await allTime.count()) await allTime.click();
      await page.waitForTimeout(800);
    }

    // Flat view so both runs are individually selectable rows.
    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.count()) { await flat.click(); await page.waitForTimeout(600); }

    // Select both runs (one per benchmark). After a row is selected its button
    // aria-label flips to "Deselect run", so the still-unselected row is always
    // the FIRST "Select run for comparison" button — click first() twice.
    const selectBtn = () => page.locator('button[aria-label="Select run for comparison"]');
    await expect(selectBtn()).toHaveCount(2, { timeout: 10000 });
    await selectBtn().first().click({ force: true });
    await page.waitForTimeout(350);
    await expect(selectBtn()).toHaveCount(1);
    await selectBtn().first().click({ force: true });
    await page.waitForTimeout(450);

    // The banner must be the new informational copy, NOT the old blocking warning.
    await expect(page.getByText(/Comparison happens at the test-case level/i)).toBeVisible();
    await expect(page.getByText(/requires runs from the same benchmark/i)).toHaveCount(0);

    // Compare is enabled and routes to the benchmark-free comparison URL.
    const compare = page.locator('button:has-text("Compare")').last();
    await expect(compare).toBeEnabled();
    await compare.click();

    await page.waitForURL(/\/compare\?runs=/, { timeout: 10000 });
    expect(page.url()).not.toContain('/compare/undefined');
    expect(page.url()).toContain('run-alpha');
    expect(page.url()).toContain('run-beta');
  });
});
