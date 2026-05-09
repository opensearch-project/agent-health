/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Tests for the full-page Assistant Chat (/assistant)
 *
 * Tests the ThreadPrimitive-based full chat interface with
 * welcome screen, suggestions, and message interaction.
 */

import { test, expect } from '@playwright/test';

test.describe('Assistant Chat Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/assistant');
    await page.waitForLoadState('networkidle');
  });

  test('renders the full-page chat interface', async ({ page }) => {
    const chatPage = page.locator('[data-testid="assistant-chat-page"]');
    await expect(chatPage).toBeVisible({ timeout: 10000 });
  });

  test('shows welcome screen with heading', async ({ page }) => {
    await expect(page.locator('text=How can I help')).toBeVisible({ timeout: 10000 });
  });

  test('shows suggested prompts', async ({ page }) => {
    await expect(page.locator('text=Benchmark Results')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Write a Test Case')).toBeVisible();
    await expect(page.locator('text=Analyze Traces')).toBeVisible();
    await expect(page.locator('text=Improve Agent')).toBeVisible();
  });

  test('has input field and send button', async ({ page }) => {
    const input = page.locator('[data-testid="assistant-chat-input"]');
    await expect(input).toBeVisible({ timeout: 10000 });

    const send = page.locator('[data-testid="assistant-chat-send"]');
    await expect(send).toBeVisible();
  });

  test('is accessible via sidebar navigation', async ({ page }) => {
    // Go to home first
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click the Assistant nav item
    const navLink = page.locator('[data-testid="nav-assistant"]');
    await expect(navLink).toBeVisible({ timeout: 10000 });
    await navLink.click();

    // Should navigate to /assistant
    await page.waitForURL('**/assistant');
    const chatPage = page.locator('[data-testid="assistant-chat-page"]');
    await expect(chatPage).toBeVisible({ timeout: 10000 });
  });

  test('input field is focusable and accepts text', async ({ page }) => {
    const input = page.locator('[data-testid="assistant-chat-input"]');
    await input.click();
    await input.fill('Test message');
    // ComposerPrimitive.Input is a textarea - check it has value
    const value = await input.inputValue();
    expect(value).toContain('Test message');
  });
});
