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
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { uniqueTestName } from '../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();

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
      name: uniqueTestName('hook-cancel-tc'),
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
      name: uniqueTestName('hook-cancel-benchmark'),
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
 * Every per-test-case report a benchmark run creates is stamped with
 * `experimentRunId` = the run's own id at creation time
 * (services/evaluationRunner.ts). `POST
 * .../cancel` only flips the run's top-level `status` immediately —
 * cancellation is cooperative, not a hard abort, so whichever test case was
 * already executing keeps running in the background and only produces its
 * report a few seconds later (the demo connector sleeps through a
 * synthetic trajectory). Reading `benchmark.runs[].results` right after
 * cancel can miss it entirely. Polling `POST /api/storage/runs/search`
 * (filtered by `experimentRunId`) until the result set stops changing is a
 * reliable, timing-agnostic "background work is done" signal; every id it
 * returns is a report this test created that `DELETE .../benchmarks/:id`
 * will NOT cascade-delete.
 */
const harvestReportIdsForRun = async (
  runId: string,
  { timeoutMs = 20000, pollMs = 500, quietMs = 1500 }: { timeoutMs?: number; pollMs?: number; quietMs?: number } = {}
): Promise<string[]> => {
  const fetchIds = async (): Promise<string[]> => {
    try {
      const res = await fetch(`${BASE_URL}/api/storage/runs/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experimentRunId: runId, size: 500 }),
      });
      if (!res.ok) return [];
      const body = await res.json();
      return (body.runs ?? []).map((r: any) => r.id).filter(Boolean);
    } catch {
      return [];
    }
  };

  const deadline = Date.now() + timeoutMs;
  let lastKey: string | null = null;
  let stableSince: number | null = null;
  let ids: string[] = [];

  while (Date.now() < deadline) {
    ids = await fetchIds();
    const key = [...ids].sort().join(',');
    if (key === lastKey) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= quietMs) return ids;
    } else {
      lastKey = key;
      stableSince = null;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return ids;
};

/**
 * Start a benchmark run through the evaluation-runs API (the only benchmark
 * execution path — the legacy `/execute` runner was removed) and return the
 * run ID from the 'started' event. Uses the demo agent for simulated
 * responses to avoid external dependencies.
 */
const startExecutionAndGetRunId = async (benchmarkId: string): Promise<string> => {
  const controller = new AbortController();

  const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uniqueTestName('hook-cancel-run'),
      sources: [{ type: 'benchmark', benchmarkId }],
      benchmarkId,
      agentKey: 'demo',
      modelId: 'demo-model',
      trigger: 'manual',
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
      let eventType = '';
      let eventData = '';
      for (const line of event.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        else if (line.startsWith('data: ')) eventData = line.slice(6);
      }
      if (eventType === 'started' && eventData) {
        try {
          const data = JSON.parse(eventData);
          if (data.runId) runId = data.runId;
        } catch {
          // Ignore parse errors
        }
      }
      if (runId) break;
    }
  }

  // Abort the SSE connection — the server keeps executing in the background.
  controller.abort();

  if (!runId) {
    throw new Error('Did not receive runId from started event');
  }

  return runId;
};

/**
 * Cancellation is cooperative: `POST .../cancel` stamps `cancelRequestedAt`
 * and the executor writes the terminal `cancelled` status once it drains.
 * Poll the evaluation-run document until it is terminal.
 */
const waitForTerminalRun = async (runId: string, timeoutMs = 30000): Promise<any> => {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
    if (res.ok) {
      const body = await res.json();
      last = body.evaluationRun ?? body;
      if (last && last.status !== 'running' && last.status !== 'pending') return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
};

describe('useBenchmarkCancellation Integration Tests', () => {
  let backendAvailable = false;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  // Per-test-case report doc(s) the executed-then-cancelled runs created,
  // harvested inside each test (see harvestReportIdsForRun) and deleted
  // here in afterAll — DELETE .../benchmarks/:id does not cascade to them.
  let leakedReportIds: string[] = [];
  // Evaluation-run documents started by the tests (the benchmark delete does
  // not cascade to them either).
  const startedRunIds: string[] = [];

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

    // Delete the per-test-case report doc(s) harvested by the tests above
    // BEFORE deleting the benchmark/test case — DELETE .../benchmarks/:id
    // does not cascade to them.
    for (const id of startedRunIds) {
      await waitForTerminalRun(id, 15000).catch(() => null);
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of leakedReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }

    // Cleanup by tracked ID only — never sweep shared storage by name:
    // "name looks test-ish" is not proof of ownership, and a name/prefix
    // getAll+delete here deletes OTHER runs'/users' data on the shared
    // cluster. uniqueTestName fixtures make cross-run collisions impossible.
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
    startedRunIds.push(runId);
    expect(runId).toBeDefined();

    // Small delay to ensure the run is registered with its executor
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

    // Step 3: Verify the run reaches `cancelled` once the executor drains,
    // and that the terminal run is linked into the benchmark's runs.
    const terminalRun = await waitForTerminalRun(runId);
    expect(terminalRun).toBeDefined();
    expect(terminalRun.status).toBe('cancelled');
    // The projection is linked into the benchmark right AFTER the terminal
    // doc write — poll for it instead of a single GET.
    let run: any;
    for (let i = 0; i < 40 && !run; i++) {
      const benchmark = await getBenchmark(benchmarkId);
      run = benchmark.runs?.find((r: any) => r.id === runId);
      if (!run) await new Promise((r) => setTimeout(r, 500));
    }
    expect(run).toBeDefined();
    expect(run.status).toBe('cancelled');

    // Harvest any per-test-case report the (possibly still in-flight)
    // background execution created for this run — DELETE .../benchmarks/:id
    // in afterAll will NOT cascade to it (see harvestReportIdsForRun above).
    leakedReportIds.push(...(await harvestReportIdsForRun(runId)));
  }, 45000);

  it('should track cancelling state during the API call', async () => {
    if (!backendAvailable || !benchmarkId) {
      console.warn('Skipping test - backend not available or benchmark not created');
      return;
    }

    // Step 1: Start the benchmark execution
    const runId = await startExecutionAndGetRunId(benchmarkId);
    startedRunIds.push(runId);
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

    // Harvest any per-test-case report the (possibly still in-flight)
    // background execution created for this run — see harvestReportIdsForRun
    // above for why this can't just be read off `benchmark.runs[].results`.
    leakedReportIds.push(...(await harvestReportIdsForRun(runId)));
  }, 45000);

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
    startedRunIds.push(runId);
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

    // Harvest any per-test-case report the (possibly still in-flight)
    // background execution created for this run — see harvestReportIdsForRun
    // above for why this can't just be read off `benchmark.runs[].results`.
    leakedReportIds.push(...(await harvestReportIdsForRun(runId)));
  }, 45000);
});
