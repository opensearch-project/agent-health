/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

const COVERAGE_DIR = path.join(process.cwd(), '.nyc_output');

/**
 * Custom test fixtures for AgentEval E2E tests
 */

// Sample test case data
export const sampleTestCase = {
  name: 'E2E Test Case',
  description: 'Test case created by E2E tests',
  labels: ['category:RCA', 'difficulty:Medium'],
  prompt: 'What is causing the high CPU usage on the web server?',
  contextItems: [
    {
      type: 'alert' as const,
      content: 'High CPU alert triggered on web-server-01',
    },
  ],
  expectedOutcomes: [
    'Agent should identify the process causing high CPU',
    'Agent should suggest remediation steps',
  ],
};

// Sample benchmark data
export const sampleBenchmark = {
  name: 'E2E Test Benchmark',
  description: 'Benchmark created by E2E tests',
};

// Helper to wait for app to be ready
export async function waitForAppReady(page: Page): Promise<void> {
  // Wait for the sidebar to be visible (indicates app is loaded)
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
}

// Helper to navigate using sidebar
export async function navigateToPage(
  page: Page,
  pageName: 'Overview' | 'Test Cases' | 'Benchmarks' | 'Agent Traces' | 'Settings'
): Promise<void> {
  const sidebarLinks: Record<string, string> = {
    'Overview': 'nav-overview',
    'Test Cases': 'nav-evals3-test-cases',
    'Benchmarks': 'nav-evals3-benchmarks',
    'Agent Traces': 'nav-agent-traces',
    'Settings': 'nav-settings',
  };

  const testId = sidebarLinks[pageName];
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForLoadState('domcontentloaded');
}

// Helper to clear test data
export async function clearTestData(page: Page): Promise<void> {
  // Navigate to settings and clear data if needed
  await navigateToPage(page, 'Settings');
  // Look for clear data button if it exists
  const clearButton = page.locator('button:has-text("Clear All Data")');
  if (await clearButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await clearButton.click();
    // Confirm in dialog
    const confirmButton = page.locator('button:has-text("Continue")');
    if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmButton.click();
    }
  }
}

// Helper to create a test case
export async function createTestCase(
  page: Page,
  testCase: typeof sampleTestCase
): Promise<void> {
  await navigateToPage(page, 'Test Cases');
  await page.click('[data-testid="new-test-case-button"]');
  await page.waitForTimeout(1000);

  // Fill in form - try to find name input
  const nameInput = page.locator('input').first();
  if (await nameInput.isVisible()) {
    await nameInput.fill(testCase.name);
  }
}

// Helper to create a benchmark
export async function createBenchmark(
  page: Page,
  benchmark: typeof sampleBenchmark
): Promise<void> {
  await navigateToPage(page, 'Benchmarks');
  await page.click('[data-testid="new-benchmark-button"]');
  await page.waitForTimeout(1000);

  // Fill in form
  const nameInput = page.locator('input').first();
  if (await nameInput.isVisible()) {
    await nameInput.fill(benchmark.name);
  }
}

// Ensure .nyc_output directory exists (once, at import time)
if (process.env.E2E_COVERAGE === 'true') {
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
}

// Extended test with fixtures and optional coverage collection
export const test = base.extend<{
  authenticatedPage: Page;
}>({
  // Collect Istanbul coverage from window.__coverage__ after each test
  page: async ({ page }, use) => {
    await use(page);

    if (process.env.E2E_COVERAGE === 'true') {
      const coverage = await page.evaluate(() => (window as any).__coverage__).catch(() => null);
      if (coverage) {
        const fileName = `coverage-${uuidv4()}.json`;
        fs.writeFileSync(
          path.join(COVERAGE_DIR, fileName),
          JSON.stringify(coverage)
        );
      }
    }
  },

  authenticatedPage: async ({ page }, use) => {
    // Navigate to the app and wait for it to be ready
    await page.goto('/');
    await waitForAppReady(page);
    await use(page);
  },
});

export { expect };
