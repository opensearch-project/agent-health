/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the `response-results` prediction source + `abstain` metric on the
 * real UI.
 *
 *   1. The evaluator editor accepts a deterministic definition whose
 *      prediction source is `response-results` and that declares an
 *      `abstain` metric (client-side validation passes; the stored document
 *      carries them). A typo'd source is rejected inline.
 *   2. Seed a COMPLETED run whose reports carry a ranked-list RESPONSE (JSON)
 *      plus tool results the agent retrieved but did not recommend; one case
 *      is explicitly gold-empty and the agent abstained.
 *   3. POST retry-judgement { scope: 'all', evaluatorId }.
 *   4. Judge Evaluation tab renders the `response-results` extraction
 *      caption with the parsed-from form, the RETURNED ids as the predicted
 *      list, and the abstain row as `n/a` on the gold case / scored on the
 *      gold-empty case.
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';
import { uniqueTestName } from '../helpers/testDataTracker';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const DEFINITION = {
  metrics: [
    { name: 'hit@5', compute: { type: 'ranked-hit', k: 5 }, weight: 1, primary: true },
    { name: 'recall@20', compute: { type: 'ranked-recall', k: 20, denominator: 'full-gold' }, weight: 1, primary: true },
    { name: 'abstain', compute: { type: 'abstain' }, weight: 1, primary: true },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }, { metric: 'abstain', min: 1 }] },
  inputs: {
    gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' },
    prediction: { source: 'response-results', idField: 'id', rankField: 'rank' },
  },
};

const retrievedStep = (ids: string[]) => ({
  id: `r-${stamp()}`, timestamp: Date.now(), type: 'tool_result', toolName: 'search products',
  content: JSON.stringify({ status: 'ok', hits: ids.map(id => ({ id, title: `item ${id}` })) }),
});
const rankedJson = (ids: string[]) =>
  JSON.stringify({ answer: null, results: ids.map((id, i) => ({ id, rank: i + 1, score: 1 - i / 10, title: `item ${id}` })), results_source: ids.length ? 'return_results' : 'abstain' });
const responseStep = (content: string) => ({ id: `a-${stamp()}`, timestamp: Date.now(), type: 'response', content });

interface Seeded { runId: string; reportGold: string; reportAbstain: string }

async function seedRun(request: APIRequestContext, testData: TestDataTracker): Promise<Seeded | null> {
  const post = async (path: string, data: unknown) => {
    const r = await request.post(path, { data });
    return r.ok() ? r.json() : null;
  };
  const mkCase = async (name: string, gold: string) => {
    const tc = await post('/api/storage/test-cases', {
      name: uniqueTestName(`det-rr-e2e-${name}`), category: 'Test', difficulty: 'Easy',
      initialPrompt: 'search products', expectedOutcomes: ['The agent returns a ranked list', `Gold id(s): ${gold}`], context: [],
    });
    if (!tc) return null;
    testData.testCase(tc.id);
    return tc.id as string;
  };
  const tcGold = await mkCase('gold', '101, 202');
  const tcAbstain = await mkCase('abstain', 'none');
  if (!tcGold || !tcAbstain) return null;

  const mkReport = async (testCaseId: string, trajectory: unknown[]) => {
    const rep = await post('/api/storage/runs', {
      id: `report-det-rr-e2e-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
      agentName: 'Retrieval Agent', agentKey: 'retrieval-agent', modelName: 'demo-model', modelId: 'demo-model',
      status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed', trajectory, metrics: { accuracy: 90 },
      llmJudgeReasoning: 'previous LLM judgement',
    });
    if (!rep) return null;
    testData.run(rep.id);
    return rep.id as string;
  };
  // Retrieved [101, 202, 9, 8] but RETURNED only [9, 202] → hit@5 1, recall 0.5; abstain n/a.
  const reportGold = await mkReport(tcGold, [retrievedStep(['101', '202', '9', '8']), responseStep(rankedJson(['9', '202']))]);
  // Gold-empty case: retrieved things but returned nothing → abstain 1; ranked n/a.
  const reportAbstain = await mkReport(tcAbstain, [retrievedStep(['1', '2']), responseStep(rankedJson([]))]);
  if (!reportGold || !reportAbstain) return null;

  const runId = `eval-run-det-rr-e2e-${stamp()}`;
  const r = await request.put(`/api/storage/evaluation-runs/${runId}`, {
    data: {
      id: runId, name: 'response-results e2e', status: 'completed', agentKey: 'retrieval-agent', modelId: 'demo-model',
      judgeModelId: 'no-such-judge-provider/never-called', sources: [{ type: 'test-case-ids', ids: [tcGold, tcAbstain] }], trigger: 'api',
      testCaseSnapshots: [tcGold, tcAbstain].map(id => ({ id, version: 1, name: id })),
      results: {
        [tcGold]: { reportId: reportGold, status: 'completed', passFailStatus: 'passed' },
        [tcAbstain]: { reportId: reportAbstain, status: 'completed', passFailStatus: 'passed' },
      },
      createdAt: new Date().toISOString(),
    },
  });
  if (!r.ok()) return null;
  testData.evaluationRun(runId);
  return { runId, reportGold, reportAbstain };
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

test.describe('Deterministic evaluator — response-results source + abstain metric', () => {
  test('editor accepts the new source and metric; Judge tab shows the response-results caption, returned ids, and n/a vs scored abstain rows', async ({ page, request, testData }) => {
    // 1. Editor.
    const evaluatorName = uniqueTestName('det-rr-e2e-evaluator');
    await page.goto('/evaluators/new');
    await page.getByLabel('Name *').fill(evaluatorName);
    await page.getByTestId('evaluator-kind-select').click();
    await page.getByRole('option', { name: /Deterministic/ }).click();
    const card = page.getByTestId('deterministic-definition-card');
    await expect(card).toBeVisible();
    // The editor's help text names both sources and the abstain type.
    await expect(card).toContainText('response-results');
    await expect(card).toContainText('abstain');
    const json = page.getByTestId('deterministic-definition-json');
    // A typo'd source is rejected client-side with a message naming both sources.
    await json.fill(JSON.stringify({ ...DEFINITION, inputs: { ...DEFINITION.inputs, prediction: { source: 'response-result' } } }));
    await page.getByLabel('Name *').click(); // blur → validate
    await expect(page.getByTestId('deterministic-definition-error')).toContainText("must be 'tool-hits-ordered' or 'response-results'");
    await json.fill(JSON.stringify(DEFINITION, null, 2));
    await page.getByLabel('Name *').click();
    await expect(page.getByTestId('deterministic-definition-error')).toHaveCount(0);
    await page.getByRole('button', { name: /^Save/ }).click();
    await page.waitForURL(/\/evaluators\/(?!new)[^/]+$/, { timeout: 20_000 });
    const evaluatorId = decodeURIComponent(page.url().split('/evaluators/')[1]);
    testData.evaluator(evaluatorId);
    const stored = await (await request.get(`/api/storage/evaluators/${evaluatorId}`)).json();
    expect(stored.kind).toBe('deterministic');
    expect(stored.inputs.prediction).toEqual({ source: 'response-results', idField: 'id', rankField: 'rank' });
    expect(stored.metrics.map((m: any) => m.compute.type)).toEqual(['ranked-hit', 'ranked-recall', 'abstain']);

    // 2–3. Seed and re-judge.
    const seeded = await seedRun(request, testData);
    test.skip(!seeded, 'Could not seed runs/reports (storage not configured?)');
    const { runId, reportGold, reportAbstain } = seeded!;
    await retryJudge(request, runId, evaluatorId);

    const gold = await (await request.get(`/api/storage/runs/${reportGold}`)).json();
    expect(gold.metrics).toEqual({ 'hit@5': 1, 'recall@20': 0.5 });
    expect(gold.scoringSnapshot).toMatchObject({ extractionRule: 'response-results', extraction: { candidateCount: 2, parsedFrom: 'json' }, notApplicable: ['abstain'] });

    // 4a. Gold case: caption, returned ids, abstain n/a.
    await page.goto(`/runs/${reportGold}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    await expect(page.getByTestId('evaluator-pass-policy')).toContainText('Pass policy: gates (hit@5 ≥ 1, abstain ≥ 1)');
    const gateRow = page.getByText('hit@5 (ranked-hit@5) ≥ 1', { exact: true });
    await expect(gateRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('abstain (abstain) ≥ 1', { exact: true })).toBeVisible();
    await expect(page.getByTestId('matcher-not-applicable')).toHaveCount(1);
    await expect(page.getByTestId('matcher-not-applicable')).toHaveText('n/a');
    await expect(page.getByText(/2\/2 passed, 1 n\/a/)).toBeVisible(); // n/a rows are excluded from the tally
    await gateRow.click();
    // The RETURNED list (9, 202) — not the retrieved 101 / 8.
    await expect(page.getByTestId('matcher-predicted-ids').first()).toHaveText(/^9\s*202$/);
    const caption = page.getByTestId('matcher-extraction-rule').first();
    await expect(caption).toContainText('extraction rule: response-results');
    await expect(caption).toContainText('parsed from json');
    // The n/a row explains itself when expanded.
    await page.getByText('abstain (abstain) ≥ 1', { exact: true }).click();
    await expect(page.getByTestId('matcher-not-applicable-reason')).toContainText('abstain only scores cases whose gold is explicitly empty');

    // 4b. Gold-empty case: abstain scored (1) and gating; ranked rows n/a.
    await page.goto(`/runs/${reportAbstain}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    await expect(page.getByText('abstain (abstain) ≥ 1', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('matcher-not-applicable')).toHaveCount(2); // hit@5, recall@20
    await expect(page.getByTestId('matcher-role-primary')).toHaveCount(1);   // only the abstain gate applies
    await expect(page.getByText(/1\/1 passed, 2 n\/a/)).toBeVisible();
    await page.getByText('abstain (abstain) ≥ 1', { exact: true }).click();
    await expect(page.getByText('value:').first()).toBeVisible();
    await expect(page.getByText('(gate ≥ 1)').first()).toBeVisible();
    await expect(page.getByTestId('matcher-gold-ids').first()).toHaveText('none');
    await expect(page.getByTestId('matcher-predicted-ids').first()).toHaveText('none');
  });
});
