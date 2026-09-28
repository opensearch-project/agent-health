/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the "api-contract-hardening" PR: regression coverage
 * for API KPI-probe findings F4, F7, F8, F9, F11, F12. Each block below maps
 * 1:1 to a finding in the PR description.
 *
 * Requires a real running backend (real OpenSearch storage) + a real
 * observability data source for the metrics/logs findings:
 *   AH_PORT=4342 BENCHMARK_RUN_RECOVERY_DISABLED=1 EVALUATION_RUN_RECOVERY_DISABLED=1 npm run dev:server
 *
 * Run:
 *   AH_PORT=4342 npm run test:integration -- --testPathPattern=apiContractHardening.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const TEST_TIMEOUT = 60000;

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    if (!response.ok) return false;
    const data = await response.json();
    return data?.status === 'connected' || data?.status === 'ok';
  } catch {
    return false;
  }
};

// Unique marker so this suite's created data never collides with real data
// or other test runs sharing the cluster.
const NAME_MARKER = `apicontract-integration-${Date.now()}-${process.pid}`;

const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];

const deleteTestCase = (id: string) =>
  fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
const deleteBenchmark = (id: string) =>
  fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});

describe('API contract hardening (F4/F7/F8/F9/F11/F12 regressions)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping api-contract-hardening integration tests');
      console.warn(`Start it with: AH_PORT=4342 npm run dev:server (BASE_URL=${BASE_URL})`);
    }
  }, 30000);

  afterAll(async () => {
    if (!backendAvailable) return;
    for (const id of createdBenchmarkIds) await deleteBenchmark(id);
    for (const id of createdTestCaseIds) await deleteTestCase(id);
  }, 30000);

  // ── F4: malformed JSON body never leaks an HTML stack trace ────────────
  describe('F4: malformed JSON body handling', () => {
    const routes = ['/api/storage/test-cases', '/api/storage/benchmarks', '/api/logs'];

    for (const route of routes) {
      it(`returns 400 JSON (never HTML/stack) for a malformed body on POST ${route}`, async () => {
        if (!backendAvailable) return;
        const response = await fetch(`${BASE_URL}${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not json',
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toMatch(/json/);
        const text = await response.text();
        expect(text.toLowerCase()).not.toContain('<html');
        expect(text).not.toContain('SyntaxError');
        expect(text).not.toContain('    at ');
        const body = JSON.parse(text);
        expect(typeof body.error).toBe('string');
      });
    }
  });

  // ── F11: the legacy execute route never persists a run ─────────────────
  // (It used to fast-400 an unknown agentKey; the legacy runner is now removed
  // and the route answers 410 for EVERY body, still without touching storage.)
  describe('F11: POST /api/storage/benchmarks/:id/execute with unknown agentKey', () => {
    let benchmarkId: string;

    beforeAll(async () => {
      if (!backendAvailable) return;
      const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${NAME_MARKER}-f11-tc`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'noop',
          context: [],
          expectedOutcomes: [],
        }),
      });
      const tc = await tcRes.json();
      createdTestCaseIds.push(tc.id);

      const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_MARKER}-f11-bm`, testCaseIds: [tc.id] }),
      });
      const bm = await bmRes.json();
      benchmarkId = bm.id;
      createdBenchmarkIds.push(benchmarkId);
    }, TEST_TIMEOUT);

    it('answers 410 Gone (legacy runner removed) and leaves benchmark.runs[] unchanged', async () => {
      if (!backendAvailable) return;

      const before = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`).then((r) => r.json());
      const runsBefore = (before.runs ?? []).length;

      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'bogus-agent-run', agentKey: `nonexistent-agent-${NAME_MARKER}` }),
      });

      expect(response.status).toBe(410);
      expect(response.headers.get('content-type')).toMatch(/json/);
      const body = await response.json();
      expect(body.code).toBe('LEGACY_EXECUTE_REMOVED');
      expect(body.replacement).toBe('POST /api/storage/evaluation-runs');

      const after = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`).then((r) => r.json());
      expect((after.runs ?? []).length).toBe(runsBefore);
    }, TEST_TIMEOUT);
  });

  // ── F12: PATCH .../metadata rejects type-confused values ────────────────
  describe('F12: PATCH /api/storage/benchmarks/:id/metadata type validation', () => {
    let benchmarkId: string;

    beforeAll(async () => {
      if (!backendAvailable) return;
      const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_MARKER}-f12-bm`, testCaseIds: [] }),
      });
      const bm = await bmRes.json();
      benchmarkId = bm.id;
      createdBenchmarkIds.push(benchmarkId);
    }, TEST_TIMEOUT);

    it('rejects a numeric name with 400 and leaves the document unchanged', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 12345 }),
      });
      expect(response.status).toBe(400);

      const after = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`).then((r) => r.json());
      expect(after.name).toBe(`${NAME_MARKER}-f12-bm`);
      expect(typeof after.name).toBe('string');
    });

    it('rejects a non-string description with 400', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: { nested: true } }),
      });
      expect(response.status).toBe(400);
    });

    it('still accepts a valid string name update', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_MARKER}-f12-bm-renamed` }),
      });
      expect(response.status).toBe(200);
      const updated = await response.json();
      expect(updated.name).toBe(`${NAME_MARKER}-f12-bm-renamed`);
    });
  });

  // ── F7: delete-of-nonexistent must 404 consistently ─────────────────────
  describe('F7: DELETE semantics for nonexistent ids', () => {
    it('DELETE /api/storage/test-cases/:nonexistent returns 404 (regression: previously 200 { deleted: 0 })', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/test-cases/${NAME_MARKER}-does-not-exist`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(404);
    });

    it('DELETE /api/storage/benchmarks/:nonexistent returns 404 (regression: previously 200 { deleted: true })', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${NAME_MARKER}-does-not-exist`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(404);
    });

    it('still returns 200 for a real delete (no regression)', async () => {
      if (!backendAvailable) return;
      const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_MARKER}-f7-real-delete`, testCaseIds: [] }),
      });
      const bm = await bmRes.json();

      const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(true);

      // Confirm it's actually gone (don't double-delete in afterAll).
      const getRes = await fetch(`${BASE_URL}/api/storage/benchmarks/${bm.id}`);
      expect(getRes.status).toBe(404);
    });
  });

  // ── F8: metrics for a nonexistent run must be distinguishable ──────────
  describe('F8: GET /api/metrics/:runId for a nonexistent run', () => {
    it('returns hasSpans:false alongside the all-zero metrics (regression: previously indistinguishable from a real zero-cost run)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/metrics/${NAME_MARKER}-nonexistent-run`);
      // 503 is acceptable if this environment has no observability data
      // source configured at all; anything else must carry hasSpans:false.
      if (response.status === 503) return;
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hasSpans).toBe(false);
      expect(body.status).toBe('pending');
    });
  });

  // ── F9: POST /api/logs requires a runId ─────────────────────────────────
  describe('F9: POST /api/logs input validation', () => {
    it('rejects an empty body with 400 (regression: previously ran an unscoped query)', async () => {
      if (!backendAvailable) return;
      const response = await fetch(`${BASE_URL}/api/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.toLowerCase()).toContain('runid');
    });
  });

  // -- F5: dead leaderboard route was never mounted; now removed entirely --
  describe('F5: removed leaderboard routes stay 404 (dead code deletion)', () => {
    const routes = [
      '/api/coding-agents/leaderboard/rankings',
      '/api/coding-agents/leaderboard/badges/definitions',
      '/api/coding-agents/leaderboard/sync-status',
    ];

    for (const route of routes) {
      it(`GET ${route} returns 404 (unchanged: route was already unmounted before removal)`, async () => {
        if (!backendAvailable) return;
        const response = await fetch(`${BASE_URL}${route}`);
        expect(response.status).toBe(404);
      });
    }
  });
});
