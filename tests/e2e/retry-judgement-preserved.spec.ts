/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a retry judgement that produces NO judgement preserves the previous
 * judgement and surfaces WHY (owner: "the last judgement should be preserved,
 * with a dialog box somewhere showing why the last retry judgement failed").
 *
 *   1. run with two cases: A — judged PASSED by an LLM earlier, gold line in a
 *      format the run's deterministic evaluator does not read; B — errored
 *      (enables the kebab item). Retry with the run's evaluator → B scored,
 *      A not evaluable → A keeps its verdict; the Judge tab shows the amber
 *      "Last re-judgement failed …" banner; Details opens the dialog with the
 *      reason + diagnostics + "Retry again"; the header shows the "re-judge
 *      failed" pill.
 *   2. a SUCCESSFUL retry (an evaluator whose gold pattern reads both lines,
 *      via the API) replaces A's judgement and clears the record: banner and
 *      pill are gone after reload.
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';
import { uniqueTestName } from '../helpers/testDataTracker';

const wrapped = (payload: unknown) => JSON.stringify([{ text: JSON.stringify(payload) }]);
const step = (id: string, type: string, extra: Record<string, unknown>) => ({ id, timestamp: 1, type, content: '', ...extra });

const evaluatorBody = (name: string, goldPattern: string) => ({
  name, description: 'e2e deterministic evaluator', kind: 'deterministic',
  metrics: [{ name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true }],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
  inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: goldPattern }, prediction: { source: 'tool-hits-ordered' } },
});

async function seed(request: APIRequestContext, testData: TestDataTracker) {
  const post = async (path: string, data: unknown) => { const r = await request.post(path, { data }); return r.ok() ? r.json() : null; };
  const narrow = await post('/api/storage/evaluators', evaluatorBody(uniqueTestName('e2e-preserve-narrow'), '^Gold product id\\(s\\):\\s*(.+)$'));
  const wide = await post('/api/storage/evaluators', evaluatorBody(uniqueTestName('e2e-preserve-wide'), '^(?:Gold product id\\(s\\)|Reference sku\\(s\\)):\\s*(.+)$'));
  if (!narrow || !wide) return null;
  testData.evaluator(narrow.id); testData.evaluator(wide.id);

  const mkCase = async (expectedOutcomes: string[]) => {
    const tc = await post('/api/storage/test-cases', { name: uniqueTestName('e2e-preserve-tc'), category: 'Test', difficulty: 'Easy', initialPrompt: 'search products', expectedOutcomes });
    if (!tc) return null;
    const id = tc.id || tc.testCase?.id; testData.testCase(id); return id as string;
  };
  const tcA = await mkCase(['Reference sku(s): 42 (Some Item)']);
  const tcB = await mkCase(['Gold product id(s): 7 (Other Item)']);
  if (!tcA || !tcB) return null;

  const mkReport = async (testCaseId: string, hits: string[], judged: boolean) => {
    const rep = await post('/api/storage/runs', {
      id: `report-e2e-preserve-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timestamp: new Date().toISOString(), testCaseId,
      agentName: 'Retrieval Agent', agentKey: 'retrieval-agent', modelName: 'demo-model', modelId: 'demo-model', status: 'completed',
      trajectory: [step('r1', 'tool_result', { toolName: 'search', content: wrapped({ hits: hits.map(id => ({ id })) }) }), step('resp', 'response', { content: `Best match: id ${hits[0]}` })],
      ...(judged
        ? { metricsStatus: 'ready', passFailStatus: 'passed', metrics: { accuracy: 88 }, llmJudgeReasoning: 'Earlier LLM judgement: the agent found the right item.', matcherResults: [{ description: 'judge: expected outcomes', pass: true, method: 'llm-judge' }] }
        : { metricsStatus: 'error', passFailStatus: null, traceError: 'Judge evaluation failed (kind=judge_failed): mock 400', llmJudgeReasoning: '**Evaluator could not run.**', metrics: {} }),
    });
    if (!rep) return null; testData.run(rep.id); return rep.id as string;
  };
  const reportA = await mkReport(tcA, ['42'], true);
  const reportB = await mkReport(tcB, ['7'], false);
  if (!reportA || !reportB) return null;

  const runId = `eval-run-e2e-preserve-${Date.now()}`;
  const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
    data: {
      id: runId, name: uniqueTestName('E2E preserved judgement run'), status: 'completed', agentKey: 'retrieval-agent', modelId: 'demo-model',
      judgeModelId: 'no-such-judge-provider/never-called', evaluatorId: narrow.id,
      sources: [{ type: 'test-case-ids', ids: [tcA, tcB] }], trigger: 'api',
      testCaseSnapshots: [tcA, tcB].map(id => ({ id, version: 1, name: id })),
      results: { [tcA]: { reportId: reportA, status: 'completed', passFailStatus: 'passed' }, [tcB]: { reportId: reportB, status: 'completed' } },
      createdAt: new Date().toISOString(),
    },
  });
  if (!runRes.ok()) return null;
  testData.evaluationRun(runId);
  return { runId, tcA, reportA, reportB, wideEvaluatorId: wide.id, narrowName: narrow.name as string };
}

test.describe('Retry judgement — a failed attempt preserves the previous judgement and explains itself', () => {
  test('banner + Details dialog + header pill after a failing retry; all gone after a successful one', async ({ page, request, testData }) => {
    const seeded = await seed(request, testData);
    test.skip(!seeded, 'Could not seed (storage not configured?)');
    const { runId, tcA, reportA, wideEvaluatorId, narrowName } = seeded!;

    // 1. Retry through the dialog with the run's (narrow) evaluator.
    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`).click();
    await expect(page.locator('[data-testid="retry-judgement-preflight-summary"]')).toHaveText('1 of 2 cases evaluable by this evaluator', { timeout: 15000 });
    await page.locator('[data-testid="retry-judgement-confirm-btn"]').click();
    await expect(page.locator('[data-testid="retry-judgement-summary-line"]')).toHaveText('Retried 2 · 1 scored · 1 not evaluable', { timeout: 30000 });
    await page.locator('[data-testid="retry-judgement-done-btn"]').click();

    // A's judgement is preserved on the server.
    const a = await (await request.get(`/api/storage/runs/${reportA}`)).json();
    expect(a).toMatchObject({ passFailStatus: 'passed', metricsStatus: 'ready', metrics: { accuracy: 88 }, llmJudgeReasoning: 'Earlier LLM judgement: the agent found the right item.' });
    expect(a.lastRetryAttempt).toMatchObject({ outcome: 'not-evaluable', evaluatorName: narrowName });

    // Header pill: "re-judge failed".
    const failedPill = page.locator(`[data-testid="retry-judgement-failed-pill-${runId}"]`);
    await expect(failedPill).toBeVisible({ timeout: 15000 });
    await expect(failedPill).toContainText('re-judge failed');
    await expect(failedPill).toHaveAttribute('title', /1 of 2 judged, 1 not evaluable/);

    // Select case A → Judge tab → banner with the reason; the preserved verdict is still shown.
    const rowA = page.locator(`[data-testid="test-case-row"][data-test-case-id="${tcA}"]`);
    await expect(rowA).toHaveAttribute('data-status', 'passed', { timeout: 15000 }); // still passed — the failed attempt did not demote it
    await rowA.click();
    await page.getByRole('tab', { name: /Judge/ }).first().click();
    const banner = page.locator('[data-testid="last-retry-attempt-banner"]');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText('Last re-judgement failed');
    await expect(banner).toContainText(narrowName);
    await expect(page.locator('[data-testid="last-retry-attempt-reason"]')).toContainText('no gold ids on the test case');
    await expect(banner).toContainText('the previous judgement below is unchanged');
    await expect(page.getByText('judge: expected outcomes')).toBeVisible();

    // Details dialog: outcome, reason, diagnostics, Retry again.
    await page.locator('[data-testid="last-retry-attempt-details-btn"]').click();
    const dialog = page.locator('[data-testid="last-retry-attempt-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="last-retry-attempt-outcome"]')).toHaveText('not evaluable');
    await expect(page.locator('[data-testid="last-retry-attempt-dialog-reason"]')).toContainText('no gold ids on the test case');
    await expect(dialog.locator('[data-testid="scoring-diagnostics-gold"]')).toHaveText('gold not declared');
    await expect(dialog).toContainText("1 from tool 'search' hits");
    await page.locator('[data-testid="last-retry-attempt-retry-again"]').click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('[data-testid="retry-judgement-dialog"]')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');

    // 2. A successful retry (wide evaluator reads both gold lines) replaces A's judgement and clears the record.
    const start = await request.post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { data: { scope: 'all', evaluatorId: wideEvaluatorId } });
    expect(start.status()).toBe(202);
    for (let i = 0; i < 100; i++) {
      const job = await (await request.get(`/api/storage/evaluation-runs/${runId}/retry-judgement/status`)).json();
      if (job.status === 'completed') { expect(job.summary).toMatchObject({ retried: 2, succeeded: 2, notEvaluable: 0, failed: 0 }); break; }
      if (job.status === 'failed') throw new Error(job.error);
      await new Promise(r => setTimeout(r, 200));
    }
    const a2 = await (await request.get(`/api/storage/runs/${reportA}`)).json();
    expect(a2.lastRetryAttempt ?? null).toBeNull();
    expect(a2.metrics).toEqual({ 'hit@1': 1 });
    expect((await (await request.get(`/api/storage/evaluation-runs/${runId}`)).json()).lastRetryAttempt ?? null).toBeNull();

    await page.reload();
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator(`[data-testid="retry-judgement-failed-pill-${runId}"]`)).toHaveCount(0);
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${tcA}"]`).click();
    await page.getByRole('tab', { name: /Judge/ }).first().click();
    await expect(page.getByText(/hit@1 \(ranked-hit@1\)/).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="last-retry-attempt-banner"]')).toHaveCount(0);
  });
});
