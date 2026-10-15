/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E coverage for the deep-dive PAIR PICKER (owner report, 2026-10-14: on a
 * compare page with THREE runs of the same benchmark the trace-grounded
 * "What's actually different" section was missing — it only rendered for
 * exactly two runs, with no placeholder or explanation).
 *
 * Asserts on the REAL rendered compare page:
 *  - 3 runs → the section IS visible, with a Run A / Run B picker defaulting
 *    to oldest (A) / newest (B); the default pair auto-generates
 *  - changing B → the header names the new pair, the URL carries
 *    `deepDive=<idA>,<idB>`, and (non-default pair) nothing is generated
 *    until "Generate deep-dive" is clicked
 *  - reload keeps the pair; the previously generated narrative is served from
 *    cache (no new POST)
 *  - 2 runs → no picker, header unchanged
 *
 * Deterministic: storage, the models endpoint and the deep-dive job are all
 * mocked via page.route() — no LLM/AWS creds, no cluster writes.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Page, Route } from '@playwright/test';

const OLD = 'eval-run-pp-old';
const MID = 'eval-run-pp-mid';
const NEW = 'eval-run-pp-new';
const TC = 'tc-pp-shared';
const REP: Record<string, string> = { [OLD]: 'rep-pp-old', [MID]: 'rep-pp-mid', [NEW]: 'rep-pp-new' };
const NAME: Record<string, string> = { [OLD]: 'Baseline', [MID]: 'Candidate v1', [NEW]: 'Candidate v2' };
const CREATED: Record<string, string> = { [OLD]: '2026-10-01T10:00:00Z', [MID]: '2026-10-02T10:00:00Z', [NEW]: '2026-10-03T10:00:00Z' };
const FABLE = 'us.anthropic.claude-fable-5-1';

const evalRun = (id: string) => ({
  id,
  docType: 'evaluation-run',
  name: NAME[id],
  createdAt: CREATED[id],
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'PairPicker Shared Case' }],
  results: { [TC]: { reportId: REP[id], status: 'completed', passFailStatus: id === OLD ? 'failed' : 'passed' } },
  stats: { passed: id === OLD ? 0 : 1, failed: id === OLD ? 1 : 0, total: 1 },
});

const report = (runId: string) => ({
  id: REP[runId],
  createdAt: CREATED[runId],
  testCaseId: TC,
  agentId: 'demo',
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: runId === OLD ? 'failed' : 'passed',
  metrics: { accuracy: runId === OLD ? 40 : 90 },
  performanceMetrics: { durationMs: 30000 },
  trajectory: [],
});

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupRoutes(page: Page) {
  const ALL = [OLD, MID, NEW];
  await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
  await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
  await page.route('**/api/storage/evaluation-runs**', (route) => {
    const url = new URL(route.request().url());
    for (const id of ALL) if (url.pathname.endsWith(`/evaluation-runs/${id}`)) return json(route, evalRun(id));
    if (url.pathname.endsWith('/evaluation-runs')) return json(route, { evaluationRuns: ALL.map(evalRun), total: ALL.length });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
    const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
    const runs = ALL.filter((id) => ids.includes(REP[id])).map(report);
    return json(route, { runs, total: runs.length });
  });
  await page.route('**/api/storage/runs/**', (route) => {
    const url = route.request().url();
    for (const id of ALL) if (url.includes(REP[id])) return json(route, report(id));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/metrics/batch**', (route) => json(route, { metrics: [] }));
  await page.route('**/api/comparison/deep-dive/system-prompt', (route) => json(route, { systemPrompt: 'DEFAULT PROMPT' }));
  await page.route('**/api/comparison/deep-dive/models', (route) =>
    json(route, { models: [{ provider: 'amazon-bedrock', id: FABLE, name: 'Claude Fable 5.1 (US)' }], defaultId: FABLE })
  );
}

const panel = (page: Page) => page.locator('[data-testid="comparison-deep-dive"]');
const heading = (page: Page) => page.locator('[data-testid="deep-dive-heading"]');
const selectA = (page: Page) => page.locator('[data-testid="deep-dive-pair-select-a"]');
const selectB = (page: Page) => page.locator('[data-testid="deep-dive-pair-select-b"]');
const deepDiveParam = (page: Page) => new URL(page.url()).searchParams.get('deepDive');

test.describe('Comparison deep-dive — pair picker with 3+ runs', () => {
  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
  });

  test('3 runs: section visible with picker defaulting to oldest/newest; changing B updates the header + URL; reload keeps the pair', async ({ page }) => {
    const bodies: any[] = [];
    await mockDeepDiveJob(page, {
      result: (body) => ({ markdown: `narrative for ${body.reportIds.join('+')}`, modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] }),
      onPost: (body) => bodies.push(body),
    });

    // Selection order is deliberately NOT chronological: defaults must come
    // from createdAt, not from position.
    await page.goto(`/compare?runs=${MID},${NEW},${OLD}`);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });

    // Picker defaults: A = oldest (Baseline), B = newest (Candidate v2).
    await expect(selectA(page)).toHaveValue(OLD);
    await expect(selectB(page)).toHaveValue(NEW);
    await expect(heading(page)).toHaveText("What's actually different — Baseline vs Candidate v2");
    await expect(page.locator('[data-testid="deep-dive-pair-hint"]')).toHaveText('The trace-grounded deep-dive compares two runs at a time; pick the pair.');
    // Options carry name + date.
    await expect(selectA(page).locator('option')).toHaveText([/^Baseline · Oct 1, 2026/, /^Candidate v1 · Oct 2, 2026/, /^Candidate v2 · Oct 3, 2026/]);
    // No pair pinned in the URL yet (defaults are implicit).
    expect(deepDiveParam(page)).toBeNull();

    // The default pair auto-generates, exactly like the 2-run page.
    await expect(panel(page)).toContainText(`narrative for ${REP[OLD]}+${REP[NEW]}`, { timeout: 15000 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reportIds).toEqual([REP[OLD], REP[NEW]]);

    // Change B → header + URL update; the non-default pair does NOT
    // auto-generate (no surprise LLM cost) — it offers a Generate button.
    await selectB(page).selectOption(MID);
    await expect(heading(page)).toHaveText("What's actually different — Baseline vs Candidate v1");
    await expect.poll(() => deepDiveParam(page)).toBe(`${OLD},${MID}`);
    expect(new URL(page.url()).searchParams.get('runs')).toBe(`${MID},${NEW},${OLD}`); // the run selection is untouched
    await expect(page.locator('[data-testid="deep-dive-idle"]')).toBeVisible();
    await expect(panel(page)).not.toContainText('narrative for');
    expect(bodies).toHaveLength(1);

    await page.locator('[data-testid="deep-dive-generate"]').click();
    await expect(panel(page)).toContainText(`narrative for ${REP[OLD]}+${REP[MID]}`, { timeout: 15000 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].reportIds).toEqual([REP[OLD], REP[MID]]);

    // Switching back to the default pair is served from cache — no 3rd POST.
    await selectB(page).selectOption(NEW);
    await expect(heading(page)).toHaveText("What's actually different — Baseline vs Candidate v2");
    await expect(panel(page)).toContainText(`narrative for ${REP[OLD]}+${REP[NEW]}`);
    expect(bodies).toHaveLength(2);
    await expect.poll(() => deepDiveParam(page)).toBe(`${OLD},${NEW}`);

    // A ≠ B: picking A's run for B swaps the sides instead of collapsing the pair.
    await selectB(page).selectOption(OLD);
    await expect(selectA(page)).toHaveValue(NEW);
    await expect(selectB(page)).toHaveValue(OLD);
    await expect(heading(page)).toHaveText("What's actually different — Candidate v2 vs Baseline");
    await expect.poll(() => deepDiveParam(page)).toBe(`${NEW},${OLD}`);

    // Reload with the pinned pair → the same pair, same header; the narrative
    // generated earlier for (OLD, MID) is in localStorage, so pin that one
    // and confirm NO new POST is needed after reload.
    await page.goto(`/compare?runs=${MID},${NEW},${OLD}&deepDive=${OLD},${MID}`);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(selectA(page)).toHaveValue(OLD);
    await expect(selectB(page)).toHaveValue(MID);
    await expect(heading(page)).toHaveText("What's actually different — Baseline vs Candidate v1");
    await expect(panel(page)).toContainText(`narrative for ${REP[OLD]}+${REP[MID]}`, { timeout: 15000 });
    expect(bodies).toHaveLength(2);
  });

  test('an invalid deepDive param (unknown id / A = B) falls back to the oldest/newest default', async ({ page }) => {
    await mockDeepDiveJob(page, { result: { markdown: 'ok', modelId: `amazon-bedrock/${FABLE}`, durationMs: 1, runs: [] } });
    await page.goto(`/compare?runs=${OLD},${MID},${NEW}&deepDive=${OLD},does-not-exist`);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(selectA(page)).toHaveValue(OLD);
    await expect(selectB(page)).toHaveValue(NEW);

    await page.goto(`/compare?runs=${OLD},${MID},${NEW}&deepDive=${MID},${MID}`);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(selectA(page)).toHaveValue(OLD);
    await expect(selectB(page)).toHaveValue(NEW);
  });

  test('2 runs: no picker, header unchanged', async ({ page }) => {
    await mockDeepDiveJob(page, { result: { markdown: 'two-run narrative', modelId: `amazon-bedrock/${FABLE}`, durationMs: 1, runs: [] } });
    await page.goto(`/compare?runs=${OLD},${NEW}`);
    await expect(panel(page)).toBeVisible({ timeout: 30000 });
    await expect(heading(page)).toHaveText("What's actually different");
    await expect(page.locator('[data-testid="deep-dive-pair-picker"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="deep-dive-pair-hint"]')).toHaveCount(0);
    await expect(panel(page)).toContainText('two-run narrative', { timeout: 15000 });
  });
});
