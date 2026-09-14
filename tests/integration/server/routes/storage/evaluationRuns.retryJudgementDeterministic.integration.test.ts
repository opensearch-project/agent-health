/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: deterministic evaluators end-to-end on a real server.
 *
 *   POST /api/storage/evaluators  (kind: 'deterministic')  → 201; validation 400s
 *   import generic test cases whose expectedOutcomes carry a gold line
 *   seed a COMPLETED run whose reports carry a stored trajectory (generic
 *     tool names `search` / `expand`, hits under `hits[].id`, an answer that
 *     cites some ids)
 *   POST .../retry-judgement { scope: 'all', evaluatorId }
 *     → reports carry metrics + scoringSnapshot (goldRule, extractionRule,
 *       primaryMetrics) + code-assertion matcher rows; run stats recomputed;
 *       NO LLM was called (the run's judgeModelId points at a provider that
 *       would fail loudly if the LLM path ran, and the report carries no
 *       llmJudgeResponse); a report without hits ⇒ not evaluable (errored).
 *   GET /api/storage/evaluation-runs/:id → compare payload inputs carry the
 *     snapshot's primary metrics per report.
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
  name: `Ranked retrieval (integration ${stamp()})`,
  description: 'generic deterministic evaluator fixture',
  kind: 'deterministic',
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
});

const hitsStep = (ids: string[], wrap = false) => {
  const payload = { status: 'ok', hits: ids.map(id => ({ id, title: `item ${id}` })) };
  return { id: `r-${stamp()}`, timestamp: Date.now(), type: 'tool_result', toolName: 'search', content: wrap ? JSON.stringify([{ text: JSON.stringify(payload) }]) : JSON.stringify(payload) };
};

describe('deterministic evaluators — create, validate, Retry judgement on a completed run', () => {
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

  it('rejects llm-verdict pass policies and unknown compute types with 400', async () => {
    if (!backendAvailable) return;
    const llmVerdict = await post('/api/storage/evaluators', { ...evaluatorBody(), passPolicy: { kind: 'llm-verdict' } });
    expect(llmVerdict.status).toBe(400);
    expect((await llmVerdict.json()).error).toMatch(/'llm-verdict' is not allowed/);
    const badType = await post('/api/storage/evaluators', { ...evaluatorBody(), metrics: [{ name: 'x', compute: { type: 'ndcg', k: 5 }, weight: 1 }] });
    expect(badType.status).toBe(400);
    expect((await badType.json()).error).toMatch(/unknown compute type "ndcg"/);
  });

  it('creates a deterministic evaluator (no prompt), re-scores a completed run without any LLM call, and exposes primary metrics', async () => {
    if (!backendAvailable) return;

    // 1. Evaluator.
    const evRes = await post('/api/storage/evaluators', evaluatorBody());
    expect(evRes.status).toBe(201);
    const evaluator = await evRes.json();
    created.evaluators.push(evaluator.id);
    expect(evaluator.kind).toBe('deterministic');
    expect(evaluator.systemPrompt).toBe('');
    expect(evaluator.scoringConfig.metrics.map((m: any) => m.name)).toEqual(['hit@1', 'hit@3', 'recall@5', 'mrr']);
    const fetched = await (await fetch(`${BASE_URL}/api/storage/evaluators/${evaluator.id}`)).json();
    expect(fetched.metrics).toHaveLength(4);
    expect(fetched.passPolicy).toEqual({ kind: 'gates', gates: [{ metric: 'hit@3', min: 1 }] });
    expect(fetched.inputs.prediction.anchorTools).toEqual([{ tool: 'expand', argKey: 'seed_ids' }]);

    // 2. Test cases with a gold line (generic).
    const mkCase = async (name: string, goldLine: string | null) => {
      const r = await post('/api/storage/test-cases', {
        name: `det-int-${name}-${stamp()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'find the related items',
        expectedOutcomes: ['The agent lists related items', ...(goldLine ? [goldLine] : [])],
        context: [], labels: ['@integration-test'],
      });
      expect(r.status).toBeLessThan(300);
      const tc = await r.json();
      created.testCases.push(tc.id);
      return tc.id as string;
    };
    const tcHit = await mkCase('hit', 'Gold id(s): 101, 202');
    const tcMiss = await mkCase('miss', 'Gold id(s): 303');
    const tcNoHits = await mkCase('nohits', 'Gold id(s): 404');
    const tcNoGold = await mkCase('nogold', null);

    // 3. Completed run with stored trajectories.
    const mkReport = async (testCaseId: string, trajectory: unknown[]) => {
      const r = await post('/api/storage/runs', {
        id: `report-det-int-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
        agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
        status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed',
        trajectory, metrics: { accuracy: 90 },
        llmJudgeReasoning: 'previous LLM judgement',
        llmJudgeResponse: { modelId: 'old-judge', timestamp: new Date().toISOString(), promptTokens: 1, completionTokens: 1, latencyMs: 1, rawResponse: '{}' },
        matcherResults: [{ description: 'judge: expected outcomes', pass: true, method: 'llm-judge' }],
      });
      expect(r.status).toBeLessThan(300);
      const rep = await r.json();
      created.reports.push(rep.id);
      return rep.id as string;
    };
    // hit: search → [7, 101, 9]; expand(seed 101) → [202, 101, 55] (wrapped); answer cites 202 then 101.
    //   retrieved (most recent first) = [202, 101, 55, 7, 9] → minus anchor 101 → cited first: [202] → ranked [202, 55, 7, 9]
    //   gold {101, 202}: hit@1 = 1, hit@3 = 1, recall@5 = 1/2, mrr = 1 → passed
    const repHit = await mkReport(tcHit, [
      { id: 'a1', timestamp: 1, type: 'action', toolName: 'search', toolArgs: { q: 'x' }, content: '{}' },
      hitsStep(['7', '101', '9']),
      { id: 'a2', timestamp: 2, type: 'action', toolName: 'expand', toolArgs: { seed_ids: ['101'] }, content: '{}' },
      hitsStep(['202', '101', '55'], true),
      { id: 'a3', timestamp: 3, type: 'response', content: 'Best match: (id: 202), which relates to (id: 101).' },
    ]);
    // miss: gold 303 never retrieved → hit@1 0, hit@3 0, recall 0, mrr 0 → failed (gate)
    const repMiss = await mkReport(tcMiss, [hitsStep(['1', '2', '3', '4'])]);
    // no hits: answer only → not evaluable
    const repNoHits = await mkReport(tcNoHits, [{ id: 'a4', timestamp: 4, type: 'response', content: 'I could not find anything.' }]);
    // no gold: hits present but no gold line → not evaluable
    const repNoGold = await mkReport(tcNoGold, [hitsStep(['1'])]);

    const runId = `eval-run-det-int-${stamp()}`;
    const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: runId, name: 'deterministic integration run', status: 'completed', agentKey: 'demo', modelId: 'demo-model',
        // A judge model that does NOT exist: if the LLM path ran, the judge
        // would fail and the reports would land as metricsStatus 'error' with
        // a judge_failed traceError instead of code-computed metrics.
        judgeModelId: 'no-such-judge-provider/model-that-must-never-be-called',
        sources: [{ type: 'test-case-ids', ids: [tcHit, tcMiss, tcNoHits, tcNoGold] }], trigger: 'api',
        testCaseSnapshots: [tcHit, tcMiss, tcNoHits, tcNoGold].map(id => ({ id, version: 1, name: id })),
        results: {
          [tcHit]: { reportId: repHit, status: 'completed', passFailStatus: 'passed' },
          [tcMiss]: { reportId: repMiss, status: 'completed', passFailStatus: 'passed' },
          [tcNoHits]: { reportId: repNoHits, status: 'completed', passFailStatus: 'passed' },
          [tcNoGold]: { reportId: repNoGold, status: 'completed', passFailStatus: 'passed' },
        },
        createdAt: new Date().toISOString(),
      }),
    });
    expect(runRes.status).toBeLessThan(300);
    created.evalRuns.push(runId);

    // 4. Retry judgement with the deterministic evaluator.
    const start = await post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { scope: 'all', evaluatorId: evaluator.id });
    expect(start.status).toBe(202);
    expect((await start.json()).total).toBe(4);
    const job = await pollRetryJudgement(runId);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ retried: 4, succeeded: 2, failed: 2 });

    // 5. Reports.
    const get = async (id: string) => (await fetch(`${BASE_URL}/api/storage/runs/${id}`)).json();
    const hit = await get(repHit);
    expect(hit.judgeMode).toBe('deterministic');
    expect(hit.evaluatorId).toBe(evaluator.id);
    expect(hit.passFailStatus).toBe('passed');
    expect(hit.metricsStatus).toBe('completed');
    expect(hit.metrics).toEqual({ 'hit@1': 1, 'hit@3': 1, 'recall@5': 0.5, mrr: 1 });
    expect(hit.scoringSnapshot).toMatchObject({
      evaluatorId: evaluator.id, evaluatorVersion: 1, evaluatorName: evaluator.name,
      weights: { 'hit@1': 0.25, 'hit@3': 0.25, 'recall@5': 0.25, mrr: 0.25 },
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@3', min: 1 }] },
      primaryMetrics: ['hit@1', 'hit@3', 'recall@5'],
      goldRule: 'expected-outcomes-pattern', goldIdsUsed: ['101', '202'],
      extractionRule: 'tool-hits-ordered',
      extraction: { candidateCount: 5, citedCount: 1, anchorsRemoved: 1 },
      unevaluable: [],
    });
    expect(hit.scoringSnapshot.contentHash).toMatch(/^sha256:/);
    expect(hit.matcherResults).toHaveLength(4);
    expect(hit.matcherResults.map((m: any) => [m.method, m.role, m.pass])).toEqual([
      ['code-assertion', 'observe', true], ['code-assertion', 'primary', true], ['code-assertion', 'observe', true], ['code-assertion', 'observe', true],
    ]);
    expect(hit.matcherResults[1].details).toMatchObject({ gold: ['101', '202'], predicted: ['202', '55', '7', '9'], k: 3, extractionRule: 'tool-hits-ordered' });
    // No LLM artefacts survive: the previous judge reasoning/response/matcher row are gone.
    expect(hit.llmJudgeReasoning).toBe('');
    expect(hit.llmJudgeResponse ?? null).toBeNull();
    expect(hit.matcherResults.some((m: any) => m.method === 'llm-judge')).toBe(false);
    expect(hit.traceError ?? undefined).toBeUndefined();

    const miss = await get(repMiss);
    expect(miss.passFailStatus).toBe('failed');
    expect(miss.metrics).toEqual({ 'hit@1': 0, 'hit@3': 0, 'recall@5': 0, mrr: 0 });
    expect(miss.matcherResults[1]).toMatchObject({ role: 'primary', pass: false });

    for (const [id, reason] of [[repNoHits, /no candidate ids/], [repNoGold, /no gold ids/]] as const) {
      const rep = await get(id);
      expect(rep.metricsStatus).toBe('error');
      expect(rep.passFailStatus ?? null).toBeNull();
      expect(rep.metrics).toEqual({});
      expect(rep.traceError).toMatch(/Not evaluable by/);
      expect(rep.scoringSnapshot.unevaluable).toEqual(['hit@1', 'hit@3', 'recall@5', 'mrr']);
      expect(rep.matcherResults.every((m: any) => m.errored === true)).toBe(true);
      expect(rep.matcherResults[0].errorMessage).toMatch(reason);
      // Never a judge_failed LLM error: the message names the evaluator, not a provider.
      expect(rep.traceError).not.toMatch(/no-such-judge-provider/);
    }

    // 6. Run doc: stats recomputed, evaluator stamped; per-report primary metrics reachable for compare.
    const run = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json();
    expect(run.evaluatorId).toBe(evaluator.id);
    expect(run.stats).toMatchObject({ passed: 1, failed: 1, errored: 2, total: 4 });
    expect(run.results[tcHit].passFailStatus).toBe('passed');
    expect(run.results[tcMiss].passFailStatus).toBe('failed');
    expect(run.results[tcNoHits].passFailStatus).toBeUndefined();
    const reportIds = Object.values(run.results).map((r: any) => r.reportId);
    const reports = await Promise.all(reportIds.map(get));
    const evaluated = reports.filter(r => r.metricsStatus === 'completed');
    expect(evaluated).toHaveLength(2);
    for (const r of evaluated) {
      expect(r.scoringSnapshot.primaryMetrics).toEqual(['hit@1', 'hit@3', 'recall@5']);
      for (const name of r.scoringSnapshot.primaryMetrics) expect(typeof r.metrics[name]).toBe('number');
    }

    // 7. Re-running is idempotent (same inputs → same snapshot hash / verdicts).
    const again = await post(`/api/storage/evaluation-runs/${runId}/retry-judgement`, { scope: 'all', evaluatorId: evaluator.id });
    expect(again.status).toBe(202);
    await pollRetryJudgement(runId);
    const hit2 = await get(repHit);
    expect(hit2.scoringSnapshot.contentHash).toBe(hit.scoringSnapshot.contentHash);
    expect(hit2.metrics).toEqual(hit.metrics);
  }, 60000);
});
