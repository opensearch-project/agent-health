/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for experiment execution API
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=experiments
 */

const BASE_URL = 'http://localhost:4001';

// Check if backend is available and has execute endpoint
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    return response.ok;
  } catch {
    return false;
  }
};

// Check if the execute endpoint exists (new routes are deployed)
const checkExecuteEndpoint = async (): Promise<boolean> => {
  try {
    // Try to cancel a non-existent run - if route exists, we get JSON response
    const response = await fetch(`${BASE_URL}/api/storage/experiments/test/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'test' }),
    });
    // If route exists, we get JSON (either 400 or 404)
    const text = await response.text();
    return !text.includes('<!DOCTYPE');
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

describe('Experiment Execution API Integration Tests', () => {
  let backendAvailable = false;
  let executeEndpointExists = false;
  let testExperimentId: string | null = null;
  let testCaseId: string | null = null;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
      return;
    }

    executeEndpointExists = await checkExecuteEndpoint();
    if (!executeEndpointExists) {
      console.warn('Execute endpoint not available - server may need restart with new code');
      console.warn('Restart the backend with: npm run dev:server');
    }

    // Create a test case for the experiment
    const testCaseResponse = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Execute API Test Case',
        description: 'Test case for execute API integration tests',
        category: 'Test',
        difficulty: 'Easy',
        labels: ['test', 'integration'],
        initialPrompt: 'Test prompt for integration testing',
        context: [],
        expectedOutcomes: ['Test completes successfully'],
      }),
    });

    if (testCaseResponse.ok) {
      const testCase = await testCaseResponse.json();
      testCaseId = testCase.id;
    }

    // Create a test experiment
    const experimentResponse = await fetch(`${BASE_URL}/api/storage/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Execute API Test Benchmark',
        description: 'Experiment for testing execute API',
        testCaseIds: testCaseId ? [testCaseId] : [],
        runs: [],
      }),
    });

    if (experimentResponse.ok) {
      const experiment = await experimentResponse.json();
      testExperimentId = experiment.id;
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;

    // Cleanup: delete test experiment
    if (testExperimentId) {
      try {
        await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Cleanup: delete test case
    if (testCaseId) {
      try {
        await fetch(`${BASE_URL}/api/storage/test-cases/${testCaseId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('POST /api/storage/experiments/:id/execute', () => {
    it('should return 404 for non-existent experiment', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/experiments/non-existent-id/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Run',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid run configuration', async () => {
      if (!backendAvailable || !executeEndpointExists || !testExperimentId) {
        console.warn('Skipping: backend not available or no test experiment');
        return;
      }

      // Missing required fields
      const response = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Missing name, agentKey, and modelId',
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('should start execution and stream SSE events', async () => {
      if (!backendAvailable || !executeEndpointExists || !testExperimentId) {
        console.warn('Skipping: backend not available, execute endpoint missing, or no test experiment');
        return;
      }

      const response = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Integration Test Run',
          description: 'Testing execute API',
          agentKey: 'mlcommons',
          modelId: 'claude-sonnet-4',
        }),
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // Read the response body
      const text = await response.text();
      const events = parseSSEEvents(text);

      // Should have at least a 'started' event
      expect(events.length).toBeGreaterThan(0);

      const startedEvent = events.find(e => e.type === 'started');
      expect(startedEvent).toBeDefined();
      expect(startedEvent.runId).toBeDefined();

      // Should end with either 'completed' or 'error'
      const finalEvent = events[events.length - 1];
      expect(['completed', 'error']).toContain(finalEvent.type);
    }, 120000); // 2 minute timeout for full execution
  });

  describe('POST /api/storage/experiments/:id/cancel', () => {
    it('should return 400 when runId is not provided', async () => {
      if (!backendAvailable || !executeEndpointExists) {
        console.warn('Skipping: backend not available or execute endpoint missing');
        return;
      }

      // Use an existing experiment ID or create one for this test
      const experimentId = testExperimentId || 'test-exp';

      const response = await fetch(`${BASE_URL}/api/storage/experiments/${experimentId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should return 400 (bad request) because runId is missing
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it('should return 404 when run is not active', async () => {
      if (!backendAvailable || !executeEndpointExists) {
        console.warn('Skipping: backend not available or execute endpoint missing');
        return;
      }

      // Use any experiment ID - the cancel endpoint doesn't check experiment existence
      const response = await fetch(`${BASE_URL}/api/storage/experiments/any-experiment/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'non-existent-run-id' }),
      });

      // Should return 404 because the run is not in activeRuns map
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('Experiment CRUD operations', () => {
    it('should get experiment by ID', async () => {
      if (!backendAvailable || !testExperimentId) return;

      const response = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      expect(response.ok).toBe(true);

      const experiment = await response.json();
      expect(experiment.id).toBe(testExperimentId);
      expect(experiment.name).toBe('Execute API Test Benchmark');
    });

    it('should list all experiments', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/experiments`);
      expect(response.ok).toBe(true);

      const body = await response.json();
      expect(body.experiments).toBeDefined();
      expect(Array.isArray(body.experiments)).toBe(true);
    });
  });
});
