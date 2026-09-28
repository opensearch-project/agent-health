/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · API · legacy `POST /api/storage/benchmarks/:id/execute`
 *
 * The legacy benchmark runner route. It is deprecated (docs/CLI.md → "Benchmark
 * execution path"); no bundled surface calls it any more, but customers with
 * scripts might. This spec pins the route's CURRENT contract in ONE constant:
 *
 *   LEGACY_EXECUTE_EXPECTED — the status a well-formed execute request gets.
 *     200 today (the route still runs the benchmark and streams SSE).
 *     The removal PR retires the runner and must flip this constant to 410
 *     (Gone) — and change NOTHING ELSE in this file. Every other assertion
 *     below is written to hold on both sides of that flip.
 *
 * Storage caveat: the legacy runner refuses the file backend BEFORE it would
 * start ("OpenSearch not configured", 400). While the route still exists, a
 * file-storage server therefore answers 400 where an OpenSearch server
 * answers 200; once it is 410 the backend no longer matters. The spec derives
 * the file-backend expectation from LEGACY_EXECUTE_EXPECTED so the removal PR
 * still only touches the constant.
 *
 * Always pinned (both sides of the flip):
 *   - sample/demo benchmark ids are refused with 400 (read-only sample data)
 *     while the route exists, and 410 once it is gone;
 *   - the request never hangs: the response ends;
 *   - when the route DOES run (200), the run appears in `benchmark.runs[]`
 *     with N results and the SSE stream ends with a terminal `completed` event.
 */

import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, DEMO_MODEL, backendReady, caseInput, createBenchmark, createTestCase, getBenchmark, httpRequest, postSse,
  registerRestAgent, storageBackend,
} from '../../helpers/surfaceMatrix';

/** ← the removal PR changes exactly this line to `410`. */
const LEGACY_EXECUTE_EXPECTED = 200;

const TEST_TIMEOUT = 180_000;
const CASES = 2;

describe('surface-matrix · API · legacy POST /api/storage/benchmarks/:id/execute', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let benchmarkId: string;
  let backend: 'file' | 'opensearch' | 'unknown';

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    backend = await storageBackend();
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    const ids: string[] = [];
    for (let i = 1; i <= CASES; i++) {
      const tc = await createTestCase(caseInput('api-legacy-execute', i));
      tracker.testCase(tc.id);
      ids.push(tc.id);
    }
    const bm = await createBenchmark(uniqueTestName('api-legacy-execute-bench'), ids);
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    await tracker.cleanup();
  }, 60_000);

  /** What THIS server should answer a well-formed execute request with. */
  function expectedStatus(): number {
    if (LEGACY_EXECUTE_EXPECTED === 200 && backend === 'file') return 400; // runner still exists but needs OpenSearch
    return LEGACY_EXECUTE_EXPECTED;
  }

  it(`a well-formed execute request answers ${LEGACY_EXECUTE_EXPECTED} (route ${LEGACY_EXECUTE_EXPECTED === 200 ? 'still runs' : 'is gone'}) and the response ends`, async () => {
    if (!ready) return;
    const body = { name: uniqueTestName('legacy-execute-run'), agentKey, modelId: DEMO_MODEL, judgeModelId: DEMO_MODEL, concurrency: 2 };
    const res = await postSse(`/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`, body);
    expect(res.status).toBe(expectedStatus());

    if (res.status === 200) {
      // Route still live: it streams and actually runs the benchmark.
      expect(res.headers['content-type']).toContain('text/event-stream');
      const types = res.events.map((e) => e.data?.type ?? e.event);
      expect(types).toContain('started');
      expect(types).toContain('completed');
      const started = res.events.find((e) => (e.data?.type ?? e.event) === 'started')!.data;
      const runId = started.runId ?? started.run?.id;
      expect(runId).toBeTruthy();
      tracker.benchmarkRun(benchmarkId, runId);
      const bench = await getBenchmark(benchmarkId);
      const run = (bench.runs || []).find((r: any) => r.id === runId);
      expect(run).toBeDefined();
      expect(run.status).toBe('completed');
      expect(Object.keys(run.results)).toHaveLength(CASES);
      for (const r of Object.values(run.results) as any[]) tracker.run(r.reportId);
    } else if (res.status === 400) {
      expect(res.text).toMatch(/OpenSearch not configured/);
    } else {
      expect(res.status).toBe(410);
    }
  }, TEST_TIMEOUT);

  it('sample (demo-*) benchmarks are never executable through the legacy route', async () => {
    if (!ready) return;
    const res = await httpRequest('POST', '/api/storage/benchmarks/demo-baseline/execute', { name: 'x', agentKey, modelId: DEMO_MODEL });
    expect([400, 410]).toContain(res.status);
    if (LEGACY_EXECUTE_EXPECTED === 200) expect(res.status).toBe(400);
  });
});
