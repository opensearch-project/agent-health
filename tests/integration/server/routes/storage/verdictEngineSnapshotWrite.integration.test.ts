/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: canonical verdict engine + scoring-snapshot WRITE path.
 *
 * Boots nothing itself — talks to the backend at AH_PORT (file storage is
 * fine) and hosts an in-process OpenAI-compatible STUB judge so the metrics
 * the "LLM" returns are fully controlled. The backend must have been started
 * with `OPENAI_COMPATIBLE_ENDPOINT=http://127.0.0.1:<STUB_PORT>/v1/chat/completions`
 * (see STUB_PORT below; override with AH_STUB_JUDGE_PORT). Tests skip
 * cleanly when the backend or the stub wiring is not available.
 *
 * Scenarios are selected by a `SCENARIO:<name>` token in the test case's
 * expectedOutcomes, which reach the judge's user prompt verbatim:
 *   conflict  → LLM says passed, rubrics 60/60  (threshold 0.7 ⇒ computed FAILED, conflict)
 *   pass      → LLM says passed, rubrics 90/80  (computed passed)
 *   partial   → LLM says passed, one rubric omitted (unevaluable ⇒ failed under threshold)
 *
 * Covers (task R2):
 *   (a) threshold evaluator → reports carry scoringSnapshot + score + computed verdict;
 *       compare payload shows Avg score = weighted mean and "Pass rate (score ≥ 0.7)"
 *   (b) llm-verdict evaluator → verdict = LLM's, snapshot still written
 *   (c) judge failure (4xx: unknown evaluator) → NO metrics, metricsStatus error,
 *       run stats count it errored, compare shows errored N
 *   (d) retry judgement (scope=all) on a completed run REPLACES the snapshot
 *       after the evaluator changed (no history) and recomputes stats
 *   (e) evaluator PUT that changes weights → new version + new contentHash for
 *       NEW judgements; already-persisted reports keep their old snapshot
 */

import http from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';
import { calculateRunAggregates } from '@/services/comparisonService';
import { passRateHeaderLabel } from '@/lib/comparison/scoringDisplay';
import { evaluatorContentHash } from '@/lib/scoring/applyScoring';
import { computeRunStats } from '@/lib/runStats';
import type { EvaluationReport, ExperimentRun } from '@/types';

const BASE_URL = getTestBackendUrl();
const STUB_PORT = Number(process.env.AH_STUB_JUDGE_PORT || 4871);
const TEST_TIMEOUT = 90_000;

const tracker = createTestDataTracker();

// ─── Stub OpenAI-compatible judge ────────────────────────────────────────────
const stubCalls: Array<{ scenario: string }> = [];

function scenarioResponse(scenario: string): unknown {
  switch (scenario) {
    case 'conflict':
      return { pass_fail_status: 'passed', reasoning: 'stub: looks fine', metrics: { relevance: 60, grounding: 60 } };
    case 'partial':
      return { pass_fail_status: 'passed', reasoning: 'stub: partial', metrics: { relevance: 95 } };
    case 'pass':
    default:
      return { pass_fail_status: 'passed', reasoning: 'stub: good', metrics: { relevance: 90, grounding: 80 } };
  }
}

let stub: http.Server | undefined;
function startStub(): Promise<void> {
  return new Promise((resolve, reject) => {
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let scenario = 'pass';
        try {
          const parsed = JSON.parse(body);
          const user = String(parsed?.messages?.find((m: any) => m.role === 'user')?.content ?? '');
          const m = user.match(/SCENARIO:([a-z]+)/);
          if (m) scenario = m[1];
        } catch { /* default scenario */ }
        stubCalls.push({ scenario });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(scenarioResponse(scenario)) } }] }));
      });
    });
    stub.once('error', reject);
    stub.listen(STUB_PORT, '127.0.0.1', () => resolve());
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, ok: res.ok, json, text };
};

const backendAvailable = async () => {
  try {
    const r = await api('GET', '/api/storage/health');
    return r.ok && r.json?.status === 'ok';
  } catch { return false; }
};

/** Is the backend actually wired to our stub? Probe with a throwaway evaluator. */
async function stubWired(evaluatorId: string): Promise<boolean> {
  const r = await api('POST', '/api/judge', {
    trajectory: [{ type: 'assistant', content: 'probe' }],
    expectedOutcomes: ['SCENARIO:pass probe'],
    evaluatorId,
    modelId: 'stub-judge',
  });
  return r.ok && r.json?.metrics?.relevance === 90;
}

function evaluatorBody(name: string, passPolicy: any, weights = { relevance: 0.5, grounding: 0.5 }) {
  return {
    name,
    description: 'verdict engine integration fixture',
    systemPrompt: 'You are a judge. Return JSON.',
    scoringConfig: {
      metrics: [
        { name: 'relevance', weight: weights.relevance, scale: 100 },
        { name: 'grounding', weight: weights.grounding, scale: 100 },
      ],
      passThreshold: 70,
      scale: 100,
      passPolicy,
    },
    inferenceConfig: { provider: 'openai-compatible', modelId: 'stub-judge' },
  };
}

async function createEvaluator(name: string, passPolicy: any): Promise<any> {
  const r = await api('POST', '/api/storage/evaluators', evaluatorBody(name, passPolicy));
  if (!r.ok) throw new Error(`create evaluator: ${r.status} ${r.text}`);
  tracker.evaluator(r.json.id);
  return r.json;
}

async function createTestCase(scenario: string): Promise<string> {
  const r = await api('POST', '/api/storage/test-cases', {
    name: uniqueTestName(`verdict-${scenario}`),
    category: 'Test',
    difficulty: 'Easy',
    initialPrompt: `Answer the question (${scenario})`,
    expectedOutcomes: [`SCENARIO:${scenario} the answer cites the right document`],
    context: [],
    expectedTrajectory: [],
    labels: ['@integration-test'],
  });
  if (!r.ok) throw new Error(`create test case: ${r.status} ${r.text}`);
  tracker.testCase(r.json.id);
  return r.json.id;
}

/** Start an evaluation run (SSE) and wait for the persisted doc to reach a terminal state. */
async function runEvaluation(testCaseIds: string[], evaluatorId: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uniqueTestName('verdict-run'),
      sources: [{ type: 'test-case-ids', ids: testCaseIds }],
      agentKey: 'demo',
      judgeModelId: 'stub-judge',
      evaluatorId,
      concurrency: 2,
      trigger: 'api',
    }),
  });
  if (!res.ok) throw new Error(`start run: ${res.status} ${await res.text()}`);
  const text = await res.text(); // drain the SSE stream to completion
  const started = text.match(/"id":"(eval-run-[^"]+)"/);
  if (!started) throw new Error(`no run id in SSE: ${text.slice(0, 300)}`);
  const runId = started[1];
  tracker.evaluationRun(runId);
  for (let i = 0; i < 100; i++) {
    const r = await api('GET', `/api/storage/evaluation-runs/${runId}`);
    const run = r.json?.evaluationRun ?? r.json;
    if (run?.status && run.status !== 'running') {
      for (const result of Object.values(run.results ?? {}) as any[]) tracker.run(result.reportId);
      return run;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`run ${runId} did not finish`);
}

async function getReport(id: string): Promise<EvaluationReport> {
  const r = await api('GET', `/api/storage/runs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`get report ${id}: ${r.status}`);
  return r.json.run ?? r.json;
}

async function pollRetryJudgement(runId: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const r = await api('GET', `/api/storage/evaluation-runs/${runId}/retry-judgement/status`);
    if (r.ok && (r.json.status === 'completed' || r.json.status === 'failed')) return r.json;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error('retry-judgement did not finish');
}

// ─── tests ───────────────────────────────────────────────────────────────────
describe('verdict engine + scoring snapshot write path (integration)', () => {
  let available = false;

  beforeAll(async () => {
    available = await backendAvailable();
    if (!available) { console.warn(`Backend not available at ${BASE_URL}; skipping`); return; }
    try { await startStub(); } catch (e) { console.warn(`stub judge port ${STUB_PORT} busy: ${e}`); available = false; return; }
    const probe = await createEvaluator(uniqueTestName('verdict-probe'), { kind: 'llm-verdict' });
    available = await stubWired(probe.id);
    if (!available) console.warn('Backend is not wired to the stub judge (OPENAI_COMPATIBLE_ENDPOINT); skipping');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await tracker.cleanup();
    await new Promise<void>(resolve => (stub ? stub.close(() => resolve()) : resolve()));
  }, TEST_TIMEOUT);

  it('(a) threshold evaluator: reports carry snapshot + score + COMPUTED verdict; compare shows weighted Avg score and the policy-labelled pass rate', async () => {
    if (!available) return;
    const evaluator = await createEvaluator(uniqueTestName('verdict-threshold'), { kind: 'threshold', minScore: 0.7 });
    const conflictCase = await createTestCase('conflict');
    const passCase = await createTestCase('pass');
    const run = await runEvaluation([conflictCase, passCase], evaluator.id);
    expect(run.status).toBe('completed');

    const conflictReport = await getReport(run.results[conflictCase].reportId);
    const passReport = await getReport(run.results[passCase].reportId);

    // The LLM said "passed" for both; the engine disagrees on the 60/60 case.
    expect(conflictReport.metrics).toEqual({ relevance: 60, grounding: 60 });
    expect(conflictReport.score).toBeCloseTo(0.6, 9);
    expect(conflictReport.passFailStatus).toBe('failed');
    expect(conflictReport.llmVerdict).toBe('passed');
    expect(conflictReport.verdictConflict).toBe(true);
    expect(conflictReport.scoringSnapshot).toMatchObject({
      evaluatorId: evaluator.id,
      evaluatorVersion: 1,
      contentHash: evaluatorContentHash(evaluator),
      evaluatorName: evaluator.name,
      weights: { relevance: 0.5, grounding: 0.5 },
      passPolicy: { kind: 'threshold', minScore: 0.7 },
      judgeModelId: 'stub-judge',
    });
    expect(conflictReport.scoringSnapshot?.unevaluable).toBeUndefined();

    expect(passReport.score).toBeCloseTo(0.85, 9);
    expect(passReport.passFailStatus).toBe('passed');
    expect(passReport.verdictConflict).toBe(false);

    // Run-level result mirrors the COMPUTED verdict, not the LLM's.
    expect(run.results[conflictCase].passFailStatus).toBe('failed');
    expect(run.results[passCase].passFailStatus).toBe('passed');

    // Compare payload (R1 read model over the snapshots this PR wrote).
    const agg = calculateRunAggregates(run as ExperimentRun, {
      [conflictReport.id]: conflictReport,
      [passReport.id]: passReport,
    });
    expect(agg.avgScore).toBe(73); // mean(0.60, 0.85) = 0.725 → 73
    expect(agg.scoring).toMatchObject({ source: 'snapshot', passPolicy: { kind: 'threshold', minScore: 0.7 }, scoredReports: 2 });
    expect(passRateHeaderLabel([agg])).toBe('Pass rate (score ≥ 0.7)');
    expect(agg.passedCount).toBe(1);
    expect(agg.evaluatedCount).toBe(2);
    expect(agg.erroredCount).toBe(0);
  }, TEST_TIMEOUT);

  it('(b) llm-verdict evaluator: verdict is the LLM\'s, snapshot still written, an omitted rubric is unevaluable (not 0)', async () => {
    if (!available) return;
    const evaluator = await createEvaluator(uniqueTestName('verdict-llm'), { kind: 'llm-verdict' });
    const conflictCase = await createTestCase('conflict');
    const partialCase = await createTestCase('partial');
    const run = await runEvaluation([conflictCase, partialCase], evaluator.id);
    expect(run.status).toBe('completed');

    const low = await getReport(run.results[conflictCase].reportId);
    expect(low.passFailStatus).toBe('passed'); // frozen historical behaviour
    expect(low.llmVerdict).toBe('passed');
    expect(low.verdictConflict).toBe(false);
    expect(low.score).toBeCloseTo(0.6, 9);
    expect(low.scoringSnapshot?.passPolicy).toEqual({ kind: 'llm-verdict' });

    const partial = await getReport(run.results[partialCase].reportId);
    expect(partial.metrics).toEqual({ relevance: 95 });
    expect((partial.metrics as any).grounding).toBeUndefined();
    expect(partial.scoringSnapshot?.unevaluable).toEqual(['grounding']);
    expect(partial.score).toBeCloseTo(0.95, 9);
    expect(partial.passFailStatus).toBe('passed');

    const agg = calculateRunAggregates(run as ExperimentRun, { [low.id]: low, [partial.id]: partial });
    expect(passRateHeaderLabel([agg])).toBe('Pass rate (judge verdict)');
    expect(agg.passedCount).toBe(2);
  }, TEST_TIMEOUT);

  it('(c) judge failure: NO metrics, no verdict, metricsStatus error; stats + compare count it errored', async () => {
    if (!available) return;
    const testCase = await createTestCase('pass');
    // An evaluator id the backend cannot resolve makes /api/judge answer 400
    // (non-retryable) — the same shape a judge 4xx produces in production.
    const run = await runEvaluation([testCase], `eval-does-not-exist-${Date.now()}`);
    expect(run.status).toBe('completed');

    const report = await getReport(run.results[testCase].reportId);
    expect(report.metricsStatus).toBe('error');
    expect(report.metrics).toEqual({});
    expect(report.passFailStatus == null).toBe(true);
    expect(report.scoringSnapshot == null).toBe(true);
    expect(report.score == null).toBe(true);
    expect(report.llmVerdict == null).toBe(true);
    expect(report.traceError).toMatch(/kind=judge_failed/);

    const stats = computeRunStats({ status: run.status, results: run.results });
    expect(stats.errored).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.passed).toBe(0);

    const agg = calculateRunAggregates(run as ExperimentRun, { [report.id]: report });
    expect(agg.erroredCount).toBe(1);
    expect(agg.evaluatedCount).toBe(0);
    expect(agg.avgScore).toBeUndefined();
  }, TEST_TIMEOUT);

  it('(d)+(e) evaluator PUT changes weights → new version + hash for NEW judgements; persisted report keeps its snapshot until retry-judgement REPLACES it (no history)', async () => {
    if (!available) return;
    const evaluator = await createEvaluator(uniqueTestName('verdict-immutable'), { kind: 'threshold', minScore: 0.7 });
    const hash1 = evaluatorContentHash(evaluator);
    const testCase = await createTestCase('pass');
    const run = await runEvaluation([testCase], evaluator.id);
    const reportId = run.results[testCase].reportId;
    const before = await getReport(reportId);
    expect(before.scoringSnapshot?.contentHash).toBe(hash1);
    expect(before.scoringSnapshot?.evaluatorVersion).toBe(1);
    expect(before.score).toBeCloseTo(0.85, 9);

    // (e) Change the weights → new evaluator version, new content hash.
    const put = await api('PUT', `/api/storage/evaluators/${evaluator.id}`, {
      ...evaluatorBody(evaluator.name, { kind: 'threshold', minScore: 0.9 }, { relevance: 0.2, grounding: 0.8 }),
    });
    expect(put.status).toBe(200);
    expect(put.json.currentVersion).toBe(2);
    const hash2 = evaluatorContentHash(put.json);
    expect(hash2).not.toBe(hash1);

    // Immutability: the persisted report is untouched by the evaluator change.
    const still = await getReport(reportId);
    expect(still.scoringSnapshot).toEqual(before.scoringSnapshot);
    expect(still.passFailStatus).toBe('passed');

    // A fresh judgement with the same evaluator id now stamps the NEW hash.
    const fresh = await api('POST', '/api/judge', {
      trajectory: [{ type: 'assistant', content: 'x' }],
      expectedOutcomes: ['SCENARIO:pass x'],
      evaluatorId: evaluator.id,
      modelId: 'stub-judge',
    });
    expect(fresh.json.scoringSnapshot.contentHash).toBe(hash2);
    expect(fresh.json.scoringSnapshot.evaluatorVersion).toBe(2);

    // (d) Retry judgement (scope=all) REPLACES the report's snapshot + verdict.
    const retry = await api('POST', `/api/storage/evaluation-runs/${run.id}/retry-judgement?scope=all`);
    expect(retry.status).toBe(202);
    const job = await pollRetryJudgement(run.id);
    expect(job.status).toBe('completed');

    const after = await getReport(reportId);
    expect(after.scoringSnapshot?.contentHash).toBe(hash2);
    expect(after.scoringSnapshot?.evaluatorVersion).toBe(2);
    expect(after.scoringSnapshot?.weights).toEqual({ relevance: 0.2, grounding: 0.8 });
    // 0.2*90 + 0.8*80 = 82 → 0.82 < 0.9 ⇒ computed FAILED although the LLM said passed.
    expect(after.score).toBeCloseTo(0.82, 9);
    expect(after.passFailStatus).toBe('failed');
    expect(after.llmVerdict).toBe('passed');
    expect(after.verdictConflict).toBe(true);
    expect((after as any).judgements).toBeUndefined(); // no history kept

    const runAfter = (await api('GET', `/api/storage/evaluation-runs/${run.id}`)).json;
    const doc = runAfter.evaluationRun ?? runAfter;
    expect(doc.results[testCase].passFailStatus).toBe('failed');
    expect(doc.stats?.failed ?? doc.stats?.failedCount ?? 1).toBe(1);
  }, TEST_TIMEOUT);

  it('validation: the evaluator API rejects invalid scoring policies without creating a version', async () => {
    if (!available) return;
    const bad = await api('POST', '/api/storage/evaluators', evaluatorBody(uniqueTestName('verdict-bad'), { kind: 'threshold', minScore: 70 }));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/minScore/);
    const gate = await api('POST', '/api/storage/evaluators', evaluatorBody(uniqueTestName('verdict-bad'), { kind: 'gates', gates: [{ metric: 'nope', min: 1 }] }));
    expect(gate.status).toBe(400);
    expect(gate.json.error).toMatch(/unknown metric 'nope'/);
  }, TEST_TIMEOUT);
});
