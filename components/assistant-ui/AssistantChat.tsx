/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
} from '@assistant-ui/react';

/**
 * Full-page AI assistant chat interface.
 * Renders at /assistant route with welcome screen and suggested prompts.
 */
export const AssistantChat: React.FC = () => {
  return (
    <div className="flex flex-col h-full" data-testid="assistant-chat-page">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-xl font-semibold">AI Assistant</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ask questions about benchmarks, test cases, traces, and agent performance.
        </p>
      </div>

      {/* Thread */}
      <ThreadPrimitive.Root className="flex-1 flex flex-col overflow-hidden">
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6">
            <ThreadPrimitive.Empty>
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="mb-6">
                  <div className="size-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 mx-auto">
                    <span className="text-2xl">🤖</span>
                  </div>
                  <h2 className="text-lg font-semibold mb-2">How can I help?</h2>
                  <p className="text-sm text-muted-foreground max-w-md">
                    I can help you understand evaluation results, configure agents, interpret trajectories, and improve agent performance.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
                  <ThreadPrimitive.Suggestion
                    prompt="Explain this benchmark's results"
                    method="replace"
                    autoSend
                  >
                    <button className="text-sm px-4 py-3 rounded-lg border hover:bg-accent text-left transition-colors">
                      <span className="font-medium block">Benchmark Results</span>
                      <span className="text-xs text-muted-foreground">Explain pass rates and failures</span>
                    </button>
                  </ThreadPrimitive.Suggestion>

                  <ThreadPrimitive.Suggestion
                    prompt="Help me write a test case for testing log search with time filters"
                    method="replace"
                    autoSend
                  >
                    <button className="text-sm px-4 py-3 rounded-lg border hover:bg-accent text-left transition-colors">
                      <span className="font-medium block">Write a Test Case</span>
                      <span className="text-xs text-muted-foreground">Create evaluation scenarios</span>
                    </button>
                  </ThreadPrimitive.Suggestion>

                  <ThreadPrimitive.Suggestion
                    prompt="What do these traces mean? How can I identify bottlenecks?"
                    method="replace"
                    autoSend
                  >
                    <button className="text-sm px-4 py-3 rounded-lg border hover:bg-accent text-left transition-colors">
                      <span className="font-medium block">Analyze Traces</span>
                      <span className="text-xs text-muted-foreground">Understand agent execution</span>
                    </button>
                  </ThreadPrimitive.Suggestion>

                  <ThreadPrimitive.Suggestion
                    prompt="How do I improve my agent's pass rate? What are common failure patterns?"
                    method="replace"
                    autoSend
                  >
                    <button className="text-sm px-4 py-3 rounded-lg border hover:bg-accent text-left transition-colors">
                      <span className="font-medium block">Improve Agent</span>
                      <span className="text-xs text-muted-foreground">Fix failures and boost accuracy</span>
                    </button>
                  </ThreadPrimitive.Suggestion>
                </div>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages
              components={{
                UserMessage: () => (
                  <MessagePrimitive.Root className="flex justify-end mb-4">
                    <div className="max-w-[70%] rounded-lg bg-primary text-primary-foreground px-4 py-3 text-sm">
                      <MessagePrimitive.Content />
                    </div>
                  </MessagePrimitive.Root>
                ),
                AssistantMessage: () => (
                  <MessagePrimitive.Root className="flex justify-start mb-4">
                    <div className="max-w-[70%] rounded-lg bg-muted px-4 py-3 text-sm prose prose-sm dark:prose-invert max-w-none">
                      <MessagePrimitive.Content />
                    </div>
                  </MessagePrimitive.Root>
                ),
              }}
            />
          </div>

          <ThreadPrimitive.ScrollToBottom asChild>
            <button className="fixed bottom-24 right-8 size-10 rounded-full border bg-background shadow-md flex items-center justify-center hover:bg-accent transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.Viewport>

        {/* Composer */}
        <div className="border-t">
          <div className="max-w-3xl mx-auto px-6 py-4">
            <ComposerPrimitive.Root className="flex items-end gap-3">
              <ComposerPrimitive.Input
                placeholder="Type your message..."
                className="flex-1 resize-none border rounded-lg px-4 py-3 text-sm min-h-[44px] max-h-[200px] bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                data-testid="assistant-chat-input"
              />
              <ComposerPrimitive.Send asChild>
                <button
                  className="size-11 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0"
                  data-testid="assistant-chat-send"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13" />
                  </svg>
                </button>
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </div>
        </div>
      </ThreadPrimitive.Root>
    </div>
  );
};
