/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects for AG-UI events
import { SSEClient, consumeSSEStream } from '@/services/agent/sseStream';
import { AGUIEventType } from '@/types/agui';
import type { AGUIEvent } from '@/types/agui';

// Mock debug
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

// Helper to create a mock ReadableStream
function createMockReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// Helper to create SSE formatted data
function sseData(event: Partial<AGUIEvent>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe('SSEClient', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    originalFetch = global.fetch;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  describe('consume', () => {
    it('should connect and receive SSE events', async () => {
      const events: AGUIEvent[] = [];
      const mockStream = createMockReadableStream([
        sseData({ type: AGUIEventType.RUN_STARTED, runId: 'run-123', threadId: 'thread-1' }),
        sseData({ type: AGUIEventType.TEXT_MESSAGE_CONTENT, delta: 'Hello' }),
        sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: mockStream,
      });

      const client = new SSEClient();
      const onEvent = jest.fn((event: AGUIEvent) => events.push(event));
      const onComplete = jest.fn();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { prompt: 'test' },
        onEvent,
        onComplete,
        completeOnRunEnd: true,
      });

      // Advance timers to allow stream processing
      await jest.runAllTimersAsync();
      await consumePromise;

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test.com/stream',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          }),
          body: JSON.stringify({ prompt: 'test' }),
        })
      );

      expect(onEvent).toHaveBeenCalledTimes(3);
      expect(events[0].type).toBe(AGUIEventType.RUN_STARTED);
      expect(events[2].type).toBe(AGUIEventType.RUN_FINISHED);
      expect(onComplete).toHaveBeenCalled();
    });

    it('should handle HTTP errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const client = new SSEClient();
      const onError = jest.fn();
      const onComplete = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent: jest.fn(),
        onError,
        onComplete,
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'HTTP 500: Internal Server Error',
        })
      );
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('should handle null response body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
      });

      const client = new SSEClient();
      const onError = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent: jest.fn(),
        onError,
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Response body is null',
        })
      );
    });

    it('should use GET method when specified', async () => {
      const mockStream = createMockReadableStream([
        sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();

      // Note: even for GET, we pass a body for the debug log, but it won't be sent in the fetch
      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        method: 'GET',
        body: {}, // Empty body for logging purposes
        onEvent: jest.fn(),
        completeOnRunEnd: true,
      });

      await jest.runAllTimersAsync();
      await consumePromise;

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test.com/stream',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should include custom headers', async () => {
      const mockStream = createMockReadableStream([
        sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        headers: { Authorization: 'Bearer token123' },
        onEvent: jest.fn(),
        completeOnRunEnd: true,
      });

      await jest.runAllTimersAsync();
      await consumePromise;

      expect(global.fetch).toHaveBeenCalledWith(
        'http://test.com/stream',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token123',
          }),
        })
      );
    });

    it('should handle JSON parse errors gracefully', async () => {
      const mockStream = createMockReadableStream([
        'data: invalid json\n\n',
        sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();
      const onEvent = jest.fn();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent,
        completeOnRunEnd: true,
      });

      await jest.runAllTimersAsync();
      await consumePromise;

      // Should still receive the valid event
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[SSE] Parse error:', expect.any(Error));
    });

    it('should complete on RUN_ERROR event when completeOnRunEnd is true', async () => {
      const mockStream = createMockReadableStream([
        sseData({ type: AGUIEventType.RUN_STARTED, runId: 'run-123', threadId: 'thread-1' }),
        sseData({ type: AGUIEventType.RUN_ERROR, runId: 'run-123', threadId: 'thread-1', message: 'Agent error' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();
      const onEvent = jest.fn();
      const onComplete = jest.fn();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent,
        onComplete,
        completeOnRunEnd: true,
      });

      await jest.runAllTimersAsync();
      await consumePromise;

      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalled();
    });

    it('should handle abort correctly', async () => {
      // Create a mock AbortError
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      // Mock fetch to throw abort error when aborted
      global.fetch = jest.fn().mockRejectedValue(abortError);

      const client = new SSEClient();
      const onComplete = jest.fn();
      const onError = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent: jest.fn(),
        onComplete,
        onError,
      });

      // AbortError should trigger onComplete, not onError
      expect(onComplete).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('should handle unknown errors', async () => {
      global.fetch = jest.fn().mockRejectedValue('Unknown error string');

      const client = new SSEClient();
      const onError = jest.fn();

      await client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent: jest.fn(),
        onError,
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unknown error occurred',
        })
      );
    });

    it('should handle idle timeout', async () => {
      // Create a stream that sends one event then goes idle
      const encoder = new TextEncoder();
      let sentEvent = false;
      const mockStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentEvent) {
            controller.enqueue(
              encoder.encode(sseData({ type: AGUIEventType.RUN_STARTED, runId: 'run-123', threadId: 'thread-1' }))
            );
            sentEvent = true;
          }
          // Don't close the stream - simulate idle
          await new Promise((resolve) => setTimeout(resolve, 100000));
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();
      const onEvent = jest.fn();
      const onComplete = jest.fn();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent,
        onComplete,
        idleTimeoutMs: 5000, // 5 second idle timeout
      });

      // Process the initial event
      await jest.advanceTimersByTimeAsync(100);

      // Advance past idle timeout
      await jest.advanceTimersByTimeAsync(6000);

      await consumePromise;

      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalled();
    });

    it('should ignore non-data SSE lines', async () => {
      const mockStream = createMockReadableStream([
        'id: event-1\n',
        'event: message\n',
        'retry: 3000\n',
        ': this is a comment\n',
        sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();
      const onEvent = jest.fn();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent,
        completeOnRunEnd: true,
      });

      await jest.runAllTimersAsync();
      await consumePromise;

      // Only the actual data event should be processed
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AGUIEventType.RUN_FINISHED,
        })
      );
    });

    it('should skip empty data lines', async () => {
      const mockStream = createMockReadableStream([
        'data: \n\n',
        'data:   \n\n',
        sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream,
      });

      const client = new SSEClient();
      const onEvent = jest.fn();

      const consumePromise = client.consume({
        url: 'http://test.com/stream',
        body: { test: true },
        onEvent,
        completeOnRunEnd: true,
      });

      await jest.runAllTimersAsync();
      await consumePromise;

      // Only the non-empty data event should be processed
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('abort', () => {
    it('should abort without error when no stream is active', () => {
      const client = new SSEClient();

      // Should not throw
      expect(() => client.abort()).not.toThrow();
    });
  });
});

describe('consumeSSEStream', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('should resolve when stream completes', async () => {
    const mockStream = createMockReadableStream([
      sseData({ type: AGUIEventType.RUN_STARTED, runId: 'run-123', threadId: 'thread-1' }),
      sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
    ]);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: mockStream,
    });

    const events: AGUIEvent[] = [];
    const onEvent = jest.fn((event: AGUIEvent) => events.push(event));

    const streamPromise = consumeSSEStream('http://test.com/stream', { prompt: 'test' }, onEvent);

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(events[0].type).toBe(AGUIEventType.RUN_STARTED);
    expect(events[1].type).toBe(AGUIEventType.RUN_FINISHED);
  });

  it('should reject on error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const onEvent = jest.fn();

    await expect(consumeSSEStream('http://test.com/stream', { prompt: 'test' }, onEvent)).rejects.toThrow(
      'HTTP 503: Service Unavailable'
    );
  });

  it('should pass custom headers to fetch', async () => {
    const mockStream = createMockReadableStream([
      sseData({ type: AGUIEventType.RUN_FINISHED, runId: 'run-123', threadId: 'thread-1' }),
    ]);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: mockStream,
    });

    const streamPromise = consumeSSEStream(
      'http://test.com/stream',
      { prompt: 'test' },
      jest.fn(),
      { 'X-Custom-Header': 'value' }
    );

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(global.fetch).toHaveBeenCalledWith(
      'http://test.com/stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom-Header': 'value',
        }),
      })
    );
  });
});
