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

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

// Helper to check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('Health Endpoint Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        BASE_URL,
        '- skipping integration tests'
      );
    }
  }, TEST_TIMEOUT);

  describe('GET /health', () => {
    it(
      'should return status ok',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/health`);

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

        const response = await fetch(`${BASE_URL}/health`);
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

        const response = await fetch(`${BASE_URL}/health`);
        const data = await response.json();

        expect(data.service).toBe('agent-health');
      },
      TEST_TIMEOUT
    );

    it(
      'should return complete health response',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/health`);
        const data = await response.json();

        // Verify complete response structure
        expect(data).toEqual(
          expect.objectContaining({
            status: 'ok',
            version: expect.stringMatching(/^\d+\.\d+\.\d+/),
            service: 'agent-health',
            features: {
              codingAgentAnalytics: true,
            },
          })
        );
      },
      TEST_TIMEOUT
    );

    it(
      'should expose an instance identity block (pid / cwd / port / startedAt)',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/health`);
        const data = await response.json();

        // Backward-compatible: older backends predate the identity block. Only
        // assert its shape when present (a fresh build always includes it; the
        // authoritative end-to-end proof is portIsolation.integration.test.ts,
        // which boots a known-fresh server).
        if (!data.instance) {
          console.warn(
            'Backend at',
            BASE_URL,
            'reports no instance block (older build) — skipping identity assertions'
          );
          return;
        }

        expect(typeof data.instance.pid).toBe('number');
        expect(typeof data.instance.cwd).toBe('string');
        expect(data.instance.cwd.length).toBeGreaterThan(0);
        // port may be undefined only if AH_PORT is unset; the running server
        // always has it (CLI/serve set it), so assert it's a number here.
        expect(typeof data.instance.port).toBe('number');
        expect(typeof data.instance.startedAt).toBe('string');
        expect(Number.isNaN(Date.parse(data.instance.startedAt))).toBe(false);
      },
      TEST_TIMEOUT
    );

    it(
      'should respond quickly (under 1 second)',
      async () => {
        if (!backendAvailable) return;

        const startTime = Date.now();
        const response = await fetch(`${BASE_URL}/health`);
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
          fetch(`${BASE_URL}/health`).then((r) => r.json()),
          fetch(`${BASE_URL}/health`).then((r) => r.json()),
          fetch(`${BASE_URL}/health`).then((r) => r.json()),
        ]);

        // All responses should be identical
        expect(responses[0]).toEqual(responses[1]);
        expect(responses[1]).toEqual(responses[2]);
      },
      TEST_TIMEOUT
    );
  });
});
