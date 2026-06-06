/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useLocalRuntime, type ChatModelAdapter } from '@assistant-ui/react';
import { streamAssistantChat } from '@/services/client/assistantApi';
import type { AssistantContext } from '@/types';

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
  //
  // Routes we recognize:
  //   /benchmarks/:benchmarkId       → benchmarkId
  //   /runs/:runId                   → runId
  //   /traces/:traceId               → traceId
  //   /test-cases/:testCaseId        → testCaseId
  //   /compare/:benchmarkId?runs=a,b → benchmarkId + comparisonRunIds
  const context = useMemo((): AssistantContext => {
    const path = location.pathname;
    const parts = path.split('/');
    const search = new URLSearchParams(location.search);

    // /compare/:benchmarkId carries the benchmark id in the URL too — the
    // original parser only looked for the literal "benchmarks" segment, which
    // meant the assistant got an empty context on the comparison page.
    const benchmarkFromCompare =
      parts.includes('compare') && parts.indexOf('compare') + 1 < parts.length
        ? parts[parts.indexOf('compare') + 1]
        : undefined;

    const runsParam = search.get('runs');
    const comparisonRunIds = runsParam
      ? runsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    return {
      currentUrl: path + (location.search || ''),
      benchmarkId: parts.includes('benchmarks')
        ? parts[parts.indexOf('benchmarks') + 1]
        : benchmarkFromCompare,
      runId: parts.includes('runs')
        ? parts[parts.indexOf('runs') + 1]
        : undefined,
      traceId: parts.includes('traces')
        ? parts[parts.indexOf('traces') + 1]
        : undefined,
      testCaseId: parts.includes('test-cases')
        ? parts[parts.indexOf('test-cases') + 1]
        : undefined,
      comparisonRunIds: comparisonRunIds && comparisonRunIds.length > 0
        ? comparisonRunIds
        : undefined,
    };
  }, [location.pathname, location.search]);

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
