/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: deterministic evaluators end-to-end on the real UI.
 *
 *   1. Create a deterministic evaluator from the editor UI (Kind selector →
 *      JSON definition → Save) — the same body the API accepts.
 *   2. Seed two COMPLETED eval runs over the same generic test cases whose
 *      reports carry stored tool hits + an answer citing ids (fixture data,
 *      generic tool names `search` / `expand`).
 *   3. POST retry-judgement { scope: 'all', evaluatorId } on both runs (the
 *      API is the pilot surface; the picker UI lands with #509).
 *   4. Judge Evaluation tab of a re-scored report shows one code-assertion
 *      row per metric with the gold / predicted id lists.
 *   5. Compare page (/compare?runs=a,b) shows the primary metrics as columns
 *      and "Pass rate (gates)".
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';
import { uniqueTestName } from '../helpers/testDataTracker';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const DEFINITION = {
  metrics: [
    { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.25, primary: true },
    { name: 'hit@3', compute: { type: 'ranked-hit', k: 3 }, weight: 0.25, primary: true },
    { name: 'recall@5', compute: { type: 'ranked-recall', k: 5, denominator: 'full-gold' }, weight: 0.25, primary: true },
    { name: 'mrr', compute: { type: 'mrr' }, weight: 0.25 },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@3', min: 1 }] },
  inputs: {
    gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' },
    prediction: { source: 'tool-hits-ordered', anchorTools: [{ tool: 'expand', argKey: 'seed_ids' }] },
  },
};

const hitsStep = (ids: string[]) => ({
  id: `r-${stamp()}`, timestamp: Date.now(), type: 'tool_result', toolName: 'search',
  content: JSON.stringify([{ text: JSON.stringify({ status: 'ok', hits: ids.map(id => ({ id, title: `item ${id}` })) }) }]),
});

interface Seeded { runA: string; runB: string; reportHitA: string }

async function seedRuns(request: APIRequestContext, testData: TestDataTracker): Promise<Seeded | null> {
  const post = async (path: string, data: unknown) => {
    const r = await request.post(path, { data });
    return r.ok() ? r.json() : null;
  };
  const mkCase = async (name: string, gold: string) => {
    const tc = await post('/api/storage/test-cases', {
      name: uniqueTestName(`det-e2e-${name}`), category: 'Test', difficulty: 'Easy',
      initialPrompt: 'find related items', expectedOutcomes: ['The agent lists related items', `Gold id(s): ${gold}`], context: [],
    });
    if (!tc) return null;
    testData.testCase(tc.id);
    return tc.id as string;
  };
  const tc1 = await mkCase('one', '101, 202');
  const tc2 = await mkCase('two', '303');
  if (!tc1 || !tc2) return null;

  const mkReport = async (testCaseId: string, trajectory: unknown[]) => {
    const rep = await post('/api/storage/runs', {
      id: `report-det-e2e-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
      agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
      status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed', trajectory, metrics: { accuracy: 90 },
      llmJudgeReasoning: 'previous LLM judgement',
    });
    if (!rep) return null;
    testData.run(rep.id);
    return rep.id as string;
  };
  const goodTrajectory = [
    { id: 'a1', timestamp: 1, type: 'action', toolName: 'search', toolArgs: { q: 'x' }, content: '{}' },
    hitsStep(['7', '101', '9']),
    { id: 'a2', timestamp: 2, type: 'action', toolName: 'expand', toolArgs: { seed_ids: ['101'] }, content: '{}' },
    hitsStep(['202', '101', '55']),
    { id: 'a3', timestamp: 3, type: 'response', content: 'Best match: (id: 202), related to (id: 101).' },
  ];
  const missTrajectory = [hitsStep(['1', '2', '3'])];

  const mkRun = async (label: string, reports: Record<string, string>) => {
    const id = `eval-run-det-e2e-${label}-${stamp()}`;
    const r = await request.put(`/api/storage/evaluation-runs/${id}`, {
      data: {
        id, name: `Deterministic e2e ${label}`, status: 'completed', agentKey: 'demo', modelId: 'demo-model',
        judgeModelId: 'no-such-judge-provider/never-called', sources: [{ type: 'test-case-ids', ids: Object.keys(reports) }], trigger: 'api',
        testCaseSnapshots: Object.keys(reports).map(tcId => ({ id: tcId, version: 1, name: tcId })),
        results: Object.fromEntries(Object.entries(reports).map(([tcId, reportId]) => [tcId, { reportId, status: 'completed', passFailStatus: 'passed' }])),
        createdAt: new Date().toISOString(),
      },
    });
    if (!r.ok()) return null;
    testData.evaluationRun(id);
    return id;
  };

  const a1 = await mkReport(tc1, goodTrajectory);
  const a2 = await mkReport(tc2, missTrajectory);
  const b1 = await mkReport(tc1, goodTrajectory);
  const b2 = await mkReport(tc2, [hitsStep(['303', '1'])]);
  if (!a1 || !a2 || !b1 || !b2) return null;
  const runA = await mkRun('a', { [tc1]: a1, [tc2]: a2 });
  const runB = await mkRun('b', { [tc1]: b1, [tc2]: b2 });
  if (!runA || !runB) return null;
  return { runA, runB, reportHitA: a1 };
}

async function retryJudge(request: APIRequestContext, runId: string, evaluatorId: string): Promise<void> {
  const start = await request.post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { data: { scope: 'all', evaluatorId } });
  expect(start.status()).toBe(202);
  for (let i = 0; i < 100; i++) {
    const job = await (await request.get(`/api/storage/evaluation-runs/${runId}/retry-judgement/status`)).json();
    if (job.status === 'completed') return;
    if (job.status === 'failed') throw new Error(`retry-judgement failed: ${job.error}`);
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('retry-judgement did not settle');
}

test.describe('Deterministic evaluator — create in UI, Retry judgement, Judge tab rows, compare columns', () => {
  test('creates the evaluator from the editor, re-scores two completed runs without an LLM, renders gold/predicted lists and primary-metric columns', async ({ page, request, testData }) => {
    // 1. Create via the editor UI.
    const evaluatorName = uniqueTestName('det-e2e-evaluator');
    await page.goto('/evaluators/new');
    await page.getByLabel('Name *').fill(evaluatorName);
    await page.getByTestId('evaluator-kind-select').click();
    await page.getByRole('option', { name: /Deterministic/ }).click();
    const json = page.getByTestId('deterministic-definition-json');
    await expect(json).toBeVisible();
    await json.fill(JSON.stringify(DEFINITION, null, 2));
    // Client-side validation catches a bad definition before any request.
    await json.fill(JSON.stringify({ ...DEFINITION, passPolicy: { kind: 'llm-verdict' } }));
    await page.getByLabel('Name *').click(); // blur → validate
    await expect(page.getByTestId('deterministic-definition-error')).toContainText("'llm-verdict' is not allowed");
    await json.fill(JSON.stringify(DEFINITION, null, 2));
    await page.getByRole('button', { name: /^Save/ }).click();
    await page.waitForURL(/\/evaluators\/(?!new)[^/]+$/, { timeout: 20_000 });
    const evaluatorId = decodeURIComponent(page.url().split('/evaluators/')[1]);
    testData.evaluator(evaluatorId);
    const stored = await (await request.get(`/api/storage/evaluators/${evaluatorId}`)).json();
    expect(stored.kind).toBe('deterministic');
    expect(stored.name).toBe(evaluatorName);
    expect(stored.metrics.map((m: any) => m.name)).toEqual(['hit@1', 'hit@3', 'recall@5', 'mrr']);
    // Read-only view shows the definition (not a prompt editor).
    await expect(page.getByTestId('deterministic-definition-card')).toBeVisible();

    // 2–3. Seed and re-judge.
    const seeded = await seedRuns(request, testData);
    test.skip(!seeded, 'Could not seed runs/reports (storage not configured?)');
    const { runA, runB, reportHitA } = seeded!;
    await retryJudge(request, runA, evaluatorId);
    await retryJudge(request, runB, evaluatorId);

    const report = await (await request.get(`/api/storage/runs/${reportHitA}`)).json();
    expect(report.judgeMode).toBe('deterministic');
    expect(report.metrics).toEqual({ 'hit@1': 1, 'hit@3': 1, 'recall@5': 0.5, mrr: 1 });

    // 4. Judge tab: metric rows with gold / predicted ids.
    await page.goto(`/runs/${reportHitA}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    await expect(page.getByTestId('evaluator-pass-policy')).toContainText('Pass policy: gates (hit@3 ≥ 1)');
    await expect(page.getByText('hit@1 (ranked-hit@1)', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('recall@5 (ranked-recall@5)', { exact: true })).toBeVisible();
    await expect(page.getByText('mrr (mrr)', { exact: true })).toBeVisible();
    const gateRow = page.getByText('hit@3 (ranked-hit@3) ≥ 1', { exact: true });
    await expect(gateRow).toBeVisible();
    await expect(page.getByTestId('matcher-role-primary')).toHaveCount(1);
    await expect(page.getByTestId('matcher-role-observe')).toHaveCount(3);
    await expect(page.getByText(/4\/4 passed/)).toBeVisible();
    // No LLM judge row survives the deterministic re-judgement.
    await expect(page.getByText('judge: expected outcomes')).toHaveCount(0);
    // Expand the gate row → gold + predicted lists (gold hits highlighted; anchor 101 removed).
    await gateRow.click();
    const gold = page.getByTestId('matcher-gold-ids').first();
    await expect(gold).toContainText('101');
    await expect(gold).toContainText('202');
    const predicted = page.getByTestId('matcher-predicted-ids').first();
    await expect(predicted).toHaveText(/^202\s*55\s*7\s*9$/);
    await expect(page.getByText('extraction rule:').first()).toBeVisible();
    await expect(page.getByText('tool-hits-ordered').first()).toBeVisible();

    // 5. Compare page: primary-metric columns + policy-labelled pass rate.
    await page.goto(`/compare?runs=${runA},${runB}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="scoreboard-col-primary:hit@1"]')).toHaveText('hit@1', { timeout: 20_000 });
    await expect(page.locator('[data-testid="scoreboard-col-primary:hit@3"]')).toHaveText('hit@3');
    await expect(page.locator('[data-testid="scoreboard-col-primary:recall@5"]')).toHaveText('recall@5');
    await expect(page.locator('[data-testid="scoreboard-col-primary:mrr"]')).toHaveCount(0); // not declared primary
    // Run A: cases (1, 0) → mean hit@1 0.50; Run B: (1, 1) → 1.00.
    await expect(page.locator(`[data-testid="run-primary-hit@1-${runA}"]`)).toHaveText('0.50');
    await expect(page.locator(`[data-testid="run-primary-hit@1-${runB}"]`)).toHaveText('1.00');
    await expect(page.locator('[data-testid="scoreboard-col-passRate"]')).toHaveText('Pass rate (gates)');
    await expect(page.locator(`[data-testid="run-passrate-${runA}"]`)).toHaveText('50%');
    await expect(page.locator(`[data-testid="run-passrate-detail-${runA}"]`)).toHaveText('1 / 2');
    await expect(page.locator(`[data-testid="run-passrate-${runB}"]`)).toHaveText('100%');
    // Same evaluator content hash on both → comparable (Δ row present).
    await expect(page.locator('[data-testid="scoreboard-delta-blocked"]')).toHaveCount(0);
  });
});
