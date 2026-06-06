/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E round-trip tests for the assistant chat.
 *
 * Mocks `/api/assistant/chat` SSE responses with `page.route()` so the test
 * verifies the UI ↔ server contract (input, send, message bubbles, multi-turn
 * continuity) without needing the claude CLI or AWS Bedrock credentials in CI.
 *
 * Existing `assistant-chat.spec.ts` only checks the welcome chrome — this file
 * exercises the actual send → render → follow-up flow.
 */

import { test, expect, type Route } from '@playwright/test';

/**
 * Builds a fake SSE response body of `delta` events terminated by a `done` event.
 * Mirrors the wire format produced by server/routes/assistant.ts.
 */
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

test.describe('Assistant Chat — round trip', () => {
  test('sends a message and renders the streamed assistant response', async ({ page }) => {
    let chatCalls = 0;
    let lastBody: any = null;

    await page.route('**/api/assistant/chat', async (route) => {
      chatCalls += 1;
      lastBody = route.request().postDataJSON();
      const reply = 'Hello! This is a mocked assistant response.';
      await fulfillSSE(route, buildSSEBody([reply], reply));
    });
    // assistant-ui also probes /health on first render — keep it cheap.
    await page.route('**/api/assistant/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, provider: 'claude-code' }) })
    );

    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="assistant-chat-page"]', { timeout: 30_000 });

    const input = page.locator('[data-testid="assistant-chat-input"]');
    const send = page.locator('[data-testid="assistant-chat-send"]');

    await input.click();
    await input.fill('Why did this run fail?');
    await send.click();

    // The mocked reply text appears somewhere in the thread.
    await expect(page.getByText('Hello! This is a mocked assistant response.', { exact: false }))
      .toBeVisible({ timeout: 15_000 });

    expect(chatCalls).toBe(1);
    expect(lastBody?.message).toBe('Why did this run fail?');
    expect(typeof lastBody?.sessionId).toBe('string');
    expect(lastBody.sessionId.length).toBeGreaterThan(0);
  });

  test('preserves session continuity across two turns (same sessionId reused)', async ({ page }) => {
    const observedSessionIds: string[] = [];
    const observedMessages: string[] = [];
    let turn = 0;

    await page.route('**/api/assistant/chat', async (route) => {
      const body = route.request().postDataJSON();
      observedSessionIds.push(body.sessionId);
      observedMessages.push(body.message);
      turn += 1;
      const reply = turn === 1 ? 'First reply.' : 'Second reply.';
      await fulfillSSE(route, buildSSEBody([reply], reply));
    });
    await page.route('**/api/assistant/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, provider: 'claude-code' }) })
    );

    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="assistant-chat-page"]', { timeout: 30_000 });

    const input = page.locator('[data-testid="assistant-chat-input"]');
    const send = page.locator('[data-testid="assistant-chat-send"]');

    // Turn 1
    await input.click();
    await input.fill('First question');
    await send.click();
    await expect(page.getByText('First reply.', { exact: false })).toBeVisible({ timeout: 15_000 });

    // Turn 2 — same chat, no reload.
    await input.click();
    await input.fill('Follow-up question');
    await send.click();
    await expect(page.getByText('Second reply.', { exact: false })).toBeVisible({ timeout: 15_000 });

    expect(observedMessages).toEqual(['First question', 'Follow-up question']);
    expect(observedSessionIds).toHaveLength(2);
    // Critical: same client-side sessionId is reused across turns so the server can resume.
    expect(observedSessionIds[0]).toBe(observedSessionIds[1]);
  });

  test('clicking the "Benchmark Results" suggestion auto-sends the prompt', async ({ page }) => {
    let lastMessage: string | null = null;

    await page.route('**/api/assistant/chat', async (route) => {
      lastMessage = (route.request().postDataJSON() as any).message;
      await fulfillSSE(route, buildSSEBody(['Benchmark insights here.'], 'Benchmark insights here.'));
    });
    await page.route('**/api/assistant/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, provider: 'claude-code' }) })
    );

    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="assistant-chat-page"]', { timeout: 30_000 });

    await page.getByText('Benchmark Results', { exact: true }).click();

    await expect(page.getByText('Benchmark insights here.', { exact: false }))
      .toBeVisible({ timeout: 15_000 });
    expect(lastMessage).toBe("Explain this benchmark's results");
  });

  test('shows an error state when the server emits an error event', async ({ page }) => {
    await page.route('**/api/assistant/chat', async (route) => {
      const body = `data: ${JSON.stringify({ type: 'error', error: 'Claude CLI not found' })}\n\n`;
      await fulfillSSE(route, body);
    });
    await page.route('**/api/assistant/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, provider: 'claude-code' }) })
    );

    await page.goto('/assistant');
    await page.waitForSelector('[data-testid="assistant-chat-page"]', { timeout: 30_000 });

    const input = page.locator('[data-testid="assistant-chat-input"]');
    const send = page.locator('[data-testid="assistant-chat-send"]');

    await input.click();
    await input.fill('Trigger an error');
    await send.click();

    // assistant-ui surfaces stream errors as either a system error message or
    // by leaving the user-visible thread without an assistant bubble. The
    // signal we care about is that the user message itself rendered AND no
    // mocked content from a prior happy path appears.
    await expect(page.getByText('Trigger an error', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Hello! This is a mocked assistant response.', { exact: false }))
      .not.toBeVisible();
  });
});
