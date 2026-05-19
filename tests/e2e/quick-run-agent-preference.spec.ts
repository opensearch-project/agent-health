/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect, Page } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';

const QUICKRUN_AGENT_KEY_LS = 'agent-health:prefs:agentKey';

/**
 * Ensure at least one test case exists so the popup can be opened.
 * Returns the test case id, or null if creation failed.
 */
async function ensureTestCaseExists(request: APIRequestContext): Promise<string | null> {
  const list = await request.get(`/api/storage/test-cases`).catch(() => null);
  if (list?.ok()) {
    const data = await list.json().catch(() => null);
    if (data) {
      const testCases = Array.isArray(data) ? data : data.testCases ?? [];
      if (testCases.length > 0) return testCases[0].id;
    }
  }

  const created = await request.post(`/api/storage/test-cases`, {
    data: {
      name: `Popup Agent Pref Seed ${Date.now()}`,
      description: 'Seed test case for QuickRunModal agent-default e2e tests',
      category: 'E2E',
      difficulty: 'Easy',
      initialPrompt: 'What is the current time?',
      context: [],
      expectedTrajectory: [],
    },
  }).catch(() => null);

  if (created?.ok()) {
    const tc = await created.json().catch(() => null);
    return tc?.id || tc?.testCase?.id || null;
  }
  return null;
}

/** Open the QuickRunModal for the first visible test case on /test-cases. */
async function openQuickRunModal(page: Page): Promise<void> {
  await page.goto('/test-cases');
  await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
  // Wait for cards to render
  await page.waitForTimeout(1500);

  const card = page.locator('[class*="card"]').filter({ hasText: /run/i }).first();
  await card.hover();

  const runButton = page.locator('[data-testid="test-case-run-button"]').first();
  await runButton.waitFor({ state: 'visible', timeout: 10000 });
  await runButton.click();

  // Wait for modal to appear
  await page.waitForSelector('[data-testid="quickrun-agent-select"]', { timeout: 10000 });
}

test.describe('QuickRunModal — agent default and persistence', () => {
  test.beforeEach(async ({ page, request }) => {
    // Make sure storage has at least one test case to operate on
    await ensureTestCaseExists(request);

    await page.goto('/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    // Reset the QuickRun agent preference so we can test "first-time" behavior
    await page.evaluate((key) => localStorage.removeItem(key), QUICKRUN_AGENT_KEY_LS);
    await page.reload();
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
  });

  test('defaults to Observio when no preference is stored', async ({ page }) => {
    await openQuickRunModal(page);

    // The trigger should display the Observio agent name
    const trigger = page.locator('[data-testid="quickrun-agent-select"]');
    await expect(trigger).toContainText(/Observio/i, { timeout: 5000 });

    // The default isn't written to localStorage until the user actually picks
    // something (usePersistedState only persists on setState). The important
    // contract here is just that the popup shows Observio out of the box.
  });

  test('persists the user-selected agent across modal reopens', async ({ page }) => {
    await openQuickRunModal(page);

    // Open the agent dropdown and pick the Demo agent (always available)
    const trigger = page.locator('[data-testid="quickrun-agent-select"]');
    await trigger.click();

    // Built-in agents are collapsed behind a "Built-in (N)" toggle.
    const builtInToggle = page.locator('button:has-text("Built-in")').first();
    if (await builtInToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
      await builtInToggle.click();
    }

    const demoOption = page.locator('[role="option"]:has-text("Demo Agent")').first();
    await demoOption.waitFor({ state: 'visible', timeout: 5000 });
    await demoOption.click();

    await expect(trigger).toContainText(/Demo Agent/i);

    // Verify localStorage holds the new selection
    const storedAfter = await page.evaluate((key) => localStorage.getItem(key), QUICKRUN_AGENT_KEY_LS);
    expect(storedAfter).toBe(JSON.stringify('demo'));

    // Close the modal (Escape) and re-open — the choice must stick
    await page.keyboard.press('Escape');
    // Some shadcn modals close via the X button rather than Escape; fall back if still open
    if (await page.locator('[data-testid="quickrun-agent-select"]').isVisible({ timeout: 1000 }).catch(() => false)) {
      const closeBtn = page.locator('button[aria-label="Close"], button:has(svg.lucide-x)').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
    }

    await openQuickRunModal(page);
    const triggerAfterReopen = page.locator('[data-testid="quickrun-agent-select"]');
    await expect(triggerAfterReopen).toContainText(/Demo Agent/i, { timeout: 5000 });
  });

  test('persists agent across full page reloads', async ({ page }) => {
    // Pre-seed a non-default selection
    await page.evaluate((args) => {
      localStorage.setItem(args.key, JSON.stringify('demo'));
    }, { key: QUICKRUN_AGENT_KEY_LS });

    await page.reload();
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    await openQuickRunModal(page);
    const trigger = page.locator('[data-testid="quickrun-agent-select"]');
    await expect(trigger).toContainText(/Demo Agent/i, { timeout: 5000 });
  });

  test('falls back to preferred default when stored agent key is unknown', async ({ page }) => {
    // Inject a stale/unknown agent key into localStorage
    await page.evaluate((args) => {
      localStorage.setItem(args.key, JSON.stringify('agent-that-does-not-exist'));
    }, { key: QUICKRUN_AGENT_KEY_LS });

    await page.reload();
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    await openQuickRunModal(page);

    // The component's reconciliation effect should have picked observio
    const trigger = page.locator('[data-testid="quickrun-agent-select"]');
    await expect(trigger).toContainText(/Observio/i, { timeout: 5000 });

    const stored = await page.evaluate((key) => localStorage.getItem(key), QUICKRUN_AGENT_KEY_LS);
    expect(stored).toBe(JSON.stringify('observio'));
  });
});
