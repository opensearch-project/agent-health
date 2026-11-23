/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmarks list — per-agent "Latest Result" / "Trend" lines.
 *
 * Owner bug (11-18): running one benchmark with two agents produced ONE row
 * whose latest result was whichever agent ran last and whose trend compared
 * that run with the previous run of a DIFFERENT agent ("Improving" because the
 * other agent scored lower). Now each agent that ran the benchmark gets its
 * own line inside the row, and trend/sparkline only ever compare an agent
 * with itself. Two endpoints of the same agent key are two agents, labelled
 * `Name (host)`.
 *
 * Fixture (real-shaped): one benchmark with 3 agent identities — `demo`
 * (3 runs on the configured endpoint, trending DOWN on its own history),
 * `demo` against a second endpoint (1 run), and a second agent key with 2
 * runs trending UP — timestamps interleaved so the NEWEST run (demo, 50%)
 * directly follows a run of the other agent (33%); plus a single-agent
 * benchmark that must look like before apart from the agent label; plus a
 * benchmark with 4 agents to exercise the "+N more" toggle.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const SECOND_ENDPOINT = 'https://staging.example.com:8443/agent';

test.describe('Benchmarks list — one latest result + trend per agent', () => {
  const tracker = createTestDataTracker();
  const MULTI = uniqueTestName('per-agent-multi');
  const SINGLE = uniqueTestName('per-agent-single');
  const MANY = uniqueTestName('per-agent-many');
  let multiId = '';
  let singleId = '';
  let manyId = '';
  const testCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: { name: uniqueTestName(`per-agent-tc-${i}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] },
      });
      if (!r.ok()) throw new Error(`seed test case failed: ${r.status()} ${await r.text()}`);
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }

    const hour = 3_600_000;
    const now = Date.now();
    let seq = 0;
    const mkRun = (agentKey: string, createdAt: number, passed: number, total: number, extra: Record<string, unknown> = {}) => {
      const id = `run-pa-${now}-${seq++}`;
      return {
        id, name: id, agentKey, modelId: 'demo-model', createdAt: new Date(createdAt).toISOString(), status: 'completed',
        benchmarkVersion: 1, results: {},
        stats: { total, passed, failed: total - passed, errored: 0, pending: 0, running: 0 },
        ...extra,
      };
    };
    const create = async (name: string, runs: unknown[]) => {
      const res = await request.post('/api/storage/benchmarks', {
        data: {
          name, description: 'per-agent E2E', testCaseIds, runs: [], currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
        },
      });
      if (!res.ok()) throw new Error(`seed benchmark failed: ${res.status()} ${await res.text()}`);
      const id = (await res.json()).id as string;
      tracker.benchmark(id);
      const put = await request.put(`/api/storage/benchmarks/${id}`, { data: { name, description: 'per-agent E2E', testCaseIds, runs } });
      if (!put.ok()) throw new Error(`seed runs failed: ${put.status()} ${await put.text()}`);
      return id;
    };

    multiId = await create(MULTI, [
      // demo on its own history: 100% → 83% → 50% (regressing). Other agent: 17% → 33% (improving).
      mkRun('demo', now - 9 * hour, 6, 6),
      mkRun('e2e-other-agent', now - 8 * hour, 1, 6),
      mkRun('demo', now - 7 * hour, 5, 6),
      mkRun('demo', now - 6 * hour, 4, 6, { agentEndpoint: SECOND_ENDPOINT }),
      mkRun('e2e-other-agent', now - 5 * hour, 2, 6),
      mkRun('demo', now - 4 * hour, 3, 6), // newest; previous run overall is the OTHER agent at 33%
    ]);
    singleId = await create(SINGLE, [
      mkRun('demo', now - 3 * hour, 2, 6),
      mkRun('demo', now - 2 * hour, 5, 6),
    ]);
    manyId = await create(MANY, [
      mkRun('demo', now - 60 * hour, 6, 6),
      mkRun('e2e-agent-two', now - 59 * hour, 5, 6),
      mkRun('e2e-agent-three', now - 58 * hour, 4, 6),
      mkRun('e2e-agent-four', now - 57 * hour, 3, 6),
    ]);
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  async function openList(page: import('@playwright/test').Page, search: string) {
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30_000 });
    // Reset persisted filters other specs may have left behind.
    const agentSelect = page.locator('button[role="combobox"]').first();
    if (!(await agentSelect.innerText()).includes('All Agents')) {
      await agentSelect.click();
      await page.getByRole('option', { name: 'All Agents' }).click();
    }
    await page.locator('input[placeholder="Search"]').fill(search);
    const row = page.locator('tbody tr', { hasText: search });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    return row;
  }

  test('multi-agent benchmark: one line per agent, trend never crosses agents, endpoints are separate agents', async ({ page }) => {
    const row = await openList(page, MULTI);

    const lines = row.getByTestId('agent-latest-line');
    await expect(lines).toHaveCount(3);
    // Most recently active first. `demo` ran against two endpoints → both
    // identities get a host suffix; the other agent (one endpoint) stays plain.
    const labels = await lines.getByTestId('agent-label').allInnerTexts();
    expect(labels).toEqual(['Demo Agent (default endpoint)', 'e2e-other-agent', 'Demo Agent (staging.example.com:8443)']);
    const texts = await lines.allInnerTexts();
    expect(texts[0].replace(/\s+/g, ' ')).toContain('3 3 / 6');  // demo latest: 3 passed, 3 failed
    expect(texts[1].replace(/\s+/g, ' ')).toContain('2 4 / 6');  // other agent latest: 2 passed
    expect(texts[2].replace(/\s+/g, ' ')).toContain('4 2 / 6');  // demo@staging: 4 passed

    // Trends are per agent: demo 83% → 50% is REGRESSING even though the run
    // before it on the benchmark (other agent, 33%) would make it "Improving";
    // the other agent 17% → 33% is improving; one-run identities have no trend.
    const trends = await row.getByTestId('agent-trend-line').getByTestId('agent-trend').allInnerTexts();
    expect(trends.map(t => t.trim())).toEqual(['Regressing', 'Improving', '—']);
    // Sparkline only where an agent has ≥2 runs of its own.
    await expect(row.getByTestId('agent-trend-line').nth(0).locator('svg polyline')).toHaveCount(1);
    await expect(row.getByTestId('agent-trend-line').nth(2).locator('svg polyline')).toHaveCount(0);
    // Nothing merges them: no "+N more" for 3 agents.
    await expect(row.getByTestId('agent-lines-toggle')).toHaveCount(0);
  });

  test('single-agent benchmark looks like before apart from the agent label', async ({ page }) => {
    const row = await openList(page, SINGLE);
    const lines = row.getByTestId('agent-latest-line');
    await expect(lines).toHaveCount(1);
    await expect(lines.getByTestId('agent-label')).toHaveText('Demo Agent');
    expect((await lines.innerText()).replace(/\s+/g, ' ')).toContain('5 1 / 6');
    await expect(row.getByTestId('agent-trend')).toHaveText(/Improving/);
    await expect(row.getByTestId('agent-lines-toggle')).toHaveCount(0);
  });

  test('more than 3 agents collapse to 3 lines with a "+N more" toggle', async ({ page }) => {
    const row = await openList(page, MANY);
    await expect(row.getByTestId('agent-latest-line')).toHaveCount(3);
    await expect(row.getByTestId('agent-trend-line')).toHaveCount(3);
    const toggle = row.getByTestId('agent-lines-toggle');
    await expect(toggle).toHaveText('+1 more');
    await toggle.click();
    await expect(row.getByTestId('agent-latest-line')).toHaveCount(4);
    await expect(row.getByTestId('agent-trend-line')).toHaveCount(4);
    await expect(toggle).toHaveText('Show less');
    // Expanding must not navigate into the benchmark.
    await expect(page).toHaveURL(/\/evaluations\/benchmarks\/?(\?.*)?$/);
  });

  test('summary card never averages across agents silently', async ({ page }) => {
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('h2:has-text("Benchmarks")', { timeout: 30_000 });
    const agentSelect = page.locator('button[role="combobox"]').first();
    if (!(await agentSelect.innerText()).includes('All Agents')) {
      await agentSelect.click();
      await page.getByRole('option', { name: 'All Agents' }).click();
    }
    // Several agents have runs → the card reports the agent count, not an average.
    await expect(page.getByTestId('summary-agent-count')).toBeVisible();
    await expect(page.getByTestId('summary-avg-pass-rate')).toHaveCount(0);
    // Filtering to one agent KEY still leaves two identities in view (the
    // configured endpoint and the second endpoint) — still no blended average.
    await agentSelect.click();
    await page.getByRole('option', { name: 'Demo Agent', exact: true }).click();
    await expect(page.getByTestId('summary-agent-count')).toContainText('2');
    await expect(page.getByTestId('summary-avg-pass-rate')).toHaveCount(0);
    // Restore the shared preference for other specs.
    await agentSelect.click();
    await page.getByRole('option', { name: 'All Agents' }).click();
  });

  test('benchmark detail chart draws one line per endpoint of the same agent key', async ({ page }) => {
    await page.goto(`/evaluations/benchmarks/${multiId}/runs`);
    await expect(page.getByTestId('benchmark-runs-table')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('run-row')).toHaveCount(6);
    await expect(page.getByTestId('chart-legend-demo')).toHaveText(/Demo Agent \(default endpoint\)/);
    await expect(page.getByTestId(`chart-legend-demo@${SECOND_ENDPOINT}`)).toHaveText(/Demo Agent \(staging\.example\.com:8443\)/);
    await expect(page.getByTestId('chart-legend-e2e-other-agent')).toHaveText(/^e2e-other-agent/);
    // Agent column shows the disambiguated label on the endpoint run.
    await expect(page.getByTestId('run-row').filter({ hasText: 'staging.example.com:8443' })).toHaveCount(1);
    // Clicking the endpoint legend entry filters to that one run only.
    await page.getByTestId(`chart-legend-demo@${SECOND_ENDPOINT}`).click();
    await expect(page.getByTestId('run-row')).toHaveCount(1);
  });
});
