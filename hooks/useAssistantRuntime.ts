/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useLocalRuntime, type ChatModelAdapter } from '@assistant-ui/react';
import { streamAssistantChat } from '@/services/client/assistantApi';
import type { AssistantContext } from '@/types';
import { deriveAssistantContext } from '@/hooks/assistantContext';

/**
 * Hook that provides an assistant-ui runtime backed by the Agent Health
 * assistant backend. Derives page context from the current URL and streams
 * responses through the SSE chat endpoint.
 */
export function useAssistantRuntime() {
  const location = useLocation();

  // Stable session ID for the lifetime of this hook instance
  const sessionIdRef = useRef(
    `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  // Derive assistant context from the current URL path + query string.
  const context = useMemo(
    (): AssistantContext => deriveAssistantContext(location.pathname, location.search),
    [location.pathname, location.search]
  );

  const adapter: ChatModelAdapter = useMemo(
    () => ({
      async *run({ messages }) {
        // Extract the text from the last user message
        const lastMessage = messages[messages.length - 1];
        const userMessage = lastMessage.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('');

        // Queue-based bridging: streamAssistantChat uses callbacks, but the
        // ChatModelAdapter expects an async generator that yields incremental updates.
        const queue: string[] = [];
        let done = false;
        let streamError: Error | null = null;
        let resolve: () => void = () => {};

        const waitForChunk = () =>
          new Promise<void>((r) => {
            resolve = r;
          });

        const streamPromise = streamAssistantChat(
          sessionIdRef.current,
          userMessage,
          context,
          (chunk) => {
            queue.push(chunk);
            resolve();
          }
        )
          .then(() => {
            done = true;
            resolve();
          })
          .catch((e) => {
            streamError = e instanceof Error ? e : new Error(String(e));
            done = true;
            resolve();
          });

        let fullText = '';
        while (!done || queue.length > 0) {
          if (queue.length === 0 && !done) {
            await waitForChunk();
          }
          while (queue.length > 0) {
            fullText += queue.shift()!;
            yield {
              content: [{ type: 'text' as const, text: fullText }],
            };
          }
        }

        // Ensure the stream promise is fully settled
        await streamPromise;

        if (streamError) {
          throw streamError;
        }
      },
    }),
    [context]
  );

  return useLocalRuntime(adapter);
}
