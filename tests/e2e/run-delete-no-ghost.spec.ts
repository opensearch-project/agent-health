/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: deleting a dual-written run from the benchmark Runs page leaves NO
 * ghost row — neither persisted form survives.
 *
 * A benchmark-linked run is stored as an `evaluation-run` doc AND, once it
 * finishes, a projection embedded in `benchmark.runs[]`; the Runs page merges
 * both sources (deduped by id). The page's Delete hits the benchmark
 * nested-run endpoint, which used to remove only the projection — the doc
 * was then merged back in and the "deleted" run reappeared on reload. The
 * server now removes both forms from either DELETE route.
 *
 * Seeds its own benchmark + dual-written run; deletes everything it created.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Runs page — deleting a dual-written run leaves no ghost', () => {
  const tracker = createTestDataTracker();
  test.afterAll(async () => { await tracker.cleanup(); });

  test('Delete on the run row → row gone, stays gone after reload, doc 404, projection removed', async ({ page, request }) => {
    const runId = `eval-run-e2e-noghost-${Date.now()}`;
    const runName = uniqueTestName('noghost-run');
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('noghost-benchmark'), testCaseIds: [],
        runs: [{
          id: runId, name: runName, agentKey: 'demo', modelId: 'demo-model', status: 'completed',
          createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), results: {},
        }],
      },
    });
    test.skip(!bmRes.ok(), 'Could not create benchmark (storage not configured?)');
    const benchmarkId = (await bmRes.json()).id as string;
    tracker.benchmark(benchmarkId);

    const docRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, docType: 'evaluation-run', name: runName, status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', benchmarkId,
        sources: [{ type: 'benchmark', benchmarkId }], trigger: 'api',
        testCaseSnapshots: [], results: {}, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    test.skip(!docRes.ok(), 'Could not seed evaluation-run doc');
    tracker.evaluationRun(runId);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    // Run rows are cards (`.rounded-xl`) on the current Runs tab and compact
    // `[data-testid="run-row"]` rows on the table variant; either way the
    // element that contains the run name also contains its Delete button.
    const row = page.locator('[data-testid="run-row"], .rounded-xl', { hasText: runName });
    await expect(row.first()).toBeVisible({ timeout: 15000 });
    // Deduped: exactly one Delete for the dual-written run.
    await expect(page.locator('[title="Delete run"]')).toHaveCount(1);

    const deletes: string[] = [];
    page.on('request', req => { if (req.method() === 'DELETE') deletes.push(new URL(req.url()).pathname); });
    page.once('dialog', d => d.accept());
    await page.locator('[title="Delete run"]').click();
    await expect(row).toHaveCount(0, { timeout: 15000 });
    // Whichever endpoint the page picked, the server removes BOTH forms.
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(new RegExp(`^/api/storage/(evaluation-runs/${runId}|benchmarks/${benchmarkId}/runs/${runId})$`));

    // Reload re-merges benchmark.runs[] + evaluation-run docs — nothing may come back.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="run-row"], .rounded-xl', { hasText: runName })).toHaveCount(0);

    expect((await request.get(`/api/storage/evaluation-runs/${runId}`)).status()).toBe(404);
    const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    expect((bm.runs || []).some((r: any) => r.id === runId)).toBe(false);
  });
});
