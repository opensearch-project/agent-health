/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the full-test-case-payload performance fix.
 *
 * Background: ~9 frontend call sites called the bare
 * `asyncTestCaseStorage.getAll()`, which fetches every test case's full
 * versioned content (initialPrompt, context, expectedOutcomes, versions).
 * With thousands of test cases this payload is ~168MB and made the app
 * unusably slow over a tunnel. The fix switches list-only call sites to
 * `getAll({ summary: true })` (server strips heavy fields — see
 * server/routes/storage/testCases.ts toSummary()) and, where a specific
 * record's full content is actually needed (editing an existing test
 * case), fetches it by id instead of relying on the list's summary object.
 *
 * This spec:
 *   1. Asserts the real network requests issued by /test-cases and
 *      /benchmarks (+ its "New Benchmark" editor) include `fields=summary`,
 *      so a regression back to the full payload would fail this test.
 *   2. Guards the data-loss bug this fix uncovered: TestCaseEditor used to
 *      seed its form directly from whatever `testCase` it was given. Once
 *      list views started handing it summary records (truncated prompt,
 *      empty context/expectedOutcomes), opening Edit → Save would
 *      silently persist that truncated/empty data over the real content.
 *      The fix makes TestCaseEditor refetch the full record by id before
 *      rendering the form. This test creates a test case with real
 *      context + expectedOutcomes, opens it for editing from the (summary)
 *      list, asserts the full content is shown, saves without changes, and
 *      re-reads the record via the API to confirm nothing was wiped.
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RICH_TC_NAME = `e2e-summary-fetch-rich-${STAMP}`;

test.describe('Test-case summary fetch — network + data-loss regression', () => {
  let richTestCaseId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/storage/test-cases', {
      data: {
        name: RICH_TC_NAME,
        category: 'RCA',
        difficulty: 'Medium',
        // Long enough to be truncated by the summary transform (>200 chars).
        initialPrompt:
          'Full original prompt describing a CPU spike investigation in ' +
          'exhaustive detail so that it is comfortably longer than the ' +
          '200-character truncation boundary used by the list-view summary ' +
          'payload, to make truncation obvious if it leaks into the editor.',
        context: [
          { description: 'runbook', value: 'https://runbooks.example.com/cpu-spike' },
        ],
        expectedOutcomes: [
          'Identifies the offending process',
          'Recommends a scale-up or throttle',
        ],
      },
    });
    if (res.ok()) {
      const created = await res.json();
      richTestCaseId = created.id;
    }
  });

  test.afterAll(async ({ request }) => {
    if (richTestCaseId) {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(richTestCaseId)}`).catch(() => {});
    }
  });

  test('TestCasesPage list load requests fields=summary, not the full payload', async ({ page }) => {
    const listRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'GET' && /\/api\/storage\/test-cases(\?|$)/.test(url)) {
        listRequests.push(url);
      }
    });

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
    await page.waitForTimeout(1000);

    expect(listRequests.length).toBeGreaterThan(0);
    for (const url of listRequests) {
      expect(url).toContain('fields=summary');
    }
  });

  test('BenchmarksPage list load + New Benchmark editor request fields=summary', async ({ page }) => {
    const listRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'GET' && /\/api\/storage\/test-cases(\?|$)/.test(url)) {
        listRequests.push(url);
      }
    });

    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
    await page.waitForTimeout(500);

    // Open the "New Benchmark" editor, which triggers its own test-case fetch.
    await page.click('[data-testid="new-benchmark-button"]');
    await page.waitForSelector('text=Select Test Cases, text=Basic Info', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);

    expect(listRequests.length).toBeGreaterThan(0);
    for (const url of listRequests) {
      expect(url).toContain('fields=summary');
    }
  });

  test('Dashboard test-case count requests summary + size=1, not the full payload', async ({ page }) => {
    const listRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'GET' && /\/api\/storage\/test-cases(\?|$)/.test(url)) {
        listRequests.push(url);
      }
    });

    await page.goto('/');
    await page.waitForTimeout(1500);

    expect(listRequests.length).toBeGreaterThan(0);
    for (const url of listRequests) {
      expect(url).toContain('fields=summary');
      expect(url).toContain('size=1');
    }
  });

  test('editing a test case from the (summary) list shows full content and does not wipe it on save', async ({ page }) => {
    test.skip(!richTestCaseId, 'Setup failed to create the rich test case');

    // Track requests for the full-record refetch triggered by opening Edit.
    const byIdRequests: string[] = [];
    page.on('request', req => {
      const url = req.url();
      if (req.method() === 'GET' && url.includes(`/api/storage/test-cases/${richTestCaseId}`)) {
        byIdRequests.push(url);
      }
    });

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

    // Isolate the freshly-created test case with the page's search box, then
    // open its row's Edit action.
    await page.locator('input[placeholder*="Search"]').first().fill(RICH_TC_NAME);
    const row = page.locator('tr', { hasText: RICH_TC_NAME }).first();
    await row.waitFor({ state: 'visible', timeout: 10000 });

    await row.locator('[data-testid="test-case-edit-button"]').click();
    await page.waitForSelector('text=Edit Test Case', { timeout: 5000 });

    // The editor must have refetched the full record by id (not relied on
    // the summary object handed to it by the list).
    await expect.poll(() => byIdRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
    for (const url of byIdRequests) {
      expect(url).not.toContain('fields=summary');
    }

    // The full (non-truncated) prompt must be visible, not the 200-char
    // summary truncation. Assert directly on the distinguishing tail (not
    // just a substring near the front, which the 200-char-truncated summary
    // value would ALSO match) so Playwright's auto-retry keeps polling until
    // the async getById refetch has actually landed, instead of passing
    // immediately against the still-truncated seed value.
    const promptField = page.locator('#prompt');
    await expect(promptField).toHaveValue(/leaks into the editor\.$/, { timeout: 10000 });
    const promptValue = await promptField.inputValue();
    expect(promptValue.endsWith('leaks into the editor.')).toBeTruthy();

    // The real expected outcomes must be visible, not an empty placeholder.
    const outcomeTextareas = page.locator('textarea[placeholder*="Should query"]');
    const outcomeValues = await outcomeTextareas.evaluateAll(nodes =>
      (nodes as HTMLTextAreaElement[]).map(n => n.value),
    );
    expect(outcomeValues).toContain('Identifies the offending process');
    expect(outcomeValues).toContain('Recommends a scale-up or throttle');

    // Save without changing anything.
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(1000);

    // The data-loss regression check: re-fetch the record via the API and
    // confirm context/expectedOutcomes/initialPrompt were NOT wiped.
    const res = await page.request.get(`/api/storage/test-cases/${encodeURIComponent(richTestCaseId!)}`);
    expect(res.ok()).toBeTruthy();
    const saved = await res.json();
    expect(saved.expectedOutcomes).toEqual([
      'Identifies the offending process',
      'Recommends a scale-up or throttle',
    ]);
    expect(saved.context).toEqual([
      { description: 'runbook', value: 'https://runbooks.example.com/cpu-spike' },
    ]);
    expect(saved.initialPrompt.endsWith('leaks into the editor.')).toBeTruthy();
  });
});
