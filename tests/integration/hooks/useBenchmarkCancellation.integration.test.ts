/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for useBenchmarkCancellation hook
 *
 * These tests verify the hook's behavior with actual fetch calls (mocked at fetch level)
 * rather than mocking the cancelBenchmarkRun function itself.
 *
 * To run with real backend:
 *   npm run dev:server
 *   npm run test:integration -- --testPathPattern=useBenchmarkCancellation
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';

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
      name: `Hook Cancel Test Case ${Date.now()}`,
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: 'Test prompt for hook cancel integration test',
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
      name: `Hook Cancel Integration Test Benchmark ${Date.now()}`,
      description: 'Benchmark for testing hook cancel integration',
      testCaseIds: [testCaseId],
      runs: [],
      currentVersion: 1,
      versions: [
        {
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: [testCaseId],
        },
      ],
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
      name: `Hook Cancel Test Run ${Date.now()}`,
      agentKey: 'demo',
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

  // Abort the SSE connection
  controller.abort();

  if (!runId) {
    throw new Error('Did not receive runId from started event');
  }

  return runId;
};

describe('useBenchmarkCancellation Integration Tests', () => {
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

    // Cleanup
    if (benchmarkId) {
      await deleteBenchmark(benchmarkId);
    }
    if (testCaseId) {
      await deleteTestCase(testCaseId);
    }
  }, 30000);

  it('should cancel a running benchmark run using the hook', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    // Step 1: Start the benchmark execution
    const runId = await startExecutionAndGetRunId(benchmarkId);
    expect(runId).toBeDefined();

    // Small delay to ensure run is registered in activeRuns
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Step 2: Use the hook to cancel
    const { result } = renderHook(() => useBenchmarkCancellation());

    // Verify initial state
    expect(result.current.cancellingRunId).toBeNull();
    expect(result.current.isCancelling(runId)).toBe(false);

    // Track callback execution
    let callbackCalled = false;
    const onSuccess = () => {
      callbackCalled = true;
    };

    // Start cancellation
    await act(async () => {
      await result.current.handleCancelRun(benchmarkId!, runId, onSuccess);
    });

    // Verify callback was called
    expect(callbackCalled).toBe(true);

    // Verify state is cleared after cancellation
    expect(result.current.cancellingRunId).toBeNull();

    // Step 3: Verify the run is cancelled in the database
    const benchmark = await getBenchmark(benchmarkId);
    const run = benchmark.runs?.find((r: any) => r.id === runId);

    expect(run).toBeDefined();
    expect(run.status).toBe('cancelled');
  }, 30000);

  it('should track cancelling state during the API call', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    // Step 1: Start the benchmark execution
    const runId = await startExecutionAndGetRunId(benchmarkId);
    expect(runId).toBeDefined();

    // Small delay to ensure run is registered
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Step 2: Use the hook
    const { result } = renderHook(() => useBenchmarkCancellation());

    // Track state during cancellation
    const statesDuringCancel: boolean[] = [];

    // Start cancellation without awaiting first
    let cancelPromise: Promise<void>;
    act(() => {
      cancelPromise = result.current.handleCancelRun(benchmarkId!, runId);
    });

    // Check that isCancelling returns true during the call
    statesDuringCancel.push(result.current.isCancelling(runId));
    expect(result.current.cancellingRunId).toBe(runId);

    // Wait for completion
    await act(async () => {
      await cancelPromise;
    });

    // State should be cleared
    expect(result.current.cancellingRunId).toBeNull();
    expect(result.current.isCancelling(runId)).toBe(false);

    // At least one state check should have shown cancelling in progress
    expect(statesDuringCancel).toContain(true);
  }, 30000);

  it('should handle cancellation errors gracefully', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useBenchmarkCancellation());

    // Try to cancel a non-existent run
    await act(async () => {
      await result.current.handleCancelRun(benchmarkId!, 'non-existent-run-id');
    });

    // Should have logged an error
    expect(consoleError).toHaveBeenCalled();

    // State should still be cleared
    expect(result.current.cancellingRunId).toBeNull();

    consoleError.mockRestore();
  }, 30000);

  it('should not call onSuccess when cancellation fails', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    jest.spyOn(console, 'error').mockImplementation();

    const { result } = renderHook(() => useBenchmarkCancellation());

    let callbackCalled = false;
    const onSuccess = () => {
      callbackCalled = true;
    };

    // Try to cancel a non-existent run
    await act(async () => {
      await result.current.handleCancelRun(benchmarkId!, 'non-existent-run-id', onSuccess);
    });

    // Callback should NOT have been called
    expect(callbackCalled).toBe(false);
  }, 30000);

  it('should handle async onSuccess callback', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    // Step 1: Start the benchmark execution
    const runId = await startExecutionAndGetRunId(benchmarkId);
    expect(runId).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 100));

    const { result } = renderHook(() => useBenchmarkCancellation());

    // Track async callback execution
    let asyncCallbackResolved = false;
    const asyncOnSuccess = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      asyncCallbackResolved = true;
    };

    await act(async () => {
      await result.current.handleCancelRun(benchmarkId!, runId, asyncOnSuccess);
    });

    // Async callback should have completed
    expect(asyncCallbackResolved).toBe(true);

    // State should be cleared only after callback completes
    expect(result.current.cancellingRunId).toBeNull();
  }, 30000);
});
