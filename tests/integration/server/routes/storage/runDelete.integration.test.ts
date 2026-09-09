/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests: deleting a run removes BOTH persisted forms of it,
 * whichever DELETE route is used (server/services/runDelete.ts).
 *
 * A benchmark-linked run is stored as a first-class `evaluation-run` doc AND,
 * once finished, a legacy projection embedded in `benchmark.runs[]`. Before
 * this fix each route removed exactly one form — the benchmark page then
 * showed a ghost row, and the nested-run route 404ed for a never-embedded
 * run (owner report: "the run doesn't get deleted when I go inside the run
 * page and try it myself").
 *
 * Requires the backend server to be running (see tests/integration/testConfig).
 * Every entity created here is deleted by id in afterAll.
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

const createTestCase = async (name: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, category: 'Test', difficulty: 'Easy', initialPrompt: `Test prompt for ${name}`,
      expectedOutcomes: ['Identifies the root cause'], context: [], expectedTrajectory: [], labels: ['@integration-test'],
    }),
  });
  if (!response.ok) throw new Error(`Failed to create test case: ${response.statusText}`);
  const tc = await response.json();
  cleanupIds.testCases.push(tc.id);
  return tc.id;
};

const seedEvalRun = async (overrides: Record<string, any> = {}): Promise<any> => {
  const id = overrides.id || `eval-run-delete-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    name: 'Run Delete Integration Test Run', status: 'completed', agentKey: 'demo', modelId: 'claude-sonnet',
    sources: [{ type: 'test-case-ids', ids: [] }], trigger: 'api', testCaseSnapshots: [], results: {},
    createdAt: new Date().toISOString(), ...overrides, id,
  };
  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(`Failed to seed eval run: ${response.status} ${await response.text()}`);
  cleanupIds.evalRuns.push(id);
  return response.json();
};

const seedReport = async (overrides: Record<string, any> = {}): Promise<any> => {
  const response = await fetch(`${BASE_URL}/api/storage/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
      status: 'completed', passFailStatus: 'failed',
      trajectory: [{ type: 'response', content: 'Root cause identified: disk full' }],
      metrics: { accuracy: 20 }, timestamp: new Date().toISOString(), ...overrides,
    }),
  });
  if (!response.ok) throw new Error(`Failed to seed report: ${response.status} ${await response.text()}`);
  const report = await response.json();
  cleanupIds.reports.push(report.id);
  return report;
};

const seedBenchmark = async (overrides: Record<string, any> = {}): Promise<any> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Run Delete Integration Test Benchmark', testCaseIds: [], runs: [], ...overrides }),
  });
  if (!response.ok) throw new Error(`Failed to seed benchmark: ${response.status} ${await response.text()}`);
  const bm = await response.json();
  cleanupIds.benchmarks.push(bm.id);
  return bm;
};

const seedDualWritten = async () => {
  const runId = `eval-run-delete-dual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bm = await seedBenchmark({
    runs: [{
      id: runId, name: 'Dual-written run', agentKey: 'demo', modelId: 'claude-sonnet',
      status: 'completed', createdAt: new Date().toISOString(), results: {},
    }],
  });
  const run = await seedEvalRun({ id: runId, benchmarkId: bm.id, sources: [{ type: 'benchmark', benchmarkId: bm.id }] });
  return { bm, run };
};

const benchmarkHasProjection = async (benchmarkId: string, runId: string) => {
  const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
  return (bm.runs || []).some((r: any) => r.id === runId);
};

const docStatus = async (runId: string) => (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).status;

describe('Run delete — removes both persisted forms of a run, keeps its reports', () => {
  let backendAvailable = false;

  beforeAll(async () => { backendAvailable = await checkBackend(); });
  afterAll(async () => { if (backendAvailable) await cleanup(); });

  it('DELETE /evaluation-runs/:id removes the doc AND the projection embedded in benchmark.runs[]', async () => {
    if (!backendAvailable) return;
    const { bm, run } = await seedDualWritten();
    expect(await benchmarkHasProjection(bm.id, run.id)).toBe(true);

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, projectionDeleted: true, benchmarkId: bm.id, cancelled: false });

    expect(await docStatus(run.id)).toBe(404);
    expect(await benchmarkHasProjection(bm.id, run.id)).toBe(false);
  }, 15000);

  it('DELETE /benchmarks/:id/runs/:runId removes the projection AND the evaluation-run doc', async () => {
    if (!backendAvailable) return;
    const { bm, run } = await seedDualWritten();

    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}/runs/${run.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, runId: run.id, projectionDeleted: true, docDeleted: true });

    expect(await docStatus(run.id)).toBe(404);
    expect(await benchmarkHasProjection(bm.id, run.id)).toBe(false);
  }, 15000);

  it('DELETE /benchmarks/:id/runs/:runId on a standalone (never embedded) doc of that benchmark → 200, doc gone (was 404)', async () => {
    if (!backendAvailable) return;
    const bm = await seedBenchmark();
    const run = await seedEvalRun({ status: 'running', benchmarkId: bm.id, sources: [{ type: 'benchmark', benchmarkId: bm.id }] });

    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}/runs/${run.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    // Seeded via PUT — no executor in this process, so nothing to cancel.
    expect(await res.json()).toMatchObject({ deleted: true, projectionDeleted: false, docDeleted: true, cancelled: false });
    expect(await docStatus(run.id)).toBe(404);
  }, 15000);

  it('a run doc belonging to ANOTHER benchmark is not deletable through this benchmark\'s URL', async () => {
    if (!backendAvailable) return;
    const owner = await seedBenchmark({ name: 'Run Delete owner BM' });
    const other = await seedBenchmark({ name: 'Run Delete other BM' });
    const run = await seedEvalRun({ benchmarkId: owner.id, sources: [{ type: 'benchmark', benchmarkId: owner.id }] });

    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${other.id}/runs/${run.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await docStatus(run.id)).toBe(200);
  }, 15000);

  it('an UNLINKED (ad-hoc) run doc is not deletable through any benchmark URL', async () => {
    if (!backendAvailable) return;
    const bm = await seedBenchmark();
    const run = await seedEvalRun();
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}/runs/${run.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await docStatus(run.id)).toBe(200);
  }, 15000);

  it('sample/demo ids are rejected with 400 on the evaluation-runs DELETE too', async () => {
    if (!backendAvailable) return;
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/demo-run-does-not-matter`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  }, 15000);

  it('deleting a run does NOT cascade to its per-test-case report documents', async () => {
    if (!backendAvailable) return;
    const tc = await createTestCase('Delete Keeps Reports TC');
    const report = await seedReport({ testCaseId: tc });
    const run = await seedEvalRun({
      testCaseSnapshots: [{ id: tc, version: 1, name: 'Delete Keeps Reports TC' }],
      results: { [tc]: { status: 'completed', reportId: report.id } },
    });

    expect((await fetch(`${BASE_URL}/api/storage/evaluation-runs/${run.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${BASE_URL}/api/storage/runs/${report.id}`)).status).toBe(200);
  }, 15000);
});
