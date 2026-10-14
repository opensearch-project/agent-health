/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the debug/dev-mode page-latency HUD (DebugLatencyHud + lib/pageLatency.ts).
 *
 * Owner's information design (2026-09-27): the collapsed pill is the CURRENT
 * page + ONE number (time-to-ready) + a colour dot; expanded shows plain
 * rows -- Page ready / First paint / API count + wall span + slowest
 * requests / "Slow steps on this page" (only when recorded) -- no legend,
 * no navigation history, no previous page, no summed API duration.
 * Everything resets on every route change.
 *
 * Debug mode is enabled through BOTH halves of the real mechanism (see
 * lib/debug.ts + App.tsx's `DebugStateSync`): `POST /api/debug` sets the
 * server-side truth (so the per-route-change sync in `App.tsx` doesn't
 * clobber it back to off a moment later), and `page.addInitScript`
 * pre-seeds the SAME `localStorage.agenteval_debug` key the Settings page
 * writes, so it's already correct at the very first render.
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

  test('the pill is the current route + ONE time-to-ready number with a colour dot, and follows client-side navigation', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    const pill = page.getByTestId('debug-latency-hud-pill');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    // Wait for the benchmarks page to report itself ready ("…" → a number).
    await expect(pill).toHaveText(/^● benchmarks · \d+(\.\d)? (ms|s)$/, { timeout: 15_000 });
    await expect(pill).not.toContainText(/render|paint|api/i);
    await expect(page.getByTestId('debug-latency-hud-dot')).toHaveAttribute('data-band', /fast|ok|slow/);

    // Client-side nav (NOT page.goto -- a full reload would reset module state).
    await page.getByTestId('nav-evals3-runs').click();
    await expect(pill).toHaveText(/^● eval-runs · \d+(\.\d)? (ms|s)$/, { timeout: 15_000 });

    // Expanded: current page only -- nothing about the page we came from.
    await page.getByTestId('debug-latency-hud').click();
    const panel = page.getByTestId('debug-latency-hud-panel');
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText(/Last \d+ navigations|prev page|● benchmarks/);
  });

  test('expanded view: plain-language rows, the slowest requests, API wall span ≤ page ready, no legend, steps only when recorded', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: true } });
    await page.addInitScript(() => {
      window.localStorage.setItem('agenteval_debug', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    const pill = page.getByTestId('debug-latency-hud-pill');
    await expect(pill).toHaveText(/^● benchmarks · \d+(\.\d)? (ms|s)$/, { timeout: 15_000 });

    // Collapsed footprint: the panel is only rendered once expanded.
    await expect(page.getByTestId('debug-latency-hud-panel')).toHaveCount(0);
    await page.getByTestId('debug-latency-hud').click();
    const panel = page.getByTestId('debug-latency-hud-panel');
    await expect(panel).toBeVisible();

    const parseMs = (s: string): number => {
      const m = /(\d+(?:\.\d+)?) (ms|s)/.exec(s);
      if (!m) throw new Error(`no duration in ${JSON.stringify(s)}`);
      return m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    };
    const readyText = await page.getByTestId('debug-latency-hud-ready').innerText();
    const paintText = await page.getByTestId('debug-latency-hud-paint').innerText();
    const apiText = await page.getByTestId('debug-latency-hud-api').innerText();
    expect(readyText).toMatch(/^\d+(\.\d)? (ms|s)$/); // reported by the page itself (no ~ estimate marker)
    expect(paintText).toMatch(/^First paint\s*\d+(\.\d)? (ms|s)$/);
    expect(apiText).toMatch(/^API\s*\d+ requests? · \d+(\.\d)? (ms|s) wall$/);
    // The benchmarks list page fetches its data (at least one /api/* request)…
    const apiCount = parseInt(/(\d+) request/.exec(apiText)![1], 10);
    expect(apiCount).toBeGreaterThan(0);
    // …and the wall-clock span of those requests can never exceed the page's own time-to-ready.
    expect(parseMs(apiText.replace(/^API\s*\d+ requests? · /, ''))).toBeLessThanOrEqual(parseMs(readyText));

    // Slowest requests: method + templated path + duration, at most 5, ids collapsed.
    const requests = page.getByTestId('debug-latency-hud-request');
    const n = await requests.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
    await expect(requests.first()).toHaveText(/^(GET|POST|PUT|PATCH|DELETE) \/api\/\S+?\s*\d+(\.\d)? (ms|s)$/);
    for (const text of await requests.allInnerTexts()) expect(text).not.toMatch(/\?|[0-9a-f]{8}-[0-9a-f]{4}-/i);

    // No legend, no history, no "Operations", no summed api duration anywhere.
    const panelText = await panel.innerText();
    expect(panelText).not.toMatch(/< 50 ms|< 200 ms|≥ 200 ms|Last \d+ navigations|prev page|Operations|measurements|render /);
    // No steps recorded on this page → the section is absent, and there is no placeholder sentence for it.
    await expect(page.getByTestId('debug-latency-hud-operations')).toHaveCount(0);
    expect(panelText).not.toMatch(/Slow steps|No operation timings/);

    // Record a step through the console API (same lib/performance path the trace flow view uses)…
    await page.waitForFunction(() => typeof (window as any).__agentHealthPerf?.startMeasure === 'function');
    await page.evaluate(async () => {
      const api = (window as any).__agentHealthPerf;
      api.startMeasure('e2eSample.flowTransform');
      await new Promise(r => setTimeout(r, 60));
      api.endMeasure('e2eSample.flowTransform', false);
    });
    // …and the "Slow steps on this page" section appears with that step, still without a legend.
    const ops = page.getByTestId('debug-latency-hud-operations');
    await expect(ops).toContainText('Slow steps on this page');
    await expect(page.getByTestId('debug-latency-hud-op')).toHaveCount(1);
    await expect(page.getByTestId('debug-latency-hud-op')).toContainText('flowTransform');
    await expect(ops).not.toContainText(/< 50 ms|Clear/);

    // Line budget: 3 summary rows + ≤5 request rows + the steps block (≤3 rows).
    expect(await panel.locator(':scope > div').count()).toBeLessThanOrEqual(3 + 5 + 1);
    expect(await page.getByTestId('debug-latency-hud-op').count()).toBeLessThanOrEqual(3);

    // Everything is reset on the next route change: steps are gone, the pill is the new page's.
    await page.getByTestId('nav-evals3-runs').click();
    await expect(pill).toContainText('eval-runs', { timeout: 15_000 });
    await expect(page.getByTestId('debug-latency-hud-operations')).toHaveCount(0);
  });

  test('the former Performance Monitor overlay is gone; its DEBUG_PERFORMANCE flag now shows this HUD instead', async ({ page, request }) => {
    await request.post('/api/debug', { data: { enabled: false } });
    await page.addInitScript(() => {
      window.localStorage.removeItem('agenteval_debug');
      window.localStorage.setItem('DEBUG_PERFORMANCE', 'true');
    });

    await page.goto('/evaluations/benchmarks');
    await expect(page.getByTestId('debug-latency-hud')).toBeVisible({ timeout: 15_000 });
    // Give the old overlay's 1 s localStorage poll (had it still been mounted) time to fire.
    await page.waitForTimeout(1500);
    await expect(page.getByText('Performance Monitor')).toHaveCount(0);
    await expect(page.getByText('No metrics recorded yet')).toHaveCount(0);
    await expect(page.locator('[data-testid="debug-latency-hud"]')).toHaveCount(1);
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
