/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Skills Evaluator Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/skills');
    await page.waitForSelector('[data-testid="skills-page"]', { timeout: 30000 });
  });

  test('should display Skills Evaluator page with title', async ({ page }) => {
    await expect(page.locator('[data-testid="skills-title"]')).toHaveText('Skills Evaluator');
  });

  test('should show skill selector dropdown', async ({ page }) => {
    const selector = page.locator('[data-testid="skill-selector"]');
    await expect(selector).toBeVisible();
  });

  test('should show agent and judge model dropdowns', async ({ page }) => {
    await expect(page.locator('[data-testid="agent-selector"]')).toBeVisible();
    await expect(page.locator('[data-testid="judge-model-selector"]')).toBeVisible();
  });

  test('should have Run Evaluation button disabled initially', async ({ page }) => {
    const btn = page.locator('[data-testid="run-evaluation-btn"]');
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  });

  test('should discover and list available skills in dropdown', async ({ page }) => {
    const selector = page.locator('[data-testid="skill-selector"]');
    await selector.click();

    // Wait for the dropdown content to appear
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5000 });

    // Should have at least one skill option (from .claude/skills/)
    const options = listbox.locator('[role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should validate skill when selected from dropdown', async ({ page }) => {
    const selector = page.locator('[data-testid="skill-selector"]');
    await selector.click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5000 });

    // Click the first available skill
    const firstOption = listbox.locator('[role="option"]').first();
    await firstOption.click();

    // Should show validation result
    await expect(page.locator('[data-testid="validation-result"]')).toBeVisible({ timeout: 10000 });
  });

  test('should enable Run Evaluation after valid skill selection', async ({ page }) => {
    const selector = page.locator('[data-testid="skill-selector"]');
    await selector.click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5000 });

    const firstOption = listbox.locator('[role="option"]').first();
    await firstOption.click();

    // Wait for validation to complete
    await expect(page.locator('[data-testid="validation-result"]')).toBeVisible({ timeout: 10000 });

    // Run Evaluation button should now be enabled
    const btn = page.locator('[data-testid="run-evaluation-btn"]');
    await expect(btn).toBeEnabled({ timeout: 5000 });
  });

  test('should show SKILL.md tab with instructions after validation', async ({ page }) => {
    const selector = page.locator('[data-testid="skill-selector"]');
    await selector.click();

    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible({ timeout: 5000 });

    const firstOption = listbox.locator('[role="option"]').first();
    await firstOption.click();

    await expect(page.locator('[data-testid="validation-result"]')).toBeVisible({ timeout: 10000 });

    // SKILL.md tab should be visible with content
    await expect(page.locator('text=SKILL.md')).toBeVisible();
    await expect(page.locator('text=Skill Instructions')).toBeVisible();
  });

  test('should be accessible from sidebar navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    const skillsNav = page.locator('[data-testid="nav-skills"]');
    await expect(skillsNav).toBeVisible();
    await skillsNav.click();

    await expect(page).toHaveURL(/.*\/skills/);
    await expect(page.locator('[data-testid="skills-page"]')).toBeVisible();
  });
});
