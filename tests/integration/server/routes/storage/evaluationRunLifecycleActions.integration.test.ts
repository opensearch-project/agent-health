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
 *   - Retry judgement: re-judges a terminal run's judge-failed test cases
 *     in place (using the `demo-model` judge provider so this needs no AWS
 *     credentials), and 400s when not applicable.
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
      const run = await seedEvalRun({ status: 'running' });
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
  });

  describe('Cancel — zombie fallback (legacy benchmark-embedded run)', () => {
    it('marks a running-but-tokenless benchmark run cancelled with an audit note instead of 404ing', async () => {
      if (!backendAvailable) return;

      const runId = `bm-run-lifecycle-${Date.now()}`;
      const bm = await seedBenchmark({
        runs: [{
          id: runId, name: 'BM Run', agentKey: 'demo', modelId: 'claude-sonnet',
          status: 'running', createdAt: new Date().toISOString(), results: {},
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

  describe('Retry judgement', () => {
    it('400s when the run has no judge-failed test cases', async () => {
      if (!backendAvailable) return;
      const run = await seedEvalRun({
        status: 'completed',
        results: { tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r-nonexistent' } },
      });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no judge-failed/i);
    }, 15000);

    it('400s when the run is still running, even with a judge-failed-shaped result', async () => {
      if (!backendAvailable) return;
      const run = await seedEvalRun({
        status: 'running',
        results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r-nonexistent' } },
      });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(400);
    }, 15000);

    it('404s when the run does not exist', async () => {
      if (!backendAvailable) return;
      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/does-not-exist-retry/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(404);
    }, 15000);

    it('re-judges a judge-failed case using the demo judge and updates the report + run stats', async () => {
      if (!backendAvailable) return;

      const tc1 = await createTestCase('Retry Judgement TC1');
      cleanupIds.testCases.push(tc1);

      const report = await seedReport({ testCaseId: tc1, passFailStatus: 'failed' });
      cleanupIds.reports.push(report.id);

      const run = await seedEvalRun({
        status: 'completed',
        judgeModelId: 'demo-model',
        testCaseSnapshots: [{ id: tc1, version: 1, name: 'Retry Judgement TC1' }],
        results: { [tc1]: { status: 'completed', passFailStatus: 'failed', reportId: report.id } },
      });
      cleanupIds.evalRuns.push(run.id);

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.retried).toBe(1);
      expect(body.skipped).toBe(0);
      // The demo/mock judge's accuracy floor (0.7+) always resolves to
      // 'passed' — see server/routes/judge.ts generateMockEvaluation.
      expect(body.nowPassed).toBe(1);

      const getRunRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`);
      const persistedRun = await getRunRes.json();
      expect(persistedRun.results[tc1].passFailStatus).toBe('passed');
      expect(persistedRun.stats.passed).toBe(1);
      expect(persistedRun.stats.failed).toBe(0);

      const getReportRes = await fetch(`${BASE_URL}/api/storage/runs/${report.id}`);
      const persistedReport = await getReportRes.json();
      expect(persistedReport.passFailStatus).toBe('passed');
      expect(persistedReport.llmJudgeReasoning).toBeTruthy();

      // Retrying again is a true no-op now (no judge-failed cases left).
      const secondRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}/retry-judgement`, { method: 'POST' });
      expect(secondRes.status).toBe(400);
    }, 30000);
  });
});
