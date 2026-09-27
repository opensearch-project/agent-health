/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: CLI quick mode attaches every run to ONE stable benchmark.
 *
 * Regression for the "same command creates a new benchmark every time" bug:
 * quick mode (`agent-health benchmark` with no `-n`/`-f`) used to create a
 * `quick-<timestamp>` Benchmark on every invocation. It must NOT go ad-hoc
 * either (owner feedback: the Runs page's Benchmark column has to link to a
 * benchmark page, and history has to accumulate). Quick mode therefore
 * finds-or-creates a single benchmark, refreshes its test-case set to the
 * full stored set when it drifted, and starts the run through the unified
 * evaluation-runs API as a `benchmark` source with `benchmarkId` set.
 *
 * This drives the real CLI helper (`resolveQuickModeBenchmark`) and the real
 * evaluation-runs API against the backend, exactly as the CLI does — under a
 * run-unique benchmark name so it never touches the real quick-mode benchmark
 * on a shared server. Pins: two "quick runs" → exactly one benchmark, two
 * runs dual-written under it; a drifted case set bumps the benchmark version
 * before the run starts.
 *
 * Requires the backend running (npm run dev:server). Cleans up everything it
 * creates (by id).
 */

import { ApiClient } from '@/cli/utils/apiClient';
import { resolveQuickModeBenchmark } from '@/cli/utils/quickModeBenchmark';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const TEST_TIMEOUT = 120000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    if (!response.ok) return false;
    const storageHealth = await fetch(`${BASE_URL}/api/storage/health`);
    const storageData = await storageHealth.json();
    return storageData.status === 'ok';
  } catch {
    return false;
  }
};

describe('CLI quick mode → one stable benchmark, runs attached to it', () => {
  let backendAvailable = false;
  let client: ApiClient;
  const tracker = createTestDataTracker(BASE_URL);
  const testCaseIds: string[] = [];
  // Run-unique stand-in for QUICK_MODE_BENCHMARK_NAME (shared-server safety).
  const identity = {
    name: uniqueTestName('quick-mode-benchmark'),
    description: 'integration stand-in for the CLI quick-mode benchmark',
  };

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      return;
    }
    client = new ApiClient(BASE_URL);

    const bulk = await client.bulkCreateTestCases(
      [1, 2].map((n) => ({
        name: uniqueTestName(`quick-mode-tc-${n}`),
        category: 'General',
        difficulty: 'Easy',
        initialPrompt: `Say hello number ${n}.`,
        expectedOutcomes: ['Greets the user'],
      }))
    );
    testCaseIds.push(...bulk.testCases.map((tc) => tc.id));
    tracker.testCases(testCaseIds);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!backendAvailable) return;
    await tracker.cleanup();
  }, TEST_TIMEOUT);

  async function quickRun(i: number) {
    // What the CLI does per quick-mode invocation: resolve the stable
    // benchmark over the full stored set, then run it as a benchmark source.
    const resolution = await resolveQuickModeBenchmark(client, testCaseIds, identity);
    expect(resolution.outcome).not.toBe('ambiguous');
    const benchmark = (resolution as { benchmark: { id: string } }).benchmark;
    tracker.benchmark(benchmark.id);

    const run = await client.createEvaluationRun(
      {
        name: `quick-mode-run-${i}`,
        sources: [{ type: 'benchmark', benchmarkId: benchmark.id }],
        agentKey: 'demo',
        modelId: 'demo-model',
        benchmarkId: benchmark.id,
        trigger: 'cli',
      },
      () => {}
    );
    expect(run?.id).toBeTruthy();
    tracker.evaluationRun(run!.id);
    for (const result of Object.values(run!.results ?? {})) tracker.run((result as any).reportId);
    return { resolution, run: run! };
  }

  it(
    'two quick runs → exactly one benchmark (created, then reused) with both runs linked to it',
    async () => {
      if (!backendAvailable) return;

      const first = await quickRun(1);
      expect(first.resolution.outcome).toBe('created');
      const benchmarkId = (first.resolution as any).benchmark.id as string;

      const second = await quickRun(2);
      expect(second.resolution.outcome).toBe('reused');
      expect((second.resolution as any).refreshed).toBe(false);
      expect((second.resolution as any).benchmark.id).toBe(benchmarkId);

      // Exactly one benchmark carries the name — no quick-<timestamp> debris.
      const benchmarks = await client.listBenchmarks();
      expect(benchmarks.filter((b) => b.name === identity.name)).toHaveLength(1);
      expect(benchmarks.filter((b) => /^quick-\d+$/.test(b.name) && b.testCaseIds?.some((id) => testCaseIds.includes(id)))).toEqual([]);

      // Both runs are attached to the benchmark (this is what the Runs page's
      // Benchmark column links on) …
      for (const { run } of [first, second]) {
        const stored = await client.getEvaluationRun(run.id);
        expect(stored?.benchmarkId).toBe(benchmarkId);
        expect(stored?.status).toBe('completed');
      }
      // … and dual-written into benchmark.runs[] so the benchmark page's
      // history accumulates.
      const benchmark = await client.getBenchmark(benchmarkId);
      const linkedRunIds = (benchmark?.runs ?? []).map((r) => r.id);
      expect(linkedRunIds).toEqual(expect.arrayContaining([first.run.id, second.run.id]));
      expect(benchmark?.currentVersion).toBe(1);
    },
    TEST_TIMEOUT
  );

  it(
    'a drifted case set is refreshed to the full stored set (new benchmark version) before the run',
    async () => {
      if (!backendAvailable) return;

      const bulk = await client.bulkCreateTestCases([
        {
          name: uniqueTestName('quick-mode-tc-3'),
          category: 'General',
          difficulty: 'Easy',
          initialPrompt: 'Say hello number 3.',
          expectedOutcomes: ['Greets the user'],
        },
      ]);
      testCaseIds.push(...bulk.testCases.map((tc) => tc.id));
      tracker.testCases(bulk.testCases.map((tc) => tc.id));

      const third = await quickRun(3);
      expect(third.resolution.outcome).toBe('reused');
      expect((third.resolution as any).refreshed).toBe(true);

      const benchmark = await client.getBenchmark((third.resolution as any).benchmark.id);
      expect(benchmark?.currentVersion).toBe(2);
      expect([...(benchmark?.testCaseIds ?? [])].sort()).toEqual([...testCaseIds].sort());
      expect(Object.keys(third.run.results ?? {}).sort()).toEqual([...testCaseIds].sort());
      expect((benchmark?.runs ?? []).map((r) => r.id)).toContain(third.run.id);
    },
    TEST_TIMEOUT
  );
});
