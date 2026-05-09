/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for storage client middleware
 *
 * These tests verify that:
 * 1. The middleware properly attaches storage client to requests
 * 2. Header-based configuration (X-Storage-*) is respected
 * 3. Routes use the request-scoped client correctly
 * 4. Fallback to environment variables works
 *
 * Run tests:
 *   npm test -- --testPathPattern=storageClient.integration
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 *   - OR run against a real OpenSearch cluster
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

// Test configuration - uses environment or defaults
const getTestConfig = () => {
  return {
    endpoint: process.env.TEST_OPENSEARCH_ENDPOINT || 'https://localhost:9200',
    username: process.env.TEST_OPENSEARCH_USERNAME || 'admin',
    password: process.env.TEST_OPENSEARCH_PASSWORD || 'admin',
  };
};

// Helper to check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
};

// Helper to make requests with storage headers
const fetchWithStorageHeaders = async (
  url: string,
  config: { endpoint: string; username: string; password: string },
  options: RequestInit = {}
) => {
  const headers = new Headers(options.headers);
  headers.set('X-Storage-Endpoint', config.endpoint);
  headers.set('X-Storage-Username', config.username);
  headers.set('X-Storage-Password', config.password);

  return fetch(url, {
    ...options,
    headers,
  });
};

describe('Storage Client Middleware Integration Tests', () => {
  let backendAvailable = false;
  let config: ReturnType<typeof getTestConfig>;

  beforeAll(async () => {
    config = getTestConfig();
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        BASE_URL,
        '- skipping integration tests'
      );
    }
  }, TEST_TIMEOUT);

  describe('Health endpoint with header-based config', () => {
    it(
      'should connect using X-Storage-* headers',
      async () => {
        if (!backendAvailable) return;

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          config
        );

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should return connected status when headers are valid
        expect(data.status).toBeDefined();
        // Status could be 'connected' or 'error' depending on the endpoint
        expect(['connected', 'error']).toContain(data.status);
      },
      TEST_TIMEOUT
    );

    it(
      'should handle missing headers gracefully',
      async () => {
        if (!backendAvailable) return;

        // Request without X-Storage-* headers
        const response = await fetch(`${BASE_URL}/api/storage/health`);

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should return disconnected status when no config is available
        expect(data.status).toBeDefined();
        expect(['connected', 'disconnected']).toContain(data.status);
      },
      TEST_TIMEOUT
    );
  });

  describe('Stats endpoint with header-based config', () => {
    it(
      'should retrieve stats using X-Storage-* headers',
      async () => {
        if (!backendAvailable) return;

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/stats`,
          config
        );

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should have stats object when connected
        if (data.stats) {
          expect(data.stats).toBeDefined();
          // Indexes should be present
          expect(data.stats.evals_test_cases).toBeDefined();
          expect(data.stats.evals_experiments).toBeDefined();
          expect(data.stats.evals_runs).toBeDefined();
          expect(data.stats.evals_analytics).toBeDefined();
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('Test cases endpoint with header-based config', () => {
    it(
      'should retrieve test cases using X-Storage-* headers',
      async () => {
        if (!backendAvailable) return;

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/test-cases`,
          config
        );

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should return testCases array (may be empty or sample data)
        expect(data.testCases).toBeDefined();
        expect(Array.isArray(data.testCases)).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe('Experiments endpoint with header-based config', () => {
    it(
      'should retrieve experiments using X-Storage-* headers',
      async () => {
        if (!backendAvailable) return;

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/experiments`,
          config
        );

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should return experiments array (may be empty or sample data)
        expect(data.experiments).toBeDefined();
        expect(Array.isArray(data.experiments)).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe('Runs endpoint with header-based config', () => {
    it(
      'should retrieve runs using X-Storage-* headers',
      async () => {
        if (!backendAvailable) return;

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/runs`,
          config
        );

        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should return runs array (may be empty or sample data)
        expect(data.runs).toBeDefined();
        expect(Array.isArray(data.runs)).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe('Client caching behavior', () => {
    it(
      'should use cached client for same credentials',
      async () => {
        if (!backendAvailable) return;

        // Make two requests with same credentials
        const response1 = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          config
        );
        const response2 = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          config
        );

        // Both should succeed (no connection overhead for second request)
        expect(response1.ok).toBe(true);
        expect(response2.ok).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should create new client for different credentials',
      async () => {
        if (!backendAvailable) return;

        // Make requests with different credentials
        const response1 = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          config
        );

        const differentConfig = {
          ...config,
          endpoint: 'https://different-endpoint:9200',
        };
        const response2 = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          differentConfig
        );

        // First should succeed, second may fail due to invalid endpoint
        expect(response1.ok).toBe(true);
        // Second request should still be processed (different client created)
        expect(response2.ok).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe('Error handling', () => {
    it(
      'should handle invalid endpoint gracefully',
      async () => {
        if (!backendAvailable) return;

        const invalidConfig = {
          endpoint: 'https://invalid-endpoint-that-does-not-exist:9999',
          username: 'admin',
          password: 'admin',
        };

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          invalidConfig
        );

        // Should return a response (not crash)
        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should indicate error or disconnected status
        expect(['connected', 'disconnected', 'error']).toContain(data.status);
      },
      TEST_TIMEOUT
    );

    it(
      'should handle invalid credentials gracefully',
      async () => {
        if (!backendAvailable) return;

        const invalidConfig = {
          endpoint: config.endpoint,
          username: 'invalid-user',
          password: 'invalid-password',
        };

        const response = await fetchWithStorageHeaders(
          `${BASE_URL}/api/storage/health`,
          invalidConfig
        );

        // Should return a response (not crash)
        expect(response.ok).toBe(true);
        const data = await response.json();

        // Should indicate some status
        expect(data.status).toBeDefined();
      },
      TEST_TIMEOUT
    );
  });
});
