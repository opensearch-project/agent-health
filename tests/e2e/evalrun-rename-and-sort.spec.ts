/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: evaluation-run inline rename + newest-first default ordering.
 *
 * Owner ask (verbatim): "I also want to be able to rename the evaluation run
 * name, and the sorting should be by time, not by name of the benchmark then
 * time."
 *
 * Covers:
 *   1. Rename via the RunInspectorPage header pencil persists across reload
 *      (real PATCH /api/storage/evaluation-runs/:id, real re-fetch on nav).
 *   2. Rename via the EvalRunsPage row pencil persists across reload.
 *   3. /evaluations/runs renders newest-first by default (no explicit sort
 *      click needed) even when a more-recently-created run's benchmark name
 *      would otherwise sort later alphabetically.
 *
 * Data is seeded through the storage API (mirrors lazy-report-loading.spec.ts)
 * and cleaned up via the shared TestDataTracker + crash ledger.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Evaluation run rename + newest-first ordering', () => {
  const tracker = createTestDataTracker();
  const seededRunIds: string[] = [];

  async function seedEvalRun(request: any, overrides: Record<string, any>): Promise<string> {
    const id = overrides.id || `e2e-rename-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run = {
      name: uniqueTestName('rename-e2e-run'),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'demo-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
      createdAt: new Date().toISOString(),
      ...overrides,
      id,
    };
    const res = await request.put(`/api/storage/evaluation-runs/${id}`, { data: run });
    expect(res.ok()).toBeTruthy();
    seededRunIds.push(id);
    tracker.evaluationRun(id);
    return id;
  }

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('renaming a run from the inspector header persists across reload', async ({ page, request }) => {
    const runId = await seedEvalRun(request, { name: uniqueTestName('inspector-rename-before') });
    const newName = uniqueTestName('inspector-rename-after');

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    const editBtn = page.getByTestId('run-inspector-rename-edit-btn');
    await expect(editBtn).toBeVisible({ timeout: 30_000 });
    await editBtn.click();

    const input = page.getByTestId('run-inspector-rename-input');
    await input.fill(newName);
    await input.press('Enter');

    // Optimistic UI update — visible immediately, no reload needed.
    await expect(page.getByTestId('run-inspector-rename-text')).toHaveText(newName);

    // Persisted server-side: a hard reload re-fetches from the API.
    await page.reload();
    await expect(page.getByTestId('run-inspector-rename-text')).toHaveText(newName, { timeout: 30_000 });

    const verify = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect((await verify.json()).name).toBe(newName);
  });

  test('renaming a run from the Evaluation Runs list row persists across reload', async ({ page, request }) => {
    const runId = await seedEvalRun(request, { name: uniqueTestName('row-rename-before') });
    const newName = uniqueTestName('row-rename-after');

    await page.goto('/evaluations/runs');
    const editBtn = page.getByTestId(`run-row-rename-${runId}-edit-btn`);
    await expect(editBtn).toBeVisible({ timeout: 30_000 });
    await editBtn.click();

    const input = page.getByTestId(`run-row-rename-${runId}-input`);
    await input.fill(newName);
    await input.press('Enter');

    await expect(page.getByTestId(`run-row-rename-${runId}-text`)).toHaveText(newName);

    await page.reload();
    // Reload re-fetches the list; filter down to this run via search so a
    // busy shared cluster's other runs don't push this row past the
    // infinite-scroll window.
    await page.getByPlaceholder('Search runs...').fill(runId);
    await expect(page.getByTestId(`run-row-rename-${runId}-text`)).toHaveText(newName, { timeout: 30_000 });

    const verify = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect((await verify.json()).name).toBe(newName);
  });

  test('Evaluation Runs list defaults to newest-first, not alphabetical-by-benchmark', async ({ page, request }) => {
    const base = Date.now();
    // Names are deliberately chosen so alphabetical order would put the
    // OLDER run first ("Aaa...") — the regression this guards against is
    // exactly "sorted by benchmark/run name, then time".
    const olderName = uniqueTestName('newest-first-order-e2e-Aaa-older-run');
    const newerName = uniqueTestName('newest-first-order-e2e-Zzz-newer-run');

    await seedEvalRun(request, { name: olderName, createdAt: new Date(base - 5 * 60_000).toISOString() });
    await seedEvalRun(request, { name: newerName, createdAt: new Date(base).toISOString() });

    await page.goto('/evaluations/runs');
    // Default view is Flat (not Grouped) — confirm before asserting order.
    await expect(page.getByTestId('viewmode-flat')).toHaveClass(/bg-muted/);

    // Scope the list to just these two test-created runs via search so a
    // busy shared cluster's other (possibly newer) runs can't push either
    // row out of the infinite-scroll window and produce a false pass/fail.
    await page.getByPlaceholder('Search runs...').fill('newest-first-order-e2e');

    await expect(page.getByText(newerName, { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(olderName, { exact: false })).toBeVisible();

    const newerRow = page.getByText(newerName, { exact: false }).locator('xpath=ancestor::tr[1]');
    const olderRow = page.getByText(olderName, { exact: false }).locator('xpath=ancestor::tr[1]');
    const newerBox = await newerRow.boundingBox();
    const olderBox = await olderRow.boundingBox();
    expect(newerBox).not.toBeNull();
    expect(olderBox).not.toBeNull();
    // Newest-first: the newer run's row renders above (smaller y) the older one.
    expect(newerBox!.y).toBeLessThan(olderBox!.y);
  });
});
