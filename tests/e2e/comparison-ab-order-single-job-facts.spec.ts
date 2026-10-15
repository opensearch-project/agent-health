/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for three defects seen on the live compare page with two runs
 * of the same agent on the same benchmark (PR #567 follow-up):
 *
 *  1. A/B ORDER REVERSED vs the URL — `?runs=<baseline>,<candidate>` rendered
 *     A = candidate, B = baseline (the page filtered the newest-first run pool
 *     by the selection instead of mapping the selection onto the pool), and
 *     "Swap A/B" changed the URL but not the page. Now the URL order is
 *     authoritative on the scoreboard, the deep-dive header and the job's
 *     report order; Swap flips both the URL and the page.
 *
 *  2. DOUBLE DEEP-DIVE JOB — two `POST /api/comparison/deep-dive` ~70 ms
 *     apart per visit (the table re-sorted when the test-case metadata landed
 *     after the reports, moving the representative case and the cache key).
 *     Now the auto-start waits for the metadata too, the representative case
 *     is the lowest id (stable), and exactly ONE POST goes out.
 *
 *  3. HEADLINE NUMBERS from the LLM disagreed with the scoreboard. The page
 *     now computes the tallies from the scoreboard's data, sends them with
 *     the job and renders them as a data line above the narrative.
 *
 * Deterministic: storage, the models endpoint and the deep-dive job are all
 * mocked via page.route() — no LLM/AWS creds, no cluster writes.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Page, Route } from '@playwright/test';

const BM = 'bench-ab3';
const OLD = 'eval-run-ab3-baseline';
const NEW = 'eval-run-ab3-candidate';
const AGENT: Record<string, string> = { [OLD]: 'agent-baseline-ab3', [NEW]: 'agent-candidate-ab3' };
const CASES = ['tc-ab3-1', 'tc-ab3-2', 'tc-ab3-3', 'tc-ab3-4'];
// Real names carry a "[category]" tag and sort DIFFERENTLY from the ids, so the
// table re-sorts when the metadata lands (the double-job trigger).
const NAMES: Record<string, string> = {
  'tc-ab3-1': 'q4 [search] zulu case',
  'tc-ab3-2': 'q3 [rca] yankee case',
  'tc-ab3-3': 'q2 [search] xray case',
  'tc-ab3-4': 'q1 [rca] whiskey case',
};
// Verdicts: tc-1 A wins · tc-2 B wins · tc-3 both pass · tc-4 B errored (no verdict).
type Verdict = 'passed' | 'failed' | 'errored';
const VERDICT: Record<string, Record<string, Verdict>> = {
  [OLD]: { 'tc-ab3-1': 'passed', 'tc-ab3-2': 'failed', 'tc-ab3-3': 'passed', 'tc-ab3-4': 'passed' },
  [NEW]: { 'tc-ab3-1': 'failed', 'tc-ab3-2': 'passed', 'tc-ab3-3': 'passed', 'tc-ab3-4': 'errored' },
};
const rep = (runId: string, tc: string) => `rep-${runId}-${tc}`;
const FABLE = 'us.anthropic.claude-fable-5-1';

const runDoc = (runId: string) => ({
  id: runId,
  docType: 'evaluation-run',
  name: runId === OLD ? 'Baseline' : 'Candidate',
  createdAt: runId === OLD ? '2026-10-01T10:00:00Z' : '2026-10-02T10:00:00Z',
  completedAt: '2026-10-02T11:00:00Z',
  status: 'completed',
  agentKey: AGENT[runId],
  modelId: 'claude-sonnet-4-20250514',
  benchmarkId: BM,
  sources: [{ type: 'benchmark', benchmarkId: BM }],
  trigger: 'ui',
  testCaseSnapshots: CASES.map((id) => ({ id, version: 1, name: id })),
  results: Object.fromEntries(CASES.map((tc) => {
    const v = VERDICT[runId][tc];
    return [tc, { reportId: rep(runId, tc), status: 'completed', ...(v === 'errored' ? {} : { passFailStatus: v }) }];
  })),
  stats: { passed: 0, failed: 0, total: CASES.length },
});

const report = (runId: string, tc: string) => {
  const v = VERDICT[runId][tc];
  return {
    id: rep(runId, tc),
    createdAt: '2026-10-02T10:30:00Z',
    testCaseId: tc,
    agentId: AGENT[runId],
    modelId: 'claude-sonnet-4-20250514',
    status: 'completed',
    ...(v === 'errored' ? { metricsStatus: 'error', metrics: {} } : { passFailStatus: v, metricsStatus: 'completed', metrics: { accuracy: v === 'passed' ? 90 : 40 } }),
    performanceMetrics: { durationMs: 30000 },
    experimentRunId: runId,
    trajectory: [],
  };
};

const testCaseDoc = (tc: string) => ({
  id: tc, name: NAMES[tc], description: '', initialPrompt: 'q', expectedOutcomes: ['x'], labels: [], version: 1,
  createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z',
});

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function setupRoutes(page: Page, opts: { holdTestCases?: boolean } = {}): Promise<{ releaseTestCases: () => void; testCaseRequests: () => number; reportRequests: () => number }> {
  // Pool order is NEWEST FIRST — the order the page used to label A/B by.
  const benchmark = {
    id: BM, name: 'A/B order benchmark', description: '', testCaseIds: CASES, currentVersion: 1, versions: [],
    createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-10-02T11:00:00Z',
    runs: [runDoc(NEW), runDoc(OLD)],
  };
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let testCaseRequests = 0;
  let reportRequests = 0;

  await page.route('**/api/storage/benchmarks**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/benchmarks/${BM}`)) return json(route, { benchmark });
    return json(route, { benchmarks: [benchmark], total: 1 });
  });
  await page.route('**/api/storage/test-cases**', async (route) => {
    testCaseRequests += 1;
    if (opts.holdTestCases) await held;
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',').filter(Boolean);
    const testCases = ids.filter((id) => CASES.includes(id)).map(testCaseDoc);
    return json(route, { testCases, total: testCases.length });
  });
  await page.route('**/api/storage/evaluation-runs**', (route) => {
    const url = new URL(route.request().url());
    for (const id of [OLD, NEW]) if (url.pathname.endsWith(`/evaluation-runs/${id}`)) return json(route, runDoc(id));
    if (url.pathname.endsWith('/evaluation-runs')) return json(route, { evaluationRuns: [], total: 0 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
    reportRequests += 1;
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
    const runs: unknown[] = [];
    for (const runId of [OLD, NEW]) for (const tc of CASES) if (ids.includes(rep(runId, tc))) runs.push(report(runId, tc));
    return json(route, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
  await page.route('**/api/traces**', (route) => json(route, { backend: 'opensearch', spans: [], total: 0 }));
  await page.route('**/api/comparison/deep-dive/system-prompt', (route) => json(route, { systemPrompt: 'DEFAULT PROMPT' }));
  await page.route('**/api/comparison/deep-dive/models', (route) =>
    json(route, { models: [{ provider: 'amazon-bedrock', id: FABLE, name: 'Claude Fable 5.1 (US)' }], defaultId: FABLE })
  );
  return { releaseTestCases: () => release(), testCaseRequests: () => testCaseRequests, reportRequests: () => reportRequests };
}

const panel = (page: Page) => page.locator('[data-testid="comparison-deep-dive"]');
const rowA = (page: Page) => page.locator('[data-testid="scoreboard-row-A"]');
const rowB = (page: Page) => page.locator('[data-testid="scoreboard-row-B"]');
const url = (first: string, second: string) => `/compare/${BM}?runs=${first},${second}`;

test.describe('Compare page — URL order is A/B, one deep-dive job per visit, data-derived headline numbers', () => {
  test('`?runs=X,Y` → A = X, B = Y on the scoreboard, the deep-dive header and the job; Swap flips the URL AND the page', async ({ page }) => {
    await setupRoutes(page);
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: { markdown: 'narrative', modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] },
      onPost: (body) => bodies.push(body),
    });

    // The pool lists NEW first; the URL lists OLD first. The URL wins.
    await page.goto(url(OLD, NEW));
    await expect(page.locator('[data-testid="comparison-page"]')).toBeVisible({ timeout: 30000 });
    await expect(rowA(page).locator(`[data-testid="run-name-link-${OLD}"]`)).toBeVisible();
    await expect(rowB(page).locator(`[data-testid="run-name-link-${NEW}"]`)).toBeVisible();
    await expect(rowA(page).locator(`[data-testid="run-name-link-${NEW}"]`)).toHaveCount(0);

    // Deep-dive header: A = baseline agent, B = candidate agent (same order).
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText(new RegExp(`A\\s*${AGENT[OLD]}\\s*vs\\s*B\\s*${AGENT[NEW]}`));
    // The job is briefed in the same order: reportIds[0] is A's report.
    await expect.poll(() => bodies.length, { timeout: 30000 }).toBe(1);
    expect(bodies[0].reportIds).toEqual([rep(OLD, 'tc-ab3-1'), rep(NEW, 'tc-ab3-1')]);
    expect(bodies[0].rows.map((r: any) => [r.a.passFailStatus, r.b.passFailStatus])).toContainEqual(['passed', 'failed']);

    // Swap A/B — every A/B surface flips AND the order is written to the URL
    // (even though both of the benchmark's runs are selected), so a reload
    // reproduces it.
    await page.locator('button[title="Swap A/B"]').click();
    await expect(rowA(page).locator(`[data-testid="run-name-link-${NEW}"]`)).toBeVisible();
    await expect(rowB(page).locator(`[data-testid="run-name-link-${OLD}"]`)).toBeVisible();
    await expect(panel(page)).toContainText(new RegExp(`A\\s*${AGENT[NEW]}\\s*vs\\s*B\\s*${AGENT[OLD]}`));
    await expect(page).toHaveURL(new RegExp(`runs=${NEW}(,|%2C)${OLD}`));
    await page.reload();
    await expect(rowA(page).locator(`[data-testid="run-name-link-${NEW}"]`)).toBeVisible({ timeout: 30000 });
    await expect(rowB(page).locator(`[data-testid="run-name-link-${OLD}"]`)).toBeVisible();

    // Swap back — the URL follows again.
    await page.locator('button[title="Swap A/B"]').click();
    await expect(page).toHaveURL(new RegExp(`runs=${OLD}(,|%2C)${NEW}`));
    await expect(rowA(page).locator(`[data-testid="run-name-link-${OLD}"]`)).toBeVisible();
    await expect(rowB(page).locator(`[data-testid="run-name-link-${NEW}"]`)).toBeVisible();
    await page.reload();
    await expect(rowA(page).locator(`[data-testid="run-name-link-${OLD}"]`)).toBeVisible({ timeout: 30000 });
    await expect(panel(page)).toContainText(new RegExp(`A\\s*${AGENT[OLD]}\\s*vs\\s*B\\s*${AGENT[NEW]}`));

    // And the reverse URL renders the reverse order from the start.
    await page.goto(url(NEW, OLD));
    await expect(rowA(page).locator(`[data-testid="run-name-link-${NEW}"]`)).toBeVisible({ timeout: 30000 });
    await expect(rowB(page).locator(`[data-testid="run-name-link-${OLD}"]`)).toBeVisible();
  });

  test('test-case metadata landing after the reports: exactly ONE deep-dive POST, briefed with the real row names', async ({ page }) => {
    const { releaseTestCases, testCaseRequests, reportRequests } = await setupRoutes(page, { holdTestCases: true });
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: { markdown: 'narrative', modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] },
      onPost: (body) => bodies.push(body),
    });

    await page.goto(url(OLD, NEW));
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    // Reports are in (the scoreboard has real pass rates) but the metadata is
    // still held: the panel waits, no job yet.
    await expect.poll(reportRequests).toBeGreaterThan(0);
    await expect.poll(testCaseRequests).toBeGreaterThan(0);
    await expect(rowA(page).locator(`[data-testid="run-passrate-detail-${OLD}"]`)).toHaveText('3 / 4', { timeout: 30000 });
    await expect(page.locator('[data-testid="deep-dive-reports-loading"]')).toBeVisible();
    expect(bodies).toHaveLength(0);

    releaseTestCases();
    await expect(panel(page)).toContainText('narrative', { timeout: 30000 });
    // Give any stray second POST (the ~70 ms re-key) ample time to show up.
    await page.waitForTimeout(1500);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reportIds).toEqual([rep(OLD, 'tc-ab3-1'), rep(NEW, 'tc-ab3-1')]);
    // Briefed with the real names (the metadata), not the ids.
    const names = bodies[0].rows.map((r: any) => r.testCaseName).sort();
    expect(names).toEqual(Object.values(NAMES).sort());
  });

  test('the data line above the narrative shows the scoreboard\'s numbers, and the job carries the same facts', async ({ page }) => {
    await setupRoutes(page);
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: { markdown: 'A: 31 vs B: 26 passes (the model recounting — whatever it says, the line above is what the reader trusts)', modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] },
      onPost: (body) => bodies.push(body),
    });

    await page.goto(url(OLD, NEW));
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    // Scoreboard: A 3/4, B 2/3 with 1 errored (the same numbers the line must show).
    await expect(rowA(page).locator(`[data-testid="run-passrate-detail-${OLD}"]`)).toHaveText('3 / 4', { timeout: 30000 });
    await expect(rowB(page).locator(`[data-testid="run-passrate-detail-${NEW}"]`)).toHaveText('2 / 3 (errored 1)');

    const line = page.locator('[data-testid="deep-dive-facts"]');
    await expect(line).toHaveText('A 3/4 · B 2/3 (1 errored) · 2 disagreements: A wins 1, B wins 1', { timeout: 30000 });
    await expect(panel(page)).toContainText('the model recounting', { timeout: 30000 });
    // The line sits above the narrative.
    const factsBox = await line.boundingBox();
    const mdBox = await panel(page).locator('.prose').boundingBox();
    expect(factsBox!.y).toBeLessThan(mdBox!.y);

    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].facts).toMatchObject({
      a: { passed: 3, failed: 1, errored: 0, evaluated: 4, total: 4 },
      b: { passed: 2, failed: 1, errored: 1, evaluated: 3, total: 4 },
      disagreements: 2, aWins: 1, bWins: 1, bothPassed: 1, bothFailed: 0, uncovered: 1,
    });
    // Per-category slices (from the "[category]" name tags): rca and search.
    expect(bodies[0].facts.categories.map((c: any) => c.category).sort()).toEqual(['rca', 'search']);
    const rca = bodies[0].facts.categories.find((c: any) => c.category === 'rca');
    // rca = tc-2 (B wins) + tc-4 (B errored): A passed 1 (tc-4), B passed 1 (tc-2).
    expect(rca).toMatchObject({ cases: 2, aPassed: 1, bPassed: 1, aWins: 0, bWins: 1 });
  });
});
