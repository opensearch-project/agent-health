/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests: retry judgement on a LEGACY benchmark-embedded run.
 *
 * Owner report (#509 follow-up): on a benchmark whose two runs came from the
 * classic/CLI path (`run-<ts>-<rand>` ids embedded in `benchmark.runs[]`, no
 * evaluation-run doc) and whose agent key is no longer configured on this
 * server, Retry judgement was unavailable. Retry judgement needs only the
 * stored reports + an evaluator — never the agent — so
 * POST /api/storage/evaluation-runs/:id/retry-judgement (and its /preflight)
 * now accept a `benchmarkId` hint, find the embedded run, and write the
 * run-level patch to the embedded projection.
 *
 * Real-shaped fixture: 3 test cases (two with identical names), two legacy
 * embedded runs carrying reportIds + stats + performanceMetrics and NO
 * `passFailStatus` mirror on `results[tc]` (what classic runs persisted),
 * agent key not in config, a stored evaluator, `judgeModelId: 'demo-model'`
 * (the built-in demo judge: deterministic, credential-free, 'passed' for a
 * non-empty trajectory).
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 *   AH_PORT=<port> npm run test:integration -- --testPathPatterns=legacyEmbedded
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();
const UNCONFIGURED_AGENT = 'retired-prod-agent';
const TRAJECTORY = [
  { type: 'action', toolName: 'search_sessions', content: '{"q":"travel"}' },
  { type: 'tool_result', toolName: 'search_sessions', content: '[{"id":"sess-001","score":0.91}]' },
  { type: 'assistant', content: 'The answer is in session sess-001.' },
];

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    return (await response.json()).status === 'ok';
  } catch {
    return false;
  }
};

const postJson = (path: string, body: unknown, method = 'POST') =>
  fetch(`${BASE_URL}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function pollRetryJudgement(runId: string, maxAttempts = 100): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement/status`);
    if (!res.ok) throw new Error(`Status poll failed: ${res.status} ${await res.text()}`);
    const job = await res.json();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`retry-judgement job for ${runId} did not complete`);
}

const rand = () => Math.random().toString(36).slice(2, 10);

interface Fixture {
  benchmarkId: string;
  evaluatorId: string;
  testCaseIds: string[];
  /** run id → report ids in test-case order */
  runs: Record<string, string[]>;
  runA: string;
  runB: string;
}

/** Seed the fixture described in the module comment. Everything is tracked for cleanup by id. */
async function seedFixture(): Promise<Fixture> {
  const evRes = await postJson('/api/storage/evaluators', {
    name: uniqueTestName('legacy-embedded-judge'),
    description: 'integration fixture',
    systemPrompt: 'You are a strict judge.',
    scoringConfig: { metrics: [{ name: 'accuracy', weight: 1, scale: 100 }], passThreshold: 60, scale: 100 },
    inferenceConfig: {},
  });
  if (!evRes.ok) throw new Error(`evaluator: ${evRes.status} ${await evRes.text()}`);
  const evaluatorId = (await evRes.json()).id;
  tracker.evaluator(evaluatorId);

  const names = ['q-01 travel email', 'q-02 domain readiness', 'q-02 domain readiness'];
  const testCaseIds: string[] = [];
  for (const name of names) {
    const res = await postJson('/api/storage/test-cases', {
      name: uniqueTestName(name), category: 'retrieval', difficulty: 'Medium',
      initialPrompt: `Find: ${name}`, expectedOutcomes: ['cites the gold session'], context: [], expectedTrajectory: [],
    });
    if (!res.ok) throw new Error(`test case: ${res.status}`);
    const tc = await res.json();
    testCaseIds.push(tc.id);
    tracker.testCase(tc.id);
  }

  const seedReport = async (tcId: string, verdict: 'passed' | 'failed' | null) => {
    const id = `run-${Date.now()}-${rand()}`;
    const res = await postJson('/api/storage/runs', {
      id, timestamp: new Date().toISOString(),
      agentName: UNCONFIGURED_AGENT, agentKey: UNCONFIGURED_AGENT, modelName: 'prod-agent', modelId: 'prod-agent',
      judgeModelId: 'demo-model', evaluatorId, testCaseId: tcId,
      status: 'completed', metricsStatus: verdict ? 'ready' : 'error', passFailStatus: verdict,
      trajectory: TRAJECTORY,
      metrics: verdict ? { accuracy: verdict === 'passed' ? 92 : 30 } : {},
      llmJudgeReasoning: verdict ? `Original verdict (${verdict}).` : undefined,
      ...(verdict ? {} : { failureStage: 'judge', error: 'Judge call failed: 400 ValidationException', judgeError: 'Judge call failed: 400 ValidationException' }),
      performanceMetrics: { judgeDurationMs: 5600, judgeAttempts: 1, durationMs: 20944, agentDurationMs: 15301 },
    });
    if (!res.ok) throw new Error(`report: ${res.status} ${await res.text()}`);
    tracker.run(id);
    return id;
  };

  const legacyRun = async (name: string, verdicts: Array<'passed' | 'failed' | null>, offsetMs: number) => {
    const id = `run-${Date.now() - offsetMs}-${rand()}`;
    const reportIds: string[] = [];
    const results: Record<string, unknown> = {};
    for (let k = 0; k < testCaseIds.length; k++) {
      const reportId = await seedReport(testCaseIds[k], verdicts[k]);
      reportIds.push(reportId);
      // Classic runs persisted NO passFailStatus mirror on results[tc].
      results[testCaseIds[k]] = { reportId, status: 'completed', performanceMetrics: { judgeDurationMs: 5600, judgeAttempts: 1, durationMs: 20944 + k * 1000, agentDurationMs: 15301 } };
    }
    const stats = {
      total: verdicts.length, pending: 0,
      passed: verdicts.filter(v => v === 'passed').length,
      failed: verdicts.filter(v => v === 'failed').length,
      errored: verdicts.filter(v => v === null).length,
    };
    const run = {
      id, name, description: 'legacy embedded run (classic/CLI path)',
      createdAt: new Date(Date.now() - offsetMs).toISOString(), completedAt: new Date(Date.now() - offsetMs + 228032).toISOString(),
      status: 'completed', agentKey: UNCONFIGURED_AGENT, modelId: 'prod-agent',
      judgeModelId: 'demo-model', judgeProvider: 'bedrock', evaluatorId, concurrency: 2, benchmarkVersion: 1,
      testCaseSnapshots: testCaseIds.map((tcId, k) => ({ id: tcId, version: 1, name: names[k] })),
      results, stats,
      performanceMetrics: { minTestCaseDurationMs: 20944, maxTestCaseDurationMs: 22944, avgTestCaseDurationMs: 21944, durationMs: 228032, concurrency: 2 },
    };
    return { run, reportIds };
  };

  const a = await legacyRun(uniqueTestName('legacy · BEFORE'), ['passed', 'failed', 'passed'], 7200000);
  const b = await legacyRun(uniqueTestName('legacy · AFTER'), ['passed', 'passed', null], 3600000);
  const bmRes = await postJson('/api/storage/benchmarks', {
    name: uniqueTestName('legacy-embedded-benchmark'), description: 'integration fixture', testCaseIds, runs: [a.run, b.run],
  });
  if (!bmRes.ok) throw new Error(`benchmark: ${bmRes.status} ${await bmRes.text()}`);
  const bm = await bmRes.json();
  const benchmarkId = bm.id ?? bm.benchmark?.id;
  tracker.benchmark(benchmarkId);
  return { benchmarkId, evaluatorId, testCaseIds, runs: { [a.run.id]: a.reportIds, [b.run.id]: b.reportIds }, runA: a.run.id, runB: b.run.id };
}

const getEmbeddedRun = async (benchmarkId: string, runId: string) => {
  const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
  const body = await res.json();
  return (body.benchmark ?? body).runs.find((r: any) => r.id === runId);
};
const getReport = async (id: string) => (await fetch(`${BASE_URL}/api/storage/runs/${id}`)).json();

describe('Retry judgement on a LEGACY benchmark-embedded run (benchmarkId hint)', () => {
  let backendAvailable = false;
  let fx: Fixture;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (backendAvailable) fx = await seedFixture();
  });

  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
  });

  it('the fixture IS legacy: no evaluation-run doc exists for either run, and the agent is not configured on this server', async () => {
    if (!backendAvailable) return;
    expect((await fetch(`${BASE_URL}/api/storage/evaluation-runs/${fx.runA}`)).status).toBe(404);
    expect((await fetch(`${BASE_URL}/api/storage/evaluation-runs/${fx.runB}`)).status).toBe(404);
    const agents = await (await fetch(`${BASE_URL}/api/agents`)).json();
    const keys = (Array.isArray(agents) ? agents : agents.agents ?? []).map((a: any) => a.key);
    expect(keys).not.toContain(UNCONFIGURED_AGENT);
  });

  it('WITHOUT the hint the route still 404s (nothing else to look in) — preflight and retry alike', async () => {
    if (!backendAvailable) return;
    const pre = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement/preflight`, { scope: 'errored' });
    expect(pre.status).toBe(404);
    const retry = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement`, { scope: 'errored', judgeModelId: 'demo-model' });
    expect(retry.status).toBe(404);
  });

  it('preflight WITH the hint resolves the embedded run: its own evaluator, 1 judge-failed case in scope errored, 3 in scope all', async () => {
    if (!backendAvailable) return;
    const errored = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement/preflight`, { scope: 'errored', benchmarkId: fx.benchmarkId });
    expect(errored.status).toBe(200);
    expect(await errored.json()).toMatchObject({ evaluatorId: fx.evaluatorId, deterministic: false, scope: 'errored', total: 1, evaluable: 1 });
    const all = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement/preflight`, { scope: 'all', benchmarkId: fx.benchmarkId });
    expect((await all.json()).total).toBe(3);
  });

  it('retry (scope errored) re-judges the judge-failed case, writes lastJudgementRetry + truthful stats onto the EMBEDDED run, leaves the sibling run alone, creates no evaluation-run doc', async () => {
    if (!backendAvailable) return;
    const before = await getEmbeddedRun(fx.benchmarkId, fx.runB);
    expect(before.stats).toMatchObject({ passed: 2, errored: 1 });
    expect(before.lastJudgementRetry).toBeUndefined();

    const res = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement`, { scope: 'errored', benchmarkId: fx.benchmarkId, judgeModelId: 'demo-model' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ jobId: fx.runB, status: 'running', total: 1 });
    const job = await pollRetryJudgement(fx.runB);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ retried: 1, succeeded: 1, failed: 0 });

    // The judge-failed report got a verdict; the two passed ones were not re-judged.
    const [rA, rB, rC] = await Promise.all(fx.runs[fx.runB].map(getReport));
    expect(rC.passFailStatus).toBe('passed');
    expect(rC.judgementRetryCount).toBe(1);
    expect(rC.evaluatorId).toBe(fx.evaluatorId);
    expect(rC.failureStage).toBeFalsy();
    expect(rA.judgementRetryCount).toBeUndefined();
    expect(rB.judgementRetryCount).toBeUndefined();

    // Run-level patch landed on the embedded projection …
    const after = await getEmbeddedRun(fx.benchmarkId, fx.runB);
    expect(after.lastJudgementRetry).toMatchObject({ scope: 'errored', evaluatorId: fx.evaluatorId, judgeModelId: 'demo-model' });
    expect(after.lastRetryAttempt).toBeNull();
    // … with stats that stay truthful for the two cases the retry did not touch
    // (classic results carried no verdict mirror; a naive recompute reads 1 passed / 2 errored).
    expect(after.stats).toMatchObject({ total: 3, passed: 3, failed: 0, errored: 0 });
    expect(Object.values(after.results).map((r: any) => r.passFailStatus)).toEqual(['passed', 'passed', 'passed']);
    // The original run identity is untouched (#509 contract: evaluator / judge model / agent not rewritten).
    expect(after).toMatchObject({ agentKey: UNCONFIGURED_AGENT, evaluatorId: fx.evaluatorId, judgeModelId: 'demo-model', concurrency: 2 });
    expect(after.performanceMetrics.durationMs).toBe(228032);

    // … and nowhere else.
    expect((await fetch(`${BASE_URL}/api/storage/evaluation-runs/${fx.runB}`)).status).toBe(404);
    const sibling = await getEmbeddedRun(fx.benchmarkId, fx.runA);
    expect(sibling.lastJudgementRetry).toBeUndefined();
    expect(sibling.stats).toMatchObject({ passed: 2, failed: 1, errored: 0 });
  });

  it('retry (scope all) with a different evaluator re-judges every case of the OTHER legacy run, including the judged failure, and stamps that evaluator on every report', async () => {
    if (!backendAvailable) return;
    const res = await postJson(`/api/storage/evaluation-runs/${fx.runA}/retry-judgement`, { scope: 'all', benchmarkId: fx.benchmarkId, evaluatorId: 'system-factuality', judgeModelId: 'demo-model' });
    expect(res.status).toBe(202);
    expect((await res.json()).total).toBe(3);
    const job = await pollRetryJudgement(fx.runA);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ retried: 3, succeeded: 3 });
    for (const reportId of fx.runs[fx.runA]) {
      const report = await getReport(reportId);
      expect(report.evaluatorId).toBe('system-factuality');
      expect(report.judgementRetryCount).toBe(1);
      expect(report.passFailStatus).toBe('passed'); // the demo judge passes a non-empty trajectory
      expect(report.trajectory).toEqual(TRAJECTORY); // agent output never touched
    }
    const after = await getEmbeddedRun(fx.benchmarkId, fx.runA);
    expect(after.stats).toMatchObject({ total: 3, passed: 3, failed: 0, errored: 0 });
    expect(after.lastJudgementRetry).toMatchObject({ scope: 'all', evaluatorId: 'system-factuality', judgeModelId: 'demo-model' });
    expect(after.evaluatorId).toBe(fx.evaluatorId); // run's original evaluator NOT rewritten
  });

  it('the hint does not let a run be retried under a benchmark it is not embedded in (404), and still 400s an unknown evaluator', async () => {
    if (!backendAvailable) return;
    const otherBm = await postJson('/api/storage/benchmarks', { name: uniqueTestName('legacy-embedded-other'), testCaseIds: fx.testCaseIds, runs: [] });
    const other = await otherBm.json();
    tracker.benchmark(other.id ?? other.benchmark?.id);
    const wrong = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement`, { scope: 'all', benchmarkId: other.id ?? other.benchmark?.id });
    expect(wrong.status).toBe(404);
    const unknown = await postJson(`/api/storage/evaluation-runs/${fx.runB}/retry-judgement`, { scope: 'all', benchmarkId: fx.benchmarkId, evaluatorId: 'eval-does-not-exist' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/Evaluator not found/);
  });
});
