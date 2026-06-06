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
import { useAssistantSuggestions } from '@/hooks/useAssistantSuggestions';

/**
 * Floating sparkle trigger that opens a compact chat modal.
 * Uses AssistantModalPrimitive from @assistant-ui/react.
 * Renders on every page via Layout.tsx.
 *
 * Discoverability:
 * - Sparkle icon ✨ (universally read as "AI") instead of a generic "?".
 * - Pulse-once animation on first paint draws the eye without becoming
 *   a nag.
 * - On routes with a clear "moment" (failed run, traces page, etc.) we
 *   surface a one-time nudge tooltip — sessionStorage-deduped so it
 *   doesn't repeat in the same session.
 *
 * Suggestions are derived from the current route via
 * `useAssistantSuggestions`, so the prompts visible inside the modal
 * actually match the page the user is on.
 */
export const AssistantModal: React.FC = () => {
  const { suggestions, nudge, dismissNudge } = useAssistantSuggestions();

  return (
    <AssistantModalPrimitive.Root>
      <AssistantModalPrimitive.Anchor className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
        {nudge ? (
          <button
            type="button"
            onClick={dismissNudge}
            className="max-w-[260px] rounded-lg border bg-background px-3 py-2 text-xs shadow-md hover:bg-accent transition-colors flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
            data-testid="assistant-modal-nudge"
          >
            <span aria-hidden="true">✨</span>
            <span className="text-left">{nudge}</span>
            <span className="text-muted-foreground" aria-hidden="true">×</span>
          </button>
        ) : null}

        <AssistantModalPrimitive.Trigger asChild>
          <button
            className="group relative size-12 rounded-full bg-transparent text-foreground hover:bg-accent/40 active:scale-95 transition-all flex items-center justify-center"
            aria-label="Open AI Assistant"
            data-testid="assistant-modal-trigger"
            onClick={() => { if (nudge) dismissNudge(); }}
          >
            {/* Subtle pulse ring on first paint — uses the foreground color so it
                stays consistent with the dark sparkle icon. */}
            <span
              className="absolute inset-0 rounded-full bg-foreground/20 opacity-0 motion-safe:animate-ping motion-safe:[animation-iteration-count:1] motion-safe:[animation-duration:1.5s]"
              aria-hidden="true"
            />
            <SparkleIcon className="size-6 text-foreground motion-safe:group-hover:rotate-12 transition-transform" />
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
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <SparkleIcon className="size-4 text-foreground" />
            AI Assistant
          </h3>
        </div>

        {/* Thread */}
        <ThreadPrimitive.Root className="flex-1 flex flex-col overflow-hidden">
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-3">
            <ThreadPrimitive.Empty>
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <p className="text-sm text-muted-foreground mb-4">
                  Ask about benchmarks, test cases, traces, or how to improve your agent.
                </p>
                <div className="flex flex-col gap-2 w-full" data-testid="assistant-modal-suggestions">
                  {suggestions.map((prompt, i) => (
                    <ThreadPrimitive.Suggestion
                      key={`${prompt}-${i}`}
                      prompt={prompt}
                      method="replace"
                      autoSend
                    >
                      <button className="text-xs px-3 py-2 rounded-md border hover:bg-accent text-left transition-colors">
                        {prompt}
                      </button>
                    </ThreadPrimitive.Suggestion>
                  ))}
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

const SparkleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6 12 3z" />
    <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
    <path d="M5 14l.7 1.6L7.3 16.3 5.7 17l-.7 1.6L4.3 17 2.7 16.3 4.3 15.6 5 14z" />
  </svg>
);
