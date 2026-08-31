/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E for iteration-4 clarity fixes #3 and #4 (owner feedback on the live
 * comparison page):
 *
 *  #3 — run names must be prominent on scoreboard rows (agent/model/time as
 *       secondary), plus a "Comparing <A> vs <B> [· benchmark <name>]" line
 *       above the scoreboard.
 *  #4 — the Coverage column reworded from "N shared / M total" to a plain
 *       overlap statement ("6 in both · 56 only in A"), green when fully
 *       comparable, amber otherwise.
 *
 * Deterministic: storage + /api/metrics/batch + /api/comparison/deep-dive are
 * mocked via page.route(), no real backend data required.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-clarity-a';
const RUN_B = 'eval-run-clarity-b';
const BENCH_ID = 'bench-clarity';

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

// Run A ran 6 cases, Run B ran a 62-case superset (mirrors the live repro:
// a 62-result run vs a 6-result run) — 6 shared, 56 only in B.
const sharedIds = ['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5', 'tc-6'];
const extraIds = Array.from({ length: 56 }, (_, i) => `tc-extra-${i}`);

function snapshots(ids: string[]) {
  return ids.map((id) => ({ id, version: 1, name: id }));
}
function results(ids: string[], reportPrefix: string) {
  return Object.fromEntries(ids.map((id) => [id, { reportId: `${reportPrefix}-${id}`, status: 'completed', passFailStatus: 'passed' }]));
}

const evalRunA = {
  id: RUN_A,
  docType: 'evaluation-run',
  name: 'stark-retail smoke (6 tests, subset ingest)',
  createdAt: '2026-08-31T07:36:00Z',
  status: 'completed',
  agentKey: 'internal-rest-agent-example',
  modelId: 'us.anthropic.claude-sonnet-4-6',
  benchmarkId: BENCH_ID,
  sources: [{ type: 'benchmark', benchmarkId: BENCH_ID }],
  trigger: 'ui',
  testCaseSnapshots: snapshots(sharedIds),
  results: results(sharedIds, 'rep-a'),
  stats: { passed: 6, failed: 0, total: 6 },
};

const evalRunB = {
  id: RUN_B,
  docType: 'evaluation-run',
  name: 'stark-retail \u2014 mock run 1 (subset ingest)',
  createdAt: '2026-08-31T07:38:00Z',
  status: 'completed',
  agentKey: 'internal-rest-agent-example',
  modelId: 'us.anthropic.claude-sonnet-4-6',
  benchmarkId: BENCH_ID,
  sources: [{ type: 'benchmark', benchmarkId: BENCH_ID }],
  trigger: 'ui',
  testCaseSnapshots: snapshots([...sharedIds, ...extraIds]),
  results: results([...sharedIds, ...extraIds], 'rep-b'),
  stats: { passed: 40, failed: 22, total: 62 },
};

function report(id: string, agentKey: string, runId: string) {
  return {
    id, createdAt: '2026-08-31T07:36:00Z', testCaseId: 'tc-1', agentId: agentKey, runId,
    modelId: 'us.anthropic.claude-sonnet-4-6', status: 'completed', passFailStatus: 'passed',
    metrics: { accuracy: 80 }, performanceMetrics: { durationMs: 1000 }, trajectory: [],
  };
}

test.describe('Comparison page \u2014 run-name prominence, summary line, coverage wording (bugs #3/#4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/benchmarks/${BENCH_ID}`)) {
        return json(route, { id: BENCH_ID, name: 'internal-benchmark-example', testCaseIds: [], runs: [], totalRuns: 0, hasMoreRuns: false });
      }
      return json(route, { benchmarks: [], total: 0 });
    });
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_A}`)) return json(route, evalRunA);
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_B}`)) return json(route, evalRunB);
      if (url.pathname.endsWith('/evaluation-runs')) return json(route, { evaluationRuns: [evalRunA, evalRunB], total: 2 });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
      const idsParam = new URL(route.request().url()).searchParams.get('ids') || '';
      const runs = idsParam.split(',').map((rid) =>
        rid.startsWith('rep-a') ? report(rid, 'internal-rest-agent-example', 'run-a-subprocess') : report(rid, 'internal-rest-agent-example', 'run-b-subprocess')
      );
      return json(route, { runs, total: runs.length });
    });
    await page.route('**/api/metrics/batch**', (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      const runIds: string[] = body.runIds || [];
      return json(route, {
        metrics: runIds.map((runId) => ({ runId, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending' })),
        aggregate: {},
      });
    });
    await page.route('**/api/comparison/deep-dive', (route) => json(route, { markdown: 'stub', modelId: 'stub/model', durationMs: 1, runs: [] }));
  });

  test('shows the run name prominently on each row, with agent/model/time as secondary', async ({ page }) => {
    await page.goto(`/compare/${BENCH_ID}?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const rowA = page.locator('[data-testid="scoreboard-row-A"]');
    await expect(rowA).toContainText('stark-retail smoke (6 tests, subset ingest)');
    await expect(rowA).toContainText('internal-rest-agent-example');
  });

  test('renders a "Comparing <A> vs <B> · benchmark <name>" summary line above the scoreboard', async ({ page }) => {
    await page.goto(`/compare/${BENCH_ID}?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const summary = page.locator('[data-testid="comparison-summary-line"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Comparing');
    await expect(summary).toContainText('stark-retail smoke (6 tests, subset ingest)');
    await expect(summary).toContainText('stark-retail \u2014 mock run 1 (subset ingest)');
    await expect(summary).toContainText('internal-benchmark-example');
  });

  test('coverage banner plainly states "N in both \u00b7 M only in B" (amber) for the 6-vs-62 partial overlap', async ({ page }) => {
    await page.goto(`/compare/${BENCH_ID}?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    const banner = page.locator('[data-testid="comparison-overlap-banner"]');
    await expect(banner).toHaveAttribute('data-overlap', 'partial');
    await expect(banner).toContainText('6 in both');
    await expect(banner).toContainText('56 only in B');
  });
});
