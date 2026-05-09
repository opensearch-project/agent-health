/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  AssistantModalPrimitive,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
} from '@assistant-ui/react';

/**
 * Floating "?" button that opens a compact chat modal.
 * Uses AssistantModalPrimitive from @assistant-ui/react.
 * Renders on every page via Layout.tsx.
 */
export const AssistantModal: React.FC = () => {
  return (
    <AssistantModalPrimitive.Root>
      <AssistantModalPrimitive.Anchor className="fixed right-4 bottom-4 z-50">
        <AssistantModalPrimitive.Trigger asChild>
          <button
            className="size-11 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 flex items-center justify-center transition-colors"
            aria-label="Open AI Assistant"
            data-testid="assistant-modal-trigger"
          >
            <span className="text-lg font-bold">?</span>
          </button>
        </AssistantModalPrimitive.Trigger>
      </AssistantModalPrimitive.Anchor>

      <AssistantModalPrimitive.Content
        className="z-50 h-[500px] w-[400px] rounded-xl border bg-background shadow-2xl flex flex-col overflow-hidden max-sm:h-dvh max-sm:w-dvw max-sm:rounded-none"
        sideOffset={16}
        data-testid="assistant-modal-content"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">AI Assistant</h3>
        </div>

        {/* Thread */}
        <ThreadPrimitive.Root className="flex-1 flex flex-col overflow-hidden">
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-3">
            <ThreadPrimitive.Empty>
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <p className="text-sm text-muted-foreground mb-4">
                  Ask me about benchmarks, test cases, traces, or how to improve your agent.
                </p>
                <div className="flex flex-col gap-2 w-full">
                  <ThreadPrimitive.Suggestion
                    prompt="Explain this benchmark's results"
                    method="replace"
                    autoSend
                  >
                    <button className="text-xs px-3 py-2 rounded-md border hover:bg-accent text-left transition-colors">
                      Explain this benchmark's results
                    </button>
                  </ThreadPrimitive.Suggestion>
                  <ThreadPrimitive.Suggestion
                    prompt="Help me write a test case"
                    method="replace"
                    autoSend
                  >
                    <button className="text-xs px-3 py-2 rounded-md border hover:bg-accent text-left transition-colors">
                      Help me write a test case
                    </button>
                  </ThreadPrimitive.Suggestion>
                  <ThreadPrimitive.Suggestion
                    prompt="What do these traces mean?"
                    method="replace"
                    autoSend
                  >
                    <button className="text-xs px-3 py-2 rounded-md border hover:bg-accent text-left transition-colors">
                      What do these traces mean?
                    </button>
                  </ThreadPrimitive.Suggestion>
                </div>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages
              components={{
                UserMessage: () => (
                  <MessagePrimitive.Root className="flex justify-end mb-3">
                    <div className="max-w-[80%] rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm">
                      <MessagePrimitive.Content />
                    </div>
                  </MessagePrimitive.Root>
                ),
                AssistantMessage: () => (
                  <MessagePrimitive.Root className="flex justify-start mb-3">
                    <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm">
                      <MessagePrimitive.Content />
                    </div>
                  </MessagePrimitive.Root>
                ),
              }}
            />
          </ThreadPrimitive.Viewport>

          {/* Composer */}
          <div className="border-t px-3 py-2">
            <ComposerPrimitive.Root className="flex items-end gap-2">
              <ComposerPrimitive.Input
                placeholder="Ask a question..."
                className="flex-1 resize-none border rounded-md px-3 py-2 text-sm min-h-[36px] max-h-[120px] bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="assistant-modal-input"
              />
              <ComposerPrimitive.Send asChild>
                <button
                  className="size-9 rounded-md bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0"
                  data-testid="assistant-modal-send"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13" />
                  </svg>
                </button>
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
};
