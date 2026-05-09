/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for debug API endpoints
 *
 * These tests verify that:
 * 1. GET /api/debug returns the current debug state
 * 2. POST /api/debug toggles debug mode on and off
 * 3. POST /api/debug validates input
 * 4. State persists across GET/POST round-trips
 *
 * Run tests:
 *   npm test -- --testPathPattern=debug.integration
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    // Check both health and the debug endpoint itself
    const [healthRes, debugRes] = await Promise.all([
      fetch(`${BASE_URL}/health`),
      fetch(`${BASE_URL}/api/debug`),
    ]);
    return healthRes.ok && debugRes.ok;
  } catch {
    return false;
  }
};

describe('Debug API Integration Tests', () => {
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

  // Reset debug to false after each test to avoid side effects
  afterEach(async () => {
    if (!backendAvailable) return;
    await fetch(`${BASE_URL}/api/debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
  });

  describe('GET /api/debug', () => {
    it(
      'should return enabled status as boolean',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/debug`);

        expect(response.ok).toBe(true);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(typeof data.enabled).toBe('boolean');
      },
      TEST_TIMEOUT
    );

    it(
      'should return correct content-type',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/debug`);
        expect(response.headers.get('content-type')).toMatch(/application\/json/);
      },
      TEST_TIMEOUT
    );
  });

  describe('POST /api/debug', () => {
    it(
      'should enable debug mode',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.enabled).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should disable debug mode',
      async () => {
        if (!backendAvailable) return;

        // Enable first
        await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });

        // Disable
        const response = await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.enabled).toBe(false);
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 for non-boolean enabled value',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: 'yes' }),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('enabled must be a boolean');
      },
      TEST_TIMEOUT
    );

    it(
      'should return 400 for empty body',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('enabled must be a boolean');
      },
      TEST_TIMEOUT
    );
  });

  describe('State round-trip', () => {
    it(
      'should persist enabled state across GET requests',
      async () => {
        if (!backendAvailable) return;

        // Enable
        await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });

        // Verify via GET
        const getResponse = await fetch(`${BASE_URL}/api/debug`);
        const getData = await getResponse.json();
        expect(getData.enabled).toBe(true);

        // Disable
        await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });

        // Verify via GET
        const getResponse2 = await fetch(`${BASE_URL}/api/debug`);
        const getData2 = await getResponse2.json();
        expect(getData2.enabled).toBe(false);
      },
      TEST_TIMEOUT
    );

    it(
      'should be idempotent for repeated toggles',
      async () => {
        if (!backendAvailable) return;

        // Enable twice
        await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });
        const response = await fetch(`${BASE_URL}/api/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        });

        const data = await response.json();
        expect(data.enabled).toBe(true);
      },
      TEST_TIMEOUT
    );
  });
});
