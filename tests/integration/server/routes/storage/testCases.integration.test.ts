/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the test-cases CRUD API.
 *
 * Requires the backend server to be running:
 *   npm run dev:server
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=testCases.integration
 *
 * The base URL is read from AGENT_HEALTH_PORT (default 4001) via getTestBackendUrl.
 * To target a different port (e.g. 3000), run with AGENT_HEALTH_PORT=3000.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'connected';
  } catch {
    return false;
  }
};

const deleteTestCase = async (id: string): Promise<void> => {
  await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }).catch(() => {});
};

describe('Test Cases CRUD Integration Tests', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];

  // Unique marker so tests don't collide with leftover data from prior runs
  const NAME_MARKER = `integration-${Date.now()}`;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping test-cases integration tests');
      console.warn('Start the backend with: npm run dev:server');
    }
  }, 30000);

  afterAll(async () => {
    if (!backendAvailable) return;

    for (const id of createdTestCaseIds) {
      await deleteTestCase(id);
    }

    // Fallback: clean up any leftovers that share our name marker
    try {
      const resp = await fetch(`${BASE_URL}/api/storage/test-cases`);
      if (resp.ok) {
        const data = await resp.json();
        for (const tc of (data.testCases ?? [])) {
          if (typeof tc.name === 'string' && tc.name.includes(NAME_MARKER)) {
            await deleteTestCase(tc.id);
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }, 30000);

  describe('POST /api/storage/test-cases', () => {
    it('should create a new test case at version 1', async () => {
      if (!backendAvailable) return;

      const body = {
        name: `${NAME_MARKER}-create`,
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Investigate why the order-service returns 500',
        context: [{ description: 'Service info', value: 'order-service on port 8080' }],
        expectedOutcomes: ['Query error logs', 'Identify root cause'],
        labels: ['category:RCA', 'difficulty:Medium'],
      };

      const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.id).toBeDefined();
      expect(created.name).toBe(body.name);
      expect(created.currentVersion).toBe(1);
      expect(created.initialPrompt).toBe(body.initialPrompt);

      createdTestCaseIds.push(created.id);
    }, 30000);

    it('should reject creating a test case with a demo- prefix', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'demo-malicious',
          name: `${NAME_MARKER}-demo-prefix`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'should fail',
          context: [],
          expectedOutcomes: [],
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('demo-');
    });
  });

  describe('GET /api/storage/test-cases', () => {
    it('should list test cases including the one we just created', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/test-cases`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(Array.isArray(data.testCases)).toBe(true);
      expect(data.meta).toBeDefined();
      expect(typeof data.meta.storageConfigured).toBe('boolean');

      // Must contain the test case we created in the POST suite
      const ours = data.testCases.find((tc: any) => tc.name === `${NAME_MARKER}-create`);
      expect(ours).toBeDefined();
    }, 30000);

    it('should support summary mode (truncates initialPrompt and strips heavy fields)', async () => {
      if (!backendAvailable) return;

      // Create a test case with a long initialPrompt to trigger truncation
      const longPrompt = 'a'.repeat(300);
      const createResp = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${NAME_MARKER}-summary`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: longPrompt,
          context: [{ description: 'ctx', value: 'value' }],
          expectedOutcomes: ['outcome'],
        }),
      });
      const created = await createResp.json();
      createdTestCaseIds.push(created.id);

      const response = await fetch(`${BASE_URL}/api/storage/test-cases?fields=summary`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      const ours = data.testCases.find((tc: any) => tc.id === created.id);
      expect(ours).toBeDefined();
      expect(ours.initialPrompt.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(ours.initialPrompt.endsWith('...')).toBe(true);
      expect(ours.context).toEqual([]);
      expect(ours.expectedOutcomes).toEqual([]);
      expect(ours.versions).toEqual([]);
    }, 30000);

    it('should filter by ids when provided', async () => {
      if (!backendAvailable) return;
      if (createdTestCaseIds.length === 0) return;

      const targetId = createdTestCaseIds[0];
      const response = await fetch(
        `${BASE_URL}/api/storage/test-cases?ids=${encodeURIComponent(targetId)}`,
      );
      expect(response.ok).toBe(true);

      const data = await response.json();
      const realIds = data.testCases
        .filter((tc: any) => !tc.id.startsWith('demo-'))
        .map((tc: any) => tc.id);
      expect(realIds).toContain(targetId);
      expect(realIds.every((id: string) => id === targetId)).toBe(true);
    }, 30000);
  });

  describe('GET /api/storage/test-cases/:id', () => {
    it('should return the test case by id', async () => {
      if (!backendAvailable) return;
      if (createdTestCaseIds.length === 0) return;

      const id = createdTestCaseIds[0];
      const response = await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`);
      expect(response.ok).toBe(true);

      const tc = await response.json();
      expect(tc.id).toBe(id);
      expect(tc.currentVersion).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('should return 404 for a non-existent id', async () => {
      if (!backendAvailable) return;

      const response = await fetch(
        `${BASE_URL}/api/storage/test-cases/does-not-exist-${Date.now()}`,
      );
      expect(response.status).toBe(404);
      const error = await response.json();
      expect(error.error).toBeDefined();
    }, 30000);

    it('should return a sample test case by demo- id', async () => {
      if (!backendAvailable) return;

      // First, find any sample id from the list endpoint
      const listResp = await fetch(`${BASE_URL}/api/storage/test-cases?includeSample=true`);
      const listData = await listResp.json();
      const sample = (listData.testCases ?? []).find((tc: any) =>
        typeof tc.id === 'string' && tc.id.startsWith('demo-'),
      );
      if (!sample) {
        console.warn('No sample test case available - skipping');
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(sample.id)}`,
      );
      expect(response.ok).toBe(true);
      const tc = await response.json();
      expect(tc.id).toBe(sample.id);
    }, 30000);
  });

  describe('PUT /api/storage/test-cases/:id', () => {
    it('should create a new version on update', async () => {
      if (!backendAvailable) return;

      // Create a fresh test case for this test
      const createResp = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${NAME_MARKER}-update`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'original prompt',
          context: [],
          expectedOutcomes: ['original'],
        }),
      });
      const created = await createResp.json();
      createdTestCaseIds.push(created.id);
      expect(created.currentVersion).toBe(1);

      // Update it
      const updateResp = await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(created.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...created,
            initialPrompt: 'updated prompt',
            expectedOutcomes: ['updated'],
          }),
        },
      );
      expect(updateResp.ok).toBe(true);

      // Verify versions endpoint reflects the new version
      const versionsResp = await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(created.id)}/versions`,
      );
      expect(versionsResp.ok).toBe(true);
      const versionsData = await versionsResp.json();
      expect(versionsData.total).toBeGreaterThanOrEqual(2);
    }, 30000);

    it('should reject updating sample data (demo- prefix)', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/test-cases/demo-sample-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialPrompt: 'malicious' }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('sample data');
    }, 30000);
  });

  describe('DELETE /api/storage/test-cases/:id', () => {
    it('should delete a test case and all its versions', async () => {
      if (!backendAvailable) return;

      // Create a dedicated test case to delete
      const createResp = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${NAME_MARKER}-delete`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'to be deleted',
          context: [],
          expectedOutcomes: [],
        }),
      });
      const created = await createResp.json();

      const deleteResp = await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(created.id)}`,
        { method: 'DELETE' },
      );
      expect(deleteResp.ok).toBe(true);
      const result = await deleteResp.json();
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      // Confirm it's gone
      const getResp = await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(created.id)}`,
      );
      expect(getResp.status).toBe(404);
    }, 30000);

    it('should reject deleting sample data (demo- prefix)', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/test-cases/demo-sample-1`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('sample data');
    }, 30000);
  });

  describe('POST /api/storage/test-cases/bulk', () => {
    it('should bulk create multiple test cases', async () => {
      if (!backendAvailable) return;

      const testCases = [
        {
          name: `${NAME_MARKER}-bulk-1`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'bulk one',
          context: [],
          expectedOutcomes: [],
        },
        {
          name: `${NAME_MARKER}-bulk-2`,
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'bulk two',
          context: [],
          expectedOutcomes: [],
        },
      ];

      const response = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCases }),
      });

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.created).toBe(2);
      expect(Array.isArray(result.testCases)).toBe(true);
      for (const tc of result.testCases) {
        if (tc.id) createdTestCaseIds.push(tc.id);
      }
    }, 30000);

    it('should reject bulk create when payload is not an array', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCases: 'not-an-array' }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('array');
    }, 30000);

    it('should reject bulk create containing demo- ids', async () => {
      if (!backendAvailable) return;

      const response = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCases: [
            { id: 'demo-x', name: `${NAME_MARKER}-bulk-demo`, initialPrompt: 'no', context: [], expectedOutcomes: [] },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('demo-');
    }, 30000);
  });
});
