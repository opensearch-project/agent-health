/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the run-lifecycle actions added on top of the
 * existing evaluation-run/benchmark-run cancel + rerun endpoints:
 *
 *   - Cancel "zombie" run fallback: when no in-memory cancellation token
 *     exists for a run doc marked `status: 'running'` (the executor that
 *     started it is gone — server restarted/crashed), the cancel route
 *     falls back to a doc-status update instead of 404ing.
 *   - Rerun with tweaks: POST .../rerun with an overrides body produces a
 *     new run whose config reflects the overrides, still links `rerunOf`,
 *     and is flagged `modified: true` (vs `false` for an untouched rerun).
 *   - Retry judgement: re-judges a terminal run's judge-failed (no-verdict)
 *     test cases in place via the shared 202+poll job (using the
 *     `demo-model` judge provider so this needs no AWS credentials), against
 *     the test-case VERSION the run snapshotted.
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
};

const createTestCase = async (name: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: `Test prompt for ${name}`,
      expectedOutcomes: ['Identifies the root cause'],
      context: [],
      expectedTrajectory: [],
      labels: ['@integration-test'],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create test case: ${response.statusText}`);
  const testCase = await response.json();
  return testCase.id;
};

const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: 'Lifecycle Actions Integration Test Run',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
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
  return response.json();
};

const seedReport = async (overrides: Record<string, any> = {}): Promise<any> => {
  const response = await fetch(`${BASE_URL}/api/storage/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentName: 'Demo Agent',
      agentKey: 'demo',
      modelName: 'demo-model',
      modelId: 'demo-model',
      status: 'completed',
      passFailStatus: 'failed',
      trajectory: [
        { type: 'action', toolName: 'search_logs', content: 'searching logs' },
        { type: 'response', content: 'Root cause identified: disk full' },
      ],
      metrics: { accuracy: 20, faithfulness: 20, latency_score: 80, trajectory_alignment_score: 20 },
      timestamp: new Date().toISOString(),
      ...overrides,
    }),
  });
  if (!response.ok) throw new Error(`Failed to seed report: ${response.status} ${await response.text()}`);
  return response.json();
};

const seedBenchmark = async (overrides: Record<string, any> = {}): Promise<any> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Lifecycle Actions Integration Test Benchmark',
      testCaseIds: [],
      runs: [],
      ...overrides,
    }),
  });
  if (!response.ok) throw new Error(`Failed to seed benchmark: ${response.status} ${await response.text()}`);
  return response.json();
};

const cleanupIds: { testCases: string[]; evalRuns: string[]; benchmarks: string[]; reports: string[] } = {
  testCases: [], evalRuns: [], benchmarks: [], reports: [],
};

async function cleanup() {
  for (const id of cleanupIds.evalRuns) {
    await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.benchmarks) {
    await fetch(`${BASE_URL}/api/storage/benchmarks/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.reports) {
    await fetch(`${BASE_URL}/api/storage/runs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of cleanupIds.testCases) {
    await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

describe('Run lifecycle actions — cancel zombie fallback / rerun with tweaks / retry judgement', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
  });

  afterAll(async () => {
    if (backendAvailable) await cleanup();
  });

  describe('Cancel — zombie fallback (evaluation-run)', () => {
    it('marks a running-but-tokenless evaluation run cancelled with an audit note instead of 404ing', async () => {
      if (!backendAvailable) return;

      // Seeded directly via PUT (never went through the real create/execute
      // path), so no in-memory cancellation token exists for it — exactly
      // the "executor is gone" zombie scenario.
      // createdAt in the past: the zombie fallback requires a run to be
      // ZOMBIE_CANCEL_MIN_AGE_MS old before it fires (guards the narrow
      // create->register-token window), so a just-created 'running' run
      // would otherwise 409 here instead of exercising the fallback.
      const run = await seedEvalRun({ status: 'running', createdAt: new Date(Date.now() - 10000).toISOString() });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/cancel`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.viaFallback).toBe(true);

      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`);
      const persisted = await getRes.json();
      expect(persisted.status).toBe('cancelled');
      expect(persisted.cancelNote).toMatch(/no active executor/i);
    }, 15000);

    it('400s when the run is not running (nothing to cancel, no token, no zombie)', async () => {
      if (!backendAvailable) return;
      const run = await seedEvalRun({ status: 'completed' });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/cancel`, { method: 'POST' });
      expect(res.status).toBe(400);
    }, 15000);

    it('404s when the run does not exist at all', async () => {
      if (!backendAvailable) return;
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist-lifecycle/cancel`, { method: 'POST' });
      expect(res.status).toBe(404);
    }, 15000);

    it('409s (retryable) instead of the zombie fallback when the run was created moments ago', async () => {
      if (!backendAvailable) return;
      // No `createdAt` override — defaults to "now" in seedEvalRun.
      const run = await seedEvalRun({ status: 'running' });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/cancel`, { method: 'POST' });
      expect(res.status).toBe(409);

      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`);
      const persisted = await getRes.json();
      expect(persisted.status).toBe('running'); // untouched
    }, 15000);
  });

  describe('Cancel — zombie fallback (legacy benchmark-embedded run)', () => {
    it('marks a running-but-tokenless benchmark run cancelled with an audit note instead of 404ing', async () => {
      if (!backendAvailable) return;

      const runId = `bm-run-lifecycle-${Date.now()}`;
      const bm = await seedBenchmark({
        runs: [{
          id: runId, name: 'BM Run', agentKey: 'demo', modelId: 'claude-sonnet',
          status: 'running', createdAt: new Date(Date.now() - 10000).toISOString(), results: {},
        }],
      });
      cleanupIds.benchmarks.push(bm.id);

      const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cancelled).toBe(true);
      expect(body.viaFallback).toBe(true);

      const getRes = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}`);
      const persisted = await getRes.json();
      const persistedRun = persisted.runs.find((r: any) => r.id === runId);
      expect(persistedRun.status).toBe('cancelled');
      expect(persistedRun.cancelNote).toMatch(/no active executor/i);
    }, 15000);
  });

  describe('Rerun with tweaks — modified config + provenance', () => {
    it('an untouched rerun links rerunOf and is NOT flagged modified', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Rerun Tweaks Untouched TC1');
      cleanupIds.testCases.push(tc1);
      const source = await seedEvalRun({
        agentKey: 'demo', evaluatorId: 'system-factuality', judgeModelId: 'demo-model', concurrency: 1,
        sources: [{ type: 'test-case-ids', ids: [tc1] }],
        testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun Tweaks Untouched TC1' }],
      });
      cleanupIds.evalRuns.push(source.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = await res.json();
      cleanupIds.evalRuns.push(body.runId);

      expect(body.run.rerunOf).toBe(source.id);
      expect(body.modified).toBe(false);
      expect(body.run.modified).toBeUndefined();

      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${body.runId}/cancel`, { method: 'POST' }).catch(() => {});
    }, 30000);

    it('applying an override (agentKey + concurrency) creates a modified, still-linked rerun', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Rerun Tweaks Modified TC1');
      cleanupIds.testCases.push(tc1);
      const source = await seedEvalRun({
        agentKey: 'demo', evaluatorId: 'system-factuality', judgeModelId: 'demo-model', concurrency: 1,
        sources: [{ type: 'test-case-ids', ids: [tc1] }],
        testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun Tweaks Modified TC1' }],
      });
      cleanupIds.evalRuns.push(source.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentKey: 'other-demo-agent', concurrency: 4, name: 'Tweaked Rerun' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      cleanupIds.evalRuns.push(body.runId);

      expect(body.run.rerunOf).toBe(source.id);
      expect(body.modified).toBe(true);
      expect(body.run.modified).toBe(true);
      expect(body.run.agentKey).toBe('other-demo-agent');
      expect(body.run.concurrency).toBe(4);
      expect(body.run.name).toBe('Tweaked Rerun');
      // Unmentioned fields are still carried over from the source.
      expect(body.run.evaluatorId).toBe('system-factuality');

      const getRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${body.runId}`);
      const persisted = await getRes.json();
      expect(persisted.rerunOf).toBe(source.id);
      expect(persisted.modified).toBe(true);

      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${body.runId}/cancel`, { method: 'POST' }).catch(() => {});
    }, 30000);

    it('clearing judgeModelId/evaluatorId via null overrides is flagged modified', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Rerun Tweaks Clear TC1');
      cleanupIds.testCases.push(tc1);
      const source = await seedEvalRun({
        agentKey: 'demo', evaluatorId: 'system-factuality', judgeModelId: 'demo-model', concurrency: 1,
        sources: [{ type: 'test-case-ids', ids: [tc1] }],
        testCaseSnapshots: [{ id: tc1, version: 1, name: 'Rerun Tweaks Clear TC1' }],
      });
      cleanupIds.evalRuns.push(source.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${source.id}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ judgeModelId: null, evaluatorId: null }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      cleanupIds.evalRuns.push(body.runId);

      expect(body.modified).toBe(true);
      expect(body.run.judgeModelId).toBeUndefined();
      expect(body.run.evaluatorId).toBeUndefined();

      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${body.runId}/cancel`, { method: 'POST' }).catch(() => {});
    }, 30000);
  });

  describe('Retry judgement (kebab entry point → shared 202+poll job; snapshotted test-case version)', () => {
    // The route itself (404/409 gates, errored-only selection, scope=all,
    // double-submit guard, status poll) is covered by
    // evaluationRuns.retryJudgement.integration.test.ts. This block covers
    // what THIS change adds to the shared pipeline: the judge is run against
    // the test-case VERSION the run snapshotted, not today's definition.
    const pollRetryJudgement = async (runId: string, maxAttempts = 100): Promise<any> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/retry-judgement/status`);
        if (!res.ok) throw new Error(`Status poll failed: ${res.status} ${await res.text()}`);
        const job = await res.json();
        if (job.status === 'completed' || job.status === 'failed') return job;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`retry-judgement job for ${runId} did not complete within ${maxAttempts} polls`);
    };

    it('404s when the run does not exist', async () => {
      if (!backendAvailable) return;
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist-retry/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(404);
    }, 15000);

    it('re-judges a judge-failed (no-verdict) case against its snapshotted test-case version and updates report + run stats', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Retry Judgement Snapshot TC1');
      cleanupIds.testCases.push(tc1);

      const report = await seedReport({ testCaseId: tc1, metricsStatus: 'error', passFailStatus: null });
      cleanupIds.reports.push(report.id);

      const run = await seedEvalRun({
        status: 'completed',
        judgeModelId: 'demo-model',
        testCaseSnapshots: [{ id: tc1, version: 1, name: 'Retry Judgement Snapshot TC1' }],
        results: { [tc1]: { status: 'completed', reportId: report.id } },
      });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(202);
      const started = await res.json();
      expect(started.total).toBe(1);

      const job = await pollRetryJudgement(run.id);
      expect(job.status).toBe('completed');
      expect(job.summary.retried).toBe(1);
      expect(job.summary.succeeded).toBe(1);
      // The demo/mock judge's accuracy floor (0.7+) always resolves to
      // 'passed' — see server/routes/judge.ts generateMockEvaluation.
      expect(job.summary.results[0].passFailStatus).toBe('passed');

      const persistedRun = await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`)).json();
      expect(persistedRun.results[tc1].passFailStatus).toBe('passed');
      expect(persistedRun.stats.passed).toBe(1);
      expect(persistedRun.stats.errored ?? 0).toBe(0);

      const persistedReport = await (await fetch(`${BASE_URL}/api/storage/runs/${report.id}`)).json();
      expect(persistedReport.passFailStatus).toBe('passed');
      expect(persistedReport.llmJudgeReasoning).toBeTruthy();
    }, 30000);

    it('records a version-specific failure (and does not fall back to the current doc) when the snapshotted version no longer exists', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Retry Judgement Missing Version TC');
      cleanupIds.testCases.push(tc1);

      const report = await seedReport({ testCaseId: tc1, metricsStatus: 'error', passFailStatus: null });
      cleanupIds.reports.push(report.id);

      const run = await seedEvalRun({
        status: 'completed',
        judgeModelId: 'demo-model',
        testCaseSnapshots: [{ id: tc1, version: 99, name: 'Retry Judgement Missing Version TC' }],
        results: { [tc1]: { status: 'completed', reportId: report.id } },
      });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(202);
      const job = await pollRetryJudgement(run.id);
      expect(job.status).toBe('completed');
      expect(job.summary.failed).toBe(1);
      expect(job.summary.results[0].error).toBe('test case version 99 not found');

      // Report untouched — the judge never ran.
      const persistedReport = await (await fetch(`${BASE_URL}/api/storage/runs/${report.id}`)).json();
      expect(persistedReport.metricsStatus).toBe('error');
    }, 30000);
  });
});
