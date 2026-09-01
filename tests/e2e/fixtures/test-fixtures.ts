/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createTestDataTracker, TestDataTracker } from '../../helpers/testDataTracker';

const COVERAGE_DIR = path.join(process.cwd(), '.nyc_output');

/**
 * Custom test fixtures for Agent Health E2E tests
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

/**
 * Mock the async deep-dive job pattern (POST /api/comparison/deep-dive ->
 * { jobId }, then GET /api/comparison/deep-dive/jobs/:jobId polled until
 * done/error — see server/routes/comparison.ts). Centralized here because
 * essentially every comparison e2e spec that cares about the deep-dive
 * panel's RESULT (not just a quick error/503) needs to mock BOTH endpoints
 * consistently.
 */
export interface DeepDiveJobMockOptions {
  /** The DeepDiveResponse-shaped body to serve once the job reaches 'done' — static, or computed from the parsed POST body (e.g. to echo back what the client sent). */
  result?: unknown | ((postBody: any) => unknown);
  /** Called with the parsed POST body every time a new job is started (side-effect capture for assertions — does not affect what's served). */
  onPost?: (postBody: any) => void;
  /**
   * How many 'running' polls to serve before settling. Defaults to 0 (the
   * very first poll already returns the terminal state) — set higher to
   * exercise the loading/elapsed-time UI across multiple poll ticks.
   */
  runningPolls?: number;
  /** When set, the job settles in the 'error' state with this message instead of 'done'. */
  errorMessage?: string;
  /** Fixed jobId to hand back (defaults to a stable stub id — fine since these mocks never actually dedupe/cap). */
  jobId?: string;
}

export async function mockDeepDiveJob(page: Page, opts: DeepDiveJobMockOptions = {}): Promise<void> {
  const jobId = opts.jobId || 'stub-deep-dive-job';
  let pollCount = 0;
  let resultForThisJob: unknown = opts.result;

  await page.route('**/api/comparison/deep-dive', async (route) => {
    const postBody = JSON.parse(route.request().postData() || '{}');
    opts.onPost?.(postBody);
    resultForThisJob = typeof opts.result === 'function' ? (opts.result as (b: any) => unknown)(postBody) : opts.result;
    pollCount = 0;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId }) });
  });

  await page.route(`**/api/comparison/deep-dive/jobs/${jobId}`, async (route) => {
    const elapsedMs = (pollCount + 1) * 1000;
    if (pollCount < (opts.runningPolls ?? 0)) {
      pollCount++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running', elapsedMs }) });
    }
    if (opts.errorMessage) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'error', elapsedMs, error: opts.errorMessage }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'done', elapsedMs, result: resultForThisJob }) });
  });
}

// Extended test with fixtures and optional coverage collection
export const test = base.extend<{
  authenticatedPage: Page;
  testData: TestDataTracker;
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

  /**
   * Test-data cleanup tracker (see tests/helpers/testDataTracker.ts).
   *
   * e2e specs run against a real backend — often a live server wired to a
   * SHARED OpenSearch cluster — so every test case/benchmark/run/report a spec
   * creates is permanent clutter unless something deletes it. This fixture is
   * created fresh per test and its `cleanup()` always runs after the test body
   * finishes, whether the test passed, failed, or skipped early, which a
   * hand-rolled `afterAll` (easy to forget a field, or to skip on early return)
   * does not guarantee.
   *
   * Usage inside a test:
   *   test('...', async ({ page, testData }) => {
   *     const tc = await createTestCase(...);
   *     testData.testCase(tc.id);          // one line per created entity
   *     ...
   *   });
   *
   * For per-test-case report leaks specifically (DELETE on a benchmark/
   * evaluation-run does NOT cascade to the report docs referenced by
   * `results[*].reportId` / `runs[].results[*].reportId`), fetch the parent
   * AFTER it reaches a terminal state and track every reportId found:
   *   const run = await (await request.get(`/api/storage/evaluation-runs/${id}`)).json();
   *   for (const r of Object.values(run.results)) testData.run(r.reportId);
   *
   * The tracker only deletes what THIS test tracked — never reuse it to
   * delete entities the test merely read/reused (e.g. seeded/shared fixtures
   * another test created), only ones it created itself.
   */
  testData: async ({}, use) => {
    const tracker = createTestDataTracker();
    await use(tracker);
    await tracker.cleanup();
  },
});

export { expect };
