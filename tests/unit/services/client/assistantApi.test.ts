/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

import {
  streamAssistantChat,
  clearAssistantSession,
  checkAssistantHealth,
} from '@/services/client/assistantApi';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('AssistantApi', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('streamAssistantChat', () => {
    function createSSEStream(events: string[]) {
      const encoder = new TextEncoder();
      let index = 0;
      return new ReadableStream({
        pull(controller) {
          if (index < events.length) {
            controller.enqueue(encoder.encode(events[index]));
            index++;
          } else {
            controller.close();
          }
        },
      });
    }

    it('should stream delta events and return full response', async () => {
      const stream = createSSEStream([
        'data: {"type":"delta","content":"Hello"}\n\n',
        'data: {"type":"delta","content":" world"}\n\n',
        'data: {"type":"done","fullResponse":"Hello world"}\n\n',
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const chunks: string[] = [];
      const result = await streamAssistantChat(
        'session-1',
        'Hi',
        { currentUrl: '/' },
        (content) => chunks.push(content)
      );

      expect(chunks).toEqual(['Hello', ' world']);
      expect(result).toBe('Hello world');
    });

    it('should handle multiple events in a single chunk', async () => {
      const stream = createSSEStream([
        'data: {"type":"delta","content":"A"}\n\ndata: {"type":"delta","content":"B"}\n\n',
        'data: {"type":"done","fullResponse":"AB"}\n\n',
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const chunks: string[] = [];
      const result = await streamAssistantChat(
        'session-2',
        'Hello',
        {},
        (content) => chunks.push(content)
      );

      expect(chunks).toEqual(['A', 'B']);
      expect(result).toBe('AB');
    });

    it('should throw on error event', async () => {
      const stream = createSSEStream([
        'data: {"type":"error","error":"Something failed"}\n\n',
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      await expect(
        streamAssistantChat('session-3', 'Hi', {}, () => {})
      ).rejects.toThrow('Something failed');
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: jest.fn().mockResolvedValue({ error: 'Server error' }),
      });

      await expect(
        streamAssistantChat('session-4', 'Hi', {}, () => {})
      ).rejects.toThrow();
    });

    it('should throw when no response body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: null,
      });

      await expect(
        streamAssistantChat('session-5', 'Hi', {}, () => {})
      ).rejects.toThrow('No response body');
    });

    it('should send correct request body', async () => {
      const stream = createSSEStream([
        'data: {"type":"done","fullResponse":"ok"}\n\n',
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      await streamAssistantChat(
        'my-session',
        'Test message',
        { currentUrl: '/benchmarks', benchmarkId: 'bench-1' },
        () => {}
      );

      expect(mockFetch).toHaveBeenCalledWith('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'my-session',
          message: 'Test message',
          context: { currentUrl: '/benchmarks', benchmarkId: 'bench-1' },
        }),
      });
    });

    it('should handle partial SSE chunks with buffering', async () => {
      const stream = createSSEStream([
        'data: {"type":"delta","content":"He',
        'llo"}\n\ndata: {"type":"done","fullResponse":"Hello"}\n\n',
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const chunks: string[] = [];
      const result = await streamAssistantChat(
        'session-buffer',
        'Hi',
        {},
        (content) => chunks.push(content)
      );

      expect(result).toBe('Hello');
    });

    it('should throw when stream ends without done event', async () => {
      const stream = createSSEStream([
        'data: {"type":"delta","content":"partial"}\n\n',
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      await expect(
        streamAssistantChat('session-no-done', 'Hi', {}, () => {})
      ).rejects.toThrow('Assistant stream completed without returning a full response');
    });
  });

  describe('clearAssistantSession', () => {
    it('should call DELETE endpoint with encoded sessionId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ success: true }),
      });

      await clearAssistantSession('session-1');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/assistant/session/session-1',
        { method: 'DELETE' }
      );
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
        json: jest.fn().mockResolvedValue({ error: 'Not found' }),
      });

      await expect(clearAssistantSession('bad-session')).rejects.toThrow();
    });
  });

  describe('checkAssistantHealth', () => {
    it('should return health status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          available: true,
          provider: 'claude-code',
        }),
      });

      const result = await checkAssistantHealth();

      expect(result).toEqual({
        available: true,
        provider: 'claude-code',
      });
      expect(mockFetch).toHaveBeenCalledWith('/api/assistant/health');
    });

    it('should return unavailable on non-ok response (does not throw)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Service Unavailable',
      });

      const result = await checkAssistantHealth();
      expect(result).toEqual({ available: false, provider: 'unknown' });
    });
  });
});
