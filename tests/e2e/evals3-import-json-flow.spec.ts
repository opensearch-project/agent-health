/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the JSON-import "created IDs are unavailable" regression.
 *
 * Background: BenchmarksPage's and TestCasesPage's (both the legacy
 * components/BenchmarksPage.tsx / components/TestCasesPage.tsx AND the
 * evals3/ variants) `handleImportFile` used to re-fetch the entire
 * test-case corpus after `bulkCreate()` just to resolve the newly-created
 * ids by matching on `name` -- both a full-payload performance bug and a
 * correctness bug (two test cases sharing a name resolve to the wrong id).
 * The evals3 duplicates were even more broken: they read a non-existent
 * `.ids` property off the bulk-create result (always `undefined`), so
 * import silently failed with "created IDs are unavailable" on EVERY
 * attempt, logged to the console with no user-visible error.
 *
 * The fix takes the created records directly from the bulk-create response
 * (`result.testCases`, which the server already returns), so this is a
 * real, previously-always-broken user flow this spec drives end-to-end via
 * an actual file upload (not a mocked handler), the way a user would hit
 * it. tests/e2e/fixtures/sample-import-test-cases.json (2 test cases) is
 * purpose-built for this and was sitting unused until now.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from './fixtures/test-fixtures';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-import-test-cases.json');

test.describe('JSON import flow — created-ids-from-bulk-response regression', () => {
  const createdBenchmarkIds: string[] = [];
  const createdTestCaseIds: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of createdBenchmarkIds) {
      await request.delete(`/api/storage/benchmarks/${encodeURIComponent(id)}`).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    }
  });

  test('evals3 BenchmarksPage: importing a JSON file creates a benchmark with both test cases (not "created IDs are unavailable")', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Capture the bulk-create response so the test can independently verify
    // the ids it returns are the same ones the benchmark ends up with. Await
    // the response explicitly: async page.on('response') handlers are not
    // joined by Playwright, so navigation can win the race with res.json().
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });

    const bulkResponsePromise = page.waitForResponse(res =>
      res.request().method() === 'POST' && /\/api\/storage\/test-cases\/bulk(\?|$)/.test(res.url()),
    );
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    const bulkBody = await (await bulkResponsePromise).json();
    const bulkCreatedIds = (bulkBody.testCases || []).map((tc: any) => tc.id);
    createdTestCaseIds.push(...bulkCreatedIds);

    // On success the handler navigates to the new benchmark's runs page —
    // the pre-fix bug logged an error and returned without navigating.
    await page.waitForURL(/\/evaluations\/benchmarks\/[^/]+\/runs/, { timeout: 15000 });

    const match = page.url().match(/\/evaluations\/benchmarks\/([^/]+)\/runs/);
    expect(match).not.toBeNull();
    const benchmarkId = match![1];
    createdBenchmarkIds.push(benchmarkId);

    expect(bulkCreatedIds.length).toBe(2);
    expect(consoleErrors.some(e => e.includes('created IDs are unavailable'))).toBe(false);

    // The benchmark itself was created with exactly the ids bulkCreate returned.
    const bmRes = await page.request.get(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
    expect(bmRes.ok()).toBeTruthy();
    const benchmark = await bmRes.json();
    expect(new Set(benchmark.testCaseIds)).toEqual(new Set(bulkCreatedIds));
    expect(benchmark.testCaseIds).toHaveLength(2);
  });

  test('evals3 TestCasesPage: importing a JSON file creates a benchmark with both test cases (not "created IDs are unavailable")', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    const bulkResponsePromise = page.waitForResponse(res =>
      res.request().method() === 'POST' && /\/api\/storage\/test-cases\/bulk(\?|$)/.test(res.url()),
    );
    await page.locator('input[type="file"]').setInputFiles(FIXTURE_PATH);
    const bulkBody = await (await bulkResponsePromise).json();
    const bulkCreatedIds = (bulkBody.testCases || []).map((tc: any) => tc.id);
    createdTestCaseIds.push(...bulkCreatedIds);

    await page.waitForURL(/\/evaluations\/benchmarks\/[^/]+\/runs/, { timeout: 15000 });

    const match = page.url().match(/\/evaluations\/benchmarks\/([^/]+)\/runs/);
    expect(match).not.toBeNull();
    const benchmarkId = match![1];
    createdBenchmarkIds.push(benchmarkId);

    expect(bulkCreatedIds.length).toBe(2);
    expect(consoleErrors.some(e => e.includes('created IDs are unavailable'))).toBe(false);

    const bmRes = await page.request.get(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
    expect(bmRes.ok()).toBeTruthy();
    const benchmark = await bmRes.json();
    expect(new Set(benchmark.testCaseIds)).toEqual(new Set(bulkCreatedIds));
    expect(benchmark.testCaseIds).toHaveLength(2);
  });
});
