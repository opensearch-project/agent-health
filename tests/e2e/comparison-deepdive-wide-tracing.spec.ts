/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison-WIDE tracing (round 3 revision): the deep-dive agent is no
 * longer limited to one pre-resolved "representative" case — it can pull
 * real spans/logs for ANY case in the results table via an optional `caseId`
 * on query_spans/query_logs, and span citations now carry that case:
 * `[label](span:<caseId>:<runId>:<spanId>)`.
 *
 * This spec asserts the CLIENT side of that contract against a mocked
 * backend (deterministic, no LLM/AWS creds):
 *   1. The POST /api/comparison/deep-dive body includes each row's per-side
 *      reportId (`rows[].a.reportId` / `rows[].b.reportId`) — the wide-tracing
 *      lookup table the server needs to resolve ANY case on demand.
 *   2. A 3-part span citation for a case OTHER than the default/representative
 *      one still deep-links correctly: clicking it expands THAT case's row
 *      (not the default row) and selects the cited span within it.
 *   3. The old back-compat 2-part `span:<runId>:<spanId>` citation format
 *      (pre-existing spec: comparison-span-deeplink.spec.ts) still works
 *      unmodified — this spec focuses on the NEW 3-part contract only.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-wideA';
const RUN_B = 'eval-run-wideB';
const TC1 = 'tc-wide-1'; // becomes the default/representative case (first shared row)
const TC2 = 'tc-wide-2'; // the case the citation actually points at
const RUNID_A1 = 'subprocess-wideA1';
const RUNID_B1 = 'subprocess-wideB1';
const RUNID_A2 = 'subprocess-wideA2';
const RUNID_B2 = 'subprocess-wideB2';
const CITED_SPAN = 'span-on-tc2-side-b';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const evalRun = (id: string, agent: string, results: Record<string, { reportId: string }>) => ({
  id,
  docType: 'evaluation-run',
  name: `Wide Run ${agent}`,
  createdAt: '2026-03-15T10:00:00Z',
  status: 'completed',
  agentKey: agent,
  modelId: 'claude-opus-4-8',
  sources: [{ type: 'test-case-ids', ids: [TC1, TC2] }],
  trigger: 'cli',
  testCaseSnapshots: [
    { id: TC1, version: 1, name: 'Wide Case One' },
    { id: TC2, version: 1, name: 'Wide Case Two' },
  ],
  results: Object.fromEntries(
    Object.entries(results).map(([tc, r]) => [tc, { reportId: r.reportId, status: 'completed', passFailStatus: 'passed' }])
  ),
  stats: { passed: 2, failed: 0, total: 2 },
});

const report = (id: string, agent: string, testCaseId: string, runId: string) => ({
  id,
  createdAt: '2026-03-15T10:00:00Z',
  testCaseId,
  agentId: agent,
  runId,
  modelId: 'claude-opus-4-8',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 100 },
  trajectory: [],
});

const span = (spanId: string) => ({
  traceId: 'trace-wide-b2',
  spanId,
  name: 'execute_tool bash',
  startTime: '2026-03-15T10:00:01.000Z',
  endTime: '2026-03-15T10:00:01.500Z',
  durationMs: 500,
  serviceName: 'pulsar-agent',
  kind: 'SPAN_KIND_SERVER',
  attributes: { 'service.name': 'pulsar-agent' },
  status: 'OK',
});

// The 3-part citation names TC2's side-B report/run — a case OTHER than the
// default/representative pair (TC1, the first row both sides share).
const deepDiveBody = {
  markdown: `**A wins on Wide Case One, B is faster on Wide Case Two** — across the table, A and B disagree on approach. On Wide Case Two, B [used a shell tool](span:${TC2}:${RUNID_B2}:${CITED_SPAN}) that A never invoked.`,
  modelId: 'amazon-bedrock/claude-opus-4-8',
  durationMs: 4000,
  runs: [
    { key: 'B', caseId: TC2, reportId: 'rep-b2', runId: RUNID_B2, serviceName: 'pulsar-agent', startedAt: 1, endedAt: 2 },
  ],
};

async function setupRoutes(page: import('@playwright/test').Page, capturedBodies: any[]) {
  await page.route('**/api/storage/benchmarks**', (r) => json(r, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (r) => json(r, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (r) => {
    const u = r.request().url();
    const m = u.match(/evaluation-runs\/([^/?]+)/);
    const id = m && m[1] !== 'evaluation-runs' ? decodeURIComponent(m[1]) : null;
    const runA = evalRun(RUN_A, 'demo', { [TC1]: { reportId: 'rep-a1' }, [TC2]: { reportId: 'rep-a2' } });
    const runB = evalRun(RUN_B, 'pulsar', { [TC1]: { reportId: 'rep-b1' }, [TC2]: { reportId: 'rep-b2' } });
    if (!id) return json(r, { evaluationRuns: [runA, runB], total: 2 });
    if (id === RUN_A) return json(r, runA);
    if (id === RUN_B) return json(r, runB);
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const reportsById: Record<string, unknown> = {
    'rep-a1': report('rep-a1', 'demo', TC1, RUNID_A1),
    'rep-b1': report('rep-b1', 'pulsar', TC1, RUNID_B1),
    'rep-a2': report('rep-a2', 'demo', TC2, RUNID_A2),
    'rep-b2': report('rep-b2', 'pulsar', TC2, RUNID_B2),
  };
  await page.route(/\/api\/storage\/runs\?ids=/, (r) => {
    const ids = (new URL(r.request().url()).searchParams.get('ids') || '').split(',');
    const runs = ids.map((id) => reportsById[id]).filter(Boolean);
    return json(r, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (r) => {
    const u = r.request().url();
    for (const [id, rep] of Object.entries(reportsById)) {
      if (u.includes(id)) return json(r, rep);
    }
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch**', (r) => json(r, { metrics: [] }));
  await mockDeepDiveJob(page, {
    result: deepDiveBody,
    onPost: (body) => capturedBodies.push(body),
  });
  await page.route('**/api/traces', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const spans = (body.runIds || []).includes(RUNID_B2) ? [span(CITED_SPAN)] : [];
    return json(r, { backend: 'opensearch', spans, total: spans.length });
  });
}

test.describe('Comparison deep-dive — comparison-wide tracing (any case, not one representative case)', () => {
  test('POSTs each row\'s per-side reportId so the server can resolve ANY case on demand', async ({ page }) => {
    const capturedBodies: any[] = [];
    await setupRoutes(page, capturedBodies);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-deep-dive"]', { timeout: 30000 });
    await expect.poll(() => capturedBodies.length).toBeGreaterThan(0);

    const body = capturedBodies[0];
    expect(Array.isArray(body.rows)).toBe(true);
    const rowTc1 = body.rows.find((r: any) => r.testCaseId === TC1);
    const rowTc2 = body.rows.find((r: any) => r.testCaseId === TC2);
    expect(rowTc1.a.reportId).toBe('rep-a1');
    expect(rowTc1.b.reportId).toBe('rep-b1');
    expect(rowTc2.a.reportId).toBe('rep-a2');
    expect(rowTc2.b.reportId).toBe('rep-b2');
  });

  test('a 3-part span:<caseId>:<runId>:<spanId> citation deep-links to a case OTHER than the default/representative one', async ({ page }) => {
    const capturedBodies: any[] = [];
    await setupRoutes(page, capturedBodies);

    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-page"]', { timeout: 30000 });

    // The citation is for TC2 (not TC1, the default/representative case).
    const citation = page.locator(`button[data-span-id="${CITED_SPAN}"]`);
    await expect(citation).toBeVisible({ timeout: 20000 });
    await expect(citation).toHaveAttribute('data-run-id', RUNID_B2);
    await expect(citation).toHaveAttribute('data-case-id', TC2);

    await citation.click();

    // Clicking it must expand/select within TC2's row (not TC1's), and open
    // the cited span's detail — proving the panel can deep-link into a case
    // it never treated as the "default" one.
    await expect(page.locator(`[data-selected-span-id="${CITED_SPAN}"]`)).toBeVisible({ timeout: 20000 });
  });
});
