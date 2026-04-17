/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for benchmark cancel functionality
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm run test:integration -- --testPathPattern=benchmarks.integration
 *
 * These tests verify that cancelling a benchmark run immediately updates
 * the DB status, fixing the race condition where the UI would show 'running'
 * after cancel because the execute loop hadn't yet updated the DB.
 */

const BASE_URL = 'http://localhost:4001';

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'connected';
  } catch {
    return false;
  }
};

// Create a test case for the benchmark
const createTestCase = async (): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cancel Test Case',
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: 'Test prompt for cancel integration test',
      context: [],
      expectedTrajectory: [],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test case: ${response.statusText}`);
  }

  const testCase = await response.json();
  return testCase.id;
};

// Create a benchmark with the test case
const createBenchmark = async (testCaseId: string): Promise<string> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cancel Integration Test Benchmark',
      description: 'Benchmark for testing cancel race condition',
      testCaseIds: [testCaseId],
      runs: [],
      currentVersion: 1,
      versions: [{
        version: 1,
        createdAt: new Date().toISOString(),
        testCaseIds: [testCaseId],
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create benchmark: ${response.statusText}`);
  }

  const benchmark = await response.json();
  return benchmark.id;
};

// Get benchmark by ID
const getBenchmark = async (benchmarkId: string): Promise<any> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
  if (!response.ok) {
    throw new Error(`Failed to get benchmark: ${response.statusText}`);
  }
  return response.json();
};

// Delete benchmark
const deleteBenchmark = async (benchmarkId: string): Promise<void> => {
  await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`, {
    method: 'DELETE',
  });
};

// Delete test case
const deleteTestCase = async (testCaseId: string): Promise<void> => {
  await fetch(`${BASE_URL}/api/storage/test-cases/${testCaseId}`, {
    method: 'DELETE',
  });
};

// Cancel a benchmark run
const cancelRun = async (benchmarkId: string, runId: string): Promise<boolean> => {
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });

  if (!response.ok) {
    return false;
  }

  const result = await response.json();
  return result.cancelled === true;
};

/**
 * Start a benchmark execution and return the run ID from the 'started' event.
 * Uses the demo agent for simulated responses to avoid external dependencies.
 */
const startExecutionAndGetRunId = async (benchmarkId: string): Promise<string> => {
  const controller = new AbortController();

  const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cancel Test Run',
      agentKey: 'demo',  // Use demo agent for simulated responses
      modelId: 'demo-model',
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to start execution: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let runId: string | null = null;

  // Read SSE stream until we get the 'started' event with runId
  while (!runId) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const lines = event.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'started' && data.runId) {
              runId = data.runId;
              // Don't abort yet - we need the run to be in activeRuns map
              break;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
      if (runId) break;
    }
  }

  // Abort the SSE connection (simulating client disconnect)
  // The server will continue executing in the background
  controller.abort();

  if (!runId) {
    throw new Error('Did not receive runId from started event');
  }

  return runId;
};

describe('Benchmark Cancel Integration Tests', () => {
  let backendAvailable = false;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
      return;
    }

    // Create test fixtures
    testCaseId = await createTestCase();
    benchmarkId = await createBenchmark(testCaseId);
  }, 30000);

  afterAll(async () => {
    if (!backendAvailable) return;

    // Cleanup by tracked ID
    if (benchmarkId) {
      await deleteBenchmark(benchmarkId);
    }
    if (testCaseId) {
      await deleteTestCase(testCaseId);
    }
    // Fallback: clean up leftovers from previous failed runs by name
    try {
      const tcResp = await fetch(`${BASE_URL}/api/storage/test-cases`);
      if (tcResp.ok) {
        const data = await tcResp.json();
        for (const tc of (data.testCases ?? [])) {
          if (tc.name === 'Cancel Test Case') {
            await deleteTestCase(tc.id).catch(() => {});
          }
        }
      }
      const benchResp = await fetch(`${BASE_URL}/api/storage/benchmarks`);
      if (benchResp.ok) {
        const benchData = await benchResp.json();
        for (const b of (benchData.benchmarks ?? benchData ?? [])) {
          if (b.name === 'Cancel Integration Test Benchmark') {
            await deleteBenchmark(b.id).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);

  it('should immediately update DB status to cancelled when cancel is called', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    // Step 1: Start the benchmark execution
    const runId = await startExecutionAndGetRunId(benchmarkId);
    expect(runId).toBeDefined();

    // Small delay to ensure run is registered in activeRuns
    await new Promise(resolve => setTimeout(resolve, 100));

    // Step 2: Cancel the run
    const cancelled = await cancelRun(benchmarkId, runId);
    expect(cancelled).toBe(true);

    // Step 3: IMMEDIATELY fetch the benchmark from DB
    // This is the key assertion - the DB should already have 'cancelled' status
    // even though the execute loop may still be processing
    const benchmark = await getBenchmark(benchmarkId);
    const run = benchmark.runs?.find((r: any) => r.id === runId);

    expect(run).toBeDefined();
    expect(run.status).toBe('cancelled');
  }, 30000);

  it('should return 404 when trying to cancel a non-existent run', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'non-existent-run-id' }),
    });

    expect(response.status).toBe(404);
    const error = await response.json();
    expect(error.error).toBe('Run not found or already completed');
  });
});

describe('Benchmark Export Integration Tests', () => {
  let backendAvailable = false;
  let exportTestCaseId: string | null = null;
  let exportBenchmarkId: string | null = null;

  // Known values we create and then assert on export
  const EXPORT_TEST_CASE_INPUT = {
    name: 'Export Integration Test Case',
    category: 'RCA',
    difficulty: 'Medium',
    initialPrompt: 'Investigate why the service is returning 500 errors',
    context: [{ description: 'Service info', value: 'The order-service runs on port 8080' }],
    expectedOutcomes: ['Query error logs', 'Identify root cause'],
  };

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping export integration tests');
      return;
    }

    // Create a test case with known content
    const tcResponse = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EXPORT_TEST_CASE_INPUT),
    });
    if (!tcResponse.ok) throw new Error(`Failed to create test case: ${tcResponse.statusText}`);
    const tc = await tcResponse.json();
    exportTestCaseId = tc.id;

    // Create a benchmark referencing that test case
    const benchResponse = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Export Integration Benchmark',
        description: 'Benchmark for testing export round-trip',
        testCaseIds: [exportTestCaseId],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: [exportTestCaseId],
        }],
      }),
    });
    if (!benchResponse.ok) throw new Error(`Failed to create benchmark: ${benchResponse.statusText}`);
    const bench = await benchResponse.json();
    exportBenchmarkId = bench.id;
  }, 30000);

  afterAll(async () => {
    if (!backendAvailable) return;
    if (exportBenchmarkId) await deleteBenchmark(exportBenchmarkId);
    if (exportTestCaseId) await deleteTestCase(exportTestCaseId);
    // Fallback: clean up leftovers from previous failed runs by name
    try {
      const tcResp = await fetch(`${BASE_URL}/api/storage/test-cases`);
      if (tcResp.ok) {
        const data = await tcResp.json();
        for (const tc of (data.testCases ?? [])) {
          if (tc.name === 'Export Integration Test Case') {
            await deleteTestCase(tc.id).catch(() => {});
          }
        }
      }
      const benchResp = await fetch(`${BASE_URL}/api/storage/benchmarks`);
      if (benchResp.ok) {
        const benchData = await benchResp.json();
        for (const b of (benchData.benchmarks ?? benchData ?? [])) {
          if (b.name === 'Export Integration Benchmark') {
            await deleteBenchmark(b.id).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);

  it('should export the actual test case content created via OpenSearch', async () => {
    if (!backendAvailable || !exportBenchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/benchmarks/${exportBenchmarkId}/export`);
    expect(response.ok).toBe(true);

    // Verify headers
    const contentDisposition = response.headers.get('content-disposition');
    expect(contentDisposition).toContain('attachment');
    expect(contentDisposition).toContain('.json');
    expect(response.headers.get('content-type')).toContain('application/json');

    // Verify body is a non-empty JSON array
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);

    // Verify the exported content matches what we created
    const exported = data[0];
    expect(exported.name).toBe(EXPORT_TEST_CASE_INPUT.name);
    expect(exported.category).toBe(EXPORT_TEST_CASE_INPUT.category);
    expect(exported.difficulty).toBe(EXPORT_TEST_CASE_INPUT.difficulty);
    expect(exported.initialPrompt).toBe(EXPORT_TEST_CASE_INPUT.initialPrompt);
    expect(exported.expectedOutcomes).toEqual(EXPORT_TEST_CASE_INPUT.expectedOutcomes);
    expect(exported.context).toEqual(EXPORT_TEST_CASE_INPUT.context);

    // Must NOT contain system fields
    expect(exported.id).toBeUndefined();
    expect(exported.labels).toBeUndefined();
    expect(exported.createdAt).toBeUndefined();
    expect(exported.versions).toBeUndefined();
    expect(exported.currentVersion).toBeUndefined();
  }, 30000);

  it('should return 404 for non-existent benchmark', async () => {
    if (!backendAvailable) {
      console.warn('Skipping test - backend not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/storage/benchmarks/nonexistent-id/export`);
    expect(response.status).toBe(404);
  });
});
