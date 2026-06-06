/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for boot-time recovery of orphan benchmark runs.
 *
 * These tests require the backend server to be running with test endpoints
 * enabled:
 *   AGENT_HEALTH_TEST_ENDPOINTS=1 npm run dev:server
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=benchmarkRunRecovery
 *
 * What is covered (the production-bug shape):
 *   1. A benchmark with `BenchmarkRun.status === 'running'` and one or more
 *      test-case results whose `runResult.status === 'pending'` with no
 *      `reportId` is recovered: results flip to `'failed'` with a recovery
 *      note, run.status flips to `'failed'`, and stats are recomputed.
 *   2. Completed results (with reportIds) are preserved untouched.
 *   3. Recent running runs are NOT touched (must be older than the configured
 *      stale window).
 *   4. Recovery is idempotent.
 *
 * The test goes through the HTTP API for everything: PUT to seed orphan
 * state, POST to a test-only admin endpoint to invoke the same recovery
 * function `server/index.ts` calls on boot, and GET to verify final state.
 *
 * Why HTTP, not direct calls? The Jest config mocks `configService` and
 * can't dynamically import the OpenSearch client. Using HTTP keeps storage
 * access inside the running server process where it actually works.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const STALE_AGE_MS = 60 * 60 * 1000 + 1; // 1h + 1ms — past the 1h default

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function isBackendUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function isTestEndpointEnabled(): Promise<boolean> {
  // Probe the recovery endpoint. 404 = disabled, 200/503 = enabled.
  try {
    const r = await fetch(`${BASE_URL}/api/storage/admin/recover-orphan-benchmark-runs`, { method: 'POST' });
    return r.status !== 404;
  } catch {
    return false;
  }
}

async function createTestCase(name: string): Promise<string | null> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: 'p',
      expectedOutcomes: ['o'],
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.id || j.testCase?.id || null;
}

async function createBenchmark(name: string, testCaseIds: string[]): Promise<string | null> {
  const r = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: 'orphan-recovery integration test',
      testCaseIds,
      runs: [],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.id || j.benchmark?.id || null;
}

/**
 * Inject an orphan run into the benchmark by re-fetching, mutating the
 * `runs[]` array, and PUT-ting back. PUT replaces `runs` whole-cloth (see
 * `server/routes/storage/benchmarks.ts`'s PUT handler).
 */
async function setRunsOnBenchmark(benchmarkId: string, runs: any[]): Promise<void> {
  const get = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
  if (!get.ok) throw new Error(`Failed to fetch benchmark ${benchmarkId}: ${get.status}`);
  const bm = await get.json();
  const put = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: bm.name,
      description: bm.description,
      testCaseIds: bm.testCaseIds,
      runs,
    }),
  });
  if (!put.ok) throw new Error(`Failed to PUT benchmark ${benchmarkId}: ${put.status} ${await put.text()}`);
}

async function getBenchmark(id: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`Failed GET benchmark ${id}: ${r.status}`);
  return r.json();
}

async function createReport(testCaseId: string, passFail: 'passed' | 'failed' = 'passed'): Promise<string | null> {
  const r = await fetch(`${BASE_URL}/api/storage/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      testCaseId,
      agentName: 'demo',
      modelName: 'demo',
      status: 'completed',
      passFailStatus: passFail,
      trajectory: [],
      metrics: { accuracy: passFail === 'passed' ? 100 : 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      llmJudgeReasoning: '',
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.id || null;
}

async function triggerRecovery(): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/admin/recover-orphan-benchmark-runs`, { method: 'POST' });
  if (!r.ok) throw new Error(`Recovery endpoint failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];
const createdReportIds: string[] = [];

describe('Benchmark run recovery on boot — integration', () => {
  jest.setTimeout(60_000);

  let backendUp = false;
  let endpointUp = false;

  beforeAll(async () => {
    backendUp = await isBackendUp();
    if (!backendUp) {
      console.warn('Backend not available — skipping. Start with: npm run dev:server');
      return;
    }
    endpointUp = await isTestEndpointEnabled();
    if (!endpointUp) {
      console.warn(
        'Test admin endpoints not enabled — skipping. Restart server with: ' +
        'AGENT_HEALTH_TEST_ENDPOINTS=1 node server/dist/index.js',
      );
    }
  });

  afterAll(async () => {
    for (const id of createdReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdBenchmarkIds) {
      await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  it('rewrites unstarted results to failed and marks the run failed', async () => {
    if (!backendUp || !endpointUp) return;

    const tcA = await createTestCase('orphan-recovery-A-' + Date.now());
    const tcB = await createTestCase('orphan-recovery-B-' + Date.now());
    const tcC = await createTestCase('orphan-recovery-C-' + Date.now());
    expect(tcA && tcB && tcC).toBeTruthy();
    createdTestCaseIds.push(tcA!, tcB!, tcC!);

    const orphanRunId = `run-orphan-int-${Date.now()}-1`;
    const bmId = await createBenchmark('orphan-recovery-int-1-' + Date.now(), [tcA!, tcB!, tcC!]);
    expect(bmId).toBeTruthy();
    createdBenchmarkIds.push(bmId!);

    await setRunsOnBenchmark(bmId!, [{
      id: orphanRunId,
      name: 'Orphan Run',
      agentKey: 'demo',
      modelId: 'demo-model',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      benchmarkVersion: 1,
      testCaseSnapshots: [],
      results: {
        [tcA!]: { reportId: '', status: 'pending' },
        [tcB!]: { reportId: '', status: 'pending' },
        [tcC!]: { reportId: '', status: 'pending' },
      },
    }]);

    const stat = await triggerRecovery();
    expect(stat.staleRuns).toBeGreaterThanOrEqual(1);
    expect(stat.runsMarkedFailed).toBeGreaterThanOrEqual(1);
    expect(stat.resultsMarkedFailed).toBeGreaterThanOrEqual(3);

    const bm = await getBenchmark(bmId!);
    const run = bm.runs.find((r: any) => r.id === orphanRunId);
    expect(run).toBeDefined();
    expect(run.status).toBe('failed');
    for (const tcId of [tcA, tcB, tcC]) {
      expect(run.results[tcId!].status).toBe('failed');
      expect(run.results[tcId!].error).toMatch(/boot recovery/);
    }
    expect(run.stats).toEqual({ passed: 0, failed: 3, pending: 0, total: 3 });
  });

  it('preserves completed results during recovery and computes stats correctly', async () => {
    if (!backendUp || !endpointUp) return;

    const tcA = await createTestCase('orphan-keep-A-' + Date.now());
    const tcB = await createTestCase('orphan-keep-B-' + Date.now());
    expect(tcA && tcB).toBeTruthy();
    createdTestCaseIds.push(tcA!, tcB!);

    const reportId = await createReport(tcA!, 'passed');
    expect(reportId).toBeTruthy();
    createdReportIds.push(reportId!);

    const orphanRunId = `run-orphan-int-${Date.now()}-2`;
    const bmId = await createBenchmark('orphan-recovery-int-2-' + Date.now(), [tcA!, tcB!]);
    expect(bmId).toBeTruthy();
    createdBenchmarkIds.push(bmId!);

    await setRunsOnBenchmark(bmId!, [{
      id: orphanRunId,
      name: 'Mixed Run',
      agentKey: 'demo',
      modelId: 'demo-model',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      benchmarkVersion: 1,
      testCaseSnapshots: [],
      results: {
        [tcA!]: { reportId, status: 'completed' },           // keep
        [tcB!]: { reportId: '', status: 'pending' },         // -> failed
      },
    }]);

    await triggerRecovery();

    const bm = await getBenchmark(bmId!);
    const run = bm.runs.find((r: any) => r.id === orphanRunId);
    expect(run.status).toBe('failed');
    expect(run.results[tcA!].status).toBe('completed');
    expect(run.results[tcA!].reportId).toBe(reportId);
    expect(run.results[tcB!].status).toBe('failed');
    expect(run.results[tcB!].reportId).toBe('');
    // Stats: 1 passed (real report), 1 failed (orphan-recovered), 0 pending
    expect(run.stats).toEqual({ passed: 1, failed: 1, pending: 0, total: 2 });
  });

  it('does not touch recent running runs', async () => {
    if (!backendUp || !endpointUp) return;

    const tcA = await createTestCase('orphan-recent-' + Date.now());
    expect(tcA).toBeTruthy();
    createdTestCaseIds.push(tcA!);

    const recentRunId = `run-recent-int-${Date.now()}-3`;
    const bmId = await createBenchmark('orphan-recovery-int-3-' + Date.now(), [tcA!]);
    expect(bmId).toBeTruthy();
    createdBenchmarkIds.push(bmId!);

    await setRunsOnBenchmark(bmId!, [{
      id: recentRunId,
      name: 'Recent Run',
      agentKey: 'demo',
      modelId: 'demo-model',
      createdAt: new Date().toISOString(), // freshly created
      status: 'running',
      benchmarkVersion: 1,
      testCaseSnapshots: [],
      results: { [tcA!]: { reportId: '', status: 'pending' } },
    }]);

    await triggerRecovery();

    const bm = await getBenchmark(bmId!);
    const run = bm.runs.find((r: any) => r.id === recentRunId);
    expect(run.status).toBe('running');                  // untouched
    expect(run.results[tcA!].status).toBe('pending');    // untouched
  });

  it('is idempotent — running recovery twice produces the same final state', async () => {
    if (!backendUp || !endpointUp) return;

    const tcA = await createTestCase('orphan-idempotent-' + Date.now());
    expect(tcA).toBeTruthy();
    createdTestCaseIds.push(tcA!);

    const orphanRunId = `run-orphan-int-${Date.now()}-4`;
    const bmId = await createBenchmark('orphan-recovery-int-4-' + Date.now(), [tcA!]);
    expect(bmId).toBeTruthy();
    createdBenchmarkIds.push(bmId!);

    await setRunsOnBenchmark(bmId!, [{
      id: orphanRunId,
      name: 'Idempotent Run',
      agentKey: 'demo',
      modelId: 'demo-model',
      createdAt: isoAgo(STALE_AGE_MS),
      status: 'running',
      benchmarkVersion: 1,
      testCaseSnapshots: [],
      results: { [tcA!]: { reportId: '', status: 'pending' } },
    }]);

    await triggerRecovery();
    const bmAfterFirst = await getBenchmark(bmId!);
    const firstSnapshot = JSON.stringify(bmAfterFirst.runs.find((r: any) => r.id === orphanRunId));

    const stat2 = await triggerRecovery();
    const bmAfterSecond = await getBenchmark(bmId!);
    const secondSnapshot = JSON.stringify(bmAfterSecond.runs.find((r: any) => r.id === orphanRunId));

    expect(secondSnapshot).toEqual(firstSnapshot);
    // Second pass should not re-touch this run (it's no longer 'running')
    expect(stat2.runsMarkedFailed).toBe(0);
  });
});
