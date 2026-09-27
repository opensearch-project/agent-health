/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the retry-judgement PICKER (follow-up to #468):
 * POST /api/storage/evaluation-runs/:id/retry-judgement with a JSON body
 * `{ scope, evaluatorId, judgeModelId }`.
 *
 * Owner requirement: "Retry judgement should be a retryable step all the
 * time. We only preserve the last one, but the judgement should allow for
 * evaluator type and prompt evaluator when retrying; defaults will be the
 * last selected ones."
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 * Run:
 *   AH_PORT=4800 npm run test:integration -- --testPathPatterns=retryJudgementPicker
 *
 * Uses `judgeModelId: 'demo-model'` so the judge call routes to the built-in
 * demo/mock provider (server/routes/judge.ts) — deterministic and
 * credential-free. The demo judge always resolves to 'passed' for a
 * non-empty trajectory.
 *
 * Covers:
 *   (a) scope=all + evaluator/model overrides on a COMPLETED, fully-judged
 *       run → every report re-judged; evaluatorId/judgeModelId on the
 *       reports = the overrides; judgementRetryCount 1 + judgementRetriedAt
 *       set; run.lastJudgementRetry recorded; run stats recomputed; agent
 *       output untouched
 *   (b) a second retry → count 2, still exactly one judgement on the report
 *   (c) unknown evaluatorId → 400, nothing re-judged
 *   (d) running run → 409 (existing gate, now with a body)
 *   (e) legacy `?scope=all` query still honoured; absent keys inherit the run
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
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement/status`);
    if (!res.ok) throw new Error(`Status poll failed: ${res.status} ${await res.text()}`);
    const job = await res.json();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`retry-judgement job for ${runId} did not complete within ${maxAttempts} polls`);
}

const createTestCase = async (name: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uniqueTestName(name),
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: `Test prompt for ${name}`,
      expectedOutcomes: ['the agent identifies the root cause'],
      context: [],
      expectedTrajectory: [],
      labels: ['@integration-test'],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create test case: ${response.statusText}`);
  const testCase = await response.json();
  tracker.testCase(testCase.id);
  return testCase.id;
};

const ORIGINAL_TRAJECTORY = [
  { type: 'action', toolName: 'search_logs', content: 'looking' },
  { type: 'assistant', content: 'the root cause is X' },
];

/** Seed a fully-judged (passed) report doc for `testCaseId`. */
const createJudgedReport = async (testCaseId: string, overrides: Record<string, any> = {}): Promise<any> => {
  const id = `report-rejudge-picker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = {
    id,
    timestamp: new Date().toISOString(),
    agentName: 'Demo Agent',
    agentKey: 'demo',
    modelName: 'demo-model',
    modelId: 'demo-model',
    judgeModelId: 'demo-model',
    evaluatorId: 'system-rca-default',
    testCaseId,
    status: 'completed',
    metricsStatus: 'ready',
    passFailStatus: 'passed',
    trajectory: ORIGINAL_TRAJECTORY,
    rawEvents: [{ type: 'RUN_STARTED' }, { type: 'RUN_FINISHED' }],
    metrics: { accuracy: 90, faithfulness: 90, latency_score: 90, trajectory_alignment_score: 90 },
    llmJudgeReasoning: 'Original verdict: looks good.',
    ...overrides,
  };
  const response = await fetch(`${BASE_URL}/api/storage/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Failed to seed report: ${response.status} ${await response.text()}`);
  const report = await response.json();
  tracker.run(report.id);
  return report;
};

const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-rejudge-picker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: uniqueTestName('Retry Judgement Picker Integration'),
    status: 'completed',
    agentKey: 'demo',
    modelId: 'demo-model',
    judgeModelId: 'demo-model',
    evaluatorId: 'system-rca-default',
    sources: [{ type: 'test-case-ids', ids: [] }],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    createdAt: new Date().toISOString(),
    ...overrides,
    id,
  };
  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(`Failed to seed eval run: ${response.status} ${await response.text()}`);
  tracker.evaluationRun(id);
  return response.json();
};

const postRetry = (runId: string, body?: Record<string, unknown>, query = '') =>
  fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement${query}`, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

const getReport = async (id: string) => (await fetch(`${BASE_URL}/api/storage/runs/${id}`)).json();
const getRun = async (id: string) => (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`)).json();

describe('POST /api/storage/evaluation-runs/:id/retry-judgement — evaluator / judge-model / scope picker', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
  });

  it('(a) scope=all with overrides re-judges EVERY fully-judged case with the picked evaluator/model, stamps the retry, records lastJudgementRetry, recomputes stats, keeps the agent output; (b) a second retry bumps the count and still keeps one judgement', async () => {
    if (!backendAvailable) return;

    const tcA = await createTestCase('rejudge-picker-a');
    const tcB = await createTestCase('rejudge-picker-b');
    const reportA = await createJudgedReport(tcA);
    const reportB = await createJudgedReport(tcB, { passFailStatus: 'failed', metrics: { accuracy: 20, faithfulness: 20, latency_score: 20, trajectory_alignment_score: 20 } });

    const run = await seedEvalRun({
      testCaseSnapshots: [
        { id: tcA, version: 1, name: 'a' },
        { id: tcB, version: 1, name: 'b' },
      ],
      results: {
        [tcA]: { reportId: reportA.id, status: 'completed', passFailStatus: 'passed' },
        [tcB]: { reportId: reportB.id, status: 'completed', passFailStatus: 'failed' },
      },
      stats: { passed: 1, failed: 1, errored: 0, pending: 0, total: 2 },
    });
    expect(run.lastJudgementRetry).toBeUndefined();

    // ── first retry: all cases, a different system evaluator, the demo judge model
    const startRes = await postRetry(run.id, { scope: 'all', evaluatorId: 'system-factuality', judgeModelId: 'demo-model' });
    expect(startRes.status).toBe(202);
    const started = await startRes.json();
    expect(started.total).toBe(2); // both fully-judged cases — not just judge-failed ones

    const job = await pollRetryJudgement(run.id);
    expect(job.status).toBe('completed');
    expect(job.summary.retried).toBe(2);
    expect(job.summary.succeeded).toBe(2);

    for (const seeded of [reportA, reportB]) {
      const persisted = await getReport(seeded.id);
      // The judgement fields were overwritten by the retry, with the picked config…
      expect(persisted.evaluatorId).toBe('system-factuality');
      expect(persisted.judgeModelId).toBe('demo-model');
      expect(persisted.passFailStatus).toBe('passed'); // demo judge floor
      expect(persisted.metricsStatus).toBe('completed');
      expect(persisted.llmJudgeReasoning).not.toBe('Original verdict: looks good.');
      expect(persisted.llmJudgeResponse).toEqual(expect.objectContaining({ modelId: 'demo-model' }));
      // …stamped as a retry…
      expect(persisted.judgementRetryCount).toBe(1);
      expect(Date.parse(persisted.judgementRetriedAt)).not.toBeNaN();
      // …exactly ONE judgement (no history array anywhere on the doc)…
      expect(typeof persisted.llmJudgeReasoning).toBe('string');
      expect(Object.keys(persisted).filter(k => /history|previous|judgements/i.test(k))).toEqual([]);
      // …and the agent output untouched.
      expect(persisted.trajectory).toEqual(ORIGINAL_TRAJECTORY);
      expect(persisted.rawEvents).toEqual([{ type: 'RUN_STARTED' }, { type: 'RUN_FINISHED' }]);
    }

    // Run doc: last selection recorded + stats recomputed (B flipped failed → passed).
    const persistedRun = await getRun(run.id);
    expect(persistedRun.lastJudgementRetry).toEqual({
      scope: 'all', evaluatorId: 'system-factuality', judgeModelId: 'demo-model', at: expect.any(String),
    });
    expect(persistedRun.results[tcB].passFailStatus).toBe('passed');
    expect(persistedRun.stats).toMatchObject({ passed: 2, failed: 0, errored: 0, total: 2 });
    // The run's ORIGINAL config is not rewritten — only the last selection is.
    expect(persistedRun.evaluatorId).toBe('system-rca-default');

    // ── (b) second retry, back to the default evaluator + "evaluator default" model
    const secondRes = await postRetry(run.id, { scope: 'all', evaluatorId: 'system-rca-default', judgeModelId: null });
    expect(secondRes.status).toBe(202);
    const secondJob = await pollRetryJudgement(run.id);
    expect(secondJob.summary.retried).toBe(2);

    const reportA2 = await getReport(reportA.id);
    expect(reportA2.judgementRetryCount).toBe(2);
    expect(reportA2.evaluatorId).toBe('system-rca-default');
    expect(typeof reportA2.llmJudgeReasoning).toBe('string');
    expect(reportA2.trajectory).toEqual(ORIGINAL_TRAJECTORY);

    const run2 = await getRun(run.id);
    expect(run2.lastJudgementRetry).toEqual({ scope: 'all', evaluatorId: 'system-rca-default', judgeModelId: null, at: expect.any(String) });
    expect(Date.parse(run2.lastJudgementRetry.at)).toBeGreaterThanOrEqual(Date.parse(persistedRun.lastJudgementRetry.at));
  }, 60000);

  it('(c) 400s an unknown evaluatorId and re-judges nothing', async () => {
    if (!backendAvailable) return;
    const tc = await createTestCase('rejudge-picker-bad-evaluator');
    const report = await createJudgedReport(tc);
    const run = await seedEvalRun({
      testCaseSnapshots: [{ id: tc, version: 1, name: 'x' }],
      results: { [tc]: { reportId: report.id, status: 'completed', passFailStatus: 'passed' } },
    });

    const res = await postRetry(run.id, { scope: 'all', evaluatorId: 'no-such-evaluator-ever', judgeModelId: 'demo-model' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Evaluator not found: no-such-evaluator-ever/);

    const statusRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement/status`);
    expect(statusRes.status).toBe(404); // no job was started
    const persisted = await getReport(report.id);
    expect(persisted.judgementRetryCount).toBeUndefined();
    expect(persisted.llmJudgeReasoning).toBe('Original verdict: looks good.');
    expect((await getRun(run.id)).lastJudgementRetry).toBeUndefined();
  }, 30000);

  it('400s a malformed judgeModelId / scope', async () => {
    if (!backendAvailable) return;
    const run = await seedEvalRun({});
    expect((await postRetry(run.id, { judgeModelId: '' })).status).toBe(400);
    expect((await postRetry(run.id, { judgeModelId: 42 })).status).toBe(400);
    expect((await postRetry(run.id, { scope: 'everything' })).status).toBe(400);
    expect((await postRetry(run.id, { evaluatorId: '' })).status).toBe(400);
  }, 15000);

  it('(d) 409s while the run is still running, even with a valid picker body', async () => {
    if (!backendAvailable) return;
    const run = await seedEvalRun({ status: 'running' });
    const res = await postRetry(run.id, { scope: 'all', evaluatorId: 'system-factuality', judgeModelId: 'demo-model' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still executing/i);
  }, 15000);

  it('(e) absent body keys inherit the run\'s evaluator / judge model, and the legacy ?scope=all query is still honoured', async () => {
    if (!backendAvailable) return;
    const tc = await createTestCase('rejudge-picker-legacy-query');
    const report = await createJudgedReport(tc, { evaluatorId: undefined });
    const run = await seedEvalRun({
      evaluatorId: 'system-tool-usage',
      testCaseSnapshots: [{ id: tc, version: 1, name: 'x' }],
      results: { [tc]: { reportId: report.id, status: 'completed', passFailStatus: 'passed' } },
    });

    const res = await postRetry(run.id, undefined, '?scope=all');
    expect(res.status).toBe(202);
    expect((await res.json()).total).toBe(1);
    const job = await pollRetryJudgement(run.id);
    expect(job.summary.retried).toBe(1);

    const persisted = await getReport(report.id);
    expect(persisted.evaluatorId).toBe('system-tool-usage'); // inherited from the run (the report had none)
    expect(persisted.judgeModelId).toBe('demo-model');
    expect(persisted.judgementRetryCount).toBe(1);
    expect((await getRun(run.id)).lastJudgementRetry).toEqual({
      scope: 'all', evaluatorId: 'system-tool-usage', judgeModelId: 'demo-model', at: expect.any(String),
    });
  }, 30000);
});
