/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, devices } from '@playwright/test';

const backendPort = process.env.AGENT_HEALTH_PORT || '4001';
const devPort = process.env.AGENT_HEALTH_DEV_PORT || '4000';

/**
 * Playwright configuration for E2E testing of AgentEval UI
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 2 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    /* In CI, use production server; in local dev, use Vite dev server */
    baseURL: process.env.CI
      ? `http://localhost:${backendPort}`
      : (process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${devPort}`),

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Take screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Run your local dev server before starting the tests */
  /* In CI, use single production server; in local dev, use separate dev servers */
  webServer: process.env.CI
    ? {
        command: 'npm run server',
        url: `http://localhost:${backendPort}`,
        reuseExistingServer: false,
        timeout: 120000,
      }
    : [
        {
          command: 'npm run dev:server',
          url: `http://localhost:${backendPort}/health`,
          reuseExistingServer: true,
          timeout: 120000,
        },
        {
          command: 'npm run dev',
          url: `http://localhost:${devPort}`,
          reuseExistingServer: true,
          timeout: 120000,
        },
      ],

  /* Test timeout */
  timeout: 60000,

  /* Expect timeout */
  expect: {
    timeout: 10000,
  },
});
