/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: run-inspector re-run provenance chip papercut.
 *
 * Re-run provenance chip crowding the title — a long source-run name used
 * to wrap the "re-run of <source>" pill onto multiple lines, fighting the
 * (truncated) run title for vertical space. The identical chip exists on
 * TWO pages -- RunInspectorPage.tsx's split-panel inspector
 * (/evaluations/runs/:id/inspect) and EvalRunDetailPage.tsx's report page
 * (/evaluations/runs/:id) -- both are covered below.
 *
 * NOTE: an earlier draft of this spec also carried a "Run inspector —
 * auto-select first case on load" describe block, asserting that a bare
 * run URL auto-selects the first case instead of showing the "Select a
 * test case" pane. That assumption was superseded by the verdict-first
 * run-report redesign (#443, landed on main after this branch was cut):
 * a bare run URL now deliberately lands on the empty-selection overview
 * pane (see the `initialSelectionDone` comment in RunInspectorPage.tsx).
 * The block asserted the opposite of that intentional behavior and was
 * dropped as stale scope rather than reintroduced as a regression.
 *
 * Data is seeded through the storage API and cleaned up via the shared
 * TestDataTracker + crash ledger (mirrors rerun-evaluation-run.spec.ts /
 * lazy-report-loading.spec.ts).
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Run inspector — compact re-run provenance chip', () => {
  let testCaseId: string | null = null;
  let sourceRunId: string | null = null;
  let childRunId: string | null = null;
  let seeded = false;

  // Deliberately long -- this is exactly the shape that used to wrap the
  // pill onto multiple lines. Kept generic/non-identifying per repo policy.
  const LONG_SOURCE_NAME = uniqueTestName('inspector-papercut-source') +
    ' — full regression sweep across the staging benchmark with trajectory capture and judge validation enabled end to end';

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('inspector-papercut-chip-tc'),
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'p',
        expectedOutcomes: ['o'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    sourceRunId = `eval-run-e2e-inspector-papercut-src-${Date.now()}`;
    const srcRes = await request.put(`/api/storage/evaluation-runs/${sourceRunId}`, {
      data: {
        id: sourceRunId,
        name: LONG_SOURCE_NAME,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api',
        testCaseSnapshots: [],
        results: {},
        createdAt: new Date().toISOString(),
      },
    });
    if (!srcRes.ok()) return;

    childRunId = `eval-run-e2e-inspector-papercut-child-${Date.now()}`;
    const childRes = await request.put(`/api/storage/evaluation-runs/${childRunId}`, {
      data: {
        id: childRunId,
        name: 'Full Regression Retrieval Agent Evaluation Run',
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'ui',
        testCaseSnapshots: [],
        results: {},
        createdAt: new Date().toISOString(),
        rerunOf: sourceRunId,
      },
    });
    seeded = childRes.ok();
  });

  test.afterAll(async ({ request }) => {
    if (childRunId) await request.delete(`/api/storage/evaluation-runs/${childRunId}`).catch(() => {});
    if (sourceRunId) await request.delete(`/api/storage/evaluation-runs/${sourceRunId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  // (An EvalRunDetailPage variant of the next test was removed with that page;
  // /evaluations/runs/:id now redirects to the inspector.)

  test('chip stays single-line and the title is not squeezed by a long source name -- RunInspectorPage (/evaluations/runs/:id/inspect)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source/child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('re-run of');

    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(30);

    await expect(chip).toHaveAttribute('title', new RegExp(LONG_SOURCE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // The run's own title (the inline-rename field) keeps its normal
    // single-line height too -- the chip isn't stealing its vertical space --
    // and carries a tooltip with the full (untruncated) name.
    const title = page.getByTestId('run-inspector-rename-text');
    await expect(title).toBeVisible();
    const titleBox = await title.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(titleBox!.height).toBeLessThan(30);
    await expect(title).toHaveAttribute('title', 'Full Regression Retrieval Agent Evaluation Run');
  });

  test('chip click still navigates to the source run', async ({ page }) => {
    test.skip(!seeded, 'Could not seed source/child run (storage not configured?)');

    await page.goto(`/evaluations/runs/${childRunId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });

    const chip = page.locator('[data-testid="rerun-provenance-chip"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();

    // The source run opens in its inspector (the older detail page is retired).
    await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${sourceRunId}/inspect$`), { timeout: 10_000 });
  });
});
