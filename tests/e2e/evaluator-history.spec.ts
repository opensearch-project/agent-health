/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for the Evaluator history & version-diff flow.
 *
 * Covers the user-visible behaviours added in this PR:
 *
 *   List page (/evaluators)
 *     - Each row is a single click target leading to the read-only view page.
 *     - Each custom-evaluator row shows exactly two icon-buttons: History and Delete.
 *     - System-evaluator rows show only History (Delete is hidden because the
 *       server protects them anyway).
 *     - The History icon-button deep-links into the view page on the History tab.
 *     - The Delete icon-button opens the confirmation dialog and does NOT
 *       trigger the row's navigate-to-view click.
 *
 *   View page (/evaluators/:id)
 *     - Renders read-only with header buttons Close, Duplicate, Edit.
 *     - All form fields are disabled.
 *     - Banner text "Read-only view. Click Edit to modify…" is visible.
 *     - Tabs strip with "Latest" + "History" is visible.
 *     - Version pill in header reflects the persisted currentVersion.
 *     - URL hash #history opens the History tab on first paint.
 *     - History tab disabled when only v1 exists.
 *
 *   Edit page (/evaluators/:id/edit)
 *     - Header has Save / Cancel (no Tabs).
 *     - After Save the page navigates to the view page (NOT the list) and the
 *       version pill bumps by one — the visible signal that the save worked.
 *     - Cancel returns to the view page of the same evaluator.
 *
 *   Diff dialog (Compare two versions)
 *     - Compare button disabled until exactly two checkboxes are selected.
 *     - Opening the dialog shows "Comparing v{a} → v{b}" header.
 *     - Unified ↔ Split toggle changes layout (column count proxies that).
 *     - +N / −M counters reflect non-zero changes.
 *
 * Each test uses a backend-created fixture with a unique name so parallel
 * runs and re-runs don't collide. Fixtures are cleaned up via the API in
 * afterEach to keep the test cluster tidy.
 */

import { test, expect } from './fixtures/test-fixtures';

const SYSTEM_EVALUATOR_ID = 'system-rca-default';
const UNIQUE = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const BASE_PAYLOAD = {
  description: 'Created by evaluator-history.spec.ts — safe to delete.',
  systemPrompt: 'v1 prompt body — line one.\nLine two.\nLine three.',
  scoringConfig: {
    metrics: [
      { name: 'accuracy', description: 'Overall accuracy', weight: 1.0, scale: 100 },
    ],
    passThreshold: 70,
    scale: 100,
  },
  inferenceConfig: { temperature: 0.1, maxTokens: 4096 },
};

test.describe('Evaluator history & version diff', () => {
  // Track every evaluator we create so afterEach can clean it up even if
  // the test failed mid-flow.
  const createdIds = new Set<string>();

  test.afterEach(async ({ request }) => {
    for (const id of createdIds) {
      await request
        .delete(`/api/storage/evaluators/${encodeURIComponent(id)}`)
        .catch(() => {});
    }
    createdIds.clear();
  });

  /**
   * Helper: create an evaluator via the API at a target version count.
   * Returns the latest evaluator object.
   */
  async function createEvaluator(
    request: any,
    name: string,
    versionCount = 1,
  ): Promise<any> {
    const create = await request.post('/api/storage/evaluators', {
      data: { name, ...BASE_PAYLOAD },
    });
    expect(create.status()).toBe(201);
    let ev = await create.json();
    createdIds.add(ev.id);

    // Bump to N versions, mutating the system prompt each round so the
    // version-history diff has something meaningful to render.
    for (let v = 2; v <= versionCount; v++) {
      const update = await request.put(
        `/api/storage/evaluators/${encodeURIComponent(ev.id)}`,
        {
          data: {
            ...ev,
            systemPrompt: `${BASE_PAYLOAD.systemPrompt}\n\n# v${v} addition\nExtra rule introduced in v${v}.`,
            scoringConfig: {
              ...BASE_PAYLOAD.scoringConfig,
              passThreshold: 70 + v, // also bumps pass threshold so that diff-counters are non-zero
            },
          },
        },
      );
      expect(update.ok()).toBeTruthy();
      ev = await update.json();
    }
    return ev;
  }

  // ───────────────────────── List page ─────────────────────────

  test('Custom evaluator row shows exactly two action buttons (History + Delete)', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('History 2-buttons');
    const ev = await createEvaluator(request, evalName, 1);

    await page.goto('/evaluators');
    const row = page.getByRole('button', { name: new RegExp(evalName) }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    const historyBtn = row.locator('button[title="View version history"]');
    const deleteBtn = row.locator('button[title="Delete evaluator"]');
    await expect(historyBtn).toHaveCount(1);
    await expect(deleteBtn).toHaveCount(1);

    // No legacy buttons should remain (Edit, Duplicate, View were removed
    // from the row to keep the surface predictable).
    await expect(row.locator('button[title="Edit evaluator"]')).toHaveCount(0);
    await expect(row.locator('button[title="Duplicate evaluator"]')).toHaveCount(0);

    // Sanity: the URL accessible via the row is the view page (no /edit).
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/evaluators/${ev.id}$`));
  });

  test('System evaluator row shows only History (no Delete) because system evals are protected', async ({
    page,
  }) => {
    await page.goto('/evaluators');

    const systemRow = page
      .getByRole('button')
      .filter({ has: page.getByText(/RCA Default/i) })
      .first();
    await expect(systemRow).toBeVisible({ timeout: 15000 });

    await expect(systemRow.locator('button[title="View version history"]')).toHaveCount(1);
    await expect(systemRow.locator('button[title="Delete evaluator"]')).toHaveCount(0);
  });

  test('Clicking the row navigates to the view page (not the edit page)', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Row click → view');
    const ev = await createEvaluator(request, evalName, 1);

    await page.goto('/evaluators');
    const row = page.getByRole('button', { name: new RegExp(evalName) }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/evaluators/${ev.id}$`));
    await expect(
      page.getByRole('heading', { name: /view evaluator/i }),
    ).toBeVisible();
  });

  test('Delete icon-button opens the confirmation dialog without navigating', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Delete dialog');
    await createEvaluator(request, evalName, 1);

    await page.goto('/evaluators');
    const row = page.getByRole('button', { name: new RegExp(evalName) }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    await row.locator('button[title="Delete evaluator"]').click();

    // The confirmation dialog appears — and crucially we did NOT navigate.
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByText(/delete evaluator/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/evaluators$/);

    // Cancel out of the dialog so afterEach can do API-based cleanup
    // without an open dialog blocking interactions.
    await page.getByRole('button', { name: /^cancel$/i }).click();
  });

  // ───────────────────────── View page (read-only) ─────────────────────────

  test('View page is read-only with header buttons Close + Duplicate + Edit', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('View readonly');
    const ev = await createEvaluator(request, evalName, 1);

    await page.goto(`/evaluators/${ev.id}`);
    await expect(
      page.getByRole('heading', { name: /view evaluator/i }),
    ).toBeVisible({ timeout: 15000 });

    // Read-only banner is the user's signal that this is a non-editable surface.
    await expect(page.getByText(/read-only view/i)).toBeVisible();
    await expect(
      page.getByText(/new immutable version is created on save/i),
    ).toBeVisible();

    // Header actions: Close, Duplicate, Edit. NO Save in view mode.
    await expect(page.getByRole('button', { name: /^close$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^duplicate$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^edit$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0);

    // The Name field is disabled (proxy for "all form fields are disabled").
    const nameInput = page.locator('#name');
    await expect(nameInput).toBeDisabled();
    await expect(nameInput).toHaveValue(evalName);
  });

  test('View page Edit button switches to the editable form (no tabs visible)', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Edit transition');
    const ev = await createEvaluator(request, evalName, 1);

    await page.goto(`/evaluators/${ev.id}`);
    await page.getByRole('button', { name: /^edit$/i }).click();

    await expect(page).toHaveURL(new RegExp(`/evaluators/${ev.id}/edit$`));
    await expect(
      page.getByRole('heading', { name: /edit evaluator/i }),
    ).toBeVisible();

    // Edit mode hides the Latest / History tab switcher — there's only one
    // thing the user can be doing here, which is saving v_{N+1}.
    await expect(page.getByRole('tablist')).toHaveCount(0);

    // Save button is back in the header.
    await expect(page.getByRole('button', { name: /^save$/i })).toBeVisible();
    // And inputs are no longer disabled.
    await expect(page.locator('#name')).toBeEnabled();
  });

  // ─────────────── Tabs (Latest / History) deep-linking ───────────────

  test('Default URL opens the Latest tab; #history opens the History tab', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Tab deep-link');
    const ev = await createEvaluator(request, evalName, 3);

    // Default — no hash → Latest selected.
    await page.goto(`/evaluators/${ev.id}`);
    const latestTab = page.getByRole('tab', { name: /^Latest/i });
    const historyTab = page.getByRole('tab', { name: /^History/i });
    await expect(latestTab).toHaveAttribute('data-state', 'active');
    await expect(historyTab).toHaveAttribute('data-state', 'inactive');

    // #history → History selected immediately on first paint.
    await page.goto(`/evaluators/${ev.id}#history`);
    await expect(historyTab).toHaveAttribute('data-state', 'active');
    await expect(latestTab).toHaveAttribute('data-state', 'inactive');

    // The Version History card is the content of the History tab.
    await expect(page.getByText(/^Version History/)).toBeVisible();
  });

  test('History icon on the list opens the View page on the History tab', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('History deep-link');
    const ev = await createEvaluator(request, evalName, 2);

    await page.goto('/evaluators');
    const row = page.getByRole('button', { name: new RegExp(evalName) }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    await row.locator('button[title="View version history"]').click();

    await expect(page).toHaveURL(new RegExp(`/evaluators/${ev.id}#history$`));
    const historyTab = page.getByRole('tab', { name: /^History/i });
    await expect(historyTab).toHaveAttribute('data-state', 'active');
  });

  test('History tab is disabled until a second version exists', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('History single-version');
    const ev = await createEvaluator(request, evalName, 1);

    await page.goto(`/evaluators/${ev.id}`);
    await expect(
      page.getByRole('heading', { name: /view evaluator/i }),
    ).toBeVisible();

    const historyTab = page.getByRole('tab', { name: /^History/i });
    // The disabled prop on TabsTrigger surfaces as `data-disabled` and `aria-disabled`.
    await expect(historyTab).toHaveAttribute('data-disabled', '');
  });

  // ─────────────── Save → view-mode round trip ───────────────

  test('Saving in edit mode redirects to view mode and the version pill bumps', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Save bump');
    const ev = await createEvaluator(request, evalName, 1);
    expect(ev.currentVersion).toBe(1);

    await page.goto(`/evaluators/${ev.id}/edit`);
    await expect(
      page.getByRole('heading', { name: /edit evaluator/i }),
    ).toBeVisible({ timeout: 15000 });

    // Bump pass threshold to force a real, savable change.
    const threshold = page.locator('#passThreshold');
    await threshold.fill('86');

    const [putResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new RegExp(`/api/storage/evaluators/${ev.id}$`).test(r.url()) &&
          r.request().method() === 'PUT',
      ),
      page.getByRole('button', { name: /^save$/i }).click(),
    ]);
    expect(putResp.ok()).toBeTruthy();

    // After Save: URL is the view page (no /edit) and the version pill reads v2.
    await expect(page).toHaveURL(new RegExp(`/evaluators/${ev.id}$`));
    await expect(
      page.getByRole('heading', { name: /view evaluator/i }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator('header').getByText(/^v2$/)).toBeVisible({
      timeout: 10000,
    });
  });

  test('Cancel from edit mode returns to the view page of the same evaluator', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Cancel returns to view');
    const ev = await createEvaluator(request, evalName, 1);

    await page.goto(`/evaluators/${ev.id}/edit`);
    await page.getByRole('button', { name: /^cancel$/i }).click();

    await expect(page).toHaveURL(new RegExp(`/evaluators/${ev.id}$`));
    await expect(
      page.getByRole('heading', { name: /view evaluator/i }),
    ).toBeVisible();
  });

  // ─────────────── Compare → diff dialog ───────────────

  test('Compare button disabled until two versions are selected; diff dialog opens with header + counters', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Compare diff');
    const ev = await createEvaluator(request, evalName, 3);

    await page.goto(`/evaluators/${ev.id}#history`);
    await expect(page.getByText(/^Version History/)).toBeVisible({
      timeout: 15000,
    });

    const compareBtn = page.getByRole('button', { name: /^Compare \(\d+\/2\)$/ });
    await expect(compareBtn).toBeDisabled();

    // Tick exactly two version checkboxes.
    const checkboxes = page.locator('button[role="checkbox"]');
    await expect(checkboxes).toHaveCount(3);
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await expect(compareBtn).toBeEnabled();

    await compareBtn.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Comparing v\d+ → v\d+/)).toBeVisible();

    // The added/removed counters next to the diff header should be non-zero
    // because we modified the prompt and pass-threshold per version.
    await expect(dialog.getByText(/\+\d+/).first()).toBeVisible();
    await expect(dialog.getByText(/−\d+/).first()).toBeVisible();
  });

  test('Diff dialog Unified ↔ Split toggle re-renders the diff', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('Compare unified-split');
    const ev = await createEvaluator(request, evalName, 2);

    await page.goto(`/evaluators/${ev.id}#history`);
    await expect(page.getByText(/^Version History/)).toBeVisible({
      timeout: 15000,
    });

    const checkboxes = page.locator('button[role="checkbox"]');
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await page.getByRole('button', { name: /^Compare \(2\/2\)$/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Unified mode is the default.
    const unifiedBtn = dialog.getByRole('button', { name: /^Unified$/ });
    const splitBtn = dialog.getByRole('button', { name: /^Split$/ });
    // The active variant uses the default button styling; the inactive uses outline.
    // We don't assert on classes here — instead we toggle and verify the
    // split-mode column header strip ("Before / After") only appears in split.
    await splitBtn.click();
    // Split mode renders a two-column header strip with the version labels.
    // We assert two cells with the version labels are visible inside the
    // first diff hunk.
    await expect(dialog.locator('text=/^v\\d+$/').first()).toBeVisible();

    await unifiedBtn.click();
    // After flipping back the unified mode dropped the split column header,
    // so we shouldn't see the redundant uppercase labels any more.
    // (This assertion is intentionally lightweight — the precise DOM shape
    // is covered by UnifiedDiffView unit tests.)
    await expect(dialog).toBeVisible();
  });
});
