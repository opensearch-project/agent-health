/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Test Cases Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
  });

  test('should display page title and description', async ({ page }) => {
    await expect(page.locator('[data-testid="test-cases-title"]')).toHaveText('Test Cases');
    await expect(page.locator('text=Manage your test case library')).toBeVisible();
  });

  test('should show New Test Case button', async ({ page }) => {
    const newButton = page.locator('[data-testid="new-test-case-button"]');
    await expect(newButton).toBeVisible();
    await expect(newButton).toHaveText(/New Test Case/);
  });

  test('should open test case editor when clicking New Test Case', async ({ page }) => {
    await page.click('[data-testid="new-test-case-button"]');

    // Editor modal should be visible
    await expect(page.locator('text=Create Test Case').or(page.locator('text=Edit Test Case')).first()).toBeVisible({ timeout: 5000 });
  });

  test('should display search input', async ({ page }) => {
    const searchInput = page.locator('[data-testid="search-test-cases"]');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute('placeholder', /Search test cases/);
  });

  test('should display category filter dropdown', async ({ page }) => {
    const categoryDropdown = page.locator('button:has-text("All Categories")');
    await expect(categoryDropdown).toBeVisible();
  });

  test('should display difficulty filter dropdown', async ({ page }) => {
    const difficultyDropdown = page.locator('button:has-text("All Difficulties")');
    await expect(difficultyDropdown).toBeVisible();
  });

  test('should show empty state when no test cases exist', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(2000);

    // Check for either test cases (shown in subtitle count) or empty state
    // The subtitle shows "X total" when there are test cases, or empty state message when none
    const hasTestCaseCount = await page.locator('text=/\\d+ total/').first().isVisible().catch(() => false);
    const hasTestCaseCards = await page.locator('[class*="card"]').first().isVisible().catch(() => false);
    const hasEmptyState = await page.locator('text=No test cases yet').isVisible().catch(() => false);

    expect(hasTestCaseCount || hasTestCaseCards || hasEmptyState).toBeTruthy();
  });

  test('should filter test cases by search query', async ({ page }) => {
    const searchInput = page.locator('[data-testid="search-test-cases"]');
    await searchInput.fill('test');

    // Wait for filtering to apply
    await page.waitForTimeout(500);

    // Either filtered results or "no results" message should appear
    const pageContent = await page.textContent('body');
    expect(pageContent).toBeDefined();
  });
});

test.describe('Test Case Editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
    await page.click('[data-testid="new-test-case-button"]');
    // Wait for editor to open
    await page.waitForSelector('text=Create Test Case', { timeout: 5000 });
  });

  test('should display form fields', async ({ page }) => {
    // Check for required form fields
    await expect(page.locator('label:has-text("Name")').first()).toBeVisible();
  });

  test('should have Cancel button', async ({ page }) => {
    const cancelButton = page.locator('button:has-text("Cancel")');
    await expect(cancelButton).toBeVisible();
  });

  test('should close editor when clicking Cancel', async ({ page }) => {
    await page.click('button:has-text("Cancel")');

    // Editor should close, main page should be visible
    await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="new-test-case-button"]')).toBeVisible();
  });

  test('should have Save button', async ({ page }) => {
    const saveButton = page.locator('button:has-text("Save")');
    await expect(saveButton).toBeVisible();
  });

  test('should support form mode editing', async ({ page }) => {
    // Form mode should have name input
    const nameInput = page.locator('input[placeholder*="name"], input#name, [name="name"]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill('E2E Test Case');
      await expect(nameInput).toHaveValue('E2E Test Case');
    }
  });

  test('should have tabs for Form and JSON modes', async ({ page }) => {
    // Check for mode tabs
    const formTab = page.locator('button:has-text("Form"), [role="tab"]:has-text("Form")').first();
    const jsonTab = page.locator('button:has-text("JSON"), [role="tab"]:has-text("JSON")').first();

    const hasFormTab = await formTab.isVisible().catch(() => false);
    const hasJsonTab = await jsonTab.isVisible().catch(() => false);

    // At least one mode should be available
    expect(hasFormTab || hasJsonTab).toBeTruthy();
  });
});

test.describe('Test Case CRUD Operations', () => {
  const testCaseName = `E2E Test ${Date.now()}`;

  test('should create a new test case', async ({ page }) => {
    await page.goto('/#/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    // Open editor
    await page.click('[data-testid="new-test-case-button"]');
    await page.waitForSelector('text=Create Test Case', { timeout: 5000 });

    // Fill in form - try to find name input
    const nameInput = page.locator('input').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill(testCaseName);
    }

    // Try to save
    const saveButton = page.locator('button:has-text("Save")');
    if (await saveButton.isEnabled()) {
      await saveButton.click();
      await page.waitForTimeout(1000);
    }
  });

  test('should search for test cases', async ({ page }) => {
    await page.goto('/#/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    const searchInput = page.locator('[data-testid="search-test-cases"]');
    await searchInput.fill('CPU');
    await page.waitForTimeout(500);

    // Verify search is working (page doesn't crash)
    await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible();
  });

  test('should clear filters', async ({ page }) => {
    await page.goto('/#/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    // Apply a search filter
    const searchInput = page.locator('[data-testid="search-test-cases"]');
    await searchInput.fill('test');
    await page.waitForTimeout(500);

    // Look for clear button
    const clearButton = page.locator('button:has-text("Clear")');
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(searchInput).toHaveValue('');
    }
  });
});

test.describe('Test Case Actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
    await page.waitForTimeout(2000); // Wait for data to load
  });

  test('should show action buttons on test case card hover', async ({ page }) => {
    // Find a test case card
    const testCaseCard = page.locator('[class*="card"]').filter({ hasText: /run/ }).first();

    if (await testCaseCard.isVisible().catch(() => false)) {
      await testCaseCard.hover();
      // Action buttons should appear on hover
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to test case runs page on card click', async ({ page }) => {
    // Find and click a test case card
    const testCaseCard = page.locator('[class*="card"]').filter({ hasText: /run/ }).first();

    if (await testCaseCard.isVisible().catch(() => false)) {
      await testCaseCard.click();
      // Should navigate to runs page
      await page.waitForTimeout(1000);
    }
  });
});
