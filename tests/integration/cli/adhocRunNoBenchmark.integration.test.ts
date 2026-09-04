/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: repeated ad-hoc evaluation runs must NOT mint Benchmark docs.
 *
 * Regression for the "same command creates a new benchmark every time" bug:
 * CLI quick mode used to create a `quick-<timestamp>` Benchmark on every
 * invocation. Quick mode now routes through the unified evaluation-runs API
 * as an ad-hoc run (sources: test-case-ids, no benchmarkId). This test pins
 * the invariant that path relies on: creating N ad-hoc evaluation runs leaves
 * the benchmark list count unchanged.
 *
 * Requires the backend running (npm run dev:server). Cleans up everything it
 * creates.
 */

import { ApiClient } from '@/cli/utils/apiClient';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

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

describe('Ad-hoc evaluation runs do not create benchmarks (quick-mode dedup)', () => {
  let backendAvailable = false;
  let client: ApiClient;
  const createdTestCaseIds: string[] = [];
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      return;
    }
    client = new ApiClient(BASE_URL);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!backendAvailable) return;
    await Promise.all([
      ...createdRunIds.map((id) =>
        fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).catch(() => {})
      ),
      ...createdTestCaseIds.map((id) =>
        fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).catch(() => {})
      ),
    ]);
  }, TEST_TIMEOUT);

  it(
    'running the same ad-hoc evaluation twice leaves the benchmark count unchanged',
    async () => {
      if (!backendAvailable) return;

      // Seed one test case (the "quick mode" pool)
      const bulk = await client.bulkCreateTestCases([
        {
          name: `adhoc-dedup-tc-${Date.now()}`,
          category: 'General',
          difficulty: 'Easy',
          initialPrompt: 'Say hello.',
          expectedOutcomes: ['Greets the user'],
        },
      ]);
      createdTestCaseIds.push(...bulk.testCases.map((tc) => tc.id));

      const benchmarksBefore = await client.listBenchmarks();

      // Same "command" twice: identical ad-hoc runs (what quick mode now issues)
      for (let i = 0; i < 2; i++) {
        const run = await client.createEvaluationRun(
          {
            name: `adhoc-dedup-run-${Date.now()}-${i}`,
            sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
            agentKey: 'demo',
            modelId: 'demo-model',
            trigger: 'cli',
          },
          () => {}
        );
        if (run?.id) createdRunIds.push(run.id);
      }

      const benchmarksAfter = await client.listBenchmarks();

      // No benchmark docs minted by ad-hoc runs — and definitely no quick-* ones
      expect(benchmarksAfter.length).toBe(benchmarksBefore.length);
      expect(benchmarksAfter.filter((b) => /^quick-\d+$/.test(b.name))).toEqual(
        benchmarksBefore.filter((b) => /^quick-\d+$/.test(b.name))
      );
    },
    TEST_TIMEOUT
  );
});
