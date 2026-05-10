/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for sample data filtering (hide defaults when custom data exists)
 *
 * These tests verify the ?includeSample query parameter behavior:
 * - When absent: smart default hides sample data if real data exists
 * - When true: always includes sample data
 * - When false: never includes sample data
 * - meta.sampleDataIncluded reflects the actual inclusion state
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=sampleDataFiltering
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();
const TEST_TIMEOUT = 30000;

// Check if backend is available (storage connected)
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'connected';
  } catch {
    return false;
  }
};

// Create a real test case (non-demo)
const createTestCase = async (name: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'RCA',
      difficulty: 'Medium',
      initialPrompt: 'Test prompt for sample data filtering integration test',
      context: [],
      expectedOutcomes: ['Identify root cause'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test case: ${response.statusText}`);
  }

  const testCase = await response.json();
  return testCase.id;
};

// Create a real benchmark (non-demo)
const createBenchmark = async (name: string, testCaseIds: string[]): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      description: 'Benchmark for sample data filtering integration test',
      testCaseIds,
      runs: [],
      currentVersion: 1,
      versions: [{
        version: 1,
        createdAt: new Date().toISOString(),
        testCaseIds,
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create benchmark: ${response.statusText}`);
  }

  const benchmark = await response.json();
  return benchmark.id;
};

// Delete a benchmark
const deleteBenchmark = async (id: string): Promise<void> => {
  await fetch(`${BASE_URL}/api/storage/benchmarks/${id}`, { method: 'DELETE' });
};

// Delete a test case
const deleteTestCase = async (id: string): Promise<void> => {
  await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' });
};

describe('Sample Data Filtering - Benchmarks', () => {
  let backendAvailable = false;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;

  const TEST_CASE_NAME = 'SampleFilter Integration TC';
  const BENCHMARK_NAME = 'SampleFilter Integration Benchmark';

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping sample data filtering integration tests');
      console.warn('Start the backend with: npm run dev:server');
      return;
    }

    // Create real data so smart default can hide sample data
    testCaseId = await createTestCase(TEST_CASE_NAME);
    benchmarkId = await createBenchmark(BENCHMARK_NAME, [testCaseId]);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!backendAvailable) return;

    // Cleanup by tracked ID
    if (benchmarkId) await deleteBenchmark(benchmarkId);
    if (testCaseId) await deleteTestCase(testCaseId);

    // Fallback: clean up leftovers by name
    try {
      const benchResp = await fetch(`${BASE_URL}/api/storage/benchmarks`);
      if (benchResp.ok) {
        const data = await benchResp.json();
        for (const b of (data.benchmarks ?? [])) {
          if (b.name === BENCHMARK_NAME) {
            await deleteBenchmark(b.id).catch(() => {});
          }
        }
      }
      const tcResp = await fetch(`${BASE_URL}/api/storage/test-cases`);
      if (tcResp.ok) {
        const data = await tcResp.json();
        for (const tc of (data.testCases ?? [])) {
          if (tc.name === TEST_CASE_NAME) {
            await deleteTestCase(tc.id).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }, TEST_TIMEOUT);

  it('excludes sample data by default when real data exists', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/benchmarks`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.benchmarks).toBeDefined();
    expect(Array.isArray(data.benchmarks)).toBe(true);

    // Should not contain any sample data (demo- prefixed IDs)
    const sampleItems = data.benchmarks.filter((b: any) => b.id.startsWith('demo-'));
    expect(sampleItems).toHaveLength(0);

    // Should contain our real benchmark
    const realBenchmark = data.benchmarks.find((b: any) => b.id === benchmarkId);
    expect(realBenchmark).toBeDefined();
  }, TEST_TIMEOUT);

  it('?includeSample=true always includes sample data', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=true`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.benchmarks).toBeDefined();

    // Should contain items with demo- prefix IDs
    const sampleItems = data.benchmarks.filter((b: any) => b.id.startsWith('demo-'));
    expect(sampleItems.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  it('?includeSample=false never includes sample data', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.benchmarks).toBeDefined();

    // Should not contain any sample data regardless of real data existence
    const sampleItems = data.benchmarks.filter((b: any) => b.id.startsWith('demo-'));
    expect(sampleItems).toHaveLength(0);
  }, TEST_TIMEOUT);

  it('includes sample data by default when no real data exists', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    // Temporarily delete the real benchmark to simulate empty state
    if (benchmarkId) await deleteBenchmark(benchmarkId);

    try {
      // Check if there are other real benchmarks
      const checkResp = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`);
      const checkData = await checkResp.json();
      const hasOtherRealData = (checkData.benchmarks ?? []).length > 0;

      if (hasOtherRealData) {
        // Other real data exists, so we can't test the "no real data" case cleanly.
        // Just verify the meta field exists and is boolean.
        const response = await fetch(`${BASE_URL}/api/storage/benchmarks`);
        const data = await response.json();
        expect(typeof data.meta.sampleDataIncluded).toBe('boolean');
      } else {
        // No real data - smart default should include sample data
        const response = await fetch(`${BASE_URL}/api/storage/benchmarks`);
        const data = await response.json();
        expect(data.meta.sampleDataIncluded).toBe(true);

        const sampleItems = data.benchmarks.filter((b: any) => b.id.startsWith('demo-'));
        expect(sampleItems.length).toBeGreaterThan(0);
      }
    } finally {
      // Re-create the benchmark for other tests
      if (testCaseId) {
        benchmarkId = await createBenchmark(BENCHMARK_NAME, [testCaseId]);
      }
    }
  }, TEST_TIMEOUT);

  it('meta.sampleDataIncluded reflects actual inclusion state', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    // When includeSample=true, meta should say true
    const responseInclude = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=true`);
    const dataInclude = await responseInclude.json();
    expect(dataInclude.meta.sampleDataIncluded).toBe(true);

    // When includeSample=false, meta should say false
    const responseExclude = await fetch(`${BASE_URL}/api/storage/benchmarks?includeSample=false`);
    const dataExclude = await responseExclude.json();
    expect(dataExclude.meta.sampleDataIncluded).toBe(false);

    // Default (with real data existing) should say false
    const responseDefault = await fetch(`${BASE_URL}/api/storage/benchmarks`);
    const dataDefault = await responseDefault.json();
    expect(dataDefault.meta.sampleDataIncluded).toBe(false);
  }, TEST_TIMEOUT);
});

describe('Sample Data Filtering - Test Cases', () => {
  let backendAvailable = false;
  let testCaseId: string | null = null;

  const TEST_CASE_NAME = 'SampleFilter TC Integration';

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping test case sample data filtering tests');
      console.warn('Start the backend with: npm run dev:server');
      return;
    }

    // Create real data so smart default can hide sample data
    testCaseId = await createTestCase(TEST_CASE_NAME);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!backendAvailable) return;

    // Cleanup by tracked ID
    if (testCaseId) await deleteTestCase(testCaseId);

    // Fallback: clean up leftovers by name
    try {
      const tcResp = await fetch(`${BASE_URL}/api/storage/test-cases`);
      if (tcResp.ok) {
        const data = await tcResp.json();
        for (const tc of (data.testCases ?? [])) {
          if (tc.name === TEST_CASE_NAME) {
            await deleteTestCase(tc.id).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }, TEST_TIMEOUT);

  it('excludes sample data by default when real data exists', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/test-cases`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.testCases).toBeDefined();
    expect(Array.isArray(data.testCases)).toBe(true);

    // Should not contain any sample data (demo- prefixed IDs)
    const sampleItems = data.testCases.filter((tc: any) => tc.id.startsWith('demo-'));
    expect(sampleItems).toHaveLength(0);

    // Should contain our real test case
    const realTestCase = data.testCases.find((tc: any) => tc.id === testCaseId);
    expect(realTestCase).toBeDefined();
  }, TEST_TIMEOUT);

  it('?includeSample=true always includes sample data', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=true`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.testCases).toBeDefined();

    // Should contain items with demo- prefix IDs
    const sampleItems = data.testCases.filter((tc: any) => tc.id.startsWith('demo-'));
    expect(sampleItems.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  it('?includeSample=false never includes sample data', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.testCases).toBeDefined();

    // Should not contain any sample data regardless of real data existence
    const sampleItems = data.testCases.filter((tc: any) => tc.id.startsWith('demo-'));
    expect(sampleItems).toHaveLength(0);
  }, TEST_TIMEOUT);

  it('includes sample data by default when no real data exists', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    // Temporarily delete the real test case to simulate empty state
    if (testCaseId) await deleteTestCase(testCaseId);

    try {
      // Check if there are other real test cases
      const checkResp = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`);
      const checkData = await checkResp.json();
      const hasOtherRealData = (checkData.testCases ?? []).length > 0;

      if (hasOtherRealData) {
        // Other real data exists, so we can't test the "no real data" case cleanly.
        // Just verify the meta field exists and is boolean.
        const response = await fetch(`${BASE_URL}/api/storage/test-cases`);
        const data = await response.json();
        expect(typeof data.meta.sampleDataIncluded).toBe('boolean');
      } else {
        // No real data - smart default should include sample data
        const response = await fetch(`${BASE_URL}/api/storage/test-cases`);
        const data = await response.json();
        expect(data.meta.sampleDataIncluded).toBe(true);

        const sampleItems = data.testCases.filter((tc: any) => tc.id.startsWith('demo-'));
        expect(sampleItems.length).toBeGreaterThan(0);
      }
    } finally {
      // Re-create the test case for cleanup
      testCaseId = await createTestCase(TEST_CASE_NAME);
    }
  }, TEST_TIMEOUT);

  it('meta.sampleDataIncluded reflects actual inclusion state', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    // When includeSample=true, meta should say true
    const responseInclude = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=true`);
    const dataInclude = await responseInclude.json();
    expect(dataInclude.meta.sampleDataIncluded).toBe(true);

    // When includeSample=false, meta should say false
    const responseExclude = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=false`);
    const dataExclude = await responseExclude.json();
    expect(dataExclude.meta.sampleDataIncluded).toBe(false);

    // Default (with real data existing) should say false
    const responseDefault = await fetch(`${BASE_URL}/api/storage/test-cases`);
    const dataDefault = await responseDefault.json();
    expect(dataDefault.meta.sampleDataIncluded).toBe(false);
  }, TEST_TIMEOUT);
});
