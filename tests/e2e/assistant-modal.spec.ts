/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for the Assistant Modal (floating "?" popup)
 *
 * Tests the AssistantModalPrimitive-based floating chat interface
 * that appears on every page.
 */

import { test, expect } from '@playwright/test';

test.describe('Assistant Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
  });

  test('"?" button renders on the dashboard page', async ({ page }) => {
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 10000 });
  });

  test('"?" button renders on benchmarks page', async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 10000 });
  });

  test('"?" button renders on settings page', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 10000 });
  });

  test('clicking "?" opens the popup modal', async ({ page }) => {
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await trigger.click();

    const content = page.locator('[data-testid="assistant-modal-content"]');
    await expect(content).toBeVisible({ timeout: 5000 });

    // Should show the header
    await expect(content.locator('text=AI Assistant')).toBeVisible();
  });

  test('popup shows suggestion prompts when empty', async ({ page }) => {
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await trigger.click();

    const content = page.locator('[data-testid="assistant-modal-content"]');
    await expect(content).toBeVisible({ timeout: 5000 });

    // Should show suggestion buttons
    await expect(content.locator('text=Explain this benchmark')).toBeVisible();
    await expect(content.locator('text=Help me write a test case')).toBeVisible();
  });

  test('popup has input field and send button', async ({ page }) => {
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await trigger.click();

    const input = page.locator('[data-testid="assistant-modal-input"]');
    await expect(input).toBeVisible({ timeout: 5000 });

    const send = page.locator('[data-testid="assistant-modal-send"]');
    await expect(send).toBeVisible();
  });

  test('modal persists when navigating between pages', async ({ page }) => {
    const trigger = page.locator('[data-testid="assistant-modal-trigger"]');
    await trigger.click();

    const content = page.locator('[data-testid="assistant-modal-content"]');
    await expect(content).toBeVisible({ timeout: 5000 });

    // Navigate to another page
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    // The trigger should still be visible
    await expect(page.locator('[data-testid="assistant-modal-trigger"]')).toBeVisible({ timeout: 10000 });
  });
});
