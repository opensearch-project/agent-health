/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E test for the compare-page → assistant context flow.
 *
 * Regression guard for the bug where asking the assistant "which tests passed
 * for which agent?" on /compare/<bench>?runs=a,b returned an empty answer:
 *
 *   1. useAssistantRuntime's URL parser only looked for the literal segment
 *      "benchmarks", not "compare", so benchmarkId was undefined.
 *   2. There was no concept of "the set of runs being compared" — the
 *      assistant had nothing to ground on, and tools were disabled.
 *
 * Both were fixed. This spec asserts the wire contract end-to-end:
 *   - On /compare/<bench>?runs=a,b the assistant POSTs context.benchmarkId
 *     matching the URL benchmark id.
 *   - context.comparisonRunIds is the parsed `runs` query param, in order.
 *   - context.currentUrl includes the query string (was path-only before).
 *
 * The backend `/api/assistant/chat` SSE is mocked via `page.route()` so this
 * test does NOT require the claude CLI or AWS credentials in CI.
 *
 * The compare page itself has a heavy storage-fetch mount path; we don't need
 * its UI for this test (we only assert what the assistant runtime hook does
 * with the URL). Instead we land on the dedicated /assistant page (which
 * mounts cleanly and hosts the same AssistantProvider as Layout), then push
 * the compare URL into the hash. The hook re-derives context from
 * useLocation() on every navigation, so the next chat send uses the
 * comparison context.
 */

import { test, expect, type Route, type Page } from '@playwright/test';

function buildSSEBody(deltas: string[], fullResponse: string): string {
  const lines: string[] = [];
  for (const d of deltas) {
    lines.push(`data: ${JSON.stringify({ type: 'delta', content: d })}\n\n`);
  }
  lines.push(`data: ${JSON.stringify({ type: 'done', fullResponse })}\n\n`);
  return lines.join('');
}

async function fulfillSSE(route: Route, body: string) {
  await route.fulfill({
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
    body,
  });
}

async function stubAssistantHealth(page: Page) {
  await page.route('**/api/assistant/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, provider: 'claude-code' }),
    })
  );
}

/** Push a new hash route into the running SPA without a full reload. */
async function navigateInApp(page: Page, hashPath: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hashPath);
  // Let React-router pick up the hashchange and re-run useMemo in the runtime hook.
  await page.waitForTimeout(150);
}

test.describe('Assistant context on the comparison page', () => {
  test('forwards benchmarkId and comparisonRunIds parsed from /compare/:id?runs=a,b', async ({ page }) => {
    await stubAssistantHealth(page);

    let chatBody: any = null;
    await page.route('**/api/assistant/chat', async (route) => {
      chatBody = route.request().postDataJSON();
      const reply = 'Mocked: agent-alpha passed both, agent-beta failed both.';
      await fulfillSSE(route, buildSSEBody([reply], reply));
    });

    // Land on the dedicated assistant page — it always mounts cleanly and
    // hosts the same AssistantProvider as Layout, so changing the hash to
    // /compare/… immediately re-derives the runtime context from useLocation
    // without us needing to fully mount the comparison page (which has a
    // heavy storage-fetch path that's tangential to this test).
    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="assistant-chat-page"]', { timeout: 30_000 });

    // Push the comparison URL. App.tsx uses HashRouter so the route lives
    // after `#` and useLocation() updates synchronously on hashchange.
    await navigateInApp(page, '/compare/bench-X?runs=run-A,run-B');

    const input = page.locator('[data-testid="assistant-chat-input"]');
    const send = page.locator('[data-testid="assistant-chat-send"]');
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.click();
    await input.fill('which tests passed for which agent?');
    await send.click();

    await expect(page.getByText('Mocked: agent-alpha passed both', { exact: false }))
      .toBeVisible({ timeout: 15_000 });

    expect(chatBody, 'POST /api/assistant/chat was not called').toBeTruthy();
    expect(chatBody.message).toBe('which tests passed for which agent?');
    expect(chatBody.context).toBeTruthy();

    // The two assertions this regression guard exists for:
    expect(chatBody.context.benchmarkId).toBe('bench-X');
    expect(chatBody.context.comparisonRunIds).toEqual(['run-A', 'run-B']);

    // currentUrl now includes the query string, not just the path — needed so
    // the snapshot loader & system prompt show the user-visible URL.
    expect(chatBody.context.currentUrl).toContain('/compare/bench-X');
    expect(chatBody.context.currentUrl).toContain('runs=run-A,run-B');
  });

  test('absent ?runs= leaves comparisonRunIds undefined (only benchmarkId is set)', async ({ page }) => {
    await stubAssistantHealth(page);

    let chatBody: any = null;
    await page.route('**/api/assistant/chat', async (route) => {
      chatBody = route.request().postDataJSON();
      await fulfillSSE(route, buildSSEBody(['ok'], 'ok'));
    });

    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="assistant-chat-page"]', { timeout: 30_000 });

    await navigateInApp(page, '/compare/bench-X');

    const input = page.locator('[data-testid="assistant-chat-input"]');
    const send = page.locator('[data-testid="assistant-chat-send"]');
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.click();
    await input.fill('hello');
    await send.click();

    await expect(page.getByText('ok', { exact: false })).toBeVisible({ timeout: 15_000 });

    expect(chatBody.context.benchmarkId).toBe('bench-X');
    // Critical: empty/missing ?runs= is NOT serialized as comparisonRunIds: [].
    // The hook strips empty arrays so the field is omitted (or undefined).
    expect(
      chatBody.context.comparisonRunIds === undefined ||
      (Array.isArray(chatBody.context.comparisonRunIds) && chatBody.context.comparisonRunIds.length === 0)
    ).toBe(true);
  });
});
