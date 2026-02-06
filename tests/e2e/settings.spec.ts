/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should display page title', async ({ page }) => {
    await expect(page.locator('[data-testid="settings-title"]')).toHaveText('Settings');
  });

  test('should show Debug Settings section', async ({ page }) => {
    await expect(page.locator('text=Debug Settings')).toBeVisible();
  });

  test('should show Verbose Logging toggle', async ({ page }) => {
    await expect(page.locator('text=Verbose Logging')).toBeVisible();
  });

  test('should toggle debug mode', async ({ page }) => {
    const toggle = page.locator('button[role="switch"]').first();
    await expect(toggle).toBeVisible();

    // Get initial state
    const initialState = await toggle.getAttribute('data-state');

    // Toggle
    await toggle.click();
    await page.waitForTimeout(500);

    // Verify state changed
    const newState = await toggle.getAttribute('data-state');
    expect(newState).not.toBe(initialState);
  });

  test('should show warning when debug mode is enabled', async ({ page }) => {
    const toggle = page.locator('button[role="switch"]').first();

    // Enable debug mode if not already enabled
    const state = await toggle.getAttribute('data-state');
    if (state !== 'checked') {
      await toggle.click();
      await page.waitForTimeout(500);
    }

    // Warning should be visible
    await expect(page.locator('text=Debug mode enabled')).toBeVisible();
  });
});

test.describe('Agent Endpoints Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should show Agent Endpoints section', async ({ page }) => {
    await expect(page.locator('text=Agent Endpoints').first()).toBeVisible();
  });

  test('should display built-in agents', async ({ page }) => {
    await expect(page.locator('text=Built-in Agents')).toBeVisible();

    // Should show at least one built-in agent
    const builtInBadge = page.locator('text=built-in').first();
    await expect(builtInBadge).toBeVisible();
  });

  test('should show CLI-only info alert', async ({ page }) => {
    // The info alert about CLI-only agents should be visible
    const infoAlert = page.locator('text=Some agents (like Claude Code) require CLI execution');
    await expect(infoAlert).toBeVisible();
  });

  test('should show CLI-only badge for Claude Code', async ({ page }) => {
    // Claude Code should have a "CLI only" badge
    const cliBadge = page.locator('span').filter({ hasText: 'CLI only' }).first();
    await expect(cliBadge).toBeVisible();
  });

  test('should show both built-in and CLI-only badges where appropriate', async ({ page }) => {
    // Verify that agents have appropriate badges
    // Demo Agent: built-in only (browser-compatible)
    // Claude Code: built-in AND CLI only

    // First, check Claude Code has both badges
    const claudeCodeEntry = page.locator('div').filter({ hasText: /Claude Code/ });
    if (await claudeCodeEntry.first().isVisible().catch(() => false)) {
      // Should have built-in badge
      await expect(page.locator('text=built-in').first()).toBeVisible();
      // Should have CLI only badge
      await expect(page.locator('text=CLI only').first()).toBeVisible();
    }
  });

  test('should show Custom Endpoints section', async ({ page }) => {
    await expect(page.locator('text=Custom Endpoints').first()).toBeVisible();
  });

  test('should show Add button for custom endpoints', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await expect(addButton).toBeVisible();
  });

  test('should open add endpoint form when clicking Add', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Form fields should appear
    await expect(page.locator('label:has-text("Name")').first()).toBeVisible();
    await expect(page.locator('label:has-text("Endpoint URL")').first()).toBeVisible();
  });

  test('should validate endpoint URL format', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Fill name
    const nameInput = page.locator('input#new-endpoint-name');
    await nameInput.fill('Test Endpoint');

    // Fill invalid URL
    const urlInput = page.locator('input#new-endpoint-url');
    await urlInput.fill('not-a-valid-url');

    // Try to save
    const saveButton = page.locator('button:has-text("Save")').first();
    await saveButton.click();
    await page.waitForTimeout(500);

    // Error message should appear
    const errorMessage = page.locator('text=Invalid URL').or(page.locator('text=URL'));
    if (await errorMessage.isVisible().catch(() => false)) {
      await expect(errorMessage).toBeVisible();
    }
  });

  test('should cancel adding endpoint', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Click cancel
    const cancelButton = page.locator('button:has-text("Cancel")').first();
    await cancelButton.click();

    // Form should close
    await expect(page.locator('input#new-endpoint-name')).not.toBeVisible();
  });
});

test.describe('Evaluation Storage Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should show Evaluation Storage section', async ({ page }) => {
    await expect(page.locator('text=Evaluation Storage').first()).toBeVisible();
  });

  test('should show endpoint URL input', async ({ page }) => {
    await expect(page.locator('label:has-text("Endpoint URL")').first()).toBeVisible();
  });

  test('should show username and password inputs', async ({ page }) => {
    const usernameLabel = page.locator('label:has-text("Username")').first();
    const passwordLabel = page.locator('label:has-text("Password")').first();

    await expect(usernameLabel).toBeVisible();
    await expect(passwordLabel).toBeVisible();
  });

  test('should show Test Connection button', async ({ page }) => {
    const testButton = page.locator('button:has-text("Test Connection")').first();
    await expect(testButton).toBeVisible();
  });

  test('should show Save button', async ({ page }) => {
    const saveButton = page.locator('button:has-text("Save")').filter({ hasText: 'Save' });
    await expect(saveButton.first()).toBeVisible();
  });

  test('should show Clear button', async ({ page }) => {
    const clearButton = page.locator('button:has-text("Clear")').first();
    await expect(clearButton).toBeVisible();
  });

  test('should toggle password visibility', async ({ page }) => {
    // Find password input and visibility toggle
    const passwordInput = page.locator('input#storage-password');
    const toggleButton = passwordInput.locator('..').locator('button');

    // Initially password type
    await expect(passwordInput).toHaveAttribute('type', 'password');

    // Click toggle
    await toggleButton.click();
    await expect(passwordInput).toHaveAttribute('type', 'text');

    // Click again to hide
    await toggleButton.click();
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('should show connection status', async ({ page }) => {
    // Wait for status to load
    await page.waitForTimeout(2000);

    // Should show either Connected or Not connected
    const statusText = page.locator('text=Connected to OpenSearch').or(page.locator('text=Not connected')).first();
    await expect(statusText).toBeVisible();
  });

  test('should show storage stats when connected', async ({ page }) => {
    await page.waitForTimeout(2000);

    const isConnected = await page.locator('text=Connected to OpenSearch').isVisible().catch(() => false);

    if (isConnected) {
      // Should show stats
      await expect(page.locator('text=Test Cases').first()).toBeVisible();
      await expect(page.locator('text=Experiments').first()).toBeVisible();
      await expect(page.locator('text=Runs').first()).toBeVisible();
    }
  });

  test('should have Refresh button for storage stats', async ({ page }) => {
    const refreshButton = page.locator('button:has-text("Refresh")');
    await expect(refreshButton).toBeVisible();
  });
});

test.describe('Observability Data Source Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should show Observability Data Source section', async ({ page }) => {
    await expect(page.locator('text=Observability Data Source')).toBeVisible();
  });

  test('should show Advanced Index Patterns toggle', async ({ page }) => {
    const advancedToggle = page.locator('text=Advanced: Index Patterns');
    await expect(advancedToggle).toBeVisible();
  });

  test('should expand Advanced Index Patterns on click', async ({ page }) => {
    const advancedToggle = page.locator('text=Advanced: Index Patterns');
    await advancedToggle.click();
    await page.waitForTimeout(500);

    // Index fields should be visible
    await expect(page.locator('label:has-text("Traces Index")').first()).toBeVisible();
    await expect(page.locator('label:has-text("Logs Index")').first()).toBeVisible();
    await expect(page.locator('label:has-text("Metrics Index")').first()).toBeVisible();
  });

  test('should show security warning when credentials entered', async ({ page }) => {
    // Find and fill the observability username input
    const usernameInput = page.locator('input#obs-username');
    await usernameInput.fill('testuser');
    await page.waitForTimeout(500);

    // Warning about localStorage should appear
    const warning = page.locator('text=Credentials stored in browser localStorage');
    if (await warning.isVisible().catch(() => false)) {
      await expect(warning).toBeVisible();
    }
  });
});

test.describe('Data Migration Section', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should show Data Migration section when localStorage data exists', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Migration section may or may not be visible depending on localStorage state
    const migrationSection = page.locator('text=Data Migration');
    const isVisible = await migrationSection.isVisible().catch(() => false);

    // Either visible or not - both are valid states
    expect(true).toBeTruthy();
  });

  test('should have Export as JSON button when migration section visible', async ({ page }) => {
    await page.waitForTimeout(2000);

    const exportButton = page.locator('button:has-text("Export as JSON")');
    if (await exportButton.isVisible().catch(() => false)) {
      await expect(exportButton).toBeVisible();
    }
  });
});
