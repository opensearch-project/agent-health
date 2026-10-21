/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: seams between Retry judgement and the features it interacts with —
 * agent-step failure surfacing (the run-detail failure card and the
 * AGENT/JUDGE ERROR badges), the runner's result mirror (judged FAILED cases
 * are `results[tc].status: 'failed'`), the resolved judge identity on
 * reports, and the compare scoreboard's judge caption.
 *
 *   1. A judge-failed case (failure card "Judge could not produce a verdict")
 *      re-judged successfully through the dialog → the row shows the verdict
 *      and the failure card is gone.
 *   2. A run whose every case failed at the agent request → the kebab's
 *      Retry judgement item is DISABLED with the agent-failure reason.
 *   3. A run with judged-FAILED cases → they are counted as re-judgeable.
 *   4. Compare: run B re-judged (all cases) with a different judge → the
 *      judge caption names the NEW judge for B, the original for A.
 *   5. A deterministic re-score → the Judge tab no longer names the earlier
 *      LLM, and the compare caption reads "No LLM judge".
 *
 * All fixtures are synthetic and seeded through the storage API; the retry
 * uses the built-in demo/mock judge (`judgeModelId: 'demo-model'`).
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';
import { uniqueTestName } from '../helpers/testDataTracker';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const trajectory = [
  { id: 's1', timestamp: 1, type: 'action', toolName: 'search_logs', content: 'looking' },
  { id: 's2', timestamp: 2, type: 'response', content: 'The disk is full.' },
];

/** Exact persisted shape of a judge-step failure (`buildEvaluatorErrorPatch('judge_failed', …)`). */
const judgeFailedFields = {
  metricsStatus: 'error', passFailStatus: null, metrics: {},
  traceError: 'Judge evaluation failed (kind=judge_failed): judge returned no JSON',
  llmJudgeReasoning: '**Evaluator could not run.**',
  failureStage: 'judge', error: 'judge returned no JSON',
  judgeError: { message: 'judge returned no JSON', rawResponse: '', attempts: 3 },
};
/** Exact persisted shape of an agent-request failure (`buildEvaluatorErrorPatch('agent_failed', …)`). */
const agentFailedFields = {
  metricsStatus: 'error', passFailStatus: null, metrics: {}, trajectory: [],
  traceError: 'Agent request failed (kind=agent_failed): Agent request timed out after 300000ms',
  llmJudgeReasoning: '**Agent request failed.**',
  failureStage: 'agent', error: 'Agent request timed out after 300000ms',
  agentError: { kind: 'timeout', message: 'Agent request timed out after 300000ms', elapsedMs: 300000, timeoutMs: 300000 },
};

class Seeder {
  constructor(private request: APIRequestContext, private testData: TestDataTracker) {}

  async post(path: string, data: unknown) {
    const r = await this.request.post(path, { data });
    if (!r.ok()) throw new Error(`POST ${path} → ${r.status()} ${await r.text()}`);
    return r.json();
  }

  async testCase(expectedOutcomes: string[] = ['the agent identifies the root cause']): Promise<string> {
    const tc = await this.post('/api/storage/test-cases', {
      name: uniqueTestName('e2e-retry-seams-tc'), category: 'Test', difficulty: 'Easy',
      initialPrompt: 'What is causing the outage?', expectedOutcomes,
    });
    const id = tc.id || tc.testCase?.id;
    this.testData.testCase(id);
    return id as string;
  }

  async report(testCaseId: string, overrides: Record<string, unknown>): Promise<string> {
    const rep = await this.post('/api/storage/runs', {
      id: `report-e2e-retry-seams-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
      agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
      status: 'completed', trajectory, llmJudgeReasoning: '', metrics: {}, ...overrides,
    });
    this.testData.run(rep.id);
    return rep.id as string;
  }

  async evalRun(results: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
    const id = `eval-run-e2e-retry-seams-${stamp()}`;
    const r = await this.request.put(`/api/storage/evaluation-runs/${id}`, {
      data: {
        id, name: uniqueTestName('E2E retry seams run'), status: 'completed', agentKey: 'demo', modelId: 'demo-model',
        judgeModelId: 'demo-model', sources: [{ type: 'test-case-ids', ids: Object.keys(results) }], trigger: 'api',
        testCaseSnapshots: Object.keys(results).map(tcId => ({ id: tcId, version: 1, name: tcId })),
        results, createdAt: new Date().toISOString(), ...extra,
      },
    });
    if (!r.ok()) throw new Error(`PUT evaluation-run → ${r.status()} ${await r.text()}`);
    this.testData.evaluationRun(id);
    return id;
  }

  /** Start a retry through the API and wait for the job to settle. */
  async retry(runId: string, body: Record<string, unknown>) {
    const start = await this.request.post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { data: body });
    expect(start.status()).toBe(202);
    for (let i = 0; i < 150; i++) {
      const job = await (await this.request.get(`/api/storage/evaluation-runs/${runId}/retry-judgement/status`)).json();
      if (job.status === 'completed') return job;
      if (job.status === 'failed') throw new Error(job.error);
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('retry-judgement did not settle');
  }
}

async function openInspector(page: Page, runId: string) {
  await page.goto(`/evaluations/runs/${runId}/inspect`);
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
  await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30000 });
}

async function openRetryItem(page: Page, runId: string) {
  await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
  const item = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
  await expect(item).toBeVisible({ timeout: 15000 });
  return item;
}

test.describe('Retry judgement seams — failure card, enablement, judge identity', () => {
  test('a judge-failed case re-judged successfully shows its verdict and NO failure card', async ({ page, request, testData }) => {
    const seed = new Seeder(request, testData);
    const tc = await seed.testCase();
    const reportId = await seed.report(tc, judgeFailedFields);
    const runId = await seed.evalRun({ [tc]: { reportId, status: 'completed' } });

    await openInspector(page, runId);
    const row = page.locator(`[data-testid="test-case-row"][data-test-case-id="${tc}"]`);
    await expect(row).toHaveAttribute('data-status', 'errored');
    await row.click();
    // BEFORE: the judge-stage failure card is what the user sees.
    const card = page.locator('[data-testid="run-failure-card"]').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveAttribute('data-stage', 'judge');
    await expect(card).toContainText('Judge could not produce a verdict');

    // Retry through the dialog (default scope = the 1 judge-failed case, demo judge).
    const item = await openRetryItem(page, runId);
    await expect(item).toContainText('Retry judgement (1)');
    await item.click();
    await expect(page.locator('[data-testid="retry-judgement-dialog"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-scope-errored"]')).toBeChecked();
    await page.locator('[data-testid="retry-judgement-confirm-btn"]').click();
    await expect(page.locator('[data-testid="retry-judgement-summary-line"]')).toHaveText('Retried 1 · 1 scored', { timeout: 30000 });
    await page.locator('[data-testid="retry-judgement-done-btn"]').click();

    // Server truth: verdict present, every failure field cleared.
    const after = await (await request.get(`/api/storage/runs/${reportId}`)).json();
    expect(['passed', 'failed']).toContain(after.passFailStatus);
    expect(after.failureStage ?? null).toBeNull();
    expect(after.error ?? null).toBeNull();
    expect(after.judgeError ?? null).toBeNull();

    // AFTER (fresh load, no client cache): the row carries the verdict, the panel has no failure card.
    await openInspector(page, runId);
    await expect(row).toHaveAttribute('data-status', after.passFailStatus, { timeout: 15000 });
    await row.click();
    await expect(page.locator('[data-testid="status-label"]').first()).toHaveText(after.passFailStatus.toUpperCase());
    await expect(page.locator('[data-testid="run-failure-card"]')).toHaveCount(0);
    await expect(page.getByText('Judge could not produce a verdict')).toHaveCount(0);
  });

  test('a run whose every case failed at the agent request: Retry judgement is DISABLED with the agent-failure reason', async ({ page, request, testData }) => {
    const seed = new Seeder(request, testData);
    const tcA = await seed.testCase();
    const tcB = await seed.testCase();
    const repA = await seed.report(tcA, agentFailedFields);
    const repB = await seed.report(tcB, agentFailedFields);
    // The runner writes agent failures exactly like completed cases on the run doc.
    const runId = await seed.evalRun({ [tcA]: { reportId: repA, status: 'completed' }, [tcB]: { reportId: repB, status: 'completed' } });

    await openInspector(page, runId);
    await expect(page.locator('[data-testid="test-case-row"][data-status="errored"]')).toHaveCount(2);
    const item = await openRetryItem(page, runId);
    await expect(item).toContainText('Retry judgement (0)');
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('title', /2 cases failed at the agent request \(nothing to judge\); use Re-run/);
    await page.keyboard.press('Escape');
  });

  test('judged-FAILED cases (results status failed + a failed verdict) are counted as re-judgeable', async ({ page, request, testData }) => {
    const seed = new Seeder(request, testData);
    const tcs = [await seed.testCase(), await seed.testCase(), await seed.testCase()];
    const repPassed = await seed.report(tcs[0], { metricsStatus: 'ready', passFailStatus: 'passed', metrics: { accuracy: 90 } });
    const repFailed1 = await seed.report(tcs[1], { metricsStatus: 'ready', passFailStatus: 'failed', metrics: { accuracy: 10 } });
    const repFailed2 = await seed.report(tcs[2], { metricsStatus: 'ready', passFailStatus: 'failed', metrics: { accuracy: 20 } });
    const runId = await seed.evalRun({
      [tcs[0]]: { reportId: repPassed, status: 'completed', passFailStatus: 'passed' },
      [tcs[1]]: { reportId: repFailed1, status: 'failed', passFailStatus: 'failed' },
      [tcs[2]]: { reportId: repFailed2, status: 'failed', passFailStatus: 'failed' },
    });

    await openInspector(page, runId);
    await expect(page.locator('[data-testid="test-case-row"][data-status="failed"]')).toHaveCount(2);
    const item = await openRetryItem(page, runId);
    await expect(item).toContainText('Retry judgement (3)');
    await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await item.click();
    await expect(page.locator('[data-testid="retry-judgement-scope-all"]')).toBeChecked();
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('3');
    await page.keyboard.press('Escape');
  });

  test('compare: after re-judging run B with another judge, the caption names the new judge for B and the original for A', async ({ page, request, testData }) => {
    const seed = new Seeder(request, testData);
    const tc = await seed.testCase();
    const judgedByX = { metricsStatus: 'ready', passFailStatus: 'passed', metrics: { accuracy: 90 }, judgeModelId: 'judge-x-original', judgeModel: 'judge-x-original', judgeProvider: 'bedrock' };
    const repA = await seed.report(tc, judgedByX);
    const repB = await seed.report(tc, judgedByX);
    const runA = await seed.evalRun({ [tc]: { reportId: repA, status: 'completed', passFailStatus: 'passed' } }, { judgeModelId: 'judge-x-original', judgeModel: 'judge-x-original' });
    const runB = await seed.evalRun({ [tc]: { reportId: repB, status: 'completed', passFailStatus: 'passed' } }, { judgeModelId: 'judge-x-original', judgeModel: 'judge-x-original' });

    // Re-judge every case of B with the demo judge; the run's original selection stays immutable.
    const job = await seed.retry(runB, { scope: 'all', judgeModelId: 'demo-model' });
    expect(job.summary).toMatchObject({ retried: 1, succeeded: 1 });
    expect((await (await request.get(`/api/storage/evaluation-runs/${runB}`)).json()).judgeModelId).toBe('judge-x-original');

    await page.goto(`/compare?runs=${runA},${runB}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
    const line = page.locator('[data-testid="scoreboard-judge-line"]');
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toContainText(/A\s+judge-x-original/);
    await expect(line).toContainText(/B\s+Demo Model/);
    // B's segment must not still say the original judge.
    const text = (await line.textContent()) ?? '';
    const bSegment = text.slice(text.indexOf('· B'));
    expect(bSegment).toContain('Demo Model');
    expect(bSegment).not.toContain('judge-x-original');
  });

  test('deterministic re-score: the Judge tab stops naming the earlier LLM and the compare caption reads "No LLM judge"', async ({ page, request, testData }) => {
    const seed = new Seeder(request, testData);
    const evaluator = await seed.post('/api/storage/evaluators', {
      name: uniqueTestName('e2e-retry-seams-det'), description: 'e2e deterministic evaluator', kind: 'deterministic',
      metrics: [{ name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true }],
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
      inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' }, prediction: { source: 'tool-hits-ordered' } },
    });
    testData.evaluator(evaluator.id);
    const tc = await seed.testCase(['Gold id(s): 42']);
    const reportId = await seed.report(tc, {
      trajectory: [{ id: 'r1', timestamp: 1, type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: [{ id: '42' }] }) }],
      metricsStatus: 'ready', passFailStatus: 'failed', metrics: { accuracy: 20 }, llmJudgeReasoning: 'earlier LLM verdict',
      judgeModelId: 'judge-x-original', judgeModel: 'judge-x-original', judgeProvider: 'bedrock',
      llmJudgeResponse: { modelId: 'judge-x-original', timestamp: new Date().toISOString(), promptTokens: 1, completionTokens: 1, latencyMs: 1, rawResponse: '{}' },
    });
    const runId = await seed.evalRun({ [tc]: { reportId, status: 'failed', passFailStatus: 'failed' } }, { judgeModelId: 'judge-x-original', judgeModel: 'judge-x-original' });

    const job = await seed.retry(runId, { scope: 'all', evaluatorId: evaluator.id });
    expect(job.summary).toMatchObject({ retried: 1, succeeded: 1 });
    const after = await (await request.get(`/api/storage/runs/${reportId}`)).json();
    expect(after).toMatchObject({ passFailStatus: 'passed', judgeProvider: 'none' });
    expect(after.judgeModel ?? null).toBeNull();

    // Judge tab: the code-computed metric is shown, the earlier LLM is not named as the judge.
    await openInspector(page, runId);
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${tc}"]`).click();
    await page.getByRole('tab', { name: /Judge/ }).first().click();
    await expect(page.getByText(/hit@1 \(ranked-hit@1\)/).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="judge-output-model"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="judgement-retried-line"]')).toContainText('no LLM judge (scored in code)');
    await expect(page.getByText('judge-x-original')).toHaveCount(0);

    // Compare caption: "No LLM judge", never the run's original LLM.
    await page.goto(`/compare?runs=${runId}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
    const line = page.locator('[data-testid="scoreboard-judge-line"]');
    await expect(line).toContainText('No LLM judge', { timeout: 15000 });
    await expect(line).not.toContainText('judge-x-original');
  });
});
