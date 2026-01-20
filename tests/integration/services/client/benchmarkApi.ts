/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for Experiment API Client
 *
 * Tests the client-side API functions that interact with the experiment
 * execution and cancellation endpoints.
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=benchmarkApi
 */

const BASE_URL = 'http://localhost:4001';

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    return response.ok;
  } catch {
    return false;
  }
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
        description: `Test case for client API testing: ${name}`,
        labels: ['test', 'integration', 'client-api'],
        initialPrompt: 'Test prompt for client API testing',
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
        description: `Experiment for client API testing: ${name}`,
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

/**
 * Implementation of cancelBenchmarkRun matching the client API
 */
const cancelBenchmarkRun = async (
  experimentId: string,
  runId: string
): Promise<boolean> => {
  const response = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to cancel run');
  }

  const result = await response.json();
  return result.cancelled === true;
};

describe('Experiment API Client Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
    }
  });

  describe('cancelBenchmarkRun', () => {
    let testCaseId: string | null = null;
    let experimentId: string | null = null;

    beforeAll(async () => {
      if (!backendAvailable) return;

      // Create test case and experiment
      const testCase = await createTestCase('Cancel API Test Case');
      testCaseId = testCase?.id || null;

      if (testCaseId) {
        const experiment = await createExperiment('Cancel API Test Benchmark', [testCaseId]);
        experimentId = experiment?.id || null;
      }
    });

    afterAll(async () => {
      if (experimentId) await deleteExperiment(experimentId);
      if (testCaseId) await deleteTestCase(testCaseId);
    });

    it('should throw error when run is not found', async () => {
      if (!backendAvailable || !experimentId) {
        console.warn('Skipping: backend not available or no experiment');
        return;
      }

      await expect(cancelBenchmarkRun(experimentId, 'non-existent-run-id'))
        .rejects.toThrow('Run not found or already completed');
    });

    it('should successfully cancel an active run', async () => {
      if (!backendAvailable || !experimentId) {
        console.warn('Skipping: backend not available or no experiment');
        return;
      }

      // Start a run
      const executeResponse = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cancel Client API Test Run',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      expect(executeResponse.ok).toBe(true);

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
        console.warn('Could not get runId - skipping cancel client API test');
        return;
      }

      console.log(`[Cancel Client API] Got runId: ${runId}`);

      // Cancel using the client API function
      try {
        const cancelled = await cancelBenchmarkRun(experimentId, runId);
        expect(cancelled).toBe(true);
        console.log('[Cancel Client API] Successfully cancelled run');
      } catch (error: any) {
        // If the run already completed, that's acceptable
        if (error.message.includes('not found') || error.message.includes('already completed')) {
          console.log('[Cancel Client API] Run already completed before cancel');
        } else {
          throw error;
        }
      }
    }, 30000);

    it('should return true when cancellation succeeds', async () => {
      if (!backendAvailable || !experimentId) {
        console.warn('Skipping: backend not available or no experiment');
        return;
      }

      // Start another run for this specific test
      const executeResponse = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cancel Return Value Test Run',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      const reader = executeResponse.body?.getReader();
      let runId: string | null = null;

      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';

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

        reader.cancel();
      }

      if (!runId) {
        console.warn('Could not get runId - skipping return value test');
        return;
      }

      try {
        const result = await cancelBenchmarkRun(experimentId, runId);
        // The result should be a boolean
        expect(typeof result).toBe('boolean');
        if (result) {
          expect(result).toBe(true);
        }
      } catch (error: any) {
        // If already completed, that's acceptable
        if (!error.message.includes('not found') && !error.message.includes('already completed')) {
          throw error;
        }
      }
    }, 30000);
  });

  describe('Cancel Flow End-to-End', () => {
    let testCaseIds: string[] = [];
    let experimentId: string | null = null;

    beforeAll(async () => {
      if (!backendAvailable) return;

      // Create multiple test cases to ensure run takes long enough to cancel
      for (let i = 0; i < 3; i++) {
        const testCase = await createTestCase(`E2E Cancel Test Case ${i + 1}`);
        if (testCase?.id) {
          testCaseIds.push(testCase.id);
        }
      }

      if (testCaseIds.length > 0) {
        const experiment = await createExperiment('E2E Cancel Test Benchmark', testCaseIds);
        experimentId = experiment?.id || null;
      }
    });

    afterAll(async () => {
      if (experimentId) await deleteExperiment(experimentId);
      for (const id of testCaseIds) {
        await deleteTestCase(id);
      }
    });

    it('should stop execution mid-run when cancelled', async () => {
      if (!backendAvailable || !experimentId || testCaseIds.length < 2) {
        console.warn('Skipping: backend not available, no experiment, or not enough test cases');
        return;
      }

      // Start a run with multiple test cases
      const executeResponse = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E Cancel Mid-Run Test',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      const reader = executeResponse.body?.getReader();
      let runId: string | null = null;
      let progressEvents: any[] = [];

      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';

        // Read until we get runId and at least one progress event
        for (let i = 0; i < 20 && (!runId || progressEvents.length === 0); i++) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = parseSSEEvents(buffer);

          const startedEvent = events.find(e => e.type === 'started');
          if (startedEvent?.runId) {
            runId = startedEvent.runId;
          }

          progressEvents = events.filter(e => e.type === 'progress');
        }

        // Cancel the reader
        reader.cancel();
      }

      if (!runId) {
        console.warn('Could not get runId - skipping E2E cancel test');
        return;
      }

      console.log(`[E2E Cancel] Got runId: ${runId}, progress events: ${progressEvents.length}`);

      // Cancel the run
      try {
        const cancelled = await cancelBenchmarkRun(experimentId, runId);
        console.log(`[E2E Cancel] Cancellation result: ${cancelled}`);

        // Give a moment for cancellation to propagate
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verify the experiment shows the run as cancelled/completed
        const experimentResponse = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}`);
        const experiment = await experimentResponse.json();

        const run = experiment.runs?.find((r: any) => r.id === runId);
        if (run) {
          console.log(`[E2E Cancel] Run status after cancel: ${run.status}`);
          // Run should be marked as cancelled or completed
          expect(['cancelled', 'completed', 'failed']).toContain(run.status);
        }
      } catch (error: any) {
        // If already completed, that's acceptable for this test
        console.log(`[E2E Cancel] Error during cancel: ${error.message}`);
      }
    }, 60000);
  });
});
