/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "Not evaluable" is not "failed" — the retry-judgement dialog
 * PRE-FLIGHTS a deterministic evaluator against the run (real server, real
 * extractor, nothing written) and refuses to start a retry that would score
 * nothing:
 *   - evaluator whose gold pattern matches none of the cases → "0 of N cases
 *     evaluable by this evaluator", the grouped reason ("N × no gold ids on
 *     the test case …"), per-case diagnostics naming the gold source and every
 *     candidate source tried, an amber hint, and Confirm DISABLED;
 *   - the same run with a fitting evaluator → "2 of 2 cases evaluable"
 *     (one an abstain case), Confirm enabled.
 * Also checks the run report's Judge tab renders the diagnostics after a
 * real re-score (not-evaluable case → amber "Not evaluable" card).
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';
import { uniqueTestName } from '../helpers/testDataTracker';

const wrapped = (payload: unknown) => JSON.stringify([{ text: JSON.stringify(payload) }]);
const step = (id: string, type: string, extra: Record<string, unknown>) => ({ id, timestamp: 1, type, ...extra });

const evaluatorBody = (name: string, goldPattern: string) => ({
  name, description: 'e2e deterministic evaluator', kind: 'deterministic',
  metrics: [
    { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.5, primary: true },
    { name: 'hit@5', compute: { type: 'ranked-hit', k: 5 }, weight: 0.5, primary: true },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }] },
  inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: goldPattern }, prediction: { source: 'tool-hits-ordered' } },
});

interface Seeded { runFitting: string; runUnfitting: string; reportGold: string; reportNoGold: string }

async function seed(request: APIRequestContext, testData: TestDataTracker): Promise<Seeded | null> {
  const post = async (path: string, data: unknown) => {
    const r = await request.post(path, { data });
    return r.ok() ? r.json() : null;
  };
  const fitting = await post('/api/storage/evaluators', evaluatorBody(uniqueTestName('e2e-det-fitting'), '^Gold product id\\(s\\):\\s*(.+)$'));
  const unfitting = await post('/api/storage/evaluators', evaluatorBody(uniqueTestName('e2e-det-unfitting'), '^Reference sku\\(s\\):\\s*(.+)$'));
  if (!fitting || !unfitting) return null;
  testData.evaluator(fitting.id);
  testData.evaluator(unfitting.id);

  const mkCase = async (expectedOutcomes: string[]) => {
    const tc = await post('/api/storage/test-cases', { name: uniqueTestName('e2e-det-preflight-tc'), category: 'Test', difficulty: 'Easy', initialPrompt: 'search products', expectedOutcomes });
    if (!tc) return null;
    const id = tc.id || tc.testCase?.id;
    testData.testCase(id);
    return id as string;
  };
  const tcGold = await mkCase(['Gold product id(s): 290226, 116770 (First Gel Wrap; Second Gel Wrap)']);
  const tcNone = await mkCase(['NONE — the anchor has no related edges; the answer recommends ZERO products.']);
  if (!tcGold || !tcNone) return null;

  const mkReport = async (testCaseId: string, trajectory: unknown[], rawEvents?: unknown[]) => {
    const rep = await post('/api/storage/runs', {
      id: `report-e2e-det-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timestamp: new Date().toISOString(), testCaseId,
      agentName: 'Retrieval Agent', agentKey: 'retrieval-agent', modelName: 'demo-model', modelId: 'demo-model',
      // Left "not evaluable" by an earlier mis-scoring — the shape the owner hit; it is also what
      // enables the kebab's Retry judgement item on this branch (judge-failed cases > 0).
      status: 'completed', metricsStatus: 'error', passFailStatus: null, trajectory, ...(rawEvents ? { rawEvents } : {}),
      traceError: 'Judge evaluation failed (kind=judge_failed): earlier judge 400', metrics: {}, llmJudgeReasoning: '**Evaluator could not run.**',
    });
    if (!rep) return null;
    testData.run(rep.id);
    return rep.id as string;
  };
  const reportGold = await mkReport(tcGold, [
    step('r1', 'tool_result', { toolName: 'search', content: wrapped({ hits: [{ id: '44793' }] }) }),
    step('r2', 'tool_result', { toolName: 'return_results', content: wrapped({ records: [{ id: '290226' }, { id: '706155' }, { id: '116770' }] }) }),
    step('resp', 'response', { content: 'Ranked results (3):\n1. id 290226 — first\n2. id 706155 — other\n3. id 116770 — second' }),
  ]);
  const reportNoGold = await mkReport(tcNone, [
    step('r1', 'tool_result', { toolName: 'search', content: wrapped({ hits: [{ id: '956711' }] }) }),
    step('resp', 'response', { content: 'No results committed (results_source=abstain).' }),
  ], [{ answer: null, results: [], results_source: 'abstain' }]);
  if (!reportGold || !reportNoGold) return null;

  // Two runs over the same reports: one judged with the fitting evaluator (both
  // cases), one with the evaluator whose gold pattern matches nothing (the gold
  // case only — a NONE case is an abstain case for ANY pattern evaluator).
  const mkRun = async (label: string, evaluatorId: string, cases: Array<[string, string]>) => {
    const runId = `eval-run-e2e-det-preflight-${label}-${Date.now()}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: uniqueTestName(`E2E preflight run ${label}`), status: 'completed', agentKey: 'retrieval-agent', modelId: 'demo-model',
        judgeModelId: 'no-such-judge-provider/never-called', evaluatorId,
        sources: [{ type: 'test-case-ids', ids: cases.map(c => c[0]) }], trigger: 'api',
        testCaseSnapshots: cases.map(([id]) => ({ id, version: 1, name: id })),
        results: Object.fromEntries(cases.map(([tc, reportId]) => [tc, { reportId, status: 'completed' }])),
        createdAt: new Date().toISOString(),
      },
    });
    if (!runRes.ok()) return null;
    testData.evaluationRun(runId);
    return runId;
  };
  const runFitting = await mkRun('fitting', fitting.id, [[tcGold, reportGold], [tcNone, reportNoGold]]);
  const runUnfitting = await mkRun('unfitting', unfitting.id, [[tcGold, reportGold]]);
  if (!runFitting || !runUnfitting) return null;
  return { runFitting, runUnfitting, reportGold, reportNoGold };
}

async function openRetryDialog(page: import('@playwright/test').Page, runId: string) {
  await page.goto(`/evaluations/runs/${runId}/inspect`);
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
  await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
  await page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`).click();
  await expect(page.locator('[data-testid="retry-judgement-dialog"]')).toBeVisible({ timeout: 10000 });
}

test.describe('Retry judgement — deterministic pre-flight ("not evaluable" is not "failed")', () => {
  test('an evaluator that fits nothing: 0 of N evaluable, reasons + per-case diagnostics, Confirm disabled', async ({ page, request, testData }) => {
    const seeded = await seed(request, testData);
    test.skip(!seeded, 'Could not seed (storage not configured?)');
    const { runUnfitting: runId } = seeded!;

    await openRetryDialog(page, runId);
    const pre = page.locator('[data-testid="retry-judgement-preflight"]');
    await expect(pre).toBeVisible({ timeout: 15000 });
    await expect(pre).toHaveAttribute('data-evaluable', '0');
    await expect(page.locator('[data-testid="retry-judgement-preflight-summary"]')).toHaveText('0 of 1 case evaluable by this evaluator');
    const reasons = page.locator('[data-testid="retry-judgement-preflight-reasons"]');
    await expect(reasons).toContainText('1 ×');
    await expect(reasons).toContainText('no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)');
    await expect(pre).toContainText("This evaluator's gold/extraction rules don't match these cases — pick another evaluator or add gold ids.");
    // Amber, not red.
    await expect(pre).toHaveClass(/amber/);

    // Per-case diagnostics: gold source and every candidate source tried.
    await page.locator('[data-testid="retry-judgement-preflight-cases"] summary').click();
    const cases = page.locator('[data-testid^="retry-judgement-preflight-cases-tc-"]');
    await expect(cases.first()).toBeVisible();
    await expect(page.locator('[data-testid="retry-judgement-preflight-cases"]')).toContainText('Gold: gold not declared');
    await expect(page.locator('[data-testid="retry-judgement-preflight-cases"]')).toContainText("from tool 'return_results' records");
    await expect(page.locator('[data-testid="retry-judgement-preflight-cases"]')).toContainText("from tool 'search' hits (hits / results)");
    await expect(page.locator('[data-testid="retry-judgement-preflight-cases"]')).toContainText('Tools scanned:');

    const confirm = page.locator('[data-testid="retry-judgement-confirm-btn"]');
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', 'This evaluator cannot score any case of this run');
    // Deterministic wording.
    await expect(page.locator('[data-testid="retry-judgement-dialog"]')).toContainText('Cases to re-judge:');
    // #509's picker: a deterministic evaluator locks the scope to "All cases" and marks the judge model unused.
    await expect(page.locator('[data-testid="retry-judgement-scope-all"]')).toBeChecked();
    await expect(page.locator('[data-testid="retry-judgement-scope-errored"]')).toBeDisabled();
    await expect(page.locator('[data-testid="retry-judgement-scope-forced"]')).toBeVisible();
    await expect(page.locator('[data-testid="retry-judgement-no-judge-model"]')).toBeVisible();
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('1');
  });

  test('the fitting evaluator: both cases evaluable (one abstain), Confirm enabled; after the real re-score the Judge tab shows the provenance', async ({ page, request, testData }) => {
    const seeded = await seed(request, testData);
    test.skip(!seeded, 'Could not seed (storage not configured?)');
    const { runFitting: runId, reportGold, reportNoGold } = seeded!;

    await openRetryDialog(page, runId);
    const pre = page.locator('[data-testid="retry-judgement-preflight"]');
    await expect(pre).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="retry-judgement-preflight-summary"]')).toHaveText('2 of 2 cases evaluable by this evaluator');
    await expect(page.locator('[data-testid="retry-judgement-preflight-abstain"]')).toContainText('1 abstain case');
    await expect(page.locator('[data-testid="retry-judgement-preflight-reasons"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="retry-judgement-confirm-btn"]')).toBeEnabled();

    // Real re-score (deterministic → scope all), through the dialog.
    await page.locator('[data-testid="retry-judgement-confirm-btn"]').click();
    const summaryLine = page.locator('[data-testid="retry-judgement-summary-line"]');
    await expect(summaryLine).toHaveText('Retried 2 · 2 scored (1 abstain)', { timeout: 30000 });
    await expect(page.locator('[data-testid="retry-judgement-dialog"]')).not.toContainText('still failed');
    await page.locator('[data-testid="retry-judgement-done-btn"]').click();

    // Gold parsed without the parenthesised names; candidates from the RETURNED list.
    const gold = await (await request.get(`/api/storage/runs/${reportGold}`)).json();
    expect(gold.passFailStatus).toBe('passed');
    expect(gold.scoringSnapshot.goldIdsUsed).toEqual(['290226', '116770']);
    expect(gold.scoringSnapshot.extraction.sourceUsed).toBe('response-results');
    const none = await (await request.get(`/api/storage/runs/${reportNoGold}`)).json();
    expect(none).toMatchObject({ passFailStatus: 'passed', metrics: { abstain: 1 } });

    // Judge tab renders the provenance block.
    await page.goto(`/runs/${reportGold}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    const prov = page.locator('[data-testid="judge-tab-scoring-diagnostics"]');
    await expect(prov).toBeVisible({ timeout: 15000 });
    await expect(prov.locator('[data-testid="scoring-diagnostics-gold"]')).toHaveText('gold 2 ids from expectedOutcomes[0]');
    await expect(prov).toContainText("3 from tool 'return_results' records");
    await expect(prov).toContainText('(used)');
    await expect(prov.locator('[data-testid="scoring-diagnostics-tools"]')).toHaveText('search, return_results');
  });
});
