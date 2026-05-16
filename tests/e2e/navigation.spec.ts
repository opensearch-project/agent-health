/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

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
    await expect(page.locator('[data-testid="nav-evals3-test-cases"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-evals3-benchmarks"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-settings"]')).toBeVisible();
  });

  test('should navigate to Dashboard page', async ({ page }) => {
    await page.click('[data-testid="nav-overview"]');
    // Dashboard shows either the full page or a first-run experience when no data exists
    const dashboardPage = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(dashboardPage).toBeVisible({ timeout: 15000 });
  });

  test('should navigate to Test Cases page', async ({ page }) => {
    await page.click('[data-testid="nav-evals3-test-cases"]');
    await expect(page.locator('[data-testid="test-cases-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="test-cases-title"]')).toHaveText('Test Cases');
  });

  test('should navigate to Benchmarks page', async ({ page }) => {
    await page.click('[data-testid="nav-evals3-benchmarks"]');
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

  test('should display navigation items in correct order', async ({ page }) => {
    // Get all sidebar menu button labels in order
    const sidebar = page.locator('[data-testid="sidebar"]');
    const menuItems = sidebar.locator('[data-testid^="nav-"]');

    // Expected order: Overview, Agent Traces, Evaluations, AI Dev Tools, Assistant, Settings
    const expectedOrder = [
      'nav-overview',
      'nav-agent-traces',
      'nav-evals3-benchmarks',
      'nav-evals3-test-cases',
      'nav-evals3-runs',
      'nav-evaluators',
      'nav-coding-agents',
      'nav-assistant',
      'nav-settings',
    ];

    const actualTestIds: string[] = [];
    const count = await menuItems.count();
    for (let i = 0; i < count; i++) {
      const testId = await menuItems.nth(i).getAttribute('data-testid');
      if (testId) actualTestIds.push(testId);
    }

    expect(actualTestIds).toEqual(expectedOrder);
  });
});

test.describe('URL-based Navigation', () => {
  test('should load Dashboard from root URL', async ({ page }) => {
    await page.goto('/');
    const dashboardPage = page.locator('[data-testid="dashboard-page"]').or(page.locator('[data-testid="first-run-experience"]'));
    await expect(dashboardPage).toBeVisible({ timeout: 15000 });
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
