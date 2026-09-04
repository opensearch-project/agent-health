/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression for #465: the Evaluation Runs list ("Evaluation Runs" /
 * `/evaluations/runs`, the page whose newest-first default ordering is
 * covered by evalrun-rename-and-sort.spec.ts's third test) hid the rename
 * pencil for essentially every REAL production run.
 *
 * Runs created WITH a benchmarkId are dual-written (#399): a legacy-shaped
 * `BenchmarkRun` projection embedded in `benchmark.runs[]` (never carries
 * `docType`) AND a first-class `EvaluationRun` doc (`docType:
 * 'evaluation-run'`) with the SAME id. EvalRunsPage.tsx builds its row list
 * by reading `benchmark.runs[]` FIRST, then merging in `listEvaluationRuns()`
 * results de-duped by id -- so the benchmark-sourced copy always wins for a
 * dual-written run. The row-level rename pencil used to gate on `kind ===
 * 'eval-run'` (which loop produced the row), not on whether a first-class,
 * PATCH-able doc exists for that id -- so it was hidden for every
 * benchmark-associated run, dual-written or not.
 *
 * evalrun-rename-and-sort.spec.ts's own row-rename test does NOT catch this:
 * it seeds its fixture via `PUT /api/storage/evaluation-runs/:id` with NO
 * benchmarkId at all, so that fixture can never enter the `benchmark.runs[]`
 * loop in the first place -- it always takes the `kind: 'eval-run'` path and
 * always shows the pencil, regardless of whether the dedup-hides-it branch is
 * broken. This spec seeds the actual dual-written shape (same id embedded in
 * a benchmark's `runs[]` AND present as a standalone evaluation-run doc) and
 * asserts the pencil on the REAL merged list, which is the surface where the
 * bug was visible on the live product.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Evaluation Runs list — rename pencil for dual-written benchmark runs (#465)', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  const testCaseIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('dualwrite-rename-tc'),
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'p',
        expectedOutcomes: ['o'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    const tcId = tc.id || tc.testCase?.id;
    tracker.testCase(tcId);
    testCaseIds.push(tcId);

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('dualwrite-rename-benchmark'),
        description: 'dual-write rename E2E (#465)',
        testCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    runId = `run-dualwrite-e2e-${Date.now()}`;
    const runName = uniqueTestName('dualwrite-rename-run');

    // 1. Embed a legacy-shaped BenchmarkRun projection into benchmark.runs[]
    //    (server never stamps docType on this embedded shape -- matches
    //    production exactly: verified live via GET on a real benchmark's
    //    runs[], every entry has docType === undefined).
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const putBm = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [{
          id: runId,
          name: runName,
          agentKey: 'demo',
          modelId: 'demo-model',
          createdAt: new Date().toISOString(),
          status: 'completed',
          benchmarkVersion: 1,
          testCaseSnapshots: [],
          results: {},
        }],
      },
    });
    if (!putBm.ok()) { benchmarkId = null; return; }

    // 2. Dual-write the SAME id as a first-class EvaluationRun doc (#399
    //    shape) -- this is what makes rename actually work server-side.
    //    PUT /api/storage/evaluation-runs/:id force-sets docType on write.
    const putEr = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        name: runName,
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        benchmarkId,
        sources: [{ type: 'benchmark', benchmarkId }],
        trigger: 'ui',
        testCaseSnapshots: [],
        results: {},
        createdAt: new Date().toISOString(),
      },
    });
    if (!putEr.ok()) { benchmarkId = null; return; }
    tracker.evaluationRun(runId);
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('shows the rename pencil for a benchmark-embedded run that is also a first-class evaluation-run doc', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Could not seed dual-written run (storage not configured?)');

    await page.goto('/evaluations/runs');
    await page.getByPlaceholder('Search runs...').fill(runId!);

    const editBtn = page.getByTestId(`run-row-rename-${runId}-edit-btn`);
    await expect(editBtn).toBeVisible({ timeout: 30_000 });

    // Prove it actually persists (not just rendered) -- the whole point of
    // showing the pencil is that the PATCH endpoint genuinely works for this
    // row.
    const newName = uniqueTestName('dualwrite-rename-after');
    await editBtn.click();
    const input = page.getByTestId(`run-row-rename-${runId}-input`);
    await input.fill(newName);
    await input.press('Enter');
    await expect(page.getByTestId(`run-row-rename-${runId}-text`)).toHaveText(newName, { timeout: 20_000 });

    // Retry the verification GET once -- a bare connection reset against a
    // busy local test server is an infra flake, not a product regression
    // (the UI assertion above already proved the rename rendered).
    let verifyBody: { name?: string } | null = null;
    for (let attempt = 0; attempt < 3 && verifyBody === null; attempt++) {
      try {
        const verify = await page.request.get(`/api/storage/evaluation-runs/${runId}`);
        verifyBody = await verify.json();
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    expect(verifyBody?.name).toBe(newName);

    // Exactly one row for this id -- the merge's id-dedup must still collapse
    // the benchmark-embedded and first-class copies into a single row.
    await expect(page.getByTestId('run-row')).toHaveCount(1);
  });
});
