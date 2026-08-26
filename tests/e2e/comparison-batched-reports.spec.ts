/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the comparison page's report loader
 * (`asyncRunStorage.getReportsByIds`) used to issue ONE unchunked
 * `GET /api/storage/runs?ids=<all report ids comma-joined>` request. With a
 * few runs over a large benchmark that URL/query blows past the server's
 * header/URL size limit and the real backend responds `431 Request Header
 * Fields Too Large`. The loader had no error handling, so the failure was
 * silently treated as "no reports" — every per-test-case cell rendered
 * "— Not run" even though the runs themselves loaded and scored correctly
 * (verified in production, 2026-08-26, 4 runs x 400 test cases).
 *
 * This spec seeds two runs sharing 60 test cases each (120 total distinct
 * report ids — comfortably over the CHUNK_SIZE=100 threshold) against a
 * mocked backend that returns 431 for any single request asking for more
 * than 100 ids, mirroring the real failure mode. It asserts:
 *  1. The fixed loader issues multiple small requests (chunked) and every
 *     cell renders real pass/fail data — never falls back to "Not run".
 *  2. If a chunk genuinely fails, the page surfaces a visible error banner
 *     instead of silently rendering every row as "Not run".
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route, Page } from '@playwright/test';

const RUN_A = 'eval-run-batch-a';
const RUN_B = 'eval-run-batch-b';
const TC_COUNT = 60;
const TCS = Array.from({ length: TC_COUNT }, (_, i) => `tc-batch-${i}`);
// Backend header/URL limit under test: real OpenSearch/Express deployments
// choke well before this on a comma-joined ids query string; 100 ids per
// request is comfortably under it (matches CHUNK_SIZE in asyncRunStorage.ts).
const SERVER_MAX_IDS_PER_REQUEST = 100;

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const repId = (run: string, tc: string) => `rep-${run}-${tc}`;

function evalRunDoc(id: string, agentKey: string, passFailByIndex: (i: number) => 'passed' | 'failed') {
  return {
    id,
    docType: 'evaluation-run',
    name: `Batch Run ${agentKey}`,
    createdAt: '2026-08-26T10:00:00Z',
    status: 'completed',
    agentKey,
    modelId: 'e2e-model',
    sources: [{ type: 'test-case-ids', ids: TCS }],
    trigger: 'cli',
    testCaseSnapshots: TCS.map(tc => ({ id: tc, version: 1, name: `Case ${tc}` })),
    results: Object.fromEntries(
      TCS.map((tc, i) => [tc, { reportId: repId(id, tc), status: 'completed', passFailStatus: passFailByIndex(i) }])
    ),
    stats: { passed: TC_COUNT, failed: 0, total: TC_COUNT },
  };
}

function storageReport(reportId: string, testCaseId: string, agentId: string, passFailStatus: 'passed' | 'failed') {
  return {
    id: reportId,
    createdAt: '2026-08-26T10:00:00Z',
    testCaseId,
    agentId,
    modelId: 'e2e-model',
    status: 'completed',
    passFailStatus,
    metricsStatus: 'completed',
    metrics: { accuracy: passFailStatus === 'passed' ? 95 : 20, faithfulness: 90, trajectory_alignment_score: 88, latency_score: 80 },
    trajectory: [],
    annotations: [],
  };
}

// Alternate pass/fail per index so runs disagree on ~half the rows — the
// comparison table's default "differences" filter would otherwise hide
// identical rows and the cells we want to assert on wouldn't be visible.
const passFailA = (i: number): 'passed' | 'failed' => (i % 2 === 0 ? 'passed' : 'failed');
const passFailB = (i: number): 'passed' | 'failed' => (i % 2 === 0 ? 'failed' : 'passed');

let requestSizes: number[] = [];

async function setupCommon(page: Page) {
  requestSizes = [];
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const m = r.request().url().match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    if (!id) return json(r, { evaluationRuns: [evalRunDoc(RUN_A, 'agent-a', passFailA), evalRunDoc(RUN_B, 'agent-b', passFailB)], total: 2 });
    if (id === RUN_A) return json(r, evalRunDoc(RUN_A, 'agent-a', passFailA));
    if (id === RUN_B) return json(r, evalRunDoc(RUN_B, 'agent-b', passFailB));
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch', (r) => json(r, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/traces', (r) => json(r, { backend: 'opensearch', spans: [], total: 0 }));
}

test.describe('Comparison page — chunked report fetch (431 regression)', () => {
  test('chunks the report fetch under the server limit and renders real cells (not "Not run")', async ({ page }) => {
    await setupCommon(page);

    await page.route(/\/api\/storage\/runs\?ids=/, async (r) => {
      const u = new URL(r.request().url());
      const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
      requestSizes.push(ids.length);
      if (ids.length > SERVER_MAX_IDS_PER_REQUEST) {
        // Real backend behaviour being guarded against: an unchunked request
        // over the limit fails outright.
        return r.fulfill({ status: 431, contentType: 'text/plain', body: 'Request Header Fields Too Large' });
      }
      const runs = ids.map(id => {
        const isA = id.startsWith(`rep-${RUN_A}-`);
        const tc = id.replace(`rep-${isA ? RUN_A : RUN_B}-`, '');
        const idx = TCS.indexOf(tc);
        const pf = isA ? passFailA(idx) : passFailB(idx);
        return storageReport(id, tc, isA ? 'agent-a' : 'agent-b', pf);
      });
      return json(r, { runs, total: runs.length });
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // Show every row (default filter hides unchanged rows; we want all 60).
    const showAll = page.locator(`text=Show all (${TC_COUNT})`);
    if (await showAll.count() > 0) {
      await showAll.first().click();
    }
    await page.waitForTimeout(1500);

    // No error banner — every chunk succeeded.
    await expect(page.locator('[data-testid="reports-error-banner"]')).toHaveCount(0);

    // Regression guard: at least one request was issued, and NONE exceeded
    // the server's per-request id limit (the old unchunked code would have
    // sent all 120 ids in a single request here).
    expect(requestSizes.length).toBeGreaterThanOrEqual(2);
    for (const size of requestSizes) {
      expect(size).toBeLessThanOrEqual(SERVER_MAX_IDS_PER_REQUEST);
    }

    // The actual bug symptom: cells rendered real data, not "— Not run" for
    // every row. Since every test case has a report from both runs, no cell
    // should read "Not run".
    await expect(page.locator('text=Not run')).toHaveCount(0);
  });

  test('surfaces a visible error banner when a chunk genuinely fails, instead of silently rendering "Not run"', async ({ page }) => {
    await setupCommon(page);

    await page.route(/\/api\/storage\/runs\?ids=/, async (r) => {
      // Every chunk fails outright (e.g. a real backend 500), regardless of
      // size — the loader must not swallow this into an empty report map.
      return r.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' });
    });

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    await expect(page.locator('[data-testid="reports-error-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="reports-error-banner"]')).toContainText('Failed to load test case reports');
  });
});
