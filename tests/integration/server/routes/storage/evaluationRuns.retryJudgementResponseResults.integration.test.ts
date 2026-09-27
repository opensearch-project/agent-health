/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the `response-results` prediction source and the `abstain`
 * metric end-to-end on a real server.
 *
 *   POST /api/storage/evaluators (kind: 'deterministic', prediction.source
 *     'response-results', an `abstain` metric) → 201; bad option types → 400
 *   seed a COMPLETED run whose reports carry a ranked-list RESPONSE (JSON,
 *     fenced JSON, rendered text list, an empty list, no response step) plus
 *     tool results the agent retrieved but did not recommend
 *   POST .../retry-judgement { scope: 'all', evaluatorId }
 *     → matcher rows show the ids parsed from the RESPONSE (not the tool
 *       hits), `parsedFrom` per report, the abstain row (n/a on gold cases,
 *       scored on the gold-empty case), ranked metrics 0 on an explicit
 *       empty list, the no-response AND the unrecognisable-response reports
 *       not evaluable; an abstain metric with tool-hits-ordered → 400.
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
  name: `Consumer-facing ranked results (integration ${stamp()})`,
  description: 'generic deterministic evaluator fixture — scores the returned list',
  kind: 'deterministic',
  metrics: [
    { name: 'hit@5', compute: { type: 'ranked-hit', k: 5 }, weight: 1, primary: true },
    { name: 'recall@20', compute: { type: 'ranked-recall', k: 20, denominator: 'full-gold' }, weight: 1, primary: true },
    { name: 'mrr', compute: { type: 'mrr' }, weight: 1 },
    { name: 'abstain', compute: { type: 'abstain' }, weight: 1, primary: true },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }, { metric: 'recall@20', min: 0.5 }, { metric: 'abstain', min: 1 }] },
  inputs: {
    gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' },
    prediction: { source: 'response-results', idField: 'id', rankField: 'rank' },
  },
});

// The agent RETRIEVED these (a tool result) but only RECOMMENDED a subset in its answer.
const retrievedStep = (ids: string[]) => ({
  id: `r-${stamp()}`, timestamp: Date.now(), type: 'tool_result', toolName: 'search products',
  content: JSON.stringify({ status: 'ok', hits: ids.map(id => ({ id, title: `item ${id}` })) }),
});
const rankedJson = (ids: string[], results_source = 'return_results') =>
  JSON.stringify({ answer: null, results: ids.map((id, i) => ({ id, rank: i + 1, score: 1 - i / 10, title: `item ${id}` })), results_source });
const responseStep = (content: string) => ({ id: `a-${stamp()}`, timestamp: Date.now(), type: 'response', content });

describe('deterministic evaluators — response-results source + abstain metric', () => {
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

  const post = async (path: string, body: unknown) =>
    fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('rejects malformed response-results options and unknown sources with 400', async () => {
    if (!backendAvailable) return;
    const badPath = await post('/api/storage/evaluators', { ...evaluatorBody(), inputs: { ...evaluatorBody().inputs, prediction: { source: 'response-results', path: 42 } } });
    expect(badPath.status).toBe(400);
    expect((await badPath.json()).error).toMatch(/prediction.path must be a non-empty string/);
    const badSource = await post('/api/storage/evaluators', { ...evaluatorBody(), inputs: { ...evaluatorBody().inputs, prediction: { source: 'report.output' } } });
    expect(badSource.status).toBe(400);
    expect((await badSource.json()).error).toMatch(/must be 'tool-hits-ordered' or 'response-results'/);
    const abstainWithToolHits = await post('/api/storage/evaluators', { ...evaluatorBody(), inputs: { ...evaluatorBody().inputs, prediction: { source: 'tool-hits-ordered' } } });
    expect(abstainWithToolHits.status).toBe(400);
    expect((await abstainWithToolHits.json()).error).toMatch(/'abstain' metric requires inputs.prediction.source 'response-results'/);
  });

  it('creates the evaluator, re-scores a completed run from the RETURNED lists, and scores abstain on the gold-empty case', async () => {
    if (!backendAvailable) return;

    // 1. Evaluator.
    const evRes = await post('/api/storage/evaluators', evaluatorBody());
    expect(evRes.status).toBe(201);
    const evaluator = await evRes.json();
    created.evaluators.push(evaluator.id);
    expect(evaluator.inputs.prediction).toEqual({ source: 'response-results', idField: 'id', rankField: 'rank' });
    expect(evaluator.metrics[3]).toMatchObject({ name: 'abstain', compute: { type: 'abstain' }, scale: { min: 0, max: 1 } });
    expect(evaluator.scoringConfig.metrics.map((m: any) => m.name)).toEqual(['hit@5', 'recall@20', 'mrr', 'abstain']);

    // 2. Test cases (generic gold lines; one explicitly gold-empty).
    const mkCase = async (name: string, goldLine: string) => {
      const r = await post('/api/storage/test-cases', {
        name: `det-rr-int-${name}-${stamp()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'search products',
        expectedOutcomes: ['The agent returns a ranked list', goldLine],
        context: [], labels: ['@integration-test'],
      });
      expect(r.status).toBeLessThan(300);
      const tc = await r.json();
      created.testCases.push(tc.id);
      return tc.id as string;
    };
    const tcJson = await mkCase('json', 'Gold id(s): 101, 202');
    const tcFenced = await mkCase('fenced', 'Gold id(s): 303');
    const tcText = await mkCase('text', 'Gold id(s): 404, 505');
    const tcEmptyList = await mkCase('emptylist', 'Gold id(s): 606');
    const tcAbstainOk = await mkCase('abstain-ok', 'Gold id(s): none');
    const tcAbstainBad = await mkCase('abstain-bad', 'Gold id(s): none');
    const tcNoResponse = await mkCase('noresponse', 'Gold id(s): 707');
    const tcProse = await mkCase('prose', 'Gold id(s): 808');

    // 3. Completed run with stored trajectories. Every report also carries a
    //    tool result with the gold id RETRIEVED, so a tool-hits scorer would
    //    credit it — only the RETURNED list must count here.
    const mkReport = async (testCaseId: string, trajectory: unknown[]) => {
      const r = await post('/api/storage/runs', {
        id: `report-det-rr-int-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
        agentName: 'Retrieval Agent', agentKey: 'retrieval-agent', modelName: 'demo-model', modelId: 'demo-model',
        status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed',
        trajectory, metrics: { accuracy: 90 }, llmJudgeReasoning: 'previous LLM judgement',
      });
      expect(r.status).toBeLessThan(300);
      const rep = await r.json();
      created.reports.push(rep.id);
      return rep.id as string;
    };
    // json: retrieved [101, 202, 9, 8]; returned [9, 202] → hit@5 1, recall 1/2, mrr 1/2; abstain n/a → passed
    const repJson = await mkReport(tcJson, [retrievedStep(['101', '202', '9', '8']), responseStep(rankedJson(['9', '202']))]);
    // fenced: retrieved [303]; returned (fenced, ranks reversed in array order) [303 rank 1 after sort] → hit@5 1, recall 1 → passed
    const fenced = 'Top results:\n```json\n{"results":[{"id":"12","rank":2},{"id":"303","rank":1}]}\n```\n';
    const repFenced = await mkReport(tcFenced, [retrievedStep(['303']), responseStep(fenced)]);
    // text: retrieved [404, 505, 1]; rendered list returns only [1, 505] → hit@5 1, recall 1/2 → passed (recall gate 0.5 met)
    const text = 'Ranked results (2, source=return_results):\n1. id 1 — item one (score 6.3)\n2. id 505 — item two (score 5.1)\nAnchor ids (excluded): 33, 44';
    const repText = await mkReport(tcText, [retrievedStep(['404', '505', '1']), responseStep(text)]);
    // empty list: retrieved [606] but returned [] → hit@5 0, recall 0, mrr 0 → failed (real outcome, not unevaluable)
    const repEmpty = await mkReport(tcEmptyList, [retrievedStep(['606']), responseStep(rankedJson([], 'abstain'))]);
    // abstain ok: gold empty, returned [] → abstain 1, ranked n/a → passed
    const repAbstainOk = await mkReport(tcAbstainOk, [retrievedStep(['1', '2']), responseStep(rankedJson([], 'abstain'))]);
    // abstain bad: gold empty, returned [1] → abstain 0 → failed
    const repAbstainBad = await mkReport(tcAbstainBad, [retrievedStep(['1', '2']), responseStep(rankedJson(['1']))]);
    // no response step at all → not evaluable
    const repNoResponse = await mkReport(tcNoResponse, [retrievedStep(['707'])]);
    // a prose answer with no recognisable list → not evaluable (never scored as 0)
    const repProse = await mkReport(tcProse, [retrievedStep(['808']), responseStep('I found a few things but nothing definitive; product 808 might be relevant.')]);

    const cases: Record<string, string> = {
      [tcJson]: repJson, [tcFenced]: repFenced, [tcText]: repText, [tcEmptyList]: repEmpty,
      [tcAbstainOk]: repAbstainOk, [tcAbstainBad]: repAbstainBad, [tcNoResponse]: repNoResponse, [tcProse]: repProse,
    };
    const runId = `eval-run-det-rr-int-${stamp()}`;
    const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: runId, name: 'response-results integration run', status: 'completed', agentKey: 'retrieval-agent', modelId: 'demo-model',
        judgeModelId: 'no-such-judge-provider/model-that-must-never-be-called',
        sources: [{ type: 'test-case-ids', ids: Object.keys(cases) }], trigger: 'api',
        testCaseSnapshots: Object.keys(cases).map(id => ({ id, version: 1, name: id })),
        results: Object.fromEntries(Object.entries(cases).map(([tc, reportId]) => [tc, { reportId, status: 'completed', passFailStatus: 'passed' }])),
        createdAt: new Date().toISOString(),
      }),
    });
    expect(runRes.status).toBeLessThan(300);
    created.evalRuns.push(runId);

    // 4. Retry judgement with the deterministic evaluator.
    const start = await post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { scope: 'all', evaluatorId: evaluator.id });
    expect(start.status).toBe(202);
    const job = await pollRetryJudgement(runId);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ retried: 8, succeeded: 6, failed: 2 });

    // 5. Reports.
    const get = async (id: string) => (await fetch(`${BASE_URL}/api/storage/runs/${id}`)).json();
    const rowOf = (rep: any, name: string) => rep.matcherResults.find((m: any) => m.description.startsWith(`${name} `));

    const json = await get(repJson);
    expect(json.judgeMode).toBe('deterministic');
    expect(json.passFailStatus).toBe('passed');
    expect(json.metrics).toEqual({ 'hit@5': 1, 'recall@20': 0.5, mrr: 0.5 });
    expect(json.scoringSnapshot).toMatchObject({
      goldRule: 'expected-outcomes-pattern', goldIdsUsed: ['101', '202'],
      extractionRule: 'response-results', extraction: { candidateCount: 2, parsedFrom: 'json' },
      unevaluable: [], notApplicable: ['abstain'], primaryMetrics: ['hit@5', 'recall@20', 'abstain'],
    });
    expect(json.scoringSnapshot.extraction).not.toHaveProperty('citedCount');
    // The RETURNED ids — not the retrieved 101 / 8.
    expect(rowOf(json, 'hit@5').details).toMatchObject({ gold: ['101', '202'], predicted: ['9', '202'], predictedTotal: 2, k: 5, extractionRule: 'response-results', parsedFrom: 'json' });
    expect(rowOf(json, 'hit@5')).toMatchObject({ pass: true, role: 'primary', actual: 1, expected: 1 });
    const abstainRow = rowOf(json, 'abstain');
    expect(abstainRow).toMatchObject({ pass: true, role: 'observe', method: 'code-assertion', notApplicable: true });
    expect(abstainRow.details.notApplicableReason).toMatch(/abstain only scores cases whose gold is explicitly empty/);
    expect(abstainRow.errored ?? undefined).toBeUndefined();
    expect(json.llmJudgeReasoning).toBe('');

    const fencedRep = await get(repFenced);
    expect(fencedRep.passFailStatus).toBe('passed');
    expect(fencedRep.metrics).toEqual({ 'hit@5': 1, 'recall@20': 1, mrr: 1 });
    expect(fencedRep.scoringSnapshot.extraction).toEqual({ candidateCount: 2, parsedFrom: 'fenced' });
    expect(rowOf(fencedRep, 'mrr').details.predicted).toEqual(['303', '12']); // ordered by rank, not array order

    const textRep = await get(repText);
    expect(textRep.passFailStatus).toBe('passed');
    expect(textRep.metrics).toEqual({ 'hit@5': 1, 'recall@20': 0.5, mrr: 0.5 });
    expect(textRep.scoringSnapshot.extraction).toEqual({ candidateCount: 2, parsedFrom: 'text' });
    expect(rowOf(textRep, 'hit@5').details.predicted).toEqual(['1', '505']); // anchor line ignored (not a list line)

    const emptyRep = await get(repEmpty);
    expect(emptyRep.metricsStatus).toBe('completed');
    expect(emptyRep.passFailStatus).toBe('failed');
    expect(emptyRep.metrics).toEqual({ 'hit@5': 0, 'recall@20': 0, mrr: 0 });
    expect(emptyRep.scoringSnapshot).toMatchObject({ extraction: { candidateCount: 0, parsedFrom: 'json' }, unevaluable: [], notApplicable: ['abstain'] });
    expect(rowOf(emptyRep, 'hit@5')).toMatchObject({ pass: false, actual: 0 });
    expect(rowOf(emptyRep, 'hit@5').details.predicted).toEqual([]);

    const abstainOk = await get(repAbstainOk);
    expect(abstainOk.passFailStatus).toBe('passed');
    expect(abstainOk.metrics).toEqual({ abstain: 1 });
    expect(abstainOk.scoringSnapshot).toMatchObject({ goldIdsUsed: [], goldRule: 'expected-outcomes-pattern', notApplicable: ['hit@5', 'recall@20', 'mrr'], unevaluable: [] });
    expect(rowOf(abstainOk, 'abstain')).toMatchObject({ pass: true, role: 'primary', actual: 1, expected: 1 });
    expect(rowOf(abstainOk, 'hit@5')).toMatchObject({ pass: true, role: 'observe', notApplicable: true });
    expect(rowOf(abstainOk, 'hit@5').details).toMatchObject({ gold: [], predicted: [] });

    const abstainBad = await get(repAbstainBad);
    expect(abstainBad.passFailStatus).toBe('failed');
    expect(abstainBad.metrics).toEqual({ abstain: 0 });
    expect(rowOf(abstainBad, 'abstain')).toMatchObject({ pass: false, actual: 0 });

    const noResp = await get(repNoResponse);
    expect(noResp.metricsStatus).toBe('error');
    expect(noResp.passFailStatus ?? null).toBeNull();
    expect(noResp.metrics).toEqual({});
    expect(noResp.traceError).toMatch(/Not evaluable by .*no final response step/);
    expect(noResp.scoringSnapshot.unevaluable).toEqual(['hit@5', 'recall@20', 'mrr', 'abstain']);

    const prose = await get(repProse);
    expect(prose.metricsStatus).toBe('error');
    expect(prose.passFailStatus ?? null).toBeNull();
    expect(prose.metrics).toEqual({});
    expect(prose.traceError).toMatch(/no ranked list recognised in the final response/);
    expect(prose.scoringSnapshot.extraction).toEqual({ candidateCount: 0, parsedFrom: 'none' });

    // 6. Run doc.
    const run = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json();
    expect(run.evaluatorId).toBe(evaluator.id);
    expect(run.stats).toMatchObject({ passed: 4, failed: 2, errored: 2, total: 8 });
  }, 60000);
});
