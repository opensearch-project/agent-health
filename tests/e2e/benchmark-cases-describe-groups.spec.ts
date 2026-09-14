/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `describePath` (the describe() chain a code-SDK test was registered under)
 * is persisted on imported test cases and surfaced read-only in the UI:
 *
 *   • Benchmark Cases tab — a collapsed-by-default "Group by describe"
 *     affordance lists each outermost describe title with a case count;
 *     picking one narrows the list. Cases WITHOUT a describePath (JSON /
 *     UI-authored, or code cases imported before the field existed) stay
 *     ungrouped and never render as an "undefined" group.
 *   • Test case detail page — the chain renders as a breadcrumb.
 *
 * Fixtures are created through the storage API (the `bulk` route accepts
 * `describePath` on the code-import upsert path) and cleaned up by `testData`.
 */

import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

test.describe('describePath — Cases tab grouping + detail breadcrumb', () => {
  test('Cases tab groups by describePath[0] with counts; legacy case renders ungrouped; detail page shows the chain', async ({ page, request, testData }) => {
    const sourceFile = `evals/${uniqueTestName('demo')}.eval.js`;
    const suiteA = uniqueTestName('Suite A');
    const suiteB = uniqueTestName('Suite B');
    const nameA1 = uniqueTestName('grouped-a1');
    const nameA2 = uniqueTestName('grouped-a2');
    const nameB1 = uniqueTestName('grouped-b1');
    const nameLegacy = uniqueTestName('legacy-no-describe');

    const base = (name: string) => ({
      name,
      description: 'describePath e2e fixture',
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: `Investigate ${name}`,
      context: [],
      expectedOutcomes: ['n/a'],
      sourceFile,
      sourceHash: `hash-${name}`,
    });

    // Code-import upsert path carries describePath (array, outermost first).
    const codeRes = await request.post('/api/storage/test-cases/bulk', {
      data: {
        testCases: [
          { ...base(nameA1), describePath: [suiteA, 'Inner'] },
          { ...base(nameA2), describePath: [suiteA] },
          { ...base(nameB1), describePath: [suiteB] },
          // A code case imported BEFORE describePath existed: same sourceFile, no field.
          base(nameLegacy),
        ],
      },
    });
    expect(codeRes.ok()).toBeTruthy();
    const codeBody = await codeRes.json();
    const ids: string[] = (codeBody.testCases || []).map((tc: any) => tc.id);
    expect(ids).toHaveLength(4);
    testData.testCases(ids);
    const idByName = new Map<string, string>((codeBody.testCases || []).map((tc: any) => [tc.name, tc.id]));

    // Persisted + returned by GET (and absent, not "undefined", for the legacy case).
    const a1 = await (await request.get(`/api/storage/test-cases/${encodeURIComponent(idByName.get(nameA1)!)}`)).json();
    expect(a1.describePath).toEqual([suiteA, 'Inner']);
    const legacy = await (await request.get(`/api/storage/test-cases/${encodeURIComponent(idByName.get(nameLegacy)!)}`)).json();
    expect(legacy.describePath).toBeUndefined();

    const benchmarkRes = await request.post('/api/storage/benchmarks', {
      data: { name: uniqueTestName('describe-groups-benchmark'), description: 'describePath e2e fixture', testCaseIds: ids },
    });
    expect(benchmarkRes.ok()).toBeTruthy();
    const benchmark = await benchmarkRes.json();
    const benchmarkId: string = benchmark.id || benchmark.benchmark?.id;
    testData.benchmark(benchmarkId);

    // ── Cases tab ──────────────────────────────────────────────────────────
    await page.goto(`/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}`);
    await page.waitForSelector('[data-testid="benchmark-cases-tab"]', { timeout: 30000 });
    const list = page.locator('[role="listbox"][aria-label="Benchmark cases"]');
    await expect(list.locator('[role="option"]')).toHaveCount(4, { timeout: 15000 });

    const groups = page.getByTestId('describe-groups');
    await expect(groups).toBeVisible();
    await expect(page.getByTestId('describe-groups-count')).toHaveText('2 suites');
    // Collapsed by default — expand.
    await expect(groups).not.toHaveJSProperty('open', true);
    await groups.locator('summary').click();
    await expect(groups).toHaveJSProperty('open', true);

    const groupA = page.locator(`[data-testid="describe-group"][data-describe-title="${suiteA}"]`);
    const groupB = page.locator(`[data-testid="describe-group"][data-describe-title="${suiteB}"]`);
    await expect(groupA.getByTestId('describe-group-count')).toHaveText('2');
    await expect(groupB.getByTestId('describe-group-count')).toHaveText('1');
    await expect(page.getByTestId('describe-group-ungrouped').getByTestId('describe-group-count')).toHaveText('1');
    await expect(page.locator('[data-testid="describe-group"][data-describe-title="undefined"]')).toHaveCount(0);
    await expect(page.getByTestId('benchmark-cases-tab')).not.toContainText('undefined');

    // Picking Suite A narrows the list to its two cases …
    await groupA.click();
    await expect(list.locator('[role="option"]')).toHaveCount(2);
    await expect(list).toContainText(nameA1);
    await expect(list).toContainText(nameA2);
    await expect(list).not.toContainText(nameLegacy);

    // … the legacy case lives under "Ungrouped" …
    await page.getByTestId('describe-group-ungrouped').click();
    await expect(list.locator('[role="option"]')).toHaveCount(1);
    await expect(list).toContainText(nameLegacy);

    // … and clearing restores every case.
    await page.getByTestId('describe-groups-clear').click();
    await expect(list.locator('[role="option"]')).toHaveCount(4);

    // Selecting a grouped case shows its chain in the detail header; a legacy case shows none.
    await list.locator(`[data-case-id="${idByName.get(nameA1)}"]`).click();
    const pane = page.getByTestId('case-detail-pane');
    await expect(pane.getByTestId('describe-path-segment')).toHaveText([suiteA, 'Inner']);
    await list.locator(`[data-case-id="${idByName.get(nameLegacy)}"]`).click();
    await expect(pane).toContainText(nameLegacy);
    await expect(pane.getByTestId('describe-path-chain')).toHaveCount(0);

    // ── Test case detail page ─────────────────────────────────────────────
    await page.goto(`/evaluations/test-cases/${encodeURIComponent(idByName.get(nameA1)!)}`);
    await page.waitForSelector('[data-testid="test-case-detail-page"]', { timeout: 30000 });
    const hero = page.getByTestId('test-case-definition-hero');
    await expect(hero.getByTestId('describe-path-chain')).toBeVisible();
    await expect(hero.getByTestId('describe-path-segment')).toHaveText([suiteA, 'Inner']);

    await page.goto(`/evaluations/test-cases/${encodeURIComponent(idByName.get(nameLegacy)!)}`);
    await page.waitForSelector('[data-testid="test-case-detail-page"]', { timeout: 30000 });
    await expect(page.getByTestId('test-case-definition-hero').getByTestId('describe-path-chain')).toHaveCount(0);
    await expect(page.getByTestId('test-case-definition-hero')).not.toContainText('undefined');
  });

  test('a benchmark of only legacy cases shows no grouping affordance at all', async ({ page, request, testData }) => {
    const testCases = [0, 1].map(i => ({
      name: uniqueTestName(`plain-${i}`),
      description: 'describePath e2e fixture (no describePath)',
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: `Investigate ${i}`,
      context: [],
      expectedOutcomes: ['n/a'],
    }));
    const bulk = await request.post('/api/storage/test-cases/bulk', { data: { testCases } });
    expect(bulk.ok()).toBeTruthy();
    const ids: string[] = ((await bulk.json()).testCases || []).map((tc: any) => tc.id);
    testData.testCases(ids);
    const bm = await request.post('/api/storage/benchmarks', {
      data: { name: uniqueTestName('no-describe-benchmark'), description: 'describePath e2e fixture', testCaseIds: ids },
    });
    const benchmark = await bm.json();
    const benchmarkId: string = benchmark.id || benchmark.benchmark?.id;
    testData.benchmark(benchmarkId);

    await page.goto(`/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}`);
    await page.waitForSelector('[data-testid="benchmark-cases-tab"]', { timeout: 30000 });
    await expect(page.locator('[role="listbox"][aria-label="Benchmark cases"] [role="option"]')).toHaveCount(2, { timeout: 15000 });
    await expect(page.getByTestId('describe-groups')).toHaveCount(0);
    await expect(page.getByTestId('benchmark-cases-tab')).not.toContainText('undefined');
  });
});
