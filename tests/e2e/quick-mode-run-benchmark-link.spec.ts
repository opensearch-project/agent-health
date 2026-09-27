/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a CLI quick-mode run is attached to its stable benchmark on the
 * Evaluation Runs page — the Benchmark column links to the benchmark page and
 * never reads "(ad-hoc)".
 *
 * Owner feedback (2026-09-27, on #476): "The evaluation runs page column for
 * benchmarks should have the link of the benchmarks page — why does it say
 * ad-hoc? You are defeating the purpose." Quick mode therefore find-or-creates
 * ONE stable benchmark and starts its run through the unified evaluation-runs
 * API as a `{ type: 'benchmark', benchmarkId }` source with `benchmarkId` set.
 * This spec issues exactly that request shape against the real backend (under
 * a run-unique benchmark name, so a shared server's real quick-mode benchmark
 * is never touched) and asserts the rendered Runs page.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Quick-mode run on the Evaluation Runs page — Benchmark column links to the benchmark', () => {
  const tracker = createTestDataTracker();
  const BENCHMARK_NAME = uniqueTestName('quick-run-all-test-cases');
  const RUN_NAME = uniqueTestName('quick-mode-run');
  let benchmarkId: string | null = null;
  let runId: string | null = null;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    const tc = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('quick-tc'),
        category: 'General', difficulty: 'Easy', initialPrompt: 'Say hello.', expectedOutcomes: ['Greets the user'],
      },
    });
    if (!tc.ok()) return;
    const tcJson = await tc.json();
    const testCaseId: string = tcJson.id || tcJson.testCase?.id;
    tracker.testCase(testCaseId);

    // What quick mode does on its first run: create the stable benchmark over
    // the full stored set …
    const bm = await request.post('/api/storage/benchmarks', {
      data: { name: BENCHMARK_NAME, description: 'quick-mode E2E stand-in', testCaseIds: [testCaseId] },
    });
    if (!bm.ok()) return;
    benchmarkId = (await bm.json()).id;
    tracker.benchmark(benchmarkId);

    // … then start the run as a single benchmark source with benchmarkId set
    // (SSE; the response completes when the demo run finishes).
    const run = await request.post('/api/storage/evaluation-runs', {
      data: {
        name: RUN_NAME,
        sources: [{ type: 'benchmark', benchmarkId }],
        agentKey: 'demo',
        modelId: 'demo-model',
        benchmarkId,
        trigger: 'cli',
      },
      timeout: 90_000,
    });
    if (!run.ok()) { benchmarkId = null; return; }
    const started = (await run.text()).match(/"runId":"(eval-run-[^"]+)"/);
    runId = started?.[1] ?? null;
    if (runId) {
      tracker.evaluationRun(runId);
      const stored = await request.get(`/api/storage/evaluation-runs/${runId}`);
      if (stored.ok()) {
        const body = await stored.json();
        const doc = body.evaluationRun ?? body;
        for (const r of Object.values(doc?.results ?? {}) as Array<{ reportId?: string }>) tracker.run(r.reportId);
      }
    } else {
      benchmarkId = null;
    }
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('the run row shows the benchmark name as a link to /evaluations/benchmarks/<id>/runs — not "(ad-hoc)"', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed a quick-mode run (storage not configured?)');
    await page.goto('/evaluations/runs');
    await page.waitForTimeout(1500);

    const flat = page.locator('[data-testid="viewmode-flat"]');
    if (await flat.count()) { await flat.click(); await page.waitForTimeout(600); }

    const row = page.locator('[data-testid="run-row"]').filter({ hasText: RUN_NAME });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).not.toContainText('(ad-hoc)');

    const benchmarkLink = row.getByRole('button', { name: BENCHMARK_NAME });
    await expect(benchmarkLink).toBeVisible();
    await benchmarkLink.click();
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs$`), { timeout: 15_000 });
    // The benchmark page's Runs tab lists the same run — history accumulates here.
    await expect(page.locator('[data-testid="run-row"]').filter({ hasText: RUN_NAME })).toHaveCount(1, { timeout: 30_000 });
  });
});
