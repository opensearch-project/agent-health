/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for Experiment Runner Service
 *
 * Tests:
 * 1. Background run execution and status monitoring
 * 2. Test case fetch performance within expected timeframes
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=benchmarkRunner
 */

const BASE_URL = 'http://localhost:4001';

// Performance thresholds (in milliseconds)
const PERFORMANCE_THRESHOLDS = {
  testCaseFetch: 2000,      // Single test case fetch should be < 2s
  testCaseListFetch: 5000,  // List all test cases should be < 5s
  runStatusCheck: 1000,     // Run status check should be < 1s
  experimentFetch: 2000,    // Experiment fetch should be < 2s
};

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    return response.ok;
  } catch {
    return false;
  }
};

// Helper to measure execution time
const measureTime = async <T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> => {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
};

// Parse SSE events from text
const parseSSEEvents = (text: string): any[] => {
  const events: any[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // Ignore parse errors
      }
    }
  }

  return events;
};

// Helper to create a test case
const createTestCase = async (name: string): Promise<any | null> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: `Test case for integration testing: ${name}`,
        labels: ['test', 'integration', 'performance'],
        initialPrompt: 'Test prompt for performance testing',
        context: [],
        expectedOutcomes: ['Test completes successfully'],
      }),
    });

    if (response.ok) {
      return response.json();
    }
    return null;
  } catch {
    return null;
  }
};

// Helper to create an experiment
const createExperiment = async (name: string, testCaseIds: string[]): Promise<any | null> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: `Experiment for integration testing: ${name}`,
        testCaseIds,
        runs: [],
      }),
    });

    if (response.ok) {
      return response.json();
    }
    return null;
  } catch {
    return null;
  }
};

// Helper to delete a test case
const deleteTestCase = async (id: string): Promise<void> => {
  try {
    await fetch(`${BASE_URL}/api/storage/test-cases/${id}`, { method: 'DELETE' });
  } catch {
    // Ignore cleanup errors
  }
};

// Helper to delete an experiment
const deleteExperiment = async (id: string): Promise<void> => {
  try {
    await fetch(`${BASE_URL}/api/storage/experiments/${id}`, { method: 'DELETE' });
  } catch {
    // Ignore cleanup errors
  }
};

describe('Experiment Runner Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
    }
  });

  describe('Test Case Fetch Performance', () => {
    let testCaseId: string | null = null;

    beforeAll(async () => {
      if (!backendAvailable) return;

      // Create a test case for performance testing
      const testCase = await createTestCase('Performance Test Case');
      testCaseId = testCase?.id || null;
    });

    afterAll(async () => {
      if (testCaseId) {
        await deleteTestCase(testCaseId);
      }
    });

    it('should fetch all test cases within expected time', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      const { result, durationMs } = await measureTime(async () => {
        const response = await fetch(`${BASE_URL}/api/storage/test-cases`);
        return response.json();
      });

      console.log(`[Performance] List test cases: ${durationMs.toFixed(2)}ms`);

      expect(result.testCases).toBeDefined();
      expect(Array.isArray(result.testCases)).toBe(true);
      expect(durationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.testCaseListFetch);
    });

    it('should fetch single test case within expected time', async () => {
      if (!backendAvailable || !testCaseId) {
        console.warn('Skipping: backend not available or no test case');
        return;
      }

      const { result, durationMs } = await measureTime(async () => {
        const response = await fetch(`${BASE_URL}/api/storage/test-cases/${testCaseId}`);
        return response.json();
      });

      console.log(`[Performance] Fetch single test case: ${durationMs.toFixed(2)}ms`);

      expect(result.id).toBe(testCaseId);
      expect(durationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.testCaseFetch);
    });

    it('should handle concurrent test case fetches efficiently', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      const concurrentRequests = 5;
      const { durationMs } = await measureTime(async () => {
        const promises = Array(concurrentRequests)
          .fill(null)
          .map(() => fetch(`${BASE_URL}/api/storage/test-cases`));
        await Promise.all(promises);
      });

      console.log(`[Performance] ${concurrentRequests} concurrent test case fetches: ${durationMs.toFixed(2)}ms`);

      // Concurrent requests should complete within reasonable time (not n * single request time)
      const maxExpectedTime = PERFORMANCE_THRESHOLDS.testCaseListFetch * 2;
      expect(durationMs).toBeLessThan(maxExpectedTime);
    });
  });

  describe('Background Run Execution and Monitoring', () => {
    let testCaseId: string | null = null;
    let experimentId: string | null = null;

    beforeAll(async () => {
      if (!backendAvailable) return;

      // Create test case and experiment
      const testCase = await createTestCase('Background Run Test Case');
      testCaseId = testCase?.id || null;

      if (testCaseId) {
        const experiment = await createExperiment('Background Run Test Benchmark', [testCaseId]);
        experimentId = experiment?.id || null;
      }
    });

    afterAll(async () => {
      if (experimentId) await deleteExperiment(experimentId);
      if (testCaseId) await deleteTestCase(testCaseId);
    });

    it('should start a run and receive SSE progress events', async () => {
      if (!backendAvailable || !experimentId) {
        console.warn('Skipping: backend not available or no experiment');
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      try {
        const response = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Background Test Run',
            description: 'Testing background execution',
            agentKey: 'mlcommons',
            modelId: 'claude-sonnet-4',
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        expect(response.ok).toBe(true);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const text = await response.text();
        const events = parseSSEEvents(text);

        console.log(`[Background Run] Received ${events.length} SSE events`);

        // Should have at least started event
        expect(events.length).toBeGreaterThan(0);

        const startedEvent = events.find(e => e.type === 'started');
        expect(startedEvent).toBeDefined();
        expect(startedEvent?.runId).toBeDefined();

        // Log event types for debugging
        const eventTypes = events.map(e => e.type);
        console.log(`[Background Run] Event types: ${eventTypes.join(', ')}`);

      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.warn('Run timed out - this may be expected if agent is slow');
        } else {
          throw error;
        }
      }
    }, 60000); // 1 minute timeout for this test

    it('should track run status during execution', async () => {
      if (!backendAvailable || !experimentId) {
        console.warn('Skipping: backend not available or no experiment');
        return;
      }

      // Start a run in the background (don't wait for completion)
      const executePromise = fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Status Tracking Test Run',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      // Give it a moment to start
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check experiment status while run is in progress
      const { result: experiment, durationMs } = await measureTime(async () => {
        const response = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}`);
        return response.json();
      });

      console.log(`[Performance] Experiment status check: ${durationMs.toFixed(2)}ms`);

      expect(experiment).toBeDefined();
      expect(experiment.id).toBe(experimentId);
      expect(durationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.experimentFetch);

      // Wait for execute to complete (or timeout)
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10000);
        await executePromise;
      } catch {
        // Ignore - we just want to make sure it doesn't hang
      }
    }, 30000);

    it('should cancel an active run', async () => {
      if (!backendAvailable || !experimentId) {
        console.warn('Skipping: backend not available or no experiment');
        return;
      }

      // Start a run
      const executeResponse = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cancellation Test Run',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      // Read until we get the started event with runId
      const reader = executeResponse.body?.getReader();
      let runId: string | null = null;

      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';

        // Read chunks until we find runId
        for (let i = 0; i < 10 && !runId; i++) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = parseSSEEvents(buffer);
          const startedEvent = events.find(e => e.type === 'started');
          if (startedEvent?.runId) {
            runId = startedEvent.runId;
          }
        }

        // Cancel the reader to stop receiving events
        reader.cancel();
      }

      if (!runId) {
        console.warn('Could not get runId - skipping cancel test');
        return;
      }

      console.log(`[Cancellation] Got runId: ${runId}`);

      // Try to cancel the run
      const cancelResponse = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });

      // Either 200 (cancelled) or 404 (already completed) is acceptable
      expect([200, 404]).toContain(cancelResponse.status);

      const cancelResult = await cancelResponse.json();
      console.log(`[Cancellation] Result: ${JSON.stringify(cancelResult)}`);
    }, 30000);
  });

  describe('Run Results Retrieval Performance', () => {
    it('should fetch runs by experiment within expected time', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      // Use a non-existent experiment ID - should return empty but still be fast
      const { result, durationMs } = await measureTime(async () => {
        const response = await fetch(`${BASE_URL}/api/storage/runs/by-experiment/test-experiment-id`);
        return response.json();
      });

      console.log(`[Performance] Fetch runs by experiment: ${durationMs.toFixed(2)}ms`);

      expect(result.runs).toBeDefined();
      expect(durationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.runStatusCheck);
    });

    it('should search runs with filters within expected time', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      const { result, durationMs } = await measureTime(async () => {
        const response = await fetch(`${BASE_URL}/api/storage/runs/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'completed',
            size: 10,
          }),
        });
        return response.json();
      });

      console.log(`[Performance] Search runs with filters: ${durationMs.toFixed(2)}ms`);

      expect(result.runs).toBeDefined();
      expect(durationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.runStatusCheck * 2);
    });

    it('should handle date range queries efficiently', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const { result, durationMs } = await measureTime(async () => {
        const response = await fetch(`${BASE_URL}/api/storage/runs/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRange: {
              start: oneWeekAgo.toISOString(),
              end: now.toISOString(),
            },
            size: 50,
          }),
        });
        return response.json();
      });

      console.log(`[Performance] Date range query: ${durationMs.toFixed(2)}ms, found ${result.total || 0} runs`);

      expect(result.runs).toBeDefined();
      expect(durationMs).toBeLessThan(PERFORMANCE_THRESHOLDS.runStatusCheck * 3);
    });
  });
});
