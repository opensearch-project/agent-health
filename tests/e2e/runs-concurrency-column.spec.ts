/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "Conc." (concurrency) column on the benchmark Runs tab and on the
 * Evaluation Runs list, plus the "· conc N" chip in the run inspector header.
 *
 * Regression guard for the owner ask (feedback on #486, 2026-09-13): "We
 * should show concurrency on the runs page of each run, for both benchmark
 * details page and Evaluation runs page." Seeds one benchmark with two
 * embedded runs -- one sequential (concurrency: 1) and one parallel
 * (concurrency: 3) -- plus a legacy run with no `concurrency` field at all
 * (pre-existing data), to pin the "1" vs "—" rendering contract everywhere
 * the value is surfaced.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Run concurrency — benchmark Runs tab + Evaluation Runs list + inspector header', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  const testCaseIds: string[] = [];
  const RUN_SEQ = uniqueTestName('conc-seq');
  const RUN_PAR = uniqueTestName('conc-par');
  const RUN_LEGACY = uniqueTestName('conc-legacy');
  const RUN_ID_SEQ = `run-conc-seq-${Date.now()}`;
  const RUN_ID_PAR = `run-conc-par-${Date.now()}`;
  const RUN_ID_LEGACY = `run-conc-legacy-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`conc-tc-${i}`),
          category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
        },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }
    if (testCaseIds.length !== 2) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('conc-benchmark'),
        description: 'concurrency-column E2E',
        testCaseIds, runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const snaps = testCaseIds.map(id => ({ id, version: 1, name: id }));
    const now = Date.now();
    const day = 86_400_000;
    const mkRun = (id: string, name: string, createdAt: number, extra: Record<string, unknown>) => ({
      id, name, agentKey: 'demo', modelId: 'demo-model', evaluatorId: undefined,
      createdAt: new Date(createdAt).toISOString(), status: 'completed', benchmarkVersion: 1,
      testCaseSnapshots: snaps,
      results: Object.fromEntries(testCaseIds.map(tc => [tc, { reportId: `report-conc-${id}-${tc}`, status: 'completed', passFailStatus: 'passed' }])),
      ...extra,
    });
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
        runs: [
          mkRun(RUN_ID_SEQ, RUN_SEQ, now - 1 * day, { concurrency: 1 }),
          mkRun(RUN_ID_PAR, RUN_PAR, now - 2 * day, { concurrency: 3 }),
          mkRun(RUN_ID_LEGACY, RUN_LEGACY, now - 3 * day, {}), // no concurrency field at all
        ],
      },
    });
    if (!put.ok()) { benchmarkId = null; return; }
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  async function openRunsTab(page: import('@playwright/test').Page) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
      const table = page.getByTestId('benchmark-runs-table');
      await Promise.race([
        table.waitFor({ state: 'visible', timeout: 30_000 }),
        page.waitForURL(/\/evaluations\/benchmarks\/?$/, { timeout: 30_000 }).catch(() => {}),
      ]).catch(() => {});
      if (await table.isVisible().catch(() => false)) break;
    }
    await expect(page.getByTestId('run-row')).toHaveCount(3, { timeout: 30_000 });
  }

  test('benchmark Runs tab shows a Conc. column: values for configured runs, em dash for legacy, sortable', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await openRunsTab(page);

    const headers = await page.locator('[data-testid="benchmark-runs-table"] thead th').allInnerTexts();
    expect(headers.map(h => h.trim()).filter(Boolean)).toContain('Conc.');

    const seq = page.locator('[data-testid="run-row"]', { hasText: RUN_SEQ });
    const par = page.locator('[data-testid="run-row"]', { hasText: RUN_PAR });
    const legacy = page.locator('[data-testid="run-row"]', { hasText: RUN_LEGACY });
    await expect(seq.getByTestId('run-concurrency-cell')).toHaveText('1');
    await expect(par.getByTestId('run-concurrency-cell')).toHaveText('3');
    await expect(legacy.getByTestId('run-concurrency-cell')).toHaveText('—');

    // Sort by Conc. descending on first click (numeric column default).
    await page.getByRole('columnheader', { name: /Conc\./ }).click();
    const namesDesc = await page.getByTestId('run-name-link').allInnerTexts();
    expect(namesDesc.map(n => n.trim())).toEqual([RUN_PAR, RUN_SEQ, RUN_LEGACY]);

    // Click again → ascending (legacy/undefined always sinks to the bottom).
    await page.getByRole('columnheader', { name: /Conc\./ }).click();
    const namesAsc = await page.getByTestId('run-name-link').allInnerTexts();
    expect(namesAsc.map(n => n.trim())).toEqual([RUN_SEQ, RUN_PAR, RUN_LEGACY]);
  });

  test('run inspector header shows "· conc N" for a configured run and omits it for a legacy run', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_PAR}/inspect`);
    await expect(page.getByTestId('run-inspector-concurrency')).toContainText('conc 3', { timeout: 15_000 });

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${RUN_ID_LEGACY}/inspect`);
    await expect(page.getByText('Demo Model')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('run-inspector-concurrency')).toHaveCount(0);
  });

  test('Evaluation Runs list shows the Conc. column for benchmark-embedded runs', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark runs (storage not configured?)');
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(1500);

    // All time, so the seeded (multi-day-old) runs are in range.
    const timeBtn = page.locator('button:has-text("Last")').first();
    if (await timeBtn.count()) {
      await timeBtn.click();
      await page.waitForTimeout(300);
      const allTime = page.getByText('All time', { exact: true }).last();
      if (await allTime.count()) await allTime.click();
      await page.waitForTimeout(800);
    }
    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.count()) { await flat.click(); await page.waitForTimeout(600); }

    await expect(page.getByRole('columnheader', { name: /^Conc\.$/ })).toBeVisible({ timeout: 15_000 });

    const rows = page.locator('[data-testid="run-row"]');
    const seqRow = rows.filter({ hasText: RUN_SEQ });
    const parRow = rows.filter({ hasText: RUN_PAR });
    const legacyRow = rows.filter({ hasText: RUN_LEGACY });
    await expect(seqRow.locator('[data-testid="run-concurrency-cell"]')).toHaveText('1', { timeout: 15_000 });
    await expect(parRow.locator('[data-testid="run-concurrency-cell"]')).toHaveText('3');
    await expect(legacyRow.locator('[data-testid="run-concurrency-cell"]')).toHaveText('—');
  });
});
