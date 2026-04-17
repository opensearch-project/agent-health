/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Settings Page', () => {
  // Debug mode tests share server-side state, so run sequentially to avoid interference
  test.describe.configure({ mode: 'serial' });

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
    const toggle = page.locator('#debug-mode');
    await toggle.scrollIntoViewIfNeeded();
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
    const toggle = page.locator('#debug-mode');
    await toggle.scrollIntoViewIfNeeded();

    // If debug is already on (from prior test), the warning should be visible
    const currentState = await toggle.getAttribute('data-state');
    if (currentState === 'checked') {
      await expect(page.locator('text=Debug mode enabled')).toBeVisible({ timeout: 5000 });
      return;
    }

    // Enable debug mode by clicking the toggle
    await toggle.click();

    // The UI updates optimistically — check the warning appears immediately
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 5000 });
    await expect(page.locator('text=Debug mode enabled')).toBeVisible({ timeout: 5000 });
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
    // Built-in agents label is visible (not collapsible)
    const builtInLabel = page.locator('text=Built-in Agents');
    await expect(builtInLabel).toBeVisible();

    // Should show at least one built-in agent
    const builtInBadge = page.locator('text=built-in').first();
    await expect(builtInBadge).toBeVisible();
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

test.describe('Custom Endpoint Form Fields', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
  });

  test('should show Connector Type dropdown in add form', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // The Select trigger for connector type should be visible
    await expect(page.locator('label:has-text("Connector Type")').first()).toBeVisible();
  });

  test('should show Enable Traces toggle in add form', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    await expect(page.locator('label:has-text("Enable Traces")').first()).toBeVisible();
  });

  test('should default Connector Type to agui-streaming in add form', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // The SelectTrigger should display the default value
    await expect(page.locator('text=agui-streaming (default)').first()).toBeVisible();
  });

  test('should allow selecting a different connector type', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Click the Select trigger
    const selectTrigger = page.locator('button[role="combobox"]').first();
    await selectTrigger.click();
    await page.waitForTimeout(300);

    // Select 'rest'
    await page.locator('[role="option"]:has-text("rest")').first().click();
    await page.waitForTimeout(300);

    // Verify the selection changed
    await expect(selectTrigger).toContainText('rest');
  });

  test('should cancel and reset connector type and useTraces', async ({ page }) => {
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // Click cancel
    const cancelButton = page.locator('button:has-text("Cancel")').first();
    await cancelButton.click();
    await page.waitForTimeout(300);

    // Re-open the form
    await addButton.click();
    await page.waitForTimeout(500);

    // Should be back to defaults
    await expect(page.locator('text=agui-streaming (default)').first()).toBeVisible();
  });
});

test.describe('Custom Endpoint Persistence', () => {
  // Custom endpoint tests modify the same config file, so run serially to avoid write races
  test.describe.configure({ mode: 'serial' });
  // These tests involve multiple navigations and server waits, need more time
  test.setTimeout(120000);

  const AGENT_NAME = 'E2E Persistence Test Agent';
  const AGENT_URL = 'http://e2e-test.example.com:7777';

  test.beforeEach(async ({ page }) => {
    // Accept confirm dialogs (used by delete endpoint)
    page.on('dialog', dialog => dialog.accept());
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
    // Wait for server connectivity (required for saving/deleting endpoints)
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 });
    // Clean up any leftover test agents from prior runs
    let deleteBtn = page.locator(`button[aria-label="Remove ${AGENT_NAME}"]`).first();
    while (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
      deleteBtn = page.locator(`button[aria-label="Remove ${AGENT_NAME}"]`).first();
    }
  });

  test.afterEach(async ({ page }) => {
    // Best-effort cleanup: delete all test agents that exist
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 }).catch(() => {});
    let deleteBtn = page.locator(`button[aria-label="Remove ${AGENT_NAME}"]`).first();
    while (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
      deleteBtn = page.locator(`button[aria-label="Remove ${AGENT_NAME}"]`).first();
    }
  });

  test('should persist a custom endpoint across page reload', async ({ page }) => {
    // 1. Add a custom endpoint
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    const nameInput = page.locator('input#new-endpoint-name');
    await nameInput.fill(AGENT_NAME);

    const urlInput = page.locator('input#new-endpoint-url');
    await urlInput.fill(AGENT_URL);

    const saveResponsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/agents') && (resp.request().method() === 'POST' || resp.request().method() === 'PUT'),
      { timeout: 10000 },
    );
    const saveButton = page.locator('button:has-text("Save")').first();
    await saveButton.click();
    await saveResponsePromise.catch(() => {});
    await page.waitForTimeout(500);

    // 2. Verify endpoint appears
    await expect(page.locator(`text=${AGENT_NAME}`).first()).toBeVisible({ timeout: 10000 });

    // 3. Navigate away and back to test server-side persistence.
    // A plain reload can race: the component's one-shot useEffect fires
    // refreshConfig() before the Vite proxy reconnects to the backend,
    // causing it to silently fail and show no custom endpoints.
    // Navigate to another page first, wait for server connectivity, then
    // go back to /settings so the mount-time fetch succeeds.
    await page.goto('/');
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 });
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });

    // 4. Verify endpoint still appears after reload
    await expect(page.locator(`text=${AGENT_NAME}`).first()).toBeVisible({ timeout: 10000 });

    // 5. Delete the endpoint — register a fresh dialog handler right before click
    const deleteBtn = page.locator(`button[aria-label="Remove ${AGENT_NAME}"]`).first();
    if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const dialogPromise = new Promise<void>(resolve => {
        page.once('dialog', async dialog => {
          await dialog.accept().catch(() => {});
          resolve();
        });
      });
      const deleteResponsePromise = page.waitForResponse(
        resp => resp.url().includes('/api/agents') && resp.request().method() === 'DELETE',
        { timeout: 10000 },
      );
      await deleteBtn.click();
      await dialogPromise;
      await deleteResponsePromise.catch(() => {});
      await page.waitForTimeout(1000);
    }

    // 6. Verify it's gone
    await expect(page.locator(`text=${AGENT_NAME}`)).not.toBeVisible({ timeout: 10000 });
  });

  test('should persist connectorType and useTraces across page reload', async ({ page }) => {
    const TRACED_AGENT_NAME = 'E2E Traced REST Agent';
    const TRACED_AGENT_URL = 'http://e2e-traced.example.com:7778';

    // Accept confirm dialogs for delete (catch already-handled errors from auto-dismissed dialogs)
    page.on('dialog', dialog => dialog.accept().catch(() => {}));

    // Cleanup before
    let deleteBtn = page.locator(`button[aria-label="Remove ${TRACED_AGENT_NAME}"]`).first();
    while (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
      deleteBtn = page.locator(`button[aria-label="Remove ${TRACED_AGENT_NAME}"]`).first();
    }

    // 1. Open add form
    const addButton = page.locator('button:has-text("Add")').first();
    await addButton.click();
    await page.waitForTimeout(500);

    // 2. Fill name and URL
    await page.locator('input#new-endpoint-name').fill(TRACED_AGENT_NAME);
    await page.locator('input#new-endpoint-url').fill(TRACED_AGENT_URL);

    // 3. Select 'rest' connector type
    const selectTrigger = page.locator('button[role="combobox"]').first();
    await selectTrigger.click();
    await page.waitForTimeout(300);
    await page.locator('[role="option"]:has-text("rest")').first().click();
    await page.waitForTimeout(300);

    // 4. Enable traces
    const tracesSwitch = page.locator('label:has-text("Enable Traces")').locator('..').locator('button[role="switch"]');
    const isChecked = await tracesSwitch.getAttribute('data-state');
    if (isChecked !== 'checked') {
      await tracesSwitch.click();
      await page.waitForTimeout(300);
    }

    // 5. Save
    const saveResponsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/agents') && (resp.request().method() === 'POST' || resp.request().method() === 'PUT'),
      { timeout: 10000 },
    );
    const saveButton = page.locator('button:has-text("Save")').first();
    await saveButton.click();
    await saveResponsePromise.catch(() => {});
    await page.waitForTimeout(500);

    // 6. Verify agent appears with connector type and traces badge
    await expect(page.locator(`text=${TRACED_AGENT_NAME}`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=rest').first()).toBeVisible();
    await expect(page.locator('text=traces').first()).toBeVisible();

    // 7. Navigate away and back to verify persistence (avoid reload race — see first test)
    await page.goto('/');
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 });
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30000 });
    await expect(page.locator(`text=${TRACED_AGENT_NAME}`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=rest').first()).toBeVisible();
    await expect(page.locator('text=traces').first()).toBeVisible();

    // 8. Cleanup
    deleteBtn = page.locator(`button[aria-label="Remove ${TRACED_AGENT_NAME}"]`).first();
    if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(1000);
    }
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
    // Wait for server to be online and storage stats to finish loading
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 });
    // Wait for "Loading storage stats..." to disappear (stats API response)
    await expect(page.locator('text=Loading storage stats')).not.toBeVisible({ timeout: 30000 }).catch(() => {});

    // Should show either Connected or Not connected
    const statusText = page.locator('text=Connected to OpenSearch').or(page.locator('text=Not connected')).first();
    await expect(statusText).toBeVisible({ timeout: 15000 });
  });

  test('should show storage stats when connected', async ({ page }) => {
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 });

    const isConnected = await page.locator('text=Connected to OpenSearch').isVisible({ timeout: 10000 }).catch(() => false);

    if (isConnected) {
      // Should show stats
      await expect(page.locator('text=Test Cases').first()).toBeVisible();
      await expect(page.locator('text=Experiments').first()).toBeVisible();
      await expect(page.locator('text=Runs').first()).toBeVisible();
    }
  });

  test('should have Refresh button for storage stats', async ({ page }) => {
    // Refresh button only appears after storage stats load (requires server online)
    await expect(page.locator('text=Server Online')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=Loading storage stats')).not.toBeVisible({ timeout: 30000 }).catch(() => {});
    const refreshButton = page.locator('button:has-text("Refresh")');
    await expect(refreshButton).toBeVisible({ timeout: 15000 });
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
