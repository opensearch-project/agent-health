/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the app to load
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
  });

  test('should display sidebar with all navigation items', async ({ page }) => {
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible();

    // Check all main navigation links are present
    await expect(page.locator('[data-testid="nav-overview"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-agent-traces"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-test-cases"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-benchmarks"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-settings"]')).toBeVisible();
  });

  test('should navigate to Dashboard page', async ({ page }) => {
    await page.click('[data-testid="nav-overview"]');
    await expect(page.locator('[data-testid="dashboard-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="dashboard-title"]')).toHaveText('Leaderboard Overview');
  });

  test('should navigate to Test Cases page', async ({ page }) => {
    await page.click('[data-testid="nav-test-cases"]');
    await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="test-cases-title"]')).toHaveText('Test Cases');
  });

  test('should navigate to Benchmarks page', async ({ page }) => {
    await page.click('[data-testid="nav-benchmarks"]');
    await expect(page.locator('[data-testid="benchmarks-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="benchmarks-title"]')).toHaveText('Benchmarks');
  });

  test('should navigate to Settings page', async ({ page }) => {
    await page.click('[data-testid="nav-settings"]');
    await expect(page.locator('[data-testid="settings-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-title"]')).toHaveText('Settings');
  });

  test('should navigate to Agent Traces page', async ({ page }) => {
    await page.click('[data-testid="nav-agent-traces"]');
    // Check that the URL changed to agent-traces
    await expect(page).toHaveURL(/.*\/agent-traces/);
  });

  test('should show server status in sidebar footer', async ({ page }) => {
    // Server status should be visible in the footer
    const statusText = page.locator('text=Server Online').or(page.locator('text=Server Offline'));
    await expect(statusText).toBeVisible({ timeout: 10000 });
  });

  test('should display OpenSearch logo and branding', async ({ page }) => {
    // Check for the OpenSearch branding text
    await expect(page.locator('text=OpenSearch AgentHealth')).toBeVisible();
  });
});

test.describe('URL-based Navigation', () => {
  test('should load Dashboard from root URL', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="dashboard-page"]');
    await expect(page.locator('[data-testid="dashboard-title"]')).toBeVisible();
  });

  test('should load Test Cases from direct URL', async ({ page }) => {
    await page.goto('/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]');
    await expect(page.locator('[data-testid="test-cases-title"]')).toBeVisible();
  });

  test('should load Benchmarks from direct URL', async ({ page }) => {
    await page.goto('/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]');
    await expect(page.locator('[data-testid="benchmarks-title"]')).toBeVisible();
  });

  test('should load Settings from direct URL', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForSelector('[data-testid="settings-page"]');
    await expect(page.locator('[data-testid="settings-title"]')).toBeVisible();
  });
});
