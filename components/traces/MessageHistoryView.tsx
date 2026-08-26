/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MessageHistoryView
 *
 * Chat-style message list extracted from OTel spans.
 * Displays user prompts, assistant responses, tool calls, and tool results
 * in chronological order.
 */

import React, { useState, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { Span, ConversationMessage } from '@/types';
import { extractMessagesFromSpans } from '@/services/traces/messageExtraction';

interface MessageHistoryViewProps {
  spans: Span[];
  serviceName?: string;
}

const MAX_COLLAPSED_LENGTH = 500;

const MessageHistoryView: React.FC<MessageHistoryViewProps> = ({ spans, serviceName }) => {
  const messages = useMemo(
    () => extractMessagesFromSpans(spans, serviceName),
    [spans, serviceName]
  );

  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (messages.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
        <Info size={36} className="mb-3 opacity-20" />
        <p className="text-sm font-medium">No message content available</p>
        <p className="text-xs mt-2 text-center max-w-sm">
          Prompt &amp; response capture is controlled by OTEL_LOG_USER_PROMPTS
          (on by default for Claude Code). If messages are missing, it may be
          disabled in the agent&apos;s environment &mdash; re-enable with:
        </p>
        <code className="text-xs mt-1 px-2 py-1 rounded bg-muted font-mono">
          export OTEL_LOG_USER_PROMPTS=1
        </code>
      </div>
    );
  }

  // Aggregate token/cost summary
  const summary = useMemo(() => {
    let totalInput = 0;
    let totalOutput = 0;
    const models = new Set<string>();
    for (const msg of messages) {
      if (msg.metadata?.inputTokens) totalInput += msg.metadata.inputTokens;
      if (msg.metadata?.outputTokens) totalOutput += msg.metadata.outputTokens;
      if (msg.metadata?.model) models.add(msg.metadata.model);
    }
    return { totalInput, totalOutput, models: Array.from(models) };
  }, [messages]);

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        {/* Summary bar */}
        {(summary.totalInput > 0 || summary.totalOutput > 0) && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground pb-2 border-b">
            <span>{messages.length} messages</span>
            {summary.totalInput > 0 && (
              <>
                <span className="text-muted-foreground/50">|</span>
                <span>{summary.totalInput.toLocaleString()} input tokens</span>
              </>
            )}
            {summary.totalOutput > 0 && (
              <>
                <span className="text-muted-foreground/50">|</span>
                <span>{summary.totalOutput.toLocaleString()} output tokens</span>
              </>
            )}
            {summary.models.length > 0 && (
              <>
                <span className="text-muted-foreground/50">|</span>
                <span>{summary.models.join(', ')}</span>
              </>
            )}
          </div>
        )}

        {/* Messages */}
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isExpanded={expandedMessages.has(msg.id)}
            onToggleExpand={() => toggleExpand(msg.id)}
          />
        ))}
      </div>
    </ScrollArea>
  );
};

interface MessageBubbleProps {
  message: ConversationMessage;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isExpanded, onToggleExpand }) => {
  const { role, content, metadata, timestamp } = message;
  const isLong = content.length > MAX_COLLAPSED_LENGTH;
  const displayContent = isLong && !isExpanded
    ? content.slice(0, MAX_COLLAPSED_LENGTH) + '...'
    : content;

  const roleConfig = getRoleConfig(role);

  return (
    <div className={`rounded-md p-3 text-sm ${roleConfig.bg} border ${roleConfig.border}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs font-medium uppercase ${roleConfig.label}`}>
          {roleConfig.displayName}
        </span>
        {metadata?.toolName && (
          <Badge variant="secondary" className="text-xs py-0 px-1.5">
            {metadata.toolName}
          </Badge>
        )}
        {metadata?.model && (
          <span className="text-[10px] text-muted-foreground font-mono">{metadata.model}</span>
        )}
        {metadata?.inputTokens != null && metadata?.outputTokens != null && (
          <span className="text-[10px] text-muted-foreground">
            {metadata.inputTokens}→{metadata.outputTokens} tokens
          </span>
        )}
        {metadata?.durationMs != null && (
          <span className="text-[10px] text-muted-foreground">
            {metadata.durationMs > 1000
              ? `${(metadata.durationMs / 1000).toFixed(1)}s`
              : `${metadata.durationMs}ms`}
          </span>
        )}
        {timestamp && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {new Date(timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Content */}
      <pre className="whitespace-pre-wrap text-xs font-mono break-all">
        {displayContent}
      </pre>

      {/* Expand/collapse toggle for long content */}
      {isLong && (
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1"
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {isExpanded ? 'Show less' : `Show all (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
};

function getRoleConfig(role: ConversationMessage['role']) {
  switch (role) {
    case 'user':
      return {
        displayName: 'User',
        bg: 'bg-blue-50 dark:bg-blue-950/30',
        border: 'border-blue-200 dark:border-blue-800',
        label: 'text-blue-700 dark:text-blue-400',
      };
    case 'assistant':
      return {
        displayName: 'Assistant',
        bg: 'bg-muted/50',
        border: 'border-border',
        label: 'text-muted-foreground',
      };
    case 'tool_call':
      return {
        displayName: 'Tool Call',
        bg: 'bg-amber-50 dark:bg-amber-950/20',
        border: 'border-amber-200 dark:border-amber-800/50',
        label: 'text-amber-700 dark:text-amber-400',
      };
    case 'tool_result':
      return {
        displayName: 'Tool Result',
        bg: 'bg-gray-50 dark:bg-gray-900/30',
        border: 'border-gray-200 dark:border-gray-700',
        label: 'text-gray-600 dark:text-gray-400',
      };
    case 'system':
      return {
        displayName: 'System',
        bg: 'bg-purple-50 dark:bg-purple-950/20',
        border: 'border-purple-200 dark:border-purple-800/50',
        label: 'text-purple-700 dark:text-purple-400',
      };
  }
}

export default MessageHistoryView;
