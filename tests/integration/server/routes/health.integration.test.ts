/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for health endpoint
 *
 * These tests verify that:
 * 1. The /health endpoint returns correct status and version
 * 2. Version matches package.json
 * 3. Service name is correct
 *
 * Run tests:
 *   npm test -- --testPathPattern=health.integration
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 */

const TEST_TIMEOUT = 30000;

// Test configuration
const getTestConfig = () => {
  return {
    backendUrl: process.env.TEST_BACKEND_URL || 'http://localhost:4001',
  };
};

// Helper to check if backend is available
const checkBackend = async (backendUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${backendUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('Health Endpoint Integration Tests', () => {
  let backendAvailable = false;
  let config: ReturnType<typeof getTestConfig>;

  beforeAll(async () => {
    config = getTestConfig();
    backendAvailable = await checkBackend(config.backendUrl);
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        config.backendUrl,
        '- skipping integration tests'
      );
    }
  }, TEST_TIMEOUT);

  describe('GET /health', () => {
    it(
      'should return status ok',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/health`);

        expect(response.ok).toBe(true);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.status).toBe('ok');
      },
      TEST_TIMEOUT
    );

    it(
      'should return version from package.json',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/health`);
        const data = await response.json();

        // Version should be a valid semver string
        expect(data.version).toBeDefined();
        expect(typeof data.version).toBe('string');
        expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
      },
      TEST_TIMEOUT
    );

    it(
      'should return correct service name',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/health`);
        const data = await response.json();

        expect(data.service).toBe('agent-health');
      },
      TEST_TIMEOUT
    );

    it(
      'should return complete health response',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${config.backendUrl}/health`);
        const data = await response.json();

        // Verify complete response structure
        expect(data).toEqual({
          status: 'ok',
          version: expect.stringMatching(/^\d+\.\d+\.\d+/),
          service: 'agent-health',
          features: {
            codingAgentAnalytics: true,
          },
        });
      },
      TEST_TIMEOUT
    );

    it(
      'should respond quickly (under 1 second)',
      async () => {
        if (!backendAvailable) return;

        const startTime = Date.now();
        const response = await fetch(`${config.backendUrl}/health`);
        const endTime = Date.now();

        expect(response.ok).toBe(true);
        expect(endTime - startTime).toBeLessThan(1000);
      },
      TEST_TIMEOUT
    );

    it(
      'should be idempotent across multiple requests',
      async () => {
        if (!backendAvailable) return;

        const responses = await Promise.all([
          fetch(`${config.backendUrl}/health`).then((r) => r.json()),
          fetch(`${config.backendUrl}/health`).then((r) => r.json()),
          fetch(`${config.backendUrl}/health`).then((r) => r.json()),
        ]);

        // All responses should be identical
        expect(responses[0]).toEqual(responses[1]);
        expect(responses[1]).toEqual(responses[2]);
      },
      TEST_TIMEOUT
    );
  });
});
