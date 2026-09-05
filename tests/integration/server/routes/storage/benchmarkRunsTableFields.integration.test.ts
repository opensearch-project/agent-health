/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration contract for the benchmark Runs TABLE (table + pass-rate chart,
 * owner sketch 2026-09-03). Every column the table renders is derived
 * client-side from fields on the embedded run docs returned by
 * `GET /api/storage/benchmarks/:id` — so this pins that the route round-trips
 * (and, under `?runsSize=` pagination, preserves) exactly the fields the table
 * needs, on a REAL backend:
 *
 *   Size      ← run.testCaseSnapshots.length (falls back to results count)
 *   Pass %    ← run.results[*].status + passFailStatus (NOT run.stats)
 *   Judge     ← run.evaluatorId
 *   J. Model  ← run.judgeModelId
 *   Agent     ← run.agentKey     Model ← run.modelId     Date ← run.createdAt
 *
 * Also asserts the `fields=polling` request the page issues every 2–5s while a
 * run is in flight still carries the verdict fields the Pass % column and the
 * chart re-derive on every poll (results[*].status/passFailStatus, status,
 * judgeModelId).
 *
 * Requires a running backend (AH_PORT). Run:
 *   AH_PORT=4361 npm run test:integration -- --testPathPatterns=benchmarkRunsTableFields
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';
import { buildRunTableRow, buildPassRateSeries } from '@/lib/benchmarkRunsTable';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    return (await r.json()).status === 'ok';
  } catch {
    return false;
  }
};

describe('GET /api/storage/benchmarks/:id — fields the Runs table depends on (integration)', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;
  let benchmarkId: string | null = null;
  const testCaseIds: string[] = [];
  const RUN_A = `run-rt-int-a-${Date.now()}`;
  const RUN_B = `run-rt-int-b-${Date.now()}`;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) return;

    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uniqueTestName(`rt-int-tc-${i}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] }),
      });
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }

    const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('rt-int-benchmark'), description: 'runs-table integration', testCaseIds, runs: [], currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
      }),
    });
    benchmarkId = (await bmRes.json()).id;
    tracker.benchmark(benchmarkId);

    const snaps = testCaseIds.map(id => ({ id, version: 1, name: id }));
    const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    const put = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
        runs: [
          {
            id: RUN_A, name: 'RT-INT A', agentKey: 'demo', modelId: 'demo-model',
            judgeModelId: 'rt-int-judge-model', evaluatorId: 'rt-int-evaluator',
            createdAt: '2026-09-02T00:00:00.000Z', status: 'completed', benchmarkVersion: 1,
            testCaseSnapshots: snaps,
            results: {
              [testCaseIds[0]]: { reportId: `report-${RUN_A}-0`, status: 'completed', passFailStatus: 'passed' },
              [testCaseIds[1]]: { reportId: `report-${RUN_A}-1`, status: 'completed', passFailStatus: 'failed' },
            },
            // Deliberately stale denormalized stats — the table must NOT read these.
            stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 },
          },
          {
            id: RUN_B, name: 'RT-INT B (in flight)', agentKey: 'demo', modelId: 'demo-model',
            createdAt: '2026-09-01T00:00:00.000Z', status: 'running', benchmarkVersion: 1,
            testCaseSnapshots: snaps,
            // Only one of two planned cases has started → Size must still be 2.
            results: { [testCaseIds[0]]: { reportId: `report-${RUN_B}-0`, status: 'running' } },
          },
        ],
      }),
    });
    if (!put.ok) benchmarkId = null;
  }, 60_000);

  afterAll(async () => {
    if (backendAvailable) await tracker.cleanup();
  }, 60_000);

  it('round-trips judgeModelId / evaluatorId / testCaseSnapshots / results on embedded runs', async () => {
    if (!backendAvailable || !benchmarkId) return;
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const a = body.runs.find((r: any) => r.id === RUN_A);
    const b = body.runs.find((r: any) => r.id === RUN_B);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    expect(a.judgeModelId).toBe('rt-int-judge-model');
    expect(a.evaluatorId).toBe('rt-int-evaluator');
    expect(a.agentKey).toBe('demo');
    expect(a.modelId).toBe('demo-model');
    expect(a.createdAt).toBe('2026-09-02T00:00:00.000Z');
    expect(a.testCaseSnapshots).toHaveLength(2);
    expect(a.results[testCaseIds[0]].passFailStatus).toBe('passed');
    expect(a.results[testCaseIds[1]].passFailStatus).toBe('failed');
    expect(b.testCaseSnapshots).toHaveLength(2);
    expect(Object.keys(b.results)).toHaveLength(1);
  });

  it('the table row derived from the real response shows Size=2, Pass %=50 (ignoring stale stats), Judge + J. Model ids', async () => {
    if (!backendAvailable || !benchmarkId) return;
    const body = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).json();
    const resolvers = {
      agentName: (k: string) => k, modelName: (id: string) => id,
      judgeLabel: (id?: string | null) => id || '—', evaluatorLabel: (id?: string | null) => id || '—',
    };
    const rowA = buildRunTableRow(body.runs.find((r: any) => r.id === RUN_A), resolvers);
    expect(rowA.size).toBe(2);
    expect(rowA.passed).toBe(1);
    expect(rowA.failed).toBe(1);
    expect(rowA.passRate).toBe(50); // stale stats claimed 2/2
    expect(rowA.judgeModelId).toBe('rt-int-judge-model');
    expect(rowA.evaluatorId).toBe('rt-int-evaluator');

    const rowB = buildRunTableRow(body.runs.find((r: any) => r.id === RUN_B), resolvers);
    expect(rowB.status).toBe('running');
    expect(rowB.size).toBe(2);       // planned, not started
    expect(rowB.total).toBe(2);
    expect(rowB.pending + rowB.running).toBe(2);
    expect(rowB.passRate).toBeNull(); // nothing judged yet

    // The chart excludes the un-judged in-flight run and keeps the judged one.
    const series = buildPassRateSeries([rowA, rowB]);
    expect(series).toHaveLength(1);
    expect(series[0].points.map(p => p.runId)).toEqual([RUN_A]);
  });

  it('preserves those fields under ?runsSize= pagination (what the page actually requests) and reports totals', async () => {
    if (!backendAvailable || !benchmarkId) return;
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}?runsSize=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalRuns).toBe(2);
    expect(body.hasMoreRuns).toBe(true);
    expect(body.runs).toHaveLength(1);
    const first = body.runs[0];
    expect(first.testCaseSnapshots).toHaveLength(2);
    expect(typeof first.agentKey).toBe('string');
    expect(typeof first.createdAt).toBe('string');

    const page2 = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}?runsSize=1&runsOffset=1`)).json();
    expect(page2.hasMoreRuns).toBe(false);
    expect(page2.runs).toHaveLength(1);
    expect(new Set([first.id, page2.runs[0].id])).toEqual(new Set([RUN_A, RUN_B]));
  });

  it('fields=polling (the in-flight poll request) still carries the verdict + judge fields the table re-derives on each poll', async () => {
    if (!backendAvailable || !benchmarkId) return;
    const body = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}?fields=polling&runsSize=100`)).json();
    const a = body.runs.find((r: any) => r.id === RUN_A);
    const b = body.runs.find((r: any) => r.id === RUN_B);
    expect(a).toBeTruthy();
    expect(a.results[testCaseIds[0]].passFailStatus).toBe('passed');
    expect(a.results[testCaseIds[1]].passFailStatus).toBe('failed');
    expect(a.status).toBe('completed');
    expect(a.judgeModelId).toBe('rt-int-judge-model');
    expect(a.evaluatorId).toBe('rt-int-evaluator');
    expect(b.status).toBe('running');
    expect(b.results[testCaseIds[0]].status).toBe('running');
  });
});
