/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the deep-dive with EXACTLY TWO runs (owner report,
 * 2026-10-15: the trace-grounded "What's actually different" section was
 * missing from the compare page even with two runs selected).
 *
 * Root cause: the panel read its report-id pair only from the comparison
 * rows, and a row carries a reportId only after the browser has downloaded
 * that report doc (`buildTestCaseComparisonRows` marks a not-yet-loaded
 * report as `missing`). So the section was absent for the whole reports
 * fetch — two large batched GETs per pair on a real benchmark — and forever
 * when that fetch failed. No header, no placeholder, no message.
 *
 * Asserts on the REAL rendered compare page, scoped to a benchmark whose
 * two runs come from the dual-written `benchmark.runs[]` projection:
 *  - reports slow → the section is visible immediately with a "loading
 *    reports" line and NO LLM job yet; once the reports land it generates
 *    with the run docs' report ids
 *  - reports fetch fails → the section still renders but does not launch
 *    the job on its own; "Generate anyway" posts the run docs' report ids
 *  - no test case completed on both sides → an explicit message, not nothing
 *
 * Deterministic: storage, the models endpoint and the deep-dive job are all
 * mocked via page.route() — no LLM/AWS creds, no cluster writes.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Page, Route } from '@playwright/test';

const BM = 'bench-dd2';
const RUN_A = 'eval-run-dd2-a';
const RUN_B = 'eval-run-dd2-b';
const CASES = ['tc-dd2-1', 'tc-dd2-2'];
const REP: Record<string, Record<string, string>> = {
  [RUN_A]: { 'tc-dd2-1': 'rep-dd2-a-1', 'tc-dd2-2': 'rep-dd2-a-2' },
  [RUN_B]: { 'tc-dd2-1': 'rep-dd2-b-1', 'tc-dd2-2': 'rep-dd2-b-2' },
};
const FABLE = 'us.anthropic.claude-fable-5-1';

type Result = { reportId: string; status: string; passFailStatus?: string };
/** Which test cases a run executed (every executed case carries its reportId, as the dual-written projection does). */
type RunShape = { cases?: string[] };

const results = (runId: string, { cases = CASES }: RunShape): Record<string, Result> =>
  Object.fromEntries(cases.map((tc) => [tc, {
    reportId: REP[runId][tc],
    status: 'completed',
    passFailStatus: runId === RUN_A ? 'failed' : 'passed',
  }]));

const runDoc = (runId: string, shape: RunShape) => ({
  id: runId,
  docType: 'evaluation-run',
  name: runId === RUN_A ? 'Baseline' : 'Candidate',
  createdAt: runId === RUN_A ? '2026-10-01T10:00:00Z' : '2026-10-02T10:00:00Z',
  completedAt: '2026-10-02T11:00:00Z',
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  benchmarkId: BM,
  sources: [{ type: 'benchmark', benchmarkId: BM }],
  trigger: 'ui',
  testCaseSnapshots: (shape.cases ?? CASES).map((id, i) => ({ id, version: 1, name: `Shared Case ${i + 1}` })),
  results: results(runId, shape),
  stats: { passed: runId === RUN_A ? 0 : 2, failed: runId === RUN_A ? 2 : 0, total: 2 },
});

const report = (runId: string, tc: string) => ({
  id: REP[runId][tc],
  createdAt: '2026-10-02T10:30:00Z',
  testCaseId: tc,
  agentId: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: runId === RUN_A ? 'failed' : 'passed',
  metrics: { accuracy: runId === RUN_A ? 40 : 90 },
  performanceMetrics: { durationMs: 30000 },
  experimentRunId: runId,
  trajectory: [],
});

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

interface Scenario {
  /** Shape of the projection embedded in `benchmark.runs[]` (what the page reads). */
  projection: Record<string, RunShape>;
  /** Reports batch (`GET /runs?ids=`): normal, held until released, or a 500. */
  reports?: 'ok' | 'hold' | 'fail';
}

async function setupRoutes(page: Page, s: Scenario): Promise<{ releaseReports: () => void; reportRequests: () => number }> {
  const benchmark = {
    id: BM, name: 'Deep-dive two-run benchmark', description: '', testCaseIds: CASES, currentVersion: 1, versions: [],
    createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-10-02T11:00:00Z',
    runs: [RUN_A, RUN_B].map((id) => runDoc(id, s.projection[id])),
  };
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reportRequests = 0;

  await page.route('**/api/storage/benchmarks**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/benchmarks/${BM}`)) return json(route, { benchmark });
    return json(route, { benchmarks: [benchmark], total: 1 });
  });
  await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (route) => {
    const url = new URL(route.request().url());
    for (const id of [RUN_A, RUN_B]) if (url.pathname.endsWith(`/evaluation-runs/${id}`)) return json(route, runDoc(id, s.projection[id]));
    if (url.pathname.endsWith('/evaluation-runs')) return json(route, { evaluationRuns: [], total: 0 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, async (route) => {
    reportRequests += 1;
    if (s.reports === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"storage unavailable"}' });
    if (s.reports === 'hold') await held;
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    for (const runId of [RUN_A, RUN_B]) for (const tc of CASES) if (ids.includes(REP[runId][tc])) runs.push(report(runId, tc));
    return json(route, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive/system-prompt', (route) => json(route, { systemPrompt: 'DEFAULT PROMPT' }));
  await page.route('**/api/comparison/deep-dive/models', (route) =>
    json(route, { models: [{ provider: 'amazon-bedrock', id: FABLE, name: 'Claude Fable 5.1 (US)' }], defaultId: FABLE })
  );
  return { releaseReports: () => release(), reportRequests: () => reportRequests };
}

const panel = (page: Page) => page.locator('[data-testid="comparison-deep-dive"]');
const url = `/compare/${BM}?runs=${RUN_A},${RUN_B}`;

test.describe('Comparison deep-dive — exactly two runs, report ids from the run docs', () => {
  test('reports still downloading: the section is visible at once (no job yet), then generates from the run docs\' report ids', async ({ page }) => {
    const { releaseReports, reportRequests } = await setupRoutes(page, {
      projection: { [RUN_A]: {}, [RUN_B]: {} },
      reports: 'hold',
    });
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: (body) => ({ markdown: `narrative for ${body.reportIds.join('+')}`, modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] }),
      onPost: (body) => bodies.push(body),
    });

    await page.goto(url);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="deep-dive-heading"]')).toHaveText("What's actually different");
    await expect(page.locator('[data-testid="deep-dive-reports-loading"]')).toBeVisible();
    // The reports request IS in flight (held by the mock) and nothing has been generated.
    await expect.poll(reportRequests).toBeGreaterThan(0);
    expect(bodies).toHaveLength(0);

    releaseReports();
    await expect(page.locator('[data-testid="deep-dive-reports-loading"]')).toHaveCount(0, { timeout: 30000 });
    await expect(panel(page)).toContainText(`narrative for ${REP[RUN_A]['tc-dd2-1']}+${REP[RUN_B]['tc-dd2-1']}`, { timeout: 30000 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reportIds).toEqual([REP[RUN_A]['tc-dd2-1'], REP[RUN_B]['tc-dd2-1']]);
    // The per-row summary sent along was built from LOADED reports (verdicts present).
    expect(bodies[0].rows.map((r: any) => [r.a?.passFailStatus, r.b?.passFailStatus])).toEqual([['failed', 'passed'], ['failed', 'passed']]);
  });

  test('reports fetch fails: the section still renders, does not auto-start, and "Generate anyway" posts the run docs\' report ids', async ({ page }) => {
    await setupRoutes(page, {
      projection: { [RUN_A]: {}, [RUN_B]: {} },
      reports: 'fail',
    });
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: { markdown: 'generated without client-side reports', modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] },
      onPost: (body) => bodies.push(body),
    });

    await page.goto(url);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="deep-dive-reports-failed"]')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Failed to load test case reports/)).toBeVisible();
    expect(bodies).toHaveLength(0);

    await page.locator('[data-testid="deep-dive-generate-anyway"]').click();
    await expect(panel(page)).toContainText('generated without client-side reports', { timeout: 30000 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reportIds).toEqual([REP[RUN_A]['tc-dd2-1'], REP[RUN_B]['tc-dd2-1']]);
  });

  test('no test case completed on both sides: an explicit message instead of a vanished section', async ({ page }) => {
    await setupRoutes(page, {
      projection: { [RUN_A]: { cases: ['tc-dd2-1'] }, [RUN_B]: { cases: ['tc-dd2-2'] } },
    });
    const bodies: any[] = [];
    await mockDeepDiveJob(page, { result: { markdown: 'never', modelId: 'x', durationMs: 1, runs: [] }, onPost: (body) => bodies.push(body) });

    await page.goto(url);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="deep-dive-no-shared-case"]'))
      .toHaveText('The deep-dive needs at least one test case that both runs completed — none found.');
    await page.waitForTimeout(1500);
    expect(bodies).toHaveLength(0);
  });
});
