/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: Retry judgement against a REAL server — the seams between the
 * retry pipeline and three features it interacts with on disk:
 *
 *   1. Agent-step failure surfacing (`failureStage` / `error` / `judgeError`
 *      on the report): a judge-failed report re-judged successfully must come
 *      back from GET /api/storage/runs/:id with those fields cleared, so the
 *      run-detail failure card cannot render next to the new verdict.
 *   2. The runner's result mirror (`results[tc].status: 'failed'` for a FAILED
 *      verdict): `scope: 'all'` must re-judge those cases too — they have
 *      stored output — while an agent-stage failure stays excluded.
 *   3. The resolved judge identity (`judgeModel` / `judgeProvider`): a report
 *      re-scored by a deterministic evaluator must not keep naming the LLM an
 *      earlier judgement used; it carries the shared no-LLM marker instead.
 *
 * Uses `judgeModelId: 'demo-model'` (the built-in mock judge provider) so no
 * credentials are needed. Requires the backend (AH_PORT) to be running:
 *   AH_PORT=<port> npm run test:integration -- --testPathPatterns=retryJudgementSeams
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
};

async function pollRetryJudgement(runId: string, maxAttempts = 100): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement/status`);
    if (!res.ok) throw new Error(`status poll ${res.status} ${await res.text()}`);
    const job = await res.json();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('retry-judgement did not settle');
}

const postJson = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};
const getJson = async (path: string) => {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function createTestCase(expectedOutcomes: string[] = ['the agent identifies the root cause']): Promise<string> {
  const tc = await postJson('/api/storage/test-cases', {
    name: uniqueTestName('retry-seams-tc'), category: 'Test', difficulty: 'Easy',
    initialPrompt: 'What is causing the outage?', expectedOutcomes, context: [], expectedTrajectory: [], labels: ['@integration-test'],
  });
  const id = tc.id ?? tc.testCase?.id;
  tracker.testCase(id);
  return id;
}

const trajectory = [{ id: 's1', timestamp: 1, type: 'action', toolName: 'search_logs', content: 'looking' }, { id: 's2', timestamp: 2, type: 'response', content: 'The disk is full.' }];

async function createReport(testCaseId: string, overrides: Record<string, any>): Promise<string> {
  const rep = await postJson('/api/storage/runs', {
    id: `report-retry-seams-${stamp()}`, timestamp: new Date().toISOString(), testCaseId,
    agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
    status: 'completed', trajectory, llmJudgeReasoning: '', metrics: {},
    ...overrides,
  });
  tracker.run(rep.id);
  return rep.id as string;
}

async function seedEvalRun(results: Record<string, any>, extra: Record<string, any> = {}): Promise<string> {
  const id = `eval-run-retry-seams-${stamp()}`;
  const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id, name: uniqueTestName('Retry seams run'), status: 'completed', agentKey: 'demo', modelId: 'demo-model',
      judgeModelId: 'demo-model', sources: [{ type: 'test-case-ids', ids: Object.keys(results) }], trigger: 'api',
      testCaseSnapshots: Object.keys(results).map(tcId => ({ id: tcId, version: 1, name: tcId })),
      results, createdAt: new Date().toISOString(), ...extra,
    }),
  });
  if (!res.ok) throw new Error(`seed run → ${res.status} ${await res.text()}`);
  tracker.evaluationRun(id);
  return id;
}

/** The exact shape `buildEvaluatorErrorPatch('judge_failed', …)` persists (post agent-error-surfacing). */
const judgeFailedFields = {
  metricsStatus: 'error', passFailStatus: null, metrics: {},
  traceError: 'Judge evaluation failed (kind=judge_failed): judge returned no JSON',
  llmJudgeReasoning: '**Evaluator could not run.**',
  failureStage: 'judge', error: 'judge returned no JSON',
  judgeError: { message: 'judge returned no JSON', rawResponse: '', attempts: 3 },
};

/** The exact shape `buildEvaluatorErrorPatch('agent_failed', …)` persists. */
const agentFailedFields = {
  metricsStatus: 'error', passFailStatus: null, metrics: {}, trajectory: [],
  traceError: 'Agent request failed (kind=agent_failed): Agent request timed out after 300000ms',
  llmJudgeReasoning: '**Agent request failed.**',
  failureStage: 'agent', error: 'Agent request timed out after 300000ms',
  agentError: { kind: 'timeout', message: 'Agent request timed out after 300000ms', elapsedMs: 300000, timeoutMs: 300000 },
};

describe('Retry judgement — seams with failure surfacing, the result mirror and the judge identity', () => {
  let backendAvailable = false;

  // Repo pattern (tests/integration/services/storage/*): warn loudly in
  // beforeAll and bail per test — but ALSO count the skips, so a run where the
  // backend was down cannot read as "3 passed" without a trace in the log.
  let skipped = 0;
  const skipIfNoBackend = (name: string): boolean => {
    if (backendAvailable) return false;
    skipped++;
    console.warn(`[retryJudgementSeams] SKIPPED (backend ${BASE_URL} not available): ${name}`);
    return true;
  };
  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) console.warn(`[retryJudgementSeams] Backend ${BASE_URL} not available - skipping retry-judgement seam integration tests`);
    else console.log(`[retryJudgementSeams] backend ${BASE_URL} available - assertions will execute`);
  });
  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
    if (skipped > 0) console.warn(`[retryJudgementSeams] ${skipped} test(s) skipped - no assertions ran`);
  });

  it('a judge-failed report re-judged successfully comes back with NO failure fields (failureStage / error / judgeError cleared, verdict present)', async () => {
    if (skipIfNoBackend(expect.getState().currentTestName ?? 'test')) return;
    const tc = await createTestCase();
    const reportId = await createReport(tc, judgeFailedFields);
    const runId = await seedEvalRun({ [tc]: { reportId, status: 'completed' } });

    // Precondition: the stored report really carries the stage failure.
    const before = await getJson(`/api/storage/runs/${reportId}`);
    expect(before.failureStage).toBe('judge');
    expect(before.judgeError).toMatchObject({ message: 'judge returned no JSON', attempts: 3 });

    const start = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'errored' }),
    });
    expect(start.status).toBe(202);
    const job = await pollRetryJudgement(runId);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ retried: 1, succeeded: 1, failed: 0 });

    const after = await getJson(`/api/storage/runs/${reportId}`);
    expect(['passed', 'failed']).toContain(after.passFailStatus);
    expect(after.metricsStatus).toBe('completed');
    expect(after.failureStage ?? null).toBeNull();
    expect(after.error ?? null).toBeNull();
    expect(after.judgeError ?? null).toBeNull();
    expect(after.agentError ?? null).toBeNull();
    expect(after.traceError ?? null).toBeNull();
    // The run's result mirror agrees.
    const run = await getJson(`/api/storage/evaluation-runs/${runId}`);
    const result = (run.evaluationRun ?? run).results[tc];
    expect(result.passFailStatus).toBe(after.passFailStatus);
  }, 30000);

  it("scope 'all' re-judges judged-FAILED cases (results status 'failed' + a failed verdict) and skips agent-stage failures", async () => {
    if (skipIfNoBackend(expect.getState().currentTestName ?? 'test')) return;
    const tcFailed = await createTestCase();
    const tcAgent = await createTestCase();
    const tcPassed = await createTestCase();
    const repFailed = await createReport(tcFailed, { metricsStatus: 'ready', passFailStatus: 'failed', metrics: { accuracy: 10 }, llmJudgeReasoning: 'earlier verdict: wrong' });
    const repAgent = await createReport(tcAgent, agentFailedFields);
    const repPassed = await createReport(tcPassed, { metricsStatus: 'ready', passFailStatus: 'passed', metrics: { accuracy: 90 } });
    const runId = await seedEvalRun({
      [tcFailed]: { reportId: repFailed, status: 'failed', passFailStatus: 'failed' }, // the runner's mirror of a FAILED verdict
      [tcAgent]: { reportId: repAgent, status: 'completed' },                        // the runner writes agent failures as 'completed'
      [tcPassed]: { reportId: repPassed, status: 'completed', passFailStatus: 'passed' },
    });

    const start = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' }),
    });
    expect(start.status).toBe(202);
    expect((await start.json()).total).toBe(2);
    const job = await pollRetryJudgement(runId);
    expect(job.status).toBe('completed');
    expect(job.summary.retried).toBe(2);
    expect(job.summary.results.map((r: any) => r.testCaseId).sort()).toEqual([tcFailed, tcPassed].sort());

    // The judged-failed case was re-judged (stamped), the agent failure untouched.
    const failedAfter = await getJson(`/api/storage/runs/${repFailed}`);
    expect(failedAfter.judgementRetryCount).toBe(1);
    const agentAfter = await getJson(`/api/storage/runs/${repAgent}`);
    expect(agentAfter.judgementRetryCount ?? 0).toBe(0);
    expect(agentAfter.failureStage).toBe('agent');
    expect(agentAfter.agentError).toMatchObject({ kind: 'timeout' });
  }, 30000);

  it('a deterministic re-score clears the resolved LLM identity: judgeModel gone, judgeProvider "none"', async () => {
    if (skipIfNoBackend(expect.getState().currentTestName ?? 'test')) return;
    const evaluator = await postJson('/api/storage/evaluators', {
      name: uniqueTestName('retry-seams-det'), description: 'generic deterministic evaluator fixture', kind: 'deterministic',
      metrics: [{ name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true }],
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
      inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' }, prediction: { source: 'tool-hits-ordered' } },
    });
    tracker.evaluator(evaluator.id);
    const tc = await createTestCase(['Gold id(s): 42']);
    const reportId = await createReport(tc, {
      trajectory: [{ id: 'r1', timestamp: 1, type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: [{ id: '42' }] }) }],
      metricsStatus: 'ready', passFailStatus: 'failed', metrics: { accuracy: 20 },
      judgeModelId: 'some-llm-judge', judgeModel: 'provider/some-llm-judge-v1', judgeProvider: 'bedrock',
      llmJudgeResponse: { modelId: 'some-llm-judge', timestamp: new Date().toISOString(), promptTokens: 1, completionTokens: 1, latencyMs: 1, rawResponse: '{}' },
    });
    const runId = await seedEvalRun({ [tc]: { reportId, status: 'failed', passFailStatus: 'failed' } }, { judgeModelId: 'some-llm-judge' });

    const start = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all', evaluatorId: evaluator.id }),
    });
    expect(start.status).toBe(202);
    const job = await pollRetryJudgement(runId);
    expect(job.summary).toMatchObject({ retried: 1, succeeded: 1 });

    const after = await getJson(`/api/storage/runs/${reportId}`);
    expect(after.passFailStatus).toBe('passed');
    expect(after.metrics).toEqual({ 'hit@1': 1 });
    expect(after.judgeModelId ?? null).toBeNull();
    expect(after.judgeModel ?? null).toBeNull();
    expect(after.llmJudgeResponse ?? null).toBeNull();
    expect(after.judgeProvider).toBe('none');
    // The run's ORIGINAL selection is not rewritten (#509 contract) — the report is the truth.
    const run = await getJson(`/api/storage/evaluation-runs/${runId}`);
    expect((run.evaluationRun ?? run).judgeModelId).toBe('some-llm-judge');
  }, 30000);
});
