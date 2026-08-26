/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the Benchmarks detail API must NOT surface evaluation-runs.
 *
 * Benchmarks and evaluation-runs share one storage index/dir, discriminated by
 * `docType`. The benchmark detail op (`getById`) reads by id with no `docType`
 * check, so a CLI/SDK eval-run id (`docType: 'evaluation-run'`, created via
 * `POST /api/storage/evaluation-runs`) rendered as an empty benchmark when
 * fetched via `/api/storage/benchmarks/:id`.
 *
 * Regression for: /evaluations/benchmarks/<eval-run-id>/runs rendered an
 * eval-run as an empty benchmark ("No runs yet"). No benchmark doc was ever
 * created — this is an eval-run (correctly shown on the Evaluations > Runs
 * page) leaking into the benchmark detail surface.
 *
 * Requires the backend running (npm run dev:server). Cleans up everything it creates.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    const d = await r.json();
    return d.status === 'connected';
  } catch {
    return false;
  }
};

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const evalRunId = `eval-run-bmleak-${suffix}`;
let benchmarkId = '';
let backendUp = false;

beforeAll(async () => {
  backendUp = await checkBackend();
  if (!backendUp) return;

  // 1. Seed an evaluation-run (docType 'evaluation-run') via upsert PUT.
  const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${evalRunId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: evalRunId,
      name: `BM-leak eval-run ${suffix}`,
      status: 'completed',
      agentKey: 'demo',
      modelId: 'claude-sonnet',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
      createdAt: new Date().toISOString(),
    }),
  });
  if (!runRes.ok) throw new Error(`seed eval-run failed: ${runRes.status} ${await runRes.text()}`);

  // 2. Create a real benchmark (docType benchmark / none).
  const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `BM-leak real benchmark ${suffix}`, testCaseIds: [] }),
  });
  if (!bmRes.ok) throw new Error(`create benchmark failed: ${bmRes.status} ${await bmRes.text()}`);
  benchmarkId = (await bmRes.json()).id;
});

afterAll(async () => {
  if (!backendUp) return;
  await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(evalRunId)}`, { method: 'DELETE' }).catch(() => {});
  if (benchmarkId) {
    await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`, { method: 'DELETE' }).catch(() => {});
  }
});

describe('Benchmarks detail API excludes evaluation-runs', () => {
  it('GET /api/storage/benchmarks/:id returns 404 for an evaluation-run id', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(evalRunId)}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/storage/benchmarks/:id still returns a real benchmark', async () => {
    if (!backendUp) { console.warn('backend down — skipping'); return; }
    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    const bm = body.benchmark ?? body;
    expect(bm.id).toBe(benchmarkId);
  });
});
