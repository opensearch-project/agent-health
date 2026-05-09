/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for the AI assistant chat feature.
 *
 * Consumes the /api/assistant/* endpoints, following the same SSE streaming
 * pattern used by evaluationApi.ts.
 */

import type { AssistantContext } from '@/types';
import { debug } from '@/lib/debug';

/**
 * Stream a chat message to the assistant and receive incremental responses via SSE.
 *
 * @param sessionId - Stable session identifier for conversation continuity
 * @param message - The user's message text
 * @param context - Page context (current URL, benchmark/run/trace IDs)
 * @param onChunk - Callback invoked for each streamed content delta
 * @returns The full assembled response text
 */
export async function streamAssistantChat(
  sessionId: string,
  message: string,
  context: AssistantContext,
  onChunk: (content: string) => void
): Promise<string> {
  debug('AssistantAPI', 'Streaming chat:', { sessionId, message: message.slice(0, 50) });

  const response = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, context }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorBody.error || `Assistant chat request failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Append new chunk to buffer
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const events = buffer.split('\n\n');

    // Keep the last potentially incomplete event in the buffer
    buffer = events.pop() || '';

    // Process complete events
    for (const event of events) {
      const result = parseAssistantSSEEvent(event, onChunk);
      if (result !== null) {
        fullResponse = result;
      }
    }
  }

  // Process any remaining buffer content
  if (buffer.trim()) {
    const result = parseAssistantSSEEvent(buffer, onChunk);
    if (result !== null) {
      fullResponse = result;
    }
  }

  if (fullResponse === null) {
    throw new Error('Assistant stream completed without returning a full response');
  }

  debug('AssistantAPI', 'Chat completed, response length:', fullResponse.length);
  return fullResponse;
}

/**
 * Parse a single SSE event and dispatch to appropriate handler.
 * Returns the full response string on 'done' events, null otherwise.
 */
function parseAssistantSSEEvent(
  event: string,
  onChunk: (content: string) => void
): string | null {
  const lines = event.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));

        if (data.type === 'delta') {
          onChunk(data.content);
        } else if (data.type === 'done') {
          debug('AssistantAPI', 'Stream done');
          return data.fullResponse;
        } else if (data.type === 'error') {
          throw new Error(data.error);
        }
      } catch (e) {
        // Rethrow application errors, ignore JSON parse errors for incomplete chunks
        if (e instanceof Error && !(e instanceof SyntaxError)) {
          throw e;
        }
      }
    }
  }
  return null;
}

/**
 * Clear an assistant session's conversation history.
 *
 * @param sessionId - The session to clear
 */
export async function clearAssistantSession(sessionId: string): Promise<void> {
  debug('AssistantAPI', 'Clearing session:', sessionId);

  const response = await fetch(`/api/assistant/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorBody.error || `Failed to clear assistant session: ${response.statusText}`);
  }
}

/**
 * Check if the assistant backend is available and which provider is configured.
 *
 * @returns Health status with availability flag and provider name
 */
export async function checkAssistantHealth(): Promise<{ available: boolean; provider: string }> {
  debug('AssistantAPI', 'Checking assistant health');

  const response = await fetch('/api/assistant/health');

  if (!response.ok) {
    return { available: false, provider: 'unknown' };
  }

  return response.json();
}
