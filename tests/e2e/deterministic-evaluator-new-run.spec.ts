/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a NEW evaluation run with a deterministic evaluator shows its
 * code-computed verdict in the run inspector.
 *
 * Pre-fix the new-run path sent the deterministic evaluator to the LLM judge
 * (blank system prompt → provider ValidationException → 10 retries per case)
 * and the inspector showed an errored report ("evaluator could not run") —
 * only Retry judgement scored deterministic evaluators in code.
 *
 *   1. A stub REST agent (in-test HTTP server) answers with ranked tool hits
 *      — two cases whose hits include the gold ids, one case with NO hits
 *      (→ not evaluable), so the run mixes verdicts like real data does.
 *   2. Create the deterministic evaluator + test cases + custom agent via
 *      the API, start the run via POST /api/storage/evaluation-runs and wait
 *      for `completed` (seconds, not minutes).
 *   3. Run inspector (/runs/<reportId>) of a hit case: Judge Evaluation shows
 *      one code-assertion row per metric, the pass policy says
 *      "deterministic, no LLM", the gold / predicted id lists render, and no
 *      "judge: expected outcomes" LLM row exists.
 *   4. Evaluation-run detail (/evaluation-runs/<runId>) shows 2 passed / 1
 *      errored (not evaluable), never "failed" for the no-hits case.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

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
    prediction: { source: 'tool-hits-ordered' },
  },
};

test.describe('Deterministic evaluator — NEW run is code-scored and the inspector shows the verdict', () => {
  let agentServer: http.Server;
  let agentUrl = '';

  test.beforeAll(async () => {
    agentServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const noHits = /nothing/i.test(raw);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(noHits
          ? { toolCalls: [{ name: 'search', args: { query: 'nothing' }, result: { status: 'ok', hits: [] } }], answer: 'I found nothing.' }
          : {
              toolCalls: [{ name: 'search', args: { query: 'items' }, result: { status: 'ok', hits: [{ id: '202' }, { id: '101' }, { id: '55' }, { id: '9' }] } }],
              answer: 'Best match: (id: 202), related to (id: 101).',
            }));
      });
    });
    await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
    agentUrl = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/run`;
  });
  test.afterAll(async () => { await new Promise<void>(r => agentServer.close(() => r())); });

  test('run completes in seconds without an LLM; inspector renders per-metric code-assertion rows, gold/predicted ids and "deterministic, no LLM"', async ({ page, request, testData }) => {
    test.setTimeout(120_000);
    const evaluatorName = uniqueTestName('det-new-run-ranked');
    const ev = await request.post('/api/storage/evaluators', { data: { name: evaluatorName, description: 'e2e fixture', kind: 'deterministic', ...DEFINITION } });
    expect(ev.status()).toBe(201);
    const evaluatorId = (await ev.json()).id as string;
    testData.evaluator(evaluatorId);

    const mkCase = async (label: string, prompt: string, gold: string) => {
      const r = await request.post('/api/storage/test-cases', {
        data: { name: uniqueTestName(`det-new-run-${label}`), category: 'Test', difficulty: 'Easy', initialPrompt: prompt, expectedOutcomes: ['The agent lists related items', `Gold id(s): ${gold}`], context: [] },
      });
      expect(r.ok()).toBe(true);
      const id = (await r.json()).id as string;
      testData.testCase(id);
      return id;
    };
    const hitA = await mkCase('hit-a', 'find related items', '101, 202');
    const hitB = await mkCase('hit-b', 'find related items again', '202');
    const empty = await mkCase('empty', 'find nothing at all', '303');

    const ag = await request.post('/api/agents/custom', { data: { name: uniqueTestName('stub-rest-agent'), endpoint: agentUrl, connectorType: 'rest' } });
    expect(ag.status()).toBe(201);
    const agentKey = (await ag.json()).agent.key as string;
    testData.customAgent(agentKey);

    const t0 = Date.now();
    const started = await request.post('/api/storage/evaluation-runs', {
      data: { sources: [{ type: 'test-case-ids', ids: [hitA, hitB, empty] }], agentKey, evaluatorId, name: uniqueTestName('det-new-run') },
      timeout: 60_000,
    });
    expect(started.ok()).toBe(true);
    const sse = await started.text();
    const runId = sse.match(/"runId":"([^"]+)"/)?.[1] as string;
    expect(runId).toBeTruthy();
    testData.evaluationRun(runId);
    expect(sse).toContain('event: completed');
    expect(Date.now() - t0).toBeLessThan(60_000);

    const run = await (await request.get(`/api/storage/evaluation-runs/${runId}`)).json();
    for (const r of Object.values(run.results) as Array<{ reportId: string }>) testData.run(r.reportId);
    expect(run.stats).toMatchObject({ passed: 2, failed: 0, errored: 1, total: 3 });
    const reportA = await (await request.get(`/api/storage/runs/${run.results[hitA].reportId}`)).json();
    expect(reportA.judgeMode).toBe('deterministic');
    expect(reportA.metrics).toEqual({ 'hit@1': 1, 'hit@3': 1, 'recall@5': 1, mrr: 1 });
    expect(reportA.llmJudgeResponse ?? null).toBeNull();

    // Run inspector of a hit case.
    await page.goto(`/runs/${run.results[hitA].reportId}`);
    await page.getByRole('tab', { name: /judge evaluation/i }).click();
    await expect(page.getByTestId('evaluator-pass-policy')).toContainText('Pass policy: gates (hit@3 ≥ 1)');
    await expect(page.getByTestId('evaluator-pass-policy')).toContainText('deterministic, no LLM');
    await expect(page.getByText('hit@1 (ranked-hit@1)', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('recall@5 (ranked-recall@5)', { exact: true })).toBeVisible();
    await expect(page.getByText('mrr (mrr)', { exact: true })).toBeVisible();
    const gateRow = page.getByText('hit@3 (ranked-hit@3) ≥ 1', { exact: true });
    await expect(gateRow).toBeVisible();
    await expect(page.getByTestId('matcher-role-primary')).toHaveCount(1);
    await expect(page.getByTestId('matcher-role-observe')).toHaveCount(3);
    await expect(page.getByText(/4\/4 passed/)).toBeVisible();
    // No LLM judge row — the verdict came from code.
    await expect(page.getByText('judge: expected outcomes')).toHaveCount(0);
    // Expand the gate row → gold + predicted id lists (cited ids first: 202, 101).
    await gateRow.click();
    const gold = page.getByTestId('matcher-gold-ids').first();
    await expect(gold).toContainText('101');
    await expect(gold).toContainText('202');
    await expect(page.getByTestId('matcher-predicted-ids').first()).toHaveText(/^202\s*101\s*55\s*9$/);
    await expect(page.getByText('tool-hits-ordered').first()).toBeVisible();

    // The not-evaluable case renders as errored with the reason, not as a failed verdict.
    await page.goto(`/runs/${run.results[empty].reportId}`);
    await expect(page.getByText(new RegExp(`Not evaluable by ${evaluatorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).first()).toBeVisible({ timeout: 15_000 });
  });
});
