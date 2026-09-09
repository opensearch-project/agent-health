/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Delete is present on EVERY row of the benchmark Runs tab and works
 * for every run kind.
 *
 * Owner report (2026-09-08): "Delete button should be present for all runs
 * on the benchmark details page." Rows backed by a standalone evaluation-run
 * document (not embedded in benchmark.runs[] — the common case since the
 * dual-write) used to render NO Delete/Cancel because the row actions only
 * knew the benchmark-embedded API. The page now dispatches on the run's
 * kind, so this spec seeds one row of each kind on one benchmark:
 *   - standalone evaluation-run doc (never embedded)
 *   - legacy embedded-only run (no doc)
 *   - dual-written (doc + embedded projection)
 * asserts Delete is rendered on all three, and deletes the standalone and the
 * legacy row from the table, asserting the row disappears, the right endpoint
 * was called, and the server-side form is gone. (Removing BOTH forms of a
 * dual-written run is server-side behaviour with its own coverage —
 * tests/e2e/run-delete-no-ghost.spec.ts.)
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark Runs tab — Delete on every row', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  const stamp = Date.now();
  const STANDALONE = { id: `eval-run-bmdel-standalone-${stamp}`, name: uniqueTestName('bmdel-standalone') };
  const LEGACY = { id: `run-bmdel-legacy-${stamp}`, name: uniqueTestName('bmdel-legacy') };
  const DUAL = { id: `eval-run-bmdel-dual-${stamp}`, name: uniqueTestName('bmdel-dual') };

  test.beforeAll(async ({ request }) => {
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: { name: uniqueTestName('bmdel-benchmark'), testCaseIds: [], runs: [] },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    const at = (offsetMs: number) => new Date(stamp - offsetMs).toISOString();
    const embedded = (r: { id: string; name: string }, offsetMs: number) => ({
      id: r.id, name: r.name, agentKey: 'demo', modelId: 'demo-model', status: 'completed',
      createdAt: at(offsetMs), completedAt: at(offsetMs - 1000), results: {},
    });
    const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: { ...bm, runs: [embedded(LEGACY, 30_000), embedded(DUAL, 20_000)] },
    });
    if (!put.ok()) { benchmarkId = null; return; }

    const seedDoc = async (r: { id: string; name: string }, offsetMs: number) => {
      const res = await request.put(`/api/storage/evaluation-runs/${r.id}`, {
        data: {
          id: r.id, docType: 'evaluation-run', name: r.name, status: 'completed',
          agentKey: 'demo', modelId: 'demo-model', benchmarkId,
          sources: [{ type: 'benchmark', benchmarkId }], trigger: 'api',
          testCaseSnapshots: [], results: {}, createdAt: at(offsetMs), completedAt: at(offsetMs - 1000),
        },
      });
      if (res.ok()) tracker.evaluationRun(r.id);
      return res.ok();
    };
    if (!(await seedDoc(STANDALONE, 10_000)) || !(await seedDoc(DUAL, 20_000))) benchmarkId = null;
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  test('every row (standalone doc, legacy embedded, dual-written) renders a Delete button', async ({ page }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark/runs (storage not configured?)');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    for (const r of [STANDALONE, LEGACY, DUAL]) {
      const row = page.locator('[data-testid="run-row"]', { hasText: r.name });
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row.locator('[aria-label="Delete run"]')).toHaveCount(1);
    }
  });

  test('deleting a STANDALONE (non-embedded) row hits the evaluation-runs API, removes the row, and the doc is gone', async ({ page, request }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark/runs (storage not configured?)');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const row = page.locator('[data-testid="run-row"]', { hasText: STANDALONE.name });
    await expect(row).toBeVisible({ timeout: 15000 });

    const deletes: string[] = [];
    page.on('request', req => { if (req.method() === 'DELETE') deletes.push(new URL(req.url()).pathname); });
    let confirmMessage = '';
    page.once('dialog', d => { confirmMessage = d.message(); d.accept(); });

    await row.locator('[aria-label="Delete run"]').click();
    await expect(row).toHaveCount(0, { timeout: 15000 });
    expect(confirmMessage).toContain(STANDALONE.name);
    expect(confirmMessage).toMatch(/reports are kept/i);
    expect(deletes).toEqual([`/api/storage/evaluation-runs/${STANDALONE.id}`]);
    expect((await request.get(`/api/storage/evaluation-runs/${STANDALONE.id}`)).status()).toBe(404);
    await expect(page.getByText(`"${STANDALONE.name}" deleted`)).toBeVisible();
  });

  test('deleting a LEGACY embedded-only row hits the benchmark nested-run API and removes it from benchmark.runs[]', async ({ page, request }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark/runs (storage not configured?)');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const row = page.locator('[data-testid="run-row"]', { hasText: LEGACY.name });
    await expect(row).toBeVisible({ timeout: 15000 });

    const deletes: string[] = [];
    page.on('request', req => { if (req.method() === 'DELETE') deletes.push(new URL(req.url()).pathname); });
    page.once('dialog', d => d.accept());

    await row.locator('[aria-label="Delete run"]').click();
    await expect(row).toHaveCount(0, { timeout: 15000 });
    expect(deletes).toEqual([`/api/storage/benchmarks/${benchmarkId}/runs/${LEGACY.id}`]);
    const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    expect((bm.runs || []).some((r: any) => r.id === LEGACY.id)).toBe(false);
  });

  test('declining the confirm keeps the row and issues no DELETE', async ({ page, request }) => {
    test.skip(!benchmarkId, 'Could not seed benchmark/runs (storage not configured?)');
    // Seed a fresh standalone row for this test only.
    const id = `eval-run-bmdel-decline-${Date.now()}`;
    const name = uniqueTestName('bmdel-decline');
    const res = await request.put(`/api/storage/evaluation-runs/${id}`, {
      data: {
        id, docType: 'evaluation-run', name, status: 'completed', agentKey: 'demo', modelId: 'demo-model',
        benchmarkId, sources: [{ type: 'benchmark', benchmarkId }], trigger: 'api',
        testCaseSnapshots: [], results: {}, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run');
    tracker.evaluationRun(id);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const row = page.locator('[data-testid="run-row"]', { hasText: name });
    await expect(row).toBeVisible({ timeout: 15000 });
    const deletes: string[] = [];
    page.on('request', req => { if (req.method() === 'DELETE') deletes.push(req.url()); });
    page.once('dialog', d => d.dismiss());
    await row.locator('[aria-label="Delete run"]').click();
    await page.waitForTimeout(500);
    await expect(row).toHaveCount(1);
    expect(deletes).toEqual([]);
  });
});
