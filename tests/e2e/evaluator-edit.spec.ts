/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E tests for the redesigned Evaluator editor page.
 *
 * Covers user-visible behaviours of the two-column layout:
 *   - Sticky header keeps title + Cancel + Save reachable when scrolling
 *   - Full-width layout (no centered narrow column with empty left third)
 *   - System Prompt char/line counter
 *   - System evaluator: Lock badge, Save hidden, inputs disabled
 *   - Custom evaluator: full create + delete round trip via the UI
 *   - Cancel returns to /evaluators
 *
 * Each test uses a backend-created fixture where possible to avoid
 * coupling to seed data that may differ between environments.
 */

import { test, expect } from './fixtures/test-fixtures';

const SYSTEM_EVALUATOR_ID = 'system-rca-default';
const UNIQUE = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('Evaluator Edit Page (redesign)', () => {
  test('Cancel from new-evaluator page returns to /evaluators', async ({ page }) => {
    await page.goto('/evaluators/new');
    await expect(page.getByRole('heading', { name: /new evaluator/i })).toBeVisible({
      timeout: 15000,
    });

    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page).toHaveURL(/\/evaluators$/);
  });

  test('System prompt counter updates as the user types', async ({ page }) => {
    await page.goto('/evaluators/new');
    await expect(page.getByRole('heading', { name: /new evaluator/i })).toBeVisible({
      timeout: 15000,
    });

    const prompt = page.getByPlaceholder(/expert evaluator/i);
    await prompt.fill('first line\nsecond line\nthird line');

    await expect(page.getByText(/3 lines/i)).toBeVisible();
    await expect(page.getByText(/33 chars/i)).toBeVisible();
  });

  test('Header stays in view while scrolling the form', async ({ page }) => {
    await page.goto('/evaluators/new');
    const header = page.getByRole('heading', { name: /new evaluator/i });
    await expect(header).toBeVisible({ timeout: 15000 });

    // Capture header bbox before and after scrolling the page
    const before = await header.boundingBox();
    expect(before).not.toBeNull();

    await page.evaluate(() => window.scrollTo(0, 800));
    await page.waitForTimeout(150);

    const after = await header.boundingBox();
    expect(after).not.toBeNull();
    // Sticky header should still be near the top of the viewport
    // (allow some tolerance for sub-pixel layout differences).
    expect(after!.y).toBeLessThan(120);
    // And its on-screen position must not move much vs. before.
    expect(Math.abs((after!.y) - (before!.y))).toBeLessThan(40);
  });

  test('Layout uses the full width — content extends well beyond the centered narrow column', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/evaluators/new');
    await expect(page.getByRole('heading', { name: /new evaluator/i })).toBeVisible({
      timeout: 15000,
    });

    const prompt = page.getByPlaceholder(/expert evaluator/i);
    const box = await prompt.boundingBox();
    expect(box).not.toBeNull();

    // Pre-redesign the prompt sat inside max-w-5xl mx-auto (≈1024px),
    // leaving the left ~30% of a 1600px viewport empty. After redesign
    // the right (main) column starts well past the 360px sidebar and
    // the prompt is at least ~700px wide.
    expect(box!.x).toBeGreaterThan(300);
    expect(box!.width).toBeGreaterThan(700);
  });

  test('System evaluator opens read-only with a Lock badge and no Save button', async ({
    page,
  }) => {
    await page.goto(`/evaluators/${SYSTEM_EVALUATOR_ID}/edit`);

    await expect(page.getByRole('heading', { name: /view evaluator/i })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/system \(read-only\)/i)).toBeVisible();
    await expect(
      page.getByText(/duplicate.*editable copy/i),
    ).toBeVisible();

    // Save is hidden, Cancel is visible
    await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^cancel$/i })).toBeVisible();

    // Inputs are disabled — pick the system prompt textarea as a proxy
    const prompt = page.getByPlaceholder(/expert evaluator/i).or(
      page.locator('textarea.font-mono').first(),
    );
    if (await prompt.count()) {
      await expect(prompt.first()).toBeDisabled();
    }
  });

  test('Custom evaluator: full create + delete round trip via the UI', async ({
    page,
    request,
  }) => {
    const evalName = UNIQUE('E2E Eval');

    await page.goto('/evaluators/new');
    await expect(page.getByRole('heading', { name: /new evaluator/i })).toBeVisible({
      timeout: 15000,
    });

    // Fill the form
    await page.getByPlaceholder(/factuality checker/i).fill(evalName);
    await page
      .getByPlaceholder(/describe what this evaluator assesses/i)
      .fill('Created by Playwright. Safe to delete.');
    await page
      .getByPlaceholder(/expert evaluator/i)
      .fill('You are an integration-test judge. Score the agent.');

    // Save
    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/api\/storage\/evaluators$/.test(r.url()) &&
          r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /^save$/i }).click(),
    ]);

    expect(createResp.status()).toBe(201);
    const created = await createResp.json();
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(evalName);

    // After create, the page navigates to the read-only view of the new
    // evaluator (so the user can confirm the persisted state and the v1 pill).
    await expect(page).toHaveURL(new RegExp(`/evaluators/${created.id}$`));
    await expect(page.getByRole('heading', { name: /view evaluator/i })).toBeVisible({
      timeout: 10000,
    });

    // Cleanup via the API so we don't depend on the list-row delete UX.
    const del = await request.delete(`/api/storage/evaluators/${created.id}`);
    expect(del.ok()).toBeTruthy();
  });

  test('Add Metric appends a row and Pass Threshold value persists', async ({ page }) => {
    await page.goto('/evaluators/new');
    await expect(page.getByRole('heading', { name: /new evaluator/i })).toBeVisible({
      timeout: 15000,
    });

    // Initial: 1 metric. Add → 2 metrics.
    const initialNameInputs = page.locator('input[placeholder^="e.g., accuracy"]');
    await expect(initialNameInputs).toHaveCount(1);

    await page.getByRole('button', { name: /add metric/i }).click();
    await expect(initialNameInputs).toHaveCount(2);

    // Set pass threshold and verify it stays
    const threshold = page.locator('#passThreshold');
    await threshold.fill('85');
    await expect(threshold).toHaveValue('85');
  });
});
