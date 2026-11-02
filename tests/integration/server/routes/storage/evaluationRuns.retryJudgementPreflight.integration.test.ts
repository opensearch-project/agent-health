/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: POST /api/storage/evaluation-runs/:id/retry-judgement/preflight
 * on a real server (file storage or whatever AH_PORT points at).
 *
 * Seeds a deterministic evaluator (gold pattern whose captured text carries
 * the products' names in parentheses, `tool-hits-ordered` with an anchor
 * tool) and a COMPLETED run of three generic cases:
 *   - gold + a results tool (`return_results.records`) → evaluable, scored
 *     from the RETURNED list even though the configured `hits` only hold
 *     the anchor;
 *   - no gold line at all → not evaluable ("no gold ids …");
 *   - an explicit "NONE …" line + an empty returned list → evaluable ABSTAIN
 *     case.
 * Asserts the pre-flight counts / grouped reasons / per-case diagnostics,
 * that it wrote NOTHING (reports byte-identical, no job registered), that
 * the same-body validation as the POST applies, that an LLM evaluator is
 * reported `deterministic: false`, and that the real retry then matches the
 * pre-flight case for case.
 *
 * Requires a backend (AH_PORT). Every created id is deleted in afterAll.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    return (await r.json()).status === 'ok';
  } catch {
    return false;
  }
};

async function pollRetryJudgement(runId: string, maxAttempts = 100): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement/status`);
    if (!res.ok) throw new Error(`status poll ${res.status}`);
    const job = await res.json();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('retry-judgement did not settle');
}

const evaluatorBody = () => ({
  name: `Ranked products (preflight integration ${stamp()})`,
  description: 'generic deterministic evaluator fixture',
  kind: 'deterministic',
  metrics: [
    { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.5, primary: true },
    { name: 'hit@5', compute: { type: 'ranked-hit', k: 5 }, weight: 0.5, primary: true },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }] },
  inputs: {
    gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold product id\\(s\\):\\s*(.+)$' },
    prediction: { source: 'tool-hits-ordered', anchorTools: [{ tool: 'expand_relations', argKey: 'seed_ids' }] },
  },
});

const wrapped = (payload: unknown) => JSON.stringify([{ text: JSON.stringify(payload) }]);
const step = (id: string, type: string, extra: Record<string, unknown>) => ({ id, timestamp: 1, type, ...extra });

describe('retry-judgement pre-flight (read-only evaluability check)', () => {
  let backendAvailable = false;
  const created = { evaluators: [] as string[], testCases: [] as string[], reports: [] as string[], evalRuns: [] as string[] };

  beforeAll(async () => { backendAvailable = await checkBackend(); });

  afterAll(async () => {
    if (!backendAvailable) return;
    for (const id of created.evalRuns) await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of created.reports) await fetch(`${BASE_URL}/api/storage/runs/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of created.testCases) await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of created.evaluators) await fetch(`${BASE_URL}/api/storage/evaluators/${id}`, { method: 'DELETE' }).catch(() => {});
  });

  const post = async (path: string, body?: unknown) =>
    fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = async (path: string) => (await fetch(`${BASE_URL}${path}`)).json();

  it('predicts evaluable / not-evaluable / abstain per case with diagnostics, writes nothing, and the real retry then agrees', async () => {
    if (!backendAvailable) return;

    const evRes = await post('/api/storage/evaluators', evaluatorBody());
    expect(evRes.status).toBe(201);
    const evaluator = await evRes.json();
    created.evaluators.push(evaluator.id);

    const mkCase = async (name: string, expectedOutcomes: string[]) => {
      const r = await post('/api/storage/test-cases', {
        name: `det-preflight-int-${name}-${stamp()}`, category: 'Test', difficulty: 'Easy', initialPrompt: 'search products',
        expectedOutcomes, context: [], labels: ['@integration-test'],
      });
      expect(r.status).toBeLessThan(300);
      const tc = await r.json();
      created.testCases.push(tc.id);
      return tc.id as string;
    };
    const tcGold = await mkCase('gold', ['Gold product id(s): 290226, 116770 (First Gel Wrap; Second Gel Wrap)', 'The agent keeps only gel hand wraps.']);
    const tcNoGold = await mkCase('nogold', ['The agent lists related items.']);
    const tcNone = await mkCase('none', ['NONE — the anchor has no related edges in either direction; the answer recommends ZERO products.']);

    const mkReport = async (testCaseId: string, trajectory: unknown[], rawEvents?: unknown[]) => {
      const r = await post('/api/storage/runs', {
        id: `report-det-preflight-int-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
        agentName: 'Retrieval Agent', agentKey: 'retrieval-agent', modelName: 'demo-model', modelId: 'demo-model',
        status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed',
        trajectory, ...(rawEvents ? { rawEvents } : {}), metrics: { accuracy: 90 }, llmJudgeReasoning: 'previous LLM judgement',
      });
      expect(r.status).toBeLessThan(300);
      const rep = await r.json();
      created.reports.push(rep.id);
      return rep.id as string;
    };
    // Gold case: `hits` hold only the anchor; the RETURNED list is in the results tool + the raw payload.
    const repGold = await mkReport(tcGold, [
      step('a1', 'action', { toolName: 'search', toolArgs: { q: 'gel hand wraps' } }),
      step('r1', 'tool_result', { toolName: 'search', content: wrapped({ status: 'ok', hits: [{ id: '44793' }] }) }),
      step('a2', 'action', { toolName: 'expand_relations', toolArgs: { seed_ids: ['44793'] } }),
      step('r2', 'tool_result', { toolName: 'expand_relations', content: wrapped({ status: 'ok', forward: { records: [{ id: '290226' }, { id: '706155' }, { id: '116770' }] } }) }),
      step('a3', 'action', { toolName: 'return_results', toolArgs: { ids: ['290226', '706155', '116770'] } }),
      step('r3', 'tool_result', { toolName: 'return_results', content: wrapped({ status: 'ok', records: [{ id: '290226' }, { id: '706155' }, { id: '116770' }] }) }),
      step('resp', 'response', { content: 'Ranked results (3):\n1. id 290226 — first\n2. id 706155 — other\n3. id 116770 — second' }),
    ]);
    const repNoGold = await mkReport(tcNoGold, [step('r1', 'tool_result', { toolName: 'search', content: wrapped({ hits: [{ id: '1' }] }) })]);
    const repNone = await mkReport(tcNone, [
      step('r1', 'tool_result', { toolName: 'search', content: wrapped({ hits: [{ id: '956711' }] }) }),
      step('resp', 'response', { content: 'No results committed (results_source=abstain).' }),
    ], [{ answer: null, results: [], results_source: 'abstain' }]);

    const runId = `eval-run-det-preflight-int-${stamp()}`;
    const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: runId, name: 'preflight integration run', status: 'completed', agentKey: 'retrieval-agent', modelId: 'demo-model',
        judgeModelId: 'no-such-judge-provider/model-that-must-never-be-called',
        evaluatorId: evaluator.id,
        sources: [{ type: 'test-case-ids', ids: [tcGold, tcNoGold, tcNone] }], trigger: 'api',
        testCaseSnapshots: [tcGold, tcNoGold, tcNone].map(id => ({ id, version: 1, name: id })),
        results: {
          [tcGold]: { reportId: repGold, status: 'completed', passFailStatus: 'passed' },
          [tcNoGold]: { reportId: repNoGold, status: 'completed', passFailStatus: 'passed' },
          [tcNone]: { reportId: repNone, status: 'completed', passFailStatus: 'passed' },
        },
        createdAt: new Date().toISOString(),
      }),
    });
    expect(runRes.status).toBeLessThan(300);
    created.evalRuns.push(runId);
    const before = await Promise.all([repGold, repNoGold, repNone].map(id => get(`/api/storage/runs/${id}`)));

    // Pre-flight with the run's own evaluator (no body) — a deterministic evaluator forces scope 'all'.
    const preRes = await post(`/api/storage/evaluation-runs/${runId}/retry-judgement/preflight`);
    expect(preRes.status).toBe(200);
    const pre = await preRes.json();
    expect(pre).toMatchObject({ evaluatorId: evaluator.id, evaluatorName: evaluator.name, deterministic: true, scope: 'all', total: 3, evaluable: 2, notEvaluable: 1, abstain: 1 });
    expect(pre.reasons).toEqual({ 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)': 1 });
    const byCase = Object.fromEntries(pre.cases.map((c: any) => [c.testCaseId, c]));
    expect(byCase[tcGold]).toMatchObject({ evaluable: true });
    expect(byCase[tcGold].diagnostics).toMatchObject({
      gold: { source: 'expectedOutcomes[0]', ids: ['290226', '116770'], explicitlyEmpty: false },
      candidates: { sourceUsed: 'response-results', count: 3, anchorRemoved: 0, returned: true, weak: false },
      toolsScanned: ['search', 'expand_relations', 'return_results'],
    });
    expect(byCase[tcGold].diagnostics.candidates.sourceTried).toEqual(expect.arrayContaining([
      { source: 'response-results', count: 3, detail: 'final response (text)' },
      { source: 'results-tool', count: 3, detail: "tool 'return_results' records" },
      { source: 'tool-hits', count: 1, detail: "tool 'search' hits (hits / results)" },
    ]));
    expect(byCase[tcNoGold]).toMatchObject({ evaluable: false, reason: expect.stringMatching(/^no gold ids on the test case/) });
    expect(byCase[tcNoGold].diagnostics.gold).toEqual({ source: 'not declared', ids: [], explicitlyEmpty: false });
    expect(byCase[tcNone]).toMatchObject({ evaluable: true, abstain: true });
    expect(byCase[tcNone].diagnostics.gold).toEqual({ source: 'expectedOutcomes[0] (explicitly none)', ids: [], explicitlyEmpty: true });
    expect(byCase[tcNone].diagnostics.candidates).toMatchObject({ sourceUsed: 'response-results', count: 0, returned: true });

    // Read-only: no job, no report touched.
    expect((await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement/status`)).status).toBe(404);
    const after = await Promise.all([repGold, repNoGold, repNone].map(id => get(`/api/storage/runs/${id}`)));
    expect(after).toEqual(before);
    expect((await get(`/api/storage/evaluation-runs/${runId}`)).evaluatorId).toBe(evaluator.id);

    // Same validation as the POST.
    expect((await post(`/api/storage/evaluation-runs/${runId}/retry-judgement/preflight`, { scope: 'sometimes' })).status).toBe(400);
    expect((await post(`/api/storage/evaluation-runs/${runId}/retry-judgement/preflight`, { evaluatorId: 'eval-does-not-exist' })).status).toBe(400);
    expect((await post(`/api/storage/evaluation-runs/nope-${stamp()}/retry-judgement/preflight`)).status).toBe(404);

    // An LLM (system) evaluator: evaluability unknown up front — counts are the scope's selection.
    const llmPre = await (await post(`/api/storage/evaluation-runs/${runId}/retry-judgement/preflight`, { evaluatorId: 'system-rca-default', scope: 'all' })).json();
    expect(llmPre).toMatchObject({ evaluatorId: 'system-rca-default', deterministic: false, scope: 'all', total: 3, evaluable: 3, notEvaluable: 0, abstain: 0, reasons: {}, cases: [] });

    // The real retry agrees with the pre-flight, case for case.
    const start = await post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { scope: 'all', evaluatorId: evaluator.id });
    expect(start.status).toBe(202);
    const job = await pollRetryJudgement(runId);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ retried: 3, succeeded: 2, failed: 0, notEvaluable: 1, abstain: 1 });
    const outcome = Object.fromEntries(job.summary.results.map((r: any) => [r.testCaseId, r]));
    expect(outcome[tcGold]).toMatchObject({ outcome: 'succeeded', passFailStatus: 'passed' });
    expect(outcome[tcNoGold]).toMatchObject({ outcome: 'not-evaluable', reason: byCase[tcNoGold].reason, diagnostics: byCase[tcNoGold].diagnostics });
    expect(outcome[tcNone]).toMatchObject({ outcome: 'succeeded', passFailStatus: 'passed', abstain: true });

    const gold = await get(`/api/storage/runs/${repGold}`);
    expect(gold.metrics).toEqual({ 'hit@1': 1, 'hit@5': 1 });
    expect(gold.scoringSnapshot).toMatchObject({ goldIdsUsed: ['290226', '116770'], extractionRule: 'tool-hits-ordered', extraction: { sourceUsed: 'response-results', parsedFrom: 'text' } });
    expect(gold.scoringSnapshot.diagnostics).toEqual(byCase[tcGold].diagnostics);
    const none = await get(`/api/storage/runs/${repNone}`);
    expect(none).toMatchObject({ passFailStatus: 'passed', metrics: { abstain: 1 } });
    expect(none.scoringSnapshot).toMatchObject({ goldRule: 'expected-outcomes-none', notApplicable: ['hit@1', 'hit@5'] });
    // Owner rule: the not-evaluable case keeps its PREVIOUS judgement (the seeded
    // LLM verdict) byte-for-byte; the attempt is recorded on the report and the run.
    const noGold = await get(`/api/storage/runs/${repNoGold}`);
    const { lastRetryAttempt: noGoldAttempt, ...noGoldRest } = noGold;
    expect(noGoldRest).toEqual(before[1]);
    expect(noGold.passFailStatus).toBe('passed');
    expect(noGold.metricsStatus).toBe('ready');
    expect(noGold.llmJudgeReasoning).toBe('previous LLM judgement');
    expect(noGoldAttempt).toMatchObject({
      evaluatorId: evaluator.id, evaluatorName: evaluator.name, scope: 'all', outcome: 'not-evaluable',
      reason: byCase[tcNoGold].reason, diagnostics: byCase[tcNoGold].diagnostics,
    });
    expect(noGoldAttempt.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Successfully re-scored reports carry no attempt.
    expect(gold.lastRetryAttempt ?? null).toBeNull();
    const runDoc = await get(`/api/storage/evaluation-runs/${runId}`);
    // The preserved case still counts as passed — a failed attempt never demotes it to errored.
    expect(runDoc.stats).toMatchObject({ passed: 3, failed: 0, errored: 0, total: 3 });
    expect(runDoc.results[tcNoGold].passFailStatus).toBe('passed');
    expect(runDoc.lastRetryAttempt).toMatchObject({
      evaluatorId: evaluator.id, evaluatorName: evaluator.name, scope: 'all', retried: 3, succeeded: 2, notEvaluable: 1, failed: 0,
      reasons: { [byCase[tcNoGold].reason]: 1 },
    });
  }, 60000);
});
