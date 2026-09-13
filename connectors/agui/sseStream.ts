/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-Sent Events (SSE) Stream Consumer
 * Handles streaming connections to the agent endpoint
 */

import { AGUIEvent, AGUIEventType } from '@/types/agui';
import { debug, isDebugEnabled } from '@/lib/debug';

export interface SSEClientOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
  onEvent: (event: AGUIEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
  /** Complete stream when RUN_FINISHED or RUN_ERROR event is received */
  completeOnRunEnd?: boolean;
  /** Timeout (ms) after last event to assume stream is complete (default: 120000) */
  idleTimeoutMs?: number;
}

export class SSEClient {
  private abortController: AbortController | null = null;

  /**
   * Start consuming SSE stream from the agent endpoint
   */
  async consume(options: SSEClientOptions): Promise<void> {
    const {
      url,
      method = 'POST',
      headers = {},
      body,
      onEvent,
      onError,
      onComplete,
      completeOnRunEnd = false,
      idleTimeoutMs = 120000, // 2 minute idle timeout by default (LLM agents can be slow)
    } = options;

    this.abortController = new AbortController();

    debug('SSE', 'Connecting to', url);
    debug('SSE', 'Method:', method);
    debug('SSE', 'Headers:', headers);
    debug('SSE', 'Payload:', body ? JSON.stringify(body, null, 2).substring(0, 500) : 'none');
    debug('SSE', 'Timeout:', idleTimeoutMs, 'ms');

    try {
      const requestConfig = {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: this.abortController.signal,
      };
      debug('SSE', 'Request config:', JSON.stringify(requestConfig, null, 2).substring(0, 500));

      const response = await fetch(url, requestConfig);

      debug('SSE', 'Response received:', response.status, response.statusText);

      if (!response.ok) {
        // Try to get error response body for debugging
        let errorBody = '';
        try {
          errorBody = await response.text();
          debug('SSE', 'Error response body:', errorBody.substring(0, 500));
        } catch {
          debug('SSE', 'Could not read error response body');
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      console.info('[SSE] Connected to agent endpoint, streaming events...');
      debug('SSE', 'Response status:', response.status);
      debug('SSE', 'Content-Type:', response.headers.get('content-type'));

      // Process the stream with idle timeout support
      const completionReason = await this.processStream(response.body, onEvent, completeOnRunEnd, idleTimeoutMs);

      console.info(`[SSE] Stream completed: ${completionReason}`);
      debug('SSE', `Stream completed: ${completionReason}`);
      onComplete?.();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          // AbortError after completeOnRunEnd is expected, call onComplete
          debug('SSE', 'Stream aborted (expected after run completion)');
          onComplete?.();
        } else {
          console.error('[SSE] Stream error:', error.message);
          console.error('[SSE] Debug mode is:', isDebugEnabled() ? 'ENABLED ✅' : 'DISABLED ❌');

          // Detailed debug logging with diagnostics
          const errorDetails = {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: (error as any).cause,
            url,
            method,
            headers: headers,
          };
          debug('SSE', 'Error details:', errorDetails);

          // Provide diagnostic hints based on error type
          if (error.message.includes('fetch failed')) {
            debug('SSE', '💡 Diagnostic: "fetch failed" typically means:');
            debug('SSE', '   - Connection refused (endpoint not running)');
            debug('SSE', '   - DNS resolution failed (invalid hostname)');
            debug('SSE', '   - Network unreachable (firewall/VPN issues)');
            debug('SSE', '   - SSL/TLS certificate issues (self-signed cert)');
            debug('SSE', `   Check if ${url} is accessible`);
          } else if (error.message.includes('timeout')) {
            debug('SSE', '💡 Diagnostic: Request timed out - endpoint may be slow or unresponsive');
          } else if (error.message.includes('ENOTFOUND')) {
            debug('SSE', '💡 Diagnostic: DNS lookup failed - hostname not found');
          } else if (error.message.includes('ECONNREFUSED')) {
            debug('SSE', '💡 Diagnostic: Connection refused - service not listening on this port');
          }

          onError?.(error);
        }
      } else {
        console.error('[SSE] Unknown error:', error);
        debug('SSE', 'Unknown error details:', error);
        onError?.(new Error('Unknown error occurred'));
      }
    }
  }

  /**
   * Process the ReadableStream and parse SSE events
   * @returns Reason for stream completion
   */
  private async processStream(
    stream: ReadableStream<Uint8Array>,
    onEvent: (event: AGUIEvent) => void,
    completeOnRunEnd: boolean = false,
    idleTimeoutMs: number = 120000
  ): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastEventTime = Date.now();
    let eventCount = 0;
    let idleCheckInterval: ReturnType<typeof setInterval> | null = null;

    // Set up idle timeout checker
    const idleTimeoutPromise = new Promise<string>((resolve) => {
      idleCheckInterval = setInterval(() => {
        const idleTime = Date.now() - lastEventTime;
        if (eventCount > 0 && idleTime > idleTimeoutMs) {
          debug('SSE', `Idle timeout: no events for ${idleTime}ms (threshold: ${idleTimeoutMs}ms)`);
          this.abort();
          resolve('idle_timeout');
        }
      }, 1000); // Check every second
    });

    try {
      // Race between stream processing and idle timeout
      const streamPromise = (async (): Promise<string> => {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            return 'connection_closed';
          }

          // Update last event time on any data received
          lastEventTime = Date.now();

          // Decode chunk and add to buffer
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE messages
          const lines = buffer.split('\n');

          // Keep the last incomplete line in the buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6); // Remove "data: " prefix

              if (data.trim()) {
                debug('SSE', 'Raw event:', data.substring(0, 200) + (data.length > 200 ? '...' : ''));

                try {
                  const event = JSON.parse(data) as AGUIEvent;
                  debug('SSE', 'Parsed event:', event.type);
                  eventCount++;

                  // Log progress milestone every 10 events
                  if (eventCount % 10 === 0) {
                    console.info(`[SSE] Processed ${eventCount} events...`);
                  }

                  onEvent(event);

                  // Check for run-ending events when completeOnRunEnd is enabled
                  if (completeOnRunEnd && (
                    event.type === AGUIEventType.RUN_FINISHED ||
                    event.type === AGUIEventType.RUN_ERROR
                  )) {
                    debug('SSE', `Received ${event.type}, completing stream`);
                    this.abort();
                    return `event:${event.type}`;
                  }
                } catch (parseError) {
                  console.error('[SSE] Parse error:', parseError);
                  debug('SSE', 'Failed data:', data);
                }
              }
            }
            // Ignore other SSE fields (id:, event:, retry:, comments)
          }
        }
      })();

      const reason = await Promise.race([streamPromise, idleTimeoutPromise]);
      return reason;
    } finally {
      if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
      }
      reader.releaseLock();
    }
  }

  /**
   * Abort the current stream connection
   */
  abort(): void {
    this.abortController?.abort();
  }
}

/**
 * Convenience function for simple SSE consumption
 * Completes when RUN_FINISHED/RUN_ERROR event is received, or when connection closes
 */
export async function consumeSSEStream(
  url: string,
  payload: any,
  onEvent: (event: AGUIEvent) => void,
  headers?: Record<string, string>,
  options?: { idleTimeoutMs?: number }
): Promise<void> {
  const client = new SSEClient();

  return new Promise((resolve, reject) => {
    client.consume({
      url,
      method: 'POST',
      headers,
      body: payload,
      onEvent,
      onError: (error) => reject(error),
      onComplete: () => resolve(),
      // Enable auto-completion on RUN_FINISHED/RUN_ERROR events
      // This prevents hanging when the agent doesn't close the connection
      completeOnRunEnd: true,
      idleTimeoutMs: options?.idleTimeoutMs,
    });
  });
}
