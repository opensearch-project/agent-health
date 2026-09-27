/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression e2e for the comparison "Avg Accuracy 0%" fabrication.
 *
 * Live-tunnel bug (STaRK-retail comparison, two real runs scored by a custom
 * evaluator): every report carried ONLY the custom evaluator's metric keys
 * (fact_precision / provenance_verifiability / abstention_integrity /
 * payload_economy) and no `metrics.accuracy` at all. `calculateRunAggregates`
 * summed `metrics.accuracy ?? 0` over the evaluated reports, so the scoreboard
 * rendered a fabricated "Avg Accuracy 0%" for both runs — indistinguishable
 * from a run that genuinely scored zero.
 *
 * This seeds exactly that report shape via the storage API and asserts the
 * Compare scoreboard renders "--" (not recorded), not "0%".
 */

import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName, createTestDataTracker, TestDataTracker } from '../helpers/testDataTracker';

test.describe('Comparison — Avg Accuracy dash when no report carries accuracy', () => {
  let benchmarkId: string | null = null;
  const testCaseIds: string[] = [];
  const runId = `run-accdash-e2e-${Date.now()}`;
  let seeded = false;
  let tracker: TestDataTracker | null = null;

  test.beforeAll(async ({ request }, testInfo) => {
    testInfo.setTimeout(120_000);
    tracker = createTestDataTracker();

    // Two test cases.
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`accdash-tc-${i}`),
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'p',
          expectedOutcomes: ['o'],
        },
      });
      if (!r.ok()) return;
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      testCaseIds.push(id);
      tracker!.testCase(id);
    }
    if (testCaseIds.length !== 2) return;

    // Two evaluated reports in the EXACT real custom-evaluator shape: ready,
    // real verdicts, custom metric keys only — no `accuracy` field anywhere.
    const mkReport = async (data: Record<string, unknown>): Promise<string | null> => {
      const r = await request.post('/api/storage/runs', { data });
      if (!r.ok()) return null;
      const id = (await r.json()).id;
      if (id) tracker!.run(id);
      return id;
    };
    const r1 = await mkReport({
      testCaseId: testCaseIds[0],
      agentId: 'demo',
      modelId: 'demo-model',
      status: 'completed',
      passFailStatus: 'passed',
      metricsStatus: 'ready',
      metrics: { fact_precision: 100, provenance_verifiability: 100, abstention_integrity: 100, payload_economy: 85 },
    });
    const r2 = await mkReport({
      testCaseId: testCaseIds[1],
      agentId: 'demo',
      modelId: 'demo-model',
      status: 'completed',
      passFailStatus: 'failed',
      metricsStatus: 'ready',
      metrics: { fact_precision: 40, provenance_verifiability: 20, abstention_integrity: 60, payload_economy: 70 },
    });
    if (!r1 || !r2) return;

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('accdash-bm'),
        description: 'avg-accuracy dash e2e',
        testCaseIds,
        runs: [{
          id: runId,
          name: 'AccDash E2E Run',
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {
            [testCaseIds[0]]: { reportId: r1, status: 'completed', passFailStatus: 'passed' },
            [testCaseIds[1]]: { reportId: r2, status: 'completed', passFailStatus: 'failed' },
          },
          stats: { passed: 1, failed: 1, pending: 0, errored: 0, total: 2 },
        }],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker!.benchmark(benchmarkId!);
    seeded = true;
  });

  test.afterAll(async () => {
    if (tracker) await tracker.cleanup();
  });

  test('scoreboard renders a dash (not a fabricated 0%) when no report has metrics.accuracy', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark/run/reports (storage not configured?)');

    await page.goto(`/compare/${benchmarkId}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 15000 });

    // Two scoreboard layouts exist across in-flight branches: the older one
    // keeps per-run pass-rate/accuracy cells inside the collapsed "All
    // metrics" panel (MetricComparisonPanel); the decluttered one puts them
    // directly on the scoreboard row. Expand the panel when present, then
    // match the first accuracy cell for the run in either layout.
    const toggle = page.locator('[data-testid="scoreboard-all-metrics-toggle"]');
    if (await toggle.count()) await toggle.click();

    // Pass rate is real and unaffected: 1 of 2 passed.
    const passRate = page.locator(`[data-testid="run-passrate-${runId}"]`).first();
    await expect(passRate).toBeVisible({ timeout: 15000 });
    await expect(passRate).toHaveText('50%');

    // The fix, one step further: there is no accuracy-only column at all any
    // more ("accuracy" is one evaluator's rubric name, not the score), and the
    // run-level "Avg score" for a legacy (snapshot-less) run is "—" +
    // "legacy scoring" — never a fabricated "0%".
    await expect(page.locator(`[data-testid="run-accuracy-${runId}"]`)).toHaveCount(0);
    const avgScore = page.locator(`[data-testid="run-avgscore-${runId}"]`).first();
    await expect(avgScore).toBeVisible({ timeout: 15000 });
    await expect(avgScore).toContainText('—');
    await expect(avgScore).not.toContainText('%');
    await expect(page.locator(`[data-testid="run-avgscore-legacy-${runId}"]`)).toHaveText('legacy scoring');
  });

  test('per-case cells omit the accuracy chip (no fabricated "Passed 0%") when reports carry no accuracy', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark/run/reports (storage not configured?)');

    await page.goto(`/compare/${benchmarkId}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // Wait for the per-case comparison table to render real verdict cells.
    await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible({ timeout: 30000 });

    // Same fabrication as the scoreboard, one level down: MetricCell used to
    // render `result.accuracy ?? 0` as a "0%" chip beside EVERY verdict when
    // the reports were scored by a custom evaluator (no metrics.accuracy).
    // With no report carrying accuracy, no accuracy chip may render at all.
    await expect(page.locator('[data-testid="metric-cell-accuracy"]')).toHaveCount(0);
  });

  // The old "Avg score" for this fixture was 80 = the mean of
  // abstention_integrity (the ALPHABETICALLY-FIRST metric key) — an unrelated
  // rubric presented as the score. Without a scoring snapshot there is no
  // honest aggregate, so the cell is "—" + "legacy scoring" and the per-case
  // cells show every rubric BY NAME instead of one relabelled "primary".
  test('scoreboard "Avg score" is "— legacy scoring" for snapshot-less reports (no alphabetical rubric pick)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark/run/reports (storage not configured?)');

    await page.goto(`/compare/${benchmarkId}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 15000 });

    const avgScore = page.locator(`[data-testid="run-avgscore-${runId}"]`);
    await expect(avgScore).toBeVisible({ timeout: 15000 });
    await expect(avgScore).not.toContainText('80%');
    await expect(avgScore).toContainText('legacy scoring');
    expect(await avgScore.getAttribute('title')).toContain('not aggregated into a score');
  });

  test('per-case cells show rubric values by name (stored order), not a "primary rubric"', async ({ page }) => {
    test.skip(!seeded, 'Could not seed benchmark/run/reports (storage not configured?)');

    await page.goto(`/compare/${benchmarkId}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible({ timeout: 30000 });

    await expect(page.locator('[data-testid="metric-cell-primary-rubric"]')).toHaveCount(0);
    const chips = page.locator('[data-testid="metric-cell-rubrics"]');
    await expect(chips.first()).toBeVisible({ timeout: 15000 });
    const texts = await chips.allTextContents();
    // Stored order leads with fact_precision / provenance_verifiability inline
    // (+N for the rest); abstention_integrity is still there by name in the
    // hover — but nothing calls any of them "the score".
    expect(texts.some(t => t.includes('fact_precision') && t.includes('provenance_verifiability') && t.includes('+2'))).toBe(true);
    const titles = await chips.evaluateAll(els => els.map(e => e.getAttribute('title') || ''));
    expect(titles.every(t => t.startsWith('Legacy scoring'))).toBe(true);
    expect(titles.some(t => t.includes('abstention_integrity 100%'))).toBe(true);
    expect(titles.some(t => t.includes('abstention_integrity 60%'))).toBe(true);
  });
});
