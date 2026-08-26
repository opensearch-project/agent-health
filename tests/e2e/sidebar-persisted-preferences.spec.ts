/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect, Page } from './fixtures/test-fixtures';

/**
 * Persisted-preference round-trip coverage for the sidebar pages.
 *
 * Strategy: for each persisted key we (a) set it directly via localStorage,
 * (b) navigate / reload, (c) assert the on-disk value is unchanged AND that
 * the corresponding UI control reflects the stored value where reasonably
 * observable.
 *
 * For freshly-introduced keys we also exercise a UI round-trip (interact →
 * reload → assert) for at least one representative input per page so we
 * have proof that the UI actually writes through usePersistedState.
 */

const PREFIX = 'agent-health:';

async function setPref(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(
    ({ k, v }) => localStorage.setItem(k, JSON.stringify(v)),
    { k: PREFIX + key, v: value }
  );
}

async function getPref(page: Page, key: string): Promise<string | null> {
  return await page.evaluate((k) => localStorage.getItem(k), PREFIX + key);
}

async function clearAllPrefs(page: Page): Promise<void> {
  await page.evaluate((prefix) => {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  }, PREFIX);
}

test.describe('Sidebar pages — persisted preferences round-trip', () => {
  test.beforeEach(async ({ page }) => {
    // Visit the app once so we have a localStorage scope to manipulate.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await clearAllPrefs(page);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Dashboard — /
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Dashboard (/)', () => {
    test('persists timeRange, selectedMetric and filters', async ({ page }) => {
      await setPref(page, 'dashboard:timeRange', '30d');
      await setPref(page, 'dashboard:selectedMetric', 'avgRunTime');
      await setPref(page, 'dashboard:filters', { agentKey: 'observio' });

      await page.goto('/');
      // The dashboard renders either the data view (dashboard-page) or the
      // first-run experience depending on whether any runs exist; this test
      // only checks the localStorage prefs round-trip, so accept either as the
      // "page loaded" signal (a fresh e2e backend has no data -> first-run).
      await page.waitForSelector('[data-testid="dashboard-page"], [data-testid="first-run-experience"]', { timeout: 30000 });

      expect(await getPref(page, 'dashboard:timeRange')).toBe(JSON.stringify('30d'));
      expect(await getPref(page, 'dashboard:selectedMetric')).toBe(JSON.stringify('avgRunTime'));
      expect(JSON.parse((await getPref(page, 'dashboard:filters'))!)).toEqual({ agentKey: 'observio' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Benchmarks — /evaluations/benchmarks
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Benchmarks (/evaluations/benchmarks)', () => {
    test('persists search, timeRange, selectedAgent and sort', async ({ page }) => {
      await setPref(page, 'benchmarks:search', 'cpu');
      await setPref(page, 'prefs:timeRange', '7d');
      await setPref(page, 'prefs:agentFilter', 'observio');
      await setPref(page, 'benchmarks:sort', { field: 'score', dir: 'asc' });

      await page.goto('/evaluations/benchmarks');
      await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });

      expect(await getPref(page, 'benchmarks:search')).toBe(JSON.stringify('cpu'));
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('7d'));
      expect(await getPref(page, 'prefs:agentFilter')).toBe(JSON.stringify('observio'));
      expect(JSON.parse((await getPref(page, 'benchmarks:sort'))!))
        .toEqual({ field: 'score', dir: 'asc' });
    });

    test('UI round-trip: typing in search persists across reloads', async ({ page }) => {
      await page.goto('/evaluations/benchmarks');
      await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });

      // Scope to the page content (not the sidebar's "Search the menu" input).
      const search = page.locator('[data-testid="benchmarks-page"] input[placeholder*="Search" i]').first();
      if (await search.isVisible({ timeout: 5000 }).catch(() => false)) {
        await search.fill('memory-leak-pref');
        await page.waitForTimeout(300);
        await page.reload();
        await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
        const searchAfter = page.locator('[data-testid="benchmarks-page"] input[placeholder*="Search" i]').first();
        await expect(searchAfter).toHaveValue('memory-leak-pref');
      }
      expect(await getPref(page, 'benchmarks:search')).toBe(JSON.stringify('memory-leak-pref'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test Cases — /evaluations/test-cases
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Test Cases (/evaluations/test-cases)', () => {
    test('persists search, viewMode, timeRange, selectedBenchmark, sort, collapsedGroups', async ({ page }) => {
      await setPref(page, 'test-cases:search', 'observio');
      await setPref(page, 'prefs:viewMode', 'grouped');
      await setPref(page, 'prefs:timeRange', '30d');
      await setPref(page, 'prefs:benchmarkFilter', 'all');
      await setPref(page, 'test-cases:sort', { field: 'name', dir: 'asc' });
      await setPref(page, 'test-cases:collapsedGroups', ['Group A', 'Group B']);

      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

      expect(await getPref(page, 'test-cases:search')).toBe(JSON.stringify('observio'));
      expect(await getPref(page, 'prefs:viewMode')).toBe(JSON.stringify('grouped'));
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('30d'));
      expect(JSON.parse((await getPref(page, 'test-cases:sort'))!))
        .toEqual({ field: 'name', dir: 'asc' });
      expect(JSON.parse((await getPref(page, 'test-cases:collapsedGroups'))!))
        .toEqual(['Group A', 'Group B']);
    });

    test('UI round-trip: search input persists across reloads', async ({ page }) => {
      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
      const search = page.locator('[data-testid="test-cases-page"] input[placeholder*="Search" i]').first();
      if (await search.isVisible({ timeout: 5000 }).catch(() => false)) {
        await search.fill('persisted-search-tc');
        await page.waitForTimeout(300);
        await page.reload();
        await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
        const after = page.locator('[data-testid="test-cases-page"] input[placeholder*="Search" i]').first();
        await expect(after).toHaveValue('persisted-search-tc');
      }
      expect(await getPref(page, 'test-cases:search')).toBe(JSON.stringify('persisted-search-tc'));
    });

    test('view-mode toggle lives in the page header with Grouped listed first', async ({ page }) => {
      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });

      // Both buttons must be present
      const grouped = page.locator('[data-testid="viewmode-grouped"]');
      const flat = page.locator('[data-testid="viewmode-flat"]');
      await expect(grouped).toBeVisible();
      await expect(flat).toBeVisible();

      // Visual order: Grouped sits to the LEFT of Flat (greater x means right).
      const groupedBox = await grouped.boundingBox();
      const flatBox = await flat.boundingBox();
      expect(groupedBox).not.toBeNull();
      expect(flatBox).not.toBeNull();
      expect(groupedBox!.x).toBeLessThan(flatBox!.x);

      // Clicking Grouped persists `prefs:viewMode` and survives a reload.
      await grouped.click();
      await page.waitForTimeout(200);
      expect(await getPref(page, 'prefs:viewMode')).toBe(JSON.stringify('grouped'));
      await page.reload();
      await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
      expect(await getPref(page, 'prefs:viewMode')).toBe(JSON.stringify('grouped'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Evaluation Runs — /evaluations/runs
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Evaluation Runs (/evaluations/runs)', () => {
    test('persists headline filters, advanced filters, and Set-based filters', async ({ page }) => {
      // Headline (timeRange and agent are now shared via prefs:*)
      await setPref(page, 'eval-runs:search', 'rca-search');
      await setPref(page, 'prefs:timeRange', '7d');
      await setPref(page, 'prefs:agentFilter', 'observio');
      // View (viewMode shared, sort page-specific)
      await setPref(page, 'prefs:viewMode', 'grouped');
      await setPref(page, 'eval-runs:sort', { field: 'accuracy', dir: 'asc' });
      await setPref(page, 'eval-runs:showRegressionsOnly', true);
      // Advanced (page-specific)
      await setPref(page, 'eval-runs:filterStatus', 'failed');
      await setPref(page, 'eval-runs:filterBenchmarks', ['bm-1', 'bm-2']);
      await setPref(page, 'eval-runs:filterModels', ['claude-sonnet-4.5']);
      await setPref(page, 'eval-runs:filterPassRateMin', 25);
      await setPref(page, 'eval-runs:filterPassRateMax', 75);
      await setPref(page, 'eval-runs:collapsedGroups', ['group-x']);

      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });
      await page.waitForTimeout(500);

      expect(await getPref(page, 'eval-runs:search')).toBe(JSON.stringify('rca-search'));
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('7d'));
      expect(await getPref(page, 'prefs:agentFilter')).toBe(JSON.stringify('observio'));
      expect(await getPref(page, 'prefs:viewMode')).toBe(JSON.stringify('grouped'));
      expect(JSON.parse((await getPref(page, 'eval-runs:sort'))!))
        .toEqual({ field: 'accuracy', dir: 'asc' });
      expect(await getPref(page, 'eval-runs:showRegressionsOnly')).toBe(JSON.stringify(true));
      expect(await getPref(page, 'eval-runs:filterStatus')).toBe(JSON.stringify('failed'));
      expect(JSON.parse((await getPref(page, 'eval-runs:filterBenchmarks'))!).sort())
        .toEqual(['bm-1', 'bm-2']);
      expect(JSON.parse((await getPref(page, 'eval-runs:filterModels'))!))
        .toEqual(['claude-sonnet-4.5']);
      expect(await getPref(page, 'eval-runs:filterPassRateMin')).toBe(JSON.stringify(25));
      expect(await getPref(page, 'eval-runs:filterPassRateMax')).toBe(JSON.stringify(75));
      expect(JSON.parse((await getPref(page, 'eval-runs:collapsedGroups'))!))
        .toEqual(['group-x']);
    });

    test('UI round-trip: typing in search persists across reloads', async ({ page }) => {
      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });
      const search = page.locator('input[placeholder="Search runs..."]').first();
      if (await search.isVisible({ timeout: 5000 }).catch(() => false)) {
        await search.fill('runs-search-pref');
        await page.waitForTimeout(300);
        await page.reload();
        await page.waitForSelector('h2', { timeout: 30000 });
        const after = page.locator('input[placeholder="Search runs..."]').first();
        await expect(after).toHaveValue('runs-search-pref');
      }
      expect(await getPref(page, 'eval-runs:search')).toBe(JSON.stringify('runs-search-pref'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Traces — /agent-traces
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Agent Traces (/agent-traces)', () => {
    test('persists shared agent filter, shared timeRange, textSearch and structured filters', async ({ page }) => {
      // Both agent filter and time range are shared with the eval list pages
      // (agent filter via `prefs:agentFilter`, time range via
      // `prefs:timeRange`). The dropdown stores the agent's *config key* and
      // AgentTracesPage internally translates to the OTel `service.name`
      // via `AgentConfig.traceServiceName` at query time.
      await setPref(page, 'prefs:agentFilter', 'observio');
      await setPref(page, 'prefs:timeRange', '1h');
      await setPref(page, 'agent-traces:textSearch', 'connection refused');
      await setPref(page, 'agent-traces:filters', {
        status: 'error',
        service: 'svc',
        rootSpan: '',
        traceId: '',
        durationRange: 'all',
        durationMin: '',
        durationMax: '',
        spanCountRange: 'all',
        spanCountMin: '',
        spanCountMax: '',
        timeWindowStart: '',
        timeWindowEnd: '',
      });

      await page.goto('/agent-traces');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);

      expect(await getPref(page, 'prefs:agentFilter')).toBe(JSON.stringify('observio'));
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('1h'));
      expect(await getPref(page, 'agent-traces:textSearch')).toBe(JSON.stringify('connection refused'));
      const filters = JSON.parse((await getPref(page, 'agent-traces:filters'))!);
      expect(filters.status).toBe('error');
      expect(filters.service).toBe('svc');
    });

    test('shared `prefs:timeRange` is also picked up by Agent Traces', async ({ page }) => {
      await setPref(page, 'prefs:timeRange', '1h');
      await page.goto('/agent-traces');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);
      // Agent Traces reads the shared key and converts it to a minute-based
      // cutoff internally; the localStorage value itself is unchanged.
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('1h'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AI Dev Tools / Coding Agents — /coding-agents
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('AI Dev Tools (/coding-agents)', () => {
    test('persists activeTab, rangePreset and SessionsTab filters', async ({ page }) => {
      await setPref(page, 'coding-agents:activeTab', 'workspace');
      await setPref(page, 'coding-agents:rangePreset', 'last7days');
      await setPref(page, 'coding-agents:sessions:agentFilter', 'claude-code');
      await setPref(page, 'coding-agents:sessions:completedFilter', 'completed');
      await setPref(page, 'coding-agents:sessions:projectFilter', '/some/project');
      await setPref(page, 'coding-agents:workspace:agentTab', 'kiro');
      await setPref(page, 'coding-agents:workspace:section', 'plans');

      await page.goto('/coding-agents');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);

      // The page may override activeTab from the URL ?tab= param, but in
      // this test we navigate without it, so persistence wins.
      expect(await getPref(page, 'coding-agents:rangePreset')).toBe(JSON.stringify('last7days'));
      expect(await getPref(page, 'coding-agents:sessions:agentFilter')).toBe(JSON.stringify('claude-code'));
      expect(await getPref(page, 'coding-agents:sessions:completedFilter')).toBe(JSON.stringify('completed'));
      expect(await getPref(page, 'coding-agents:sessions:projectFilter')).toBe(JSON.stringify('/some/project'));
      expect(await getPref(page, 'coding-agents:workspace:agentTab')).toBe(JSON.stringify('kiro'));
      expect(await getPref(page, 'coding-agents:workspace:section')).toBe(JSON.stringify('plans'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-page guarantees
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Cross-page guarantees', () => {
    test('all persisted keys survive a full hard reload', async ({ page }) => {
      const seeds: Array<[string, unknown]> = [
        ['dashboard:timeRange', '30d'],
        ['benchmarks:search', 'foo'],
        ['test-cases:search', 'bar'],
        ['eval-runs:search', 'baz'],
        ['agent-traces:textSearch', 'qux'],
        ['eval-runs:filterBenchmarks', ['x']],
        ['prefs:timeRange', '7d'],
        ['prefs:agentFilter', 'observio'],
        ['prefs:agentKey', 'observio'],
        ['prefs:viewMode', 'grouped'],
      ];
      for (const [k, v] of seeds) await setPref(page, k, v);

      await page.goto('/');
      await page.reload();
      await page.waitForLoadState('domcontentloaded');

      for (const [k, v] of seeds) {
        expect(await getPref(page, k)).toBe(JSON.stringify(v));
      }
    });

    test('shared `prefs:timeRange` is honoured on every list page', async ({ page }) => {
      await setPref(page, 'prefs:timeRange', '7d');
      await setPref(page, 'prefs:agentFilter', 'observio');
      await setPref(page, 'prefs:viewMode', 'grouped');

      // Visit each list page and verify the shared key is unchanged —
      // i.e. no page is silently overwriting it with a per-page default.
      // Agent Traces is included because it now reads `prefs:timeRange`
      // (its agent filter remains page-specific because the value space
      // there is telemetry service names, not agent config keys).
      const visits = [
        { url: '/evaluations/benchmarks', selector: '[data-testid="benchmarks-page"]' },
        { url: '/evaluations/test-cases', selector: '[data-testid="test-cases-page"]' },
        { url: '/evaluations/runs', selector: 'h2' },
        { url: '/agent-traces', selector: 'h2' },
      ];
      for (const { url, selector } of visits) {
        await page.goto(url);
        await page.waitForSelector(selector, { timeout: 30000 });
        await page.waitForTimeout(300);
        expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('7d'));
      }
      // Agent filter is verified across all three pages — it's now shared
      // with Agent Traces too because that page stores the agent *key* and
      // translates to the OTel `service.name` internally.
      const agentFilterVisits = [
        { url: '/evaluations/benchmarks', selector: '[data-testid="benchmarks-page"]' },
        { url: '/evaluations/runs', selector: 'h2' },
        { url: '/agent-traces', selector: 'h2' },
      ];
      for (const { url, selector } of agentFilterVisits) {
        await page.goto(url);
        await page.waitForSelector(selector, { timeout: 30000 });
        await page.waitForTimeout(300);
        expect(await getPref(page, 'prefs:agentFilter')).toBe(JSON.stringify('observio'));
      }
      // viewMode is shared by Test Cases + Eval Runs only (Benchmarks has
      // no flat/grouped switch).
      const viewModeVisits = [
        { url: '/evaluations/test-cases', selector: '[data-testid="test-cases-page"]' },
        { url: '/evaluations/runs', selector: 'h2' },
      ];
      for (const { url, selector } of viewModeVisits) {
        await page.goto(url);
        await page.waitForSelector(selector, { timeout: 30000 });
        await page.waitForTimeout(300);
        expect(await getPref(page, 'prefs:viewMode')).toBe(JSON.stringify('grouped'));
      }
    });

    test('a UI change on one page is visible on another (cross-page sync)', async ({ page }) => {
      // Set time range on Eval Runs by writing the shared key directly
      // (UI-driven changes go through the same key, this is just a faster
      // and less-flaky assertion of the shared-state contract).
      await page.goto('/evaluations/runs');
      await page.waitForSelector('h2', { timeout: 30000 });
      await setPref(page, 'prefs:timeRange', '1d');
      await page.reload();
      await page.waitForSelector('h2', { timeout: 30000 });
      await page.waitForTimeout(300);
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('1d'));

      // Navigate to Benchmarks — the same key is in effect.
      await page.goto('/evaluations/benchmarks');
      await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30000 });
      await page.waitForTimeout(300);
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('1d'));

      // Navigate to Test Cases — same again.
      await page.goto('/evaluations/test-cases');
      await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30000 });
      await page.waitForTimeout(300);
      expect(await getPref(page, 'prefs:timeRange')).toBe(JSON.stringify('1d'));
    });

    test('clearing localStorage causes pages to fall back to defaults gracefully', async ({ page }) => {
      const pages = ['/', '/evaluations/benchmarks', '/evaluations/test-cases', '/evaluations/runs', '/agent-traces'];
      for (const p of pages) {
        await page.goto(p);
        await page.waitForLoadState('domcontentloaded');
        await clearAllPrefs(page);
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        // Page should still mount without errors. We can't assert on every
        // page's testid, so we just verify the body is non-empty.
        const bodyText = await page.locator('body').innerText();
        expect(bodyText.length).toBeGreaterThan(0);
      }
    });
  });
});
