/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the Assistant API endpoints.
 * These tests require the server to be running on port 4001.
 *
 * Run with: npm run test:integration
 * Ensure server is running: npm run dev:server
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

// Skip if server is not running
async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe('Assistant API Integration', () => {
  let serverRunning = false;

  beforeAll(async () => {
    serverRunning = await isServerRunning();
    if (!serverRunning) {
      console.warn('Server not running at', BASE_URL, '- skipping integration tests');
    }
  });

  describe('GET /api/assistant/health', () => {
    it('should return health status', async () => {
      if (!serverRunning) return;

      const res = await fetch(`${BASE_URL}/api/assistant/health`);
      expect(res.ok).toBe(true);

      const data = await res.json();
      expect(data).toHaveProperty('available');
      expect(data).toHaveProperty('provider');
      expect(typeof data.available).toBe('boolean');
      expect(typeof data.provider).toBe('string');
    });
  });

  describe('POST /api/assistant/chat', () => {
    it('should return 400 for missing sessionId', async () => {
      if (!serverRunning) return;

      const res = await fetch(`${BASE_URL}/api/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('sessionId');
    });

    it('should return 400 for missing message', async () => {
      if (!serverRunning) return;

      const res = await fetch(`${BASE_URL}/api/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'test-integration' }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('message');
    });

    it('should return SSE stream headers for valid request', async () => {
      if (!serverRunning) return;

      const controller = new AbortController();
      // Set a timeout to abort since the stream may take a while
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const res = await fetch(`${BASE_URL}/api/assistant/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: `integration-test-${Date.now()}`,
            message: 'Hello, what can you do?',
            context: { currentUrl: '/' },
          }),
          signal: controller.signal,
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        // Read at least one chunk from the stream
        const reader = res.body?.getReader();
        if (reader) {
          const { done, value } = await reader.read();
          // The stream should produce at least some data (or finish)
          // We just verify it's a valid SSE stream
          if (!done && value) {
            const text = new TextDecoder().decode(value);
            // SSE events start with "data: "
            expect(text).toContain('data: ');
          }
          reader.cancel();
        }
      } catch (error: any) {
        if (error.name === 'AbortError') {
          // Timeout is acceptable for streaming endpoint
        } else {
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  });

  describe('DELETE /api/assistant/session/:sessionId', () => {
    it('should clear session successfully', async () => {
      if (!serverRunning) return;

      const res = await fetch(
        `${BASE_URL}/api/assistant/session/integration-test-cleanup`,
        { method: 'DELETE' }
      );

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });
});
