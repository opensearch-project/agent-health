/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the debug/dev-mode page-latency HUD (DebugLatencyHud + lib/pageLatency.ts).
 *
 * Regression guard for the owner ask: "publish latencies of each page when
 * debugging or dev mode is enabled." Debug mode is enabled through BOTH
 * halves of the real mechanism (see lib/debug.ts + App.tsx's
 * `DebugStateSync`): `POST /api/debug` sets the server-side truth (so the
 * per-route-change sync in `App.tsx` doesn't clobber it back to off a
 * moment later), and `page.addInitScript` pre-seeds the SAME
 * `localStorage.agenteval_debug` key the Settings page writes, so it's
 * already correct at the very first render — Layout's navigation-start
 * effect only re-evaluates on a route change, so relying on the async
 * server sync alone would race the initial page load.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Debug latency HUD', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ request }) => {
    // Always leave debug mode off for the next test/spec sharing this server.
    await request.post('/api/debug', { data: { enabled: false } });
  });

  test('is absent when debug mode is off', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: false } });
    await page.goto('/evaluations/benchmarks');
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);
  });

  test('shows the current route + timing once debug mode is enabled, and updates across navigations', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    const hud = page.getByTestId('debug-latency-hud');
    await expect(hud).toBeVisible({ timeout: 15_000 });
    await expect(hud).toContainText('benchmarks', { timeout: 15_000 });
    // Render time is measured within ~2 animation frames of navigation —
    // give it a moment, then require a real (non-em-dash) ms value.
    await expect(hud).not.toContainText('render —', { timeout: 15_000 });
    // Wait for the benchmarks page to report itself ready too, so it
    // finalizes into history before we navigate away from it.
    await expect(hud).not.toContainText('ready —', { timeout: 15_000 });

    // Client-side nav (NOT page.goto -- a full reload would reset the
    // module-level history this test is about to check for).
    await page.getByTestId('nav-evals3-runs').click();
    await expect(hud).toContainText('eval-runs', { timeout: 15_000 });

    // Hovering reveals history with at least the previous navigation in it.
    await hud.hover();
    const history = page.getByTestId('debug-latency-hud-history');
    await expect(history).toBeVisible();
    await expect(history).toContainText('benchmarks');
  });

  test('disappears again once debug mode is turned back off (next navigation)', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });
    await page.goto('/evaluations/benchmarks');
    await expect(page.getByTestId('debug-latency-hud')).toBeVisible({ timeout: 15_000 });

    await request.post('/api/debug', { data: { enabled: false } });
    // A client-side nav re-syncs localStorage from the server (App.tsx's
    // DebugStateSync, on every route change) before Layout starts the next
    // navigation window, so the HUD disappears without a full page reload.
    await page.getByTestId('nav-evals3-runs').click();
    await expect(page.getByTestId('debug-latency-hud')).toHaveCount(0);
  });
});
