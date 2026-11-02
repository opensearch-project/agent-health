/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression for issue #591 — the Evaluations pages must never download
 * the full test-case corpus.
 *
 * `/evaluations/benchmarks` used to fetch EVERY test case in full
 * (`asyncTestCaseStorage.getAll()` without `summary`) into a map nobody read,
 * and its loading state waited on that request. On a cluster where a few
 * hundred cases carry a ~400 KB `sourceCode` that is a 200+ MB response —
 * ~18 s locally, minutes over a slow link — so the benchmark list "never
 * opened". `/evaluations/test-cases` and `/evaluations/runs/new` fetched the
 * same full payload for lists that render only name / description / labels.
 *
 * Real-shaped fixture: a benchmark plus three test cases, one carrying a
 * ~400 KB `sourceCode`, all seeded through the real API and deleted by id via
 * the `testData` fixture. The slow link is simulated by HOLDING any
 * non-summary `GET /api/storage/test-cases` for longer than the render
 * deadline — exactly how the bug presented — rather than by a fast fixture
 * that would hide it.
 */

import { test, expect, Page } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

const SOURCE_CODE_BYTES = 400_000;
/** How long a non-summary full fetch is held — longer than RENDER_DEADLINE_MS. */
const FULL_FETCH_HOLD_MS = 20_000;
/** The seeded rows must render within this, i.e. without waiting on a full fetch. */
const RENDER_DEADLINE_MS = 10_000;

const TEST_CASES_LIST_RE = /\/api\/storage\/test-cases(\?[^#]*)?$/;
const BENCHMARKS_LIST_RE = /\/api\/storage\/benchmarks(\?[^#]*)?$/;
/** Bundled demo data the "Show sample data" toggle reveals (cli/demo/sample*.ts). */
const SAMPLE_TEST_CASE_NAME = 'Weekend Getaway to Napa Valley';
const SAMPLE_BENCHMARK_NAME = 'Travel Planning Accuracy - Demo';

function isFullTestCaseListUrl(url: string): boolean {
  if (!TEST_CASES_LIST_RE.test(url)) return false;
  const u = new URL(url);
  return u.searchParams.get('fields') !== 'summary';
}

function syntheticSourceCode(seed: string): string {
  const line = `test('${seed}', { prompt: 'synthetic prompt' }, async ({ result, expect }) => { expect(result.status).toBe('ok'); });\n`;
  return line.repeat(Math.ceil(SOURCE_CODE_BYTES / line.length)).slice(0, SOURCE_CODE_BYTES);
}

/**
 * Record every test-case list GET the page issues and hold the ones that
 * ask for the full payload, so a regression shows up as the list failing to
 * render in time AND as a recorded offending URL (two independent signals).
 */
async function recordTestCaseListRequests(page: Page): Promise<{ all: string[]; full: string[] }> {
  const all: string[] = [];
  const full: string[] = [];
  await page.route(TEST_CASES_LIST_RE, async (route) => {
    const url = route.request().url();
    if (route.request().method() !== 'GET') return route.continue();
    all.push(url);
    if (isFullTestCaseListUrl(url)) {
      full.push(url);
      await new Promise(r => setTimeout(r, FULL_FETCH_HOLD_MS));
    }
    // The page may already be closed once a held request is released.
    return route.continue().catch(() => {});
  });
  return { all, full };
}

test.describe('Evaluations pages never fetch the full test-case corpus (#591)', () => {
  let benchmarkName: string;
  let largeCaseName: string;
  let smallCaseNames: string[];

  test.beforeEach(async ({ request, testData }) => {
    benchmarkName = uniqueTestName('evals3-summary-bm');
    largeCaseName = uniqueTestName('evals3-summary-large');
    smallCaseNames = [uniqueTestName('evals3-summary-small-a'), uniqueTestName('evals3-summary-small-b')];

    const largeCase = {
      name: largeCaseName,
      description: 'code-imported case with a large source file',
      category: 'RCA',
      difficulty: 'Medium',
      labels: ['category:RCA', 'difficulty:Medium'],
      initialPrompt: 'Investigate the synthetic incident. '.repeat(10),
      context: [{ description: 'runbook', value: 'https://runbooks.example.invalid/large' }],
      expectedOutcomes: ['Identifies the offending component'],
      // No `sourceFile`: that selects the code-import UPSERT path, which
      // itself scans the whole corpus (slow on a large cluster, and a
      // separate concern). The strict-create path stores `sourceCode` as-is,
      // which is the property this fixture exists for.
      sourceFileName: `${largeCaseName}.eval.js`,
      sourceLanguage: 'javascript',
      sourceHash: largeCaseName,
      sourceCode: syntheticSourceCode(largeCaseName),
    };
    const smallCases = smallCaseNames.map((name, i) => ({
      name,
      description: `small case ${i}`,
      category: 'RCA',
      difficulty: 'Easy',
      labels: ['category:RCA', 'difficulty:Easy'],
      initialPrompt: `Small synthetic prompt ${i}`,
      context: [],
      expectedOutcomes: ['Answers'],
    }));

    const bulk = await request.post('/api/storage/test-cases/bulk', { data: { testCases: [largeCase, ...smallCases] } });
    const bulkBody = await bulk.json();
    // Track before asserting so a failed seed still gets cleaned up.
    const ids: string[] = (bulkBody?.testCases ?? []).map((tc: any) => tc?.id).filter(Boolean);
    testData.testCases(ids);
    expect(bulk.ok(), `bulk seed status ${bulk.status()}: ${JSON.stringify(bulkBody).slice(0, 300)}`).toBeTruthy();
    expect(ids).toHaveLength(3);

    const bm = await request.post('/api/storage/benchmarks', {
      data: {
        name: benchmarkName,
        description: 'seed for #591 regression',
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: ids }],
        testCaseIds: ids,
        runs: [],
      },
    });
    const bmBody = await bm.json();
    testData.benchmark(bmBody?.id || bmBody?.benchmark?.id);
    expect(bm.ok(), `benchmark seed status ${bm.status()}`).toBeTruthy();
  });

  test('Benchmarks page renders its list without any GET /api/storage/test-cases lacking fields=summary', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);

    const t0 = Date.now();
    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });

    // The seeded benchmark row must appear without waiting on a (held) full
    // test-case download — this is the "page never opens" symptom.
    await expect(page.getByText(benchmarkName, { exact: true })).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    const renderedAfterMs = Date.now() - t0;
    expect(renderedAfterMs).toBeLessThan(FULL_FETCH_HOLD_MS);

    // Let any stragglers be issued, then check the ledger.
    await page.waitForTimeout(500);
    expect(recorded.full, `full test-case fetches issued by /evaluations/benchmarks:\n${recorded.full.join('\n')}`).toEqual([]);
    for (const url of recorded.all) {
      expect(url).toContain('fields=summary');
    }
  });

  test('Test Cases page lists the seeded cases from a summary fetch (no sourceCode on the wire)', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);
    const summaryBodies: any[] = [];
    page.on('response', async (res) => {
      const url = res.url();
      if (res.request().method() === 'GET' && TEST_CASES_LIST_RE.test(url) && !isFullTestCaseListUrl(url)) {
        summaryBodies.push(await res.json().catch(() => null));
      }
    });

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });

    // Flat view so every seeded row is a plain table row regardless of grouping.
    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.isVisible().catch(() => false)) await flat.click();

    for (const name of [largeCaseName, ...smallCaseNames]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    }

    await page.waitForTimeout(500);
    expect(recorded.full, `full test-case fetches issued by /evaluations/test-cases:\n${recorded.full.join('\n')}`).toEqual([]);
    expect(recorded.all.length).toBeGreaterThan(0);
    for (const url of recorded.all) {
      expect(url).toContain('fields=summary');
    }

    // The large case arrived as a summary: present, but without its 400 KB source.
    const seen = summaryBodies.flatMap(b => b?.testCases ?? []).find((tc: any) => tc?.name === largeCaseName);
    expect(seen, 'large case present in the summary listing').toBeTruthy();
    expect(seen.sourceCode).toBeUndefined();
    expect(seen.sourceFileName).toBe(`${largeCaseName}.eval.js`);
    expect(seen.context).toEqual([]);
    expect(seen.expectedOutcomes).toEqual([]);
    expect(seen.versions).toEqual([]);
  });

  test('New Run page offers the seeded cases in its picker from a summary fetch', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);

    await page.goto('/evaluations/runs/new');
    await expect(page.getByText('Specific Test Cases')).toBeVisible({ timeout: 30_000 });

    for (const name of [largeCaseName, ...smallCaseNames]) {
      await expect(page.locator('label').filter({ hasText: name })).toHaveCount(1, { timeout: RENDER_DEADLINE_MS });
    }

    await page.waitForTimeout(500);
    expect(recorded.full, `full test-case fetches issued by /evaluations/runs/new:\n${recorded.full.join('\n')}`).toEqual([]);
    expect(recorded.all.length).toBeGreaterThan(0);
    for (const url of recorded.all) {
      expect(url).toContain('fields=summary');
    }
  });

  test('Test Cases page keeps the summary projection when sample data is toggled on and off', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });
    await expect(page.getByText(smallCaseNames[0], { exact: true }).first()).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    // Real data exists, so the server leaves the bundled demo cases out by default.
    await expect(page.getByText(SAMPLE_TEST_CASE_NAME, { exact: true })).toHaveCount(0);
    const initialFetches = recorded.all.length;
    expect(initialFetches).toBeGreaterThan(0);

    // Toggle ON: the refetch must ask for the demo cases explicitly AND stay a
    // summary fetch — this branch of the request used to be the easiest place
    // to reintroduce a full download.
    await page.getByRole('button', { name: 'Show sample data' }).click();
    await expect(page.getByText(SAMPLE_TEST_CASE_NAME, { exact: true }).first()).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    await expect.poll(() => recorded.all.length, { timeout: RENDER_DEADLINE_MS }).toBeGreaterThan(initialFetches);
    const withSample = recorded.all.slice(initialFetches);
    expect(withSample.length).toBeGreaterThan(0);
    for (const url of withSample) {
      const params = new URL(url).searchParams;
      expect(params.get('fields')).toBe('summary');
      expect(params.get('includeSample')).toBe('true');
    }
    // The seeded (real) rows are still listed alongside the demo ones.
    await expect(page.getByText(smallCaseNames[0], { exact: true }).first()).toBeVisible();

    // Toggle OFF: back to the server default (no includeSample), still summary.
    const beforeHide = recorded.all.length;
    await page.getByRole('button', { name: 'Hide sample data' }).click();
    await expect(page.getByText(SAMPLE_TEST_CASE_NAME, { exact: true })).toHaveCount(0, { timeout: RENDER_DEADLINE_MS });
    await expect.poll(() => recorded.all.length, { timeout: RENDER_DEADLINE_MS }).toBeGreaterThan(beforeHide);
    for (const url of recorded.all.slice(beforeHide)) {
      const params = new URL(url).searchParams;
      expect(params.get('fields')).toBe('summary');
      expect(params.get('includeSample')).toBeNull();
    }

    expect(recorded.full, `full test-case fetches issued while toggling sample data:\n${recorded.full.join('\n')}`).toEqual([]);
  });

  test('Benchmarks page toggles sample data by refetching benchmarks only (no test-case download)', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);
    const benchmarkFetches: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && BENCHMARKS_LIST_RE.test(req.url())) benchmarkFetches.push(req.url());
    });

    await page.goto('/evaluations/benchmarks');
    await page.waitForSelector('[data-testid="benchmarks-page"]', { timeout: 30_000 });
    await expect(page.getByText(benchmarkName, { exact: true })).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    await expect(page.getByText(SAMPLE_BENCHMARK_NAME, { exact: true })).toHaveCount(0);
    const initialBenchmarkFetches = benchmarkFetches.length;
    expect(initialBenchmarkFetches).toBeGreaterThan(0);
    for (const url of benchmarkFetches) {
      expect(new URL(url).searchParams.get('includeSample')).toBeNull();
    }

    await page.getByRole('button', { name: 'Show sample data' }).click();
    await expect(page.getByText(SAMPLE_BENCHMARK_NAME, { exact: true })).toBeVisible({ timeout: RENDER_DEADLINE_MS });
    await expect.poll(() => benchmarkFetches.length, { timeout: RENDER_DEADLINE_MS }).toBeGreaterThan(initialBenchmarkFetches);
    for (const url of benchmarkFetches.slice(initialBenchmarkFetches)) {
      expect(new URL(url).searchParams.get('includeSample')).toBe('true');
    }
    // The seeded (real) benchmark is still listed alongside the demo one.
    await expect(page.getByText(benchmarkName, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Hide sample data' }).click();
    await expect(page.getByText(SAMPLE_BENCHMARK_NAME, { exact: true })).toHaveCount(0, { timeout: RENDER_DEADLINE_MS });

    // Throughout: the Benchmarks list never needs test cases, in any mode.
    await page.waitForTimeout(500);
    expect(recorded.all, `test-case list fetches issued by /evaluations/benchmarks while toggling sample data:\n${recorded.all.join('\n')}`).toEqual([]);
  });
});

/**
 * The benchmark DETAIL page (`/evaluations/benchmarks/:id`, Cases tab) is the
 * second place #591 bit: it resolved the benchmark's cases with
 * `GET /api/storage/test-cases?ids=<all>` in FULL — 6.7 MB on a real 62-case
 * code-imported benchmark — for a list that shows names and a one-line
 * prompt. It must ask for `fields=summary` and fetch only the SELECTED case
 * in full (by id) for the definition pane, keyed by id (two cases share a
 * name) and immune to out-of-order responses when the selection moves fast.
 *
 * Real-shaped fixture: 62 cases × ~100 KB `sourceCode`, two with identical
 * names, all seeded through the real API and deleted by id. The per-case
 * fetch is HELD so the loading state and the late-response race are real.
 */
test.describe('Benchmark detail page fetches case summaries + the selected case in full (#591)', () => {
  const DETAIL_CASE_COUNT = 62;
  const DETAIL_SOURCE_BYTES = 100_000;
  const BULK_BATCH = 10;
  /** How long each per-case GET /:id is held — long enough to observe loading and to let selections race. */
  const PANE_HOLD_MS = 1_500;
  const CASE_BY_ID_RE = /\/api\/storage\/test-cases\/[^/?#]+(\?[^#]*)?$/;

  let benchmarkId: string;
  let ids: string[];
  let dupName: string;

  const outcomeOf = (i: number) => `Identifies synthetic component ${i} of ${DETAIL_CASE_COUNT}`;

  test.beforeEach(async ({ request, testData }) => {
    // Names sort the two same-named cases and the third target to the TOP of
    // the (name-sorted, 60-per-page) list so they are clickable without scrolling.
    dupName = uniqueTestName('detail-aaa-dup');
    const names = Array.from({ length: DETAIL_CASE_COUNT }, (_, i) =>
      i < 2 ? dupName : uniqueTestName(`detail-${i === 2 ? 'aab-third' : `case-${String(i).padStart(2, '0')}`}`));

    ids = [];
    for (let start = 0; start < DETAIL_CASE_COUNT; start += BULK_BATCH) {
      const batch = Array.from({ length: Math.min(BULK_BATCH, DETAIL_CASE_COUNT - start) }, (_, k) => {
        const i = start + k;
        const line = `test('detail-${i}', { prompt: 'synthetic prompt' }, async ({ result, expect }) => { expect(result.status).toBe('ok'); });\n`;
        return {
          name: names[i],
          description: `synthetic code-imported case ${i}`,
          category: 'RCA',
          difficulty: 'Medium',
          labels: ['category:RCA', 'difficulty:Medium'],
          initialPrompt: `Investigate synthetic incident ${i}. `.repeat(12),
          context: [{ description: 'runbook', value: `https://runbooks.example.invalid/${i}` }],
          expectedOutcomes: [outcomeOf(i)],
          sourceFileName: `detail-${i}.eval.js`,
          sourceLanguage: 'javascript',
          sourceHash: `detail-${i}`,
          sourceCode: line.repeat(Math.ceil(DETAIL_SOURCE_BYTES / line.length)).slice(0, DETAIL_SOURCE_BYTES),
        };
      });
      const bulk = await request.post('/api/storage/test-cases/bulk', { data: { testCases: batch } });
      const body = await bulk.json();
      const created: string[] = (body?.testCases ?? []).map((tc: any) => tc?.id).filter(Boolean);
      testData.testCases(created);
      expect(bulk.ok(), `bulk seed status ${bulk.status()}`).toBeTruthy();
      expect(created).toHaveLength(batch.length);
      ids.push(...created);
    }

    const bm = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('detail-summary-bm'),
        description: 'seed for the #591 detail-page regression',
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: ids }],
        testCaseIds: ids,
        runs: [],
      },
    });
    const bmBody = await bm.json();
    benchmarkId = bmBody?.id || bmBody?.benchmark?.id;
    testData.benchmark(benchmarkId);
    expect(bm.ok(), `benchmark seed status ${bm.status()}`).toBeTruthy();
  });

  test('lists 62 cases from one summary fetch, then shows the selected case\'s full definition — right case under a duplicate name, no stale pane after fast selection changes', async ({ page }) => {
    const recorded = await recordTestCaseListRequests(page);
    const perCaseFetches: string[] = [];
    await page.route(CASE_BY_ID_RE, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      perCaseFetches.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || ''));
      await new Promise(r => setTimeout(r, PANE_HOLD_MS));
      return route.continue().catch(() => {});
    });

    const t0 = Date.now();
    await page.goto(`/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}`);
    const rows = page.locator('[data-testid="benchmark-cases-tab"] [role="option"]');
    // The list renders from the summary fetch — without waiting on any (held) full download.
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    expect(Date.now() - t0).toBeLessThan(FULL_FETCH_HOLD_MS);
    await expect(rows).toHaveCount(Math.min(DETAIL_CASE_COUNT, 60), { timeout: RENDER_DEADLINE_MS });

    // One list request, summary-projected, scoped to this benchmark's ids.
    expect(recorded.full, `full test-case fetches issued by the detail page:\n${recorded.full.join('\n')}`).toEqual([]);
    expect(recorded.all.length).toBeGreaterThan(0);
    for (const url of recorded.all) {
      const params = new URL(url).searchParams;
      expect(params.get('fields')).toBe('summary');
      expect(params.get('ids')).toBeTruthy();
    }
    // Nothing is fetched in full until a case is selected.
    expect(perCaseFetches).toEqual([]);

    const [dupA, dupB, third] = ids;
    const rowFor = (id: string) => page.locator(`[data-testid="benchmark-cases-tab"] [role="option"][data-case-id="${id}"]`);
    await expect(rowFor(dupA)).toContainText(dupName);
    await expect(rowFor(dupB)).toContainText(dupName);

    // Select A, B, C in quick succession while every per-case response is held.
    await rowFor(dupA).click();
    await rowFor(dupB).click();
    await rowFor(third).click();

    const pane = page.locator('[data-testid="case-definition"]');
    await expect(pane).toHaveAttribute('data-case-id', third);
    // The pane shows a loading row — never the truncated summary — while the full document is in flight.
    await expect(page.getByTestId('case-definition-loading')).toBeVisible();
    await expect(pane).toHaveAttribute('data-status', 'loading');

    // Only the SELECTED cases were fetched in full, nothing else.
    await expect.poll(() => perCaseFetches.length).toBeGreaterThanOrEqual(1);
    for (const id of perCaseFetches) expect([dupA, dupB, third]).toContain(id);

    // When the responses land (A's and B's arrive stale), the pane shows C and only C.
    await expect(pane).toContainText(outcomeOf(2), { timeout: PANE_HOLD_MS * 3 + RENDER_DEADLINE_MS });
    await expect(pane).toHaveAttribute('data-status', 'ready');
    await expect(pane).toContainText('Investigate synthetic incident 2. Investigate synthetic incident 2.'); // full prompt, past the 200-char summary cut
    await expect(pane).not.toContainText(outcomeOf(0));
    await expect(pane).not.toContainText(outcomeOf(1));

    // Back to the SECOND same-named case: its own outcomes, under the shared name.
    await rowFor(dupB).click();
    await expect(pane).toHaveAttribute('data-case-id', dupB);
    await expect(pane).toContainText(outcomeOf(1), { timeout: PANE_HOLD_MS * 2 + RENDER_DEADLINE_MS });
    await expect(pane).not.toContainText(outcomeOf(0));
    await expect(pane).not.toContainText(outcomeOf(2));
    await expect(page.locator('[data-testid="case-detail-pane"] h3')).toHaveText(dupName);

    // Still no full list download anywhere along the way.
    expect(recorded.full).toEqual([]);
    const fullFetchesIssued = perCaseFetches.length;
    expect(fullFetchesIssued).toBeLessThanOrEqual(3);
  });
});
