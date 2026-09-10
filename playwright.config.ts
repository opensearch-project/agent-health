/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, devices } from '@playwright/test';

const backendPort = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001';
const devPort = process.env.AH_DEV_PORT || process.env.AGENT_HEALTH_DEV_PORT || '4000';

/**
 * Playwright configuration for E2E testing of Agent Health UI
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
      ? `http://127.0.0.1:${backendPort}`
      : (process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${devPort}`),

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Take screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'on-first-retry',
  },

  /* Configure projects for major browsers. The mobile project is part of the
     same npm run test:e2e / e2e-tests CI gate, but runs only the focused
     geometry suite so the full desktop suite is not doubled. */
  projects: [
    {
      name: 'chromium',
      testIgnore: /mobile-gate\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile-gate\.spec\.ts/,
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
      },
    },
  ],

  /* Run your local dev server before starting the tests */
  /* In CI, use single production server; in local dev, use separate dev servers */
  /* Set PLAYWRIGHT_SKIP_WEBSERVER=1 to run tests against an already-running server */
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : process.env.CI
    ? {
        command: 'npm run server',
        url: `http://127.0.0.1:${backendPort}`,
        reuseExistingServer: false,
        timeout: 120000,
        env: {
          // E2E runs don't have a real OpenSearch trace backend, so the
          // default 5-minute trace poll per test case (30 attempts × 10s)
          // is wasted wall time. Fail fast instead.
          TRACE_POLL_MAX_ATTEMPTS: process.env.TRACE_POLL_MAX_ATTEMPTS ?? '2',
          TRACE_POLL_INTERVAL_MS: process.env.TRACE_POLL_INTERVAL_MS ?? '1000',
        },
      }
    : [
        {
          command: 'npm run dev:server',
          url: `http://127.0.0.1:${backendPort}/health`,
          reuseExistingServer: true,
          timeout: 120000,
          env: {
            TRACE_POLL_MAX_ATTEMPTS: process.env.TRACE_POLL_MAX_ATTEMPTS ?? '2',
            TRACE_POLL_INTERVAL_MS: process.env.TRACE_POLL_INTERVAL_MS ?? '1000',
          },
        },
        {
          command: 'npm run dev',
          url: `http://127.0.0.1:${devPort}`,
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
