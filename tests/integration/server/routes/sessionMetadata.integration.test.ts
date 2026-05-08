/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for session metadata API
 *
 * Tests the GET/PUT/LIST endpoints against a running server.
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 */

const TEST_TIMEOUT = 30000;

const getTestConfig = () => ({
  backendUrl: process.env.TEST_BACKEND_URL || 'http://localhost:4011',
});

const checkBackend = async (backendUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${backendUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('Session Metadata API Integration Tests', () => {
  let backendAvailable = false;
  let config: ReturnType<typeof getTestConfig>;
  const testAgent = 'claude-code';
  const testSessionId = `integ-test-${Date.now()}`;

  beforeAll(async () => {
    config = getTestConfig();
    backendAvailable = await checkBackend(config.backendUrl);
    if (!backendAvailable) {
      console.warn('Backend not available at', config.backendUrl, '- skipping integration tests');
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Clean up: there's no DELETE endpoint, but the file will be in agent-health-data/session-metadata/
    // which is ephemeral test data
  });

  describe('GET /api/coding-agents/sessions/:agent/:sessionId/metadata', () => {
    it('should return null for non-existent session', async () => {
      if (!backendAvailable) return;

      const response = await fetch(
        `${config.backendUrl}/api/coding-agents/sessions/${testAgent}/nonexistent-session/metadata`
      );
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toBeNull();
    }, TEST_TIMEOUT);
  });

  describe('PUT /api/coding-agents/sessions/:agent/:sessionId/metadata', () => {
    it('should create metadata for a session', async () => {
      if (!backendAvailable) return;

      const payload = {
        status: 'interesting',
        annotations: [{ id: 'a1', text: 'Test annotation', tags: ['test'] }],
        bookmarked: true,
      };

      const response = await fetch(
        `${config.backendUrl}/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.agentKind).toBe(testAgent);
      expect(data.sessionId).toBe(testSessionId);
      expect(data.status).toBe('interesting');
      expect(data.bookmarked).toBe(true);
      expect(data.annotations).toHaveLength(1);
      expect(data.updatedAt).toBeDefined();
      expect(data.createdAt).toBeDefined();
    }, TEST_TIMEOUT);

    it('should merge on subsequent PUT', async () => {
      if (!backendAvailable) return;

      const response = await fetch(
        `${config.backendUrl}/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: 5, status: 'problematic' }),
        }
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      // Merged fields
      expect(data.bookmarked).toBe(true);
      expect(data.rating).toBe(5);
      expect(data.status).toBe('problematic');
    }, TEST_TIMEOUT);

    it('should reject non-object body', async () => {
      if (!backendAvailable) return;

      const response = await fetch(
        `${config.backendUrl}/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([1, 2, 3]),
        }
      );

      expect(response.status).toBe(400);
    }, TEST_TIMEOUT);
  });

  describe('GET /api/coding-agents/sessions/:agent/:sessionId/metadata (after PUT)', () => {
    it('should return previously stored metadata', async () => {
      if (!backendAvailable) return;

      const response = await fetch(
        `${config.backendUrl}/api/coding-agents/sessions/${testAgent}/${testSessionId}/metadata`
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.agentKind).toBe(testAgent);
      expect(data.sessionId).toBe(testSessionId);
      expect(data.status).toBe('problematic');
      expect(data.bookmarked).toBe(true);
      expect(data.rating).toBe(5);
    }, TEST_TIMEOUT);
  });

  describe('GET /api/coding-agents/sessions/metadata (list)', () => {
    it('should include the test session in results', async () => {
      if (!backendAvailable) return;

      const response = await fetch(
        `${config.backendUrl}/api/coding-agents/sessions/metadata`
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.items).toBeDefined();
      expect(data.total).toBeGreaterThanOrEqual(1);
      const found = data.items.find((i: any) => i.sessionId === testSessionId);
      expect(found).toBeDefined();
    }, TEST_TIMEOUT);
  });
});
