/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for SSE Stream Client
 *
 * Tests:
 * 1. Stream completing on RUN_FINISHED event
 * 2. Stream completing on RUN_ERROR event
 * 3. Stream completing on idle timeout
 * 4. Stream completing when connection closes normally
 *
 * These tests use mock SSE servers to simulate various agent behaviors.
 *
 * Run tests:
 *   npm test -- --testPathPattern=sseStream
 */

import { SSEClient, consumeSSEStream } from '@/connectors/agui/sseStream';
import { AGUIEventType } from '@/types/agui';

// Helper to create a mock ReadableStream from SSE events
function createMockSSEStream(events: Array<{ type: string; data?: any; delay?: number }>, closeAfterEvents = true): {
  stream: ReadableStream<Uint8Array>;
  close: () => void;
} {
  let closed = false;
  const encoder = new TextEncoder();
  let eventIndex = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed || eventIndex >= events.length) {
        if (closeAfterEvents) {
          controller.close();
        }
        return;
      }

      const event = events[eventIndex];
      eventIndex++;

      // Wait for delay if specified
      if (event.delay) {
        await new Promise(resolve => setTimeout(resolve, event.delay));
      }

      const eventData = {
        type: event.type,
        timestamp: Date.now(),
        ...event.data,
      };

      const sseMessage = `data: ${JSON.stringify(eventData)}\n\n`;
      controller.enqueue(encoder.encode(sseMessage));
    },
    cancel() {
      closed = true;
    },
  });

  return {
    stream,
    close: () => { closed = true; },
  };
}

// Mock fetch for testing
function mockFetch(mockStream: ReadableStream<Uint8Array>): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: mockStream,
  } as Response);
}

describe('SSE Stream Client Tests', () => {
  let fetchSpy: jest.SpyInstance | null = null;

  afterEach(() => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
      fetchSpy = null;
    }
  });

  describe('Stream completion on RUN_FINISHED event', () => {
    it('should complete stream immediately when RUN_FINISHED is received', async () => {
      const events = [
        { type: AGUIEventType.RUN_STARTED, data: { runId: 'test-run-123' } },
        { type: AGUIEventType.TEXT_MESSAGE_START, data: { messageId: 'msg-1' } },
        { type: AGUIEventType.TEXT_MESSAGE_CONTENT, data: { messageId: 'msg-1', delta: 'Hello' } },
        { type: AGUIEventType.TEXT_MESSAGE_END, data: { messageId: 'msg-1' } },
        { type: AGUIEventType.RUN_FINISHED, data: {} },
        // Events after RUN_FINISHED should NOT be processed
        { type: AGUIEventType.TEXT_MESSAGE_START, data: { messageId: 'msg-2' }, delay: 100 },
      ];

      const { stream } = createMockSSEStream(events, false); // Don't auto-close
      fetchSpy = mockFetch(stream);

      const receivedEvents: any[] = [];
      const startTime = Date.now();

      await consumeSSEStream(
        'http://test-endpoint',
        { test: true },
        (event) => receivedEvents.push(event)
      );

      const duration = Date.now() - startTime;

      // Should have received events up to and including RUN_FINISHED
      expect(receivedEvents.length).toBe(5);
      expect(receivedEvents[0].type).toBe(AGUIEventType.RUN_STARTED);
      expect(receivedEvents[4].type).toBe(AGUIEventType.RUN_FINISHED);

      // Should complete quickly (not wait for idle timeout)
      expect(duration).toBeLessThan(5000);

      console.log(`[RUN_FINISHED Test] Completed in ${duration}ms with ${receivedEvents.length} events`);
    }, 15000);
  });

  describe('Stream completion on RUN_ERROR event', () => {
    it('should complete stream immediately when RUN_ERROR is received', async () => {
      const events = [
        { type: AGUIEventType.RUN_STARTED, data: { runId: 'test-run-456' } },
        { type: AGUIEventType.RUN_ERROR, data: { message: 'Test error occurred' } },
      ];

      const { stream } = createMockSSEStream(events, false);
      fetchSpy = mockFetch(stream);

      const receivedEvents: any[] = [];
      const startTime = Date.now();

      await consumeSSEStream(
        'http://test-endpoint',
        { test: true },
        (event) => receivedEvents.push(event)
      );

      const duration = Date.now() - startTime;

      expect(receivedEvents.length).toBe(2);
      expect(receivedEvents[1].type).toBe(AGUIEventType.RUN_ERROR);
      expect(duration).toBeLessThan(5000);

      console.log(`[RUN_ERROR Test] Completed in ${duration}ms with ${receivedEvents.length} events`);
    }, 15000);
  });

  describe('Stream completion on idle timeout', () => {
    it('should complete stream after idle timeout when no RUN_FINISHED is sent', async () => {
      const events = [
        { type: AGUIEventType.RUN_STARTED, data: { runId: 'test-run-789' } },
        { type: AGUIEventType.TEXT_MESSAGE_START, data: { messageId: 'msg-1' } },
        { type: AGUIEventType.TEXT_MESSAGE_CONTENT, data: { messageId: 'msg-1', delta: 'Response text' } },
        { type: AGUIEventType.TEXT_MESSAGE_END, data: { messageId: 'msg-1' } },
        // No RUN_FINISHED event - stream should timeout
      ];

      const { stream } = createMockSSEStream(events, false); // Don't close the stream
      fetchSpy = mockFetch(stream);

      const receivedEvents: any[] = [];
      const startTime = Date.now();

      // Use a shorter idle timeout for testing (3 seconds)
      const client = new SSEClient();
      await new Promise<void>((resolve, reject) => {
        client.consume({
          url: 'http://test-endpoint',
          method: 'POST',
          body: { test: true },
          onEvent: (event) => receivedEvents.push(event),
          onError: reject,
          onComplete: resolve,
          completeOnRunEnd: true,
          idleTimeoutMs: 3000, // 3 second timeout for faster test
        });
      });

      const duration = Date.now() - startTime;

      // Should have received all events
      expect(receivedEvents.length).toBe(4);

      // Should have waited for idle timeout (approximately 3 seconds)
      expect(duration).toBeGreaterThan(2500);
      expect(duration).toBeLessThan(6000);

      console.log(`[Idle Timeout Test] Completed in ${duration}ms with ${receivedEvents.length} events`);
    }, 20000);
  });

  describe('Stream completion on connection close', () => {
    it('should complete stream when connection is closed by server', async () => {
      const events = [
        { type: AGUIEventType.RUN_STARTED, data: { runId: 'test-run-abc' } },
        { type: AGUIEventType.TEXT_MESSAGE_START, data: { messageId: 'msg-1' } },
        { type: AGUIEventType.TEXT_MESSAGE_END, data: { messageId: 'msg-1' } },
        // No RUN_FINISHED, but stream will close
      ];

      const { stream } = createMockSSEStream(events, true); // Auto-close after events
      fetchSpy = mockFetch(stream);

      const receivedEvents: any[] = [];
      const startTime = Date.now();

      await consumeSSEStream(
        'http://test-endpoint',
        { test: true },
        (event) => receivedEvents.push(event)
      );

      const duration = Date.now() - startTime;

      expect(receivedEvents.length).toBe(3);
      // Should complete quickly when connection closes
      expect(duration).toBeLessThan(5000);

      console.log(`[Connection Close Test] Completed in ${duration}ms with ${receivedEvents.length} events`);
    }, 15000);
  });

  describe('Event ordering and content', () => {
    it('should process events in correct order', async () => {
      const events = [
        { type: AGUIEventType.RUN_STARTED, data: { runId: 'order-test' } },
        { type: AGUIEventType.THINKING_START, data: {} },
        { type: AGUIEventType.THINKING_TEXT_MESSAGE_START, data: { messageId: 'think-1' } },
        { type: AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT, data: { messageId: 'think-1', delta: 'Thinking...' } },
        { type: AGUIEventType.THINKING_TEXT_MESSAGE_END, data: { messageId: 'think-1' } },
        { type: AGUIEventType.THINKING_END, data: {} },
        { type: AGUIEventType.TOOL_CALL_START, data: { toolCallId: 'tool-1', toolCallName: 'search' } },
        { type: AGUIEventType.TOOL_CALL_ARGS, data: { toolCallId: 'tool-1', delta: '{"query":"test"}' } },
        { type: AGUIEventType.TOOL_CALL_END, data: { toolCallId: 'tool-1' } },
        { type: AGUIEventType.TOOL_CALL_RESULT, data: { toolCallId: 'tool-1', content: '"result"' } },
        { type: AGUIEventType.TEXT_MESSAGE_START, data: { messageId: 'response-1' } },
        { type: AGUIEventType.TEXT_MESSAGE_CONTENT, data: { messageId: 'response-1', delta: 'Final response' } },
        { type: AGUIEventType.TEXT_MESSAGE_END, data: { messageId: 'response-1' } },
        { type: AGUIEventType.RUN_FINISHED, data: {} },
      ];

      const { stream } = createMockSSEStream(events, false);
      fetchSpy = mockFetch(stream);

      const receivedEvents: any[] = [];

      await consumeSSEStream(
        'http://test-endpoint',
        { test: true },
        (event) => receivedEvents.push(event)
      );

      // Verify all events received in order
      expect(receivedEvents.length).toBe(14);
      expect(receivedEvents.map(e => e.type)).toEqual([
        AGUIEventType.RUN_STARTED,
        AGUIEventType.THINKING_START,
        AGUIEventType.THINKING_TEXT_MESSAGE_START,
        AGUIEventType.THINKING_TEXT_MESSAGE_CONTENT,
        AGUIEventType.THINKING_TEXT_MESSAGE_END,
        AGUIEventType.THINKING_END,
        AGUIEventType.TOOL_CALL_START,
        AGUIEventType.TOOL_CALL_ARGS,
        AGUIEventType.TOOL_CALL_END,
        AGUIEventType.TOOL_CALL_RESULT,
        AGUIEventType.TEXT_MESSAGE_START,
        AGUIEventType.TEXT_MESSAGE_CONTENT,
        AGUIEventType.TEXT_MESSAGE_END,
        AGUIEventType.RUN_FINISHED,
      ]);

      console.log(`[Event Order Test] Received ${receivedEvents.length} events in correct order`);
    }, 15000);
  });

  describe('Error handling', () => {
    it('should reject promise when fetch fails', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      const receivedEvents: any[] = [];

      await expect(
        consumeSSEStream(
          'http://test-endpoint',
          { test: true },
          (event) => receivedEvents.push(event)
        )
      ).rejects.toThrow('Network error');

      expect(receivedEvents.length).toBe(0);

      console.log('[Error Test] Correctly rejected on network error');
    });

    it('should reject promise when HTTP response is not OK', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const receivedEvents: any[] = [];

      await expect(
        consumeSSEStream(
          'http://test-endpoint',
          { test: true },
          (event) => receivedEvents.push(event)
        )
      ).rejects.toThrow('HTTP 500');

      expect(receivedEvents.length).toBe(0);

      console.log('[Error Test] Correctly rejected on HTTP error');
    });
  });
});
