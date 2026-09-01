/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: GET /api/storage/evaluation-runs?benchmarkId=X must return
 * every evaluation-run associated with that benchmark — including ones with
 * status 'running' and ones that were never embedded into
 * benchmark.runs[] — end to end against the real server.
 *
 * Regression for bug #6 (2026-09-01): the benchmark-scoped Runs page
 * (components/evals3/BenchmarkRunsPage.tsx) started depending on this exact
 * query for the first time to merge in associated-but-not-embedded
 * eval-runs (e.g. runs kicked off via CLI/API/scheduler, which are
 * standalone `evaluation-run` docs, not entries in benchmark.runs[]). If
 * this filter ever silently dropped 'running' rows or the wrong-benchmark
 * rows leaked in, the page's merge logic would look broken again with no
 * client-side signal.
 *
 * Requires the backend running (npm run dev:server). Cleans up everything
 * it creates.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    const d = await r.json();
    // Both storage backends report `status: 'ok'` on success (see
    // server/adapters/{file,opensearch}/StorageModule.ts `health()`) —
    // 'connected' is not a value either backend ever returns.
    return d.status === 'ok';
  } catch {
    return false;
  }
};

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let backendUp = false;
let benchmarkAId = '';
let benchmarkBId = '';
const runIds: string[] = [];

async function seedEvalRun(id: string, benchmarkId: string | undefined, status: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      name: `benchmarkId-filter ${id}`,
      status,
      agentKey: 'demo',
      modelId: 'claude-sonnet',
      benchmarkId,
      sources: benchmarkId ? [{ type: 'benchmark', benchmarkId }] : [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: new Array(5).fill({ id: 'tc-x', version: 1, name: 'tc-x' }),
      results: status === 'running'
        ? { 'tc-0': { reportId: 'r-0', status: 'failed' } }
        : {},
      createdAt: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`seed eval-run ${id} failed: ${res.status} ${await res.text()}`);
  runIds.push(id);
}

beforeAll(async () => {
  backendUp = await checkBackend();
  if (!backendUp) return;

  const bmA = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `benchmarkId-filter A ${suffix}`, testCaseIds: [] }),
  });
  if (!bmA.ok) throw new Error(`create benchmark A failed: ${bmA.status} ${await bmA.text()}`);
  benchmarkAId = (await bmA.json()).id;

  const bmB = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `benchmarkId-filter B ${suffix}`, testCaseIds: [] }),
  });
  if (!bmB.ok) throw new Error(`create benchmark B failed: ${bmB.status} ${await bmB.text()}`);
  benchmarkBId = (await bmB.json()).id;

  await seedEvalRun(`eval-run-filter-running-${suffix}`, benchmarkAId, 'running');
  await seedEvalRun(`eval-run-filter-completed-${suffix}`, benchmarkAId, 'completed');
  await seedEvalRun(`eval-run-filter-other-bm-${suffix}`, benchmarkBId, 'running');
  await seedEvalRun(`eval-run-filter-adhoc-${suffix}`, undefined, 'completed');
});

afterAll(async () => {
  if (!backendUp) return;
  for (const id of runIds) {
    await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of [benchmarkAId, benchmarkBId]) {
    if (id) await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
});

describe('GET /api/storage/evaluation-runs?benchmarkId=X (bug #6 dependency)', () => {
  it('returns exactly the runs associated with that benchmark, including a running one, excluding other benchmarks and ad-hoc runs', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }

    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(benchmarkAId)}&size=100`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    const ids = body.evaluationRuns.map((r: { id: string }) => r.id);

    expect(ids).toContain(`eval-run-filter-running-${suffix}`);
    expect(ids).toContain(`eval-run-filter-completed-${suffix}`);
    expect(ids).not.toContain(`eval-run-filter-other-bm-${suffix}`);
    expect(ids).not.toContain(`eval-run-filter-adhoc-${suffix}`);

    const runningRow = body.evaluationRuns.find((r: { id: string }) => r.id === `eval-run-filter-running-${suffix}`);
    expect(runningRow.status).toBe('running');
    // The planned test-case count must round-trip so the client's
    // computeRunStats(run) can report the true total, not just the
    // count of cases that have started.
    expect(runningRow.testCaseSnapshots).toHaveLength(5);
  });

  it('a benchmarkId with no associated runs returns an empty (not erroring) list', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent('bench-does-not-exist-' + suffix)}`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.evaluationRuns).toEqual([]);
  });
});
