/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage: hovering (or focusing) a test-case hyperlink on the
 * comparison page surfaces a preview of the test case's input prompt,
 * without navigating away.
 *
 * Covers both link sites:
 *  - the case row's name link (UseCaseComparisonTable)
 *  - the expanded row's "View full test case" link (TaskSection)
 *
 * And the versioned-correctness requirement: the preview shows the prompt
 * AS IT WAS when the run actually executed (report.testCaseVersion), not
 * whatever the test case's content looks like today.
 *
 * Deterministic: storage, deep-dive, and metrics are all mocked via
 * page.route() — no LLM/AWS creds required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-hoverA';
const RUN_B = 'eval-run-hoverB';
const TC = 'tc-hover-prompt';
const CURRENT_PROMPT = 'CURRENT (v2): investigate the new memory leak alert.';
const RUN_PROMPT = 'RAN AS v1: why is the checkout service returning 500s?';

const evalRun = (id: string, agentKey: string, reportId: string) => ({
  id,
  docType: 'evaluation-run',
  name: `Hover Run ${agentKey}`,
  createdAt: '2026-04-01T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Checkout 500s case' }],
  results: { [TC]: { reportId, status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});

// Both runs' reports carry testCaseVersion: 1 — the run used v1, even though
// the test case has since been edited to v2 (CURRENT_PROMPT).
const report = (id: string, agentKey: string) => ({
  id,
  createdAt: '2026-04-01T10:00:00Z',
  testCaseId: TC,
  agentId: agentKey,
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 90 },
  performanceMetrics: { durationMs: 15000 },
  testCaseVersion: 1,
  trajectory: [],
});

const fullTestCase = {
  id: TC,
  name: 'Checkout 500s case',
  description: 'Investigate checkout failures',
  labels: ['category:RCA', 'difficulty:Medium'],
  category: 'RCA',
  difficulty: 'Medium',
  currentVersion: 2,
  versions: [],
  context: [],
  isPromoted: true,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-04-15T00:00:00Z',
  initialPrompt: CURRENT_PROMPT,
};

// GET /api/storage/test-cases/:id/versions — the hover's actual data source
// (asyncTestCaseStorage.getById always comes back with versions: [], see
// services/comparison/testCasePromptCache.ts's header comment).
const versionHistory = [
  { version: 1, createdAt: '2026-03-01T00:00:00Z', initialPrompt: RUN_PROMPT, context: [] },
  { version: 2, createdAt: '2026-04-15T00:00:00Z', initialPrompt: CURRENT_PROMPT, context: [] },
];

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupRoutes(page: import('@playwright/test').Page, testCaseFetchCounter: { count: number }) {
  await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));

  // One handler for the list ("**/test-cases?..."), the bulk-by-ids fetch
  // ("**/test-cases?ids=..." — ComparisonPage's own name-lookup, unrelated to
  // the hover) AND the singular-id GET ("**/test-cases/tc-hover-prompt", which
  // TaskSection uses for ITS body — also unrelated to the hover's own fetch).
  await page.route('**/api/storage/test-cases**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/test-cases/${TC}`)) {
      return json(route, fullTestCase);
    }
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    if (ids.includes(TC)) {
      return json(route, { testCases: [fullTestCase], total: 1 });
    }
    return json(route, { testCases: [], total: 0 });
  });

  // The hover's OWN lazy fetch: GET /api/storage/test-cases/:id/versions.
  await page.route(`**/api/storage/test-cases/${TC}/versions`, (route) => {
    testCaseFetchCounter.count++;
    return json(route, { versions: versionHistory, total: versionHistory.length });
  });

  await page.route('**/api/storage/evaluation-runs**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/evaluation-runs/${RUN_A}`)) return json(route, evalRun(RUN_A, 'demo', 'rep-hover-a'));
    if (url.pathname.endsWith(`/evaluation-runs/${RUN_B}`)) return json(route, evalRun(RUN_B, 'pulsar', 'rep-hover-b'));
    if (url.pathname.endsWith('/evaluation-runs')) {
      return json(route, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-hover-a'), evalRun(RUN_B, 'pulsar', 'rep-hover-b')], total: 2 });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    if (ids.some((id) => id.includes('rep-hover-a'))) runs.push(report('rep-hover-a', 'demo'));
    if (ids.some((id) => id.includes('rep-hover-b'))) runs.push(report('rep-hover-b', 'pulsar'));
    return json(route, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (route) => {
    const url = route.request().url();
    if (url.includes('rep-hover-a')) return json(route, report('rep-hover-a', 'demo'));
    if (url.includes('rep-hover-b')) return json(route, report('rep-hover-b', 'pulsar'));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
  await mockDeepDiveJob(page, { result: { markdown: 'stub deep-dive markdown', modelId: 'stub/model', durationMs: 1, runs: [] } });
}

test.describe('Comparison page — hover preview of a test case\'s input prompt', () => {
  test('hovering the case row link shows the RUN\'s prompt (not today\'s edited content)', async ({ page }) => {
    const testCaseFetchCounter = { count: 0 };
    await setupRoutes(page, testCaseFetchCounter);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const caseLink = page.locator('a', { hasText: 'Checkout 500s case' }).first();
    await expect(caseLink).toBeVisible({ timeout: 20000 });

    const preview = page.locator('[data-testid="compare-hover-prompt"]');
    await expect(preview).toHaveCount(0);

    await caseLink.hover();

    // Radix's open-intent delay (250ms) must elapse before the card appears.
    await expect(preview).toBeVisible({ timeout: 5000 });
    await expect(preview).toContainText(RUN_PROMPT);
    await expect(preview).not.toContainText(CURRENT_PROMPT);
    await expect(preview.locator('[data-testid="compare-hover-prompt-version"]').first()).toContainText('v1');

    // Hovering doesn't navigate away.
    await expect(page).toHaveURL(/\/compare/);

    // Exactly one lazy fetch for this hover (row-sweep dedup is covered
    // exhaustively at the unit level — testCasePromptCache.test.ts /
    // useTestCasePromptPreview.test.ts — this just proves the real browser
    // path fetches at all, and only once for a single hover).
    expect(testCaseFetchCounter.count).toBe(1);
  });

  test('focusing the case row link (keyboard) also opens the preview', async ({ page }) => {
    const testCaseFetchCounter = { count: 0 };
    await setupRoutes(page, testCaseFetchCounter);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const caseLink = page.locator('a', { hasText: 'Checkout 500s case' }).first();
    await expect(caseLink).toBeVisible({ timeout: 20000 });

    // Radix Tooltip dismisses on ANY scroll of an ancestor of its trigger
    // (TooltipContent's capture-phase scroll listener). In the default
    // 1280x720 viewport the case table is the last content in the page's
    // `overflow-y-auto` container and this link's bottom edge (y=723) pokes
    // 3px past the container's (y=720); focus() auto-scrolls those 3px to
    // reveal the focused element, so open-on-focus fires and the induced
    // scroll closes the tooltip ~30ms later (measured: tooltip.open →
    // scroll(scrollTop=3) → data-state="closed"). Pre-scrolling doesn't
    // help: scrolling past the scoreboard sentinel condenses the band,
    // the content shrinks to fit, and scrollTop snaps back to 0. Give the
    // page enough height that the table fits without scrolling — the
    // assertion (focus opens the preview with the RUN's prompt) is
    // unchanged.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await expect(caseLink).toBeVisible();
    await caseLink.focus();
    const preview = page.locator('[data-testid="compare-hover-prompt"]');
    await expect(preview).toBeVisible({ timeout: 5000 });
    await expect(preview).toContainText(RUN_PROMPT);
  });

  test('expanding a row and hovering "View full test case" also shows the preview', async ({ page }) => {
    const testCaseFetchCounter = { count: 0 };
    await setupRoutes(page, testCaseFetchCounter);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    const caseRow = page.locator('a', { hasText: 'Checkout 500s case' }).first();
    await expect(caseRow).toBeVisible({ timeout: 20000 });
    // Click the row itself (not the link) to expand it.
    await page.locator('tr', { has: caseRow }).first().click();

    const viewFullLink = page.locator('a', { hasText: 'View full test case' });
    await expect(viewFullLink).toBeVisible({ timeout: 20000 });

    const preview = page.locator('[data-testid="compare-hover-prompt"]');
    await viewFullLink.hover();
    await expect(preview).toBeVisible({ timeout: 5000 });
    await expect(preview).toContainText(RUN_PROMPT);
    // Exactly one versions fetch for this hover (not the same call as
    // TaskSection's own getById for its body — different endpoint entirely).
    expect(testCaseFetchCounter.count).toBe(1);
  });
});
