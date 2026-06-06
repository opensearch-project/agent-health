/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceSummaryStrip
 *
 * Compact one-line summary of a trace: category breakdown, error count,
 * token usage, model name(s). Used by both the inline-expansion header
 * row on the Agent Traces list and the fullscreen header so the user
 * keeps the same context when going from inline to fullscreen.
 *
 * Only non-zero buckets render; if the trace has no headline signal
 * (no LLM/tool/agent/eval span, no errors, no tokens, no model) the
 * caller is expected to render its own placeholder.
 */

import React from 'react';
import { TraceSummary } from '@/services/traces';
import { formatCompact } from '@/services/traces/utils';
import { cn } from '@/lib/utils';

interface TraceSummaryStripProps {
  summary: TraceSummary;
  /** Tailwind className overrides on the outer flex container. Defaults
      to the inline-strip styling (`text-[10px] text-muted-foreground`).
      Pass a larger size class for fullscreen. */
  className?: string;
  /** Tailwind className for the foreground value chips. Defaults to
      `text-foreground font-medium` which works on both contexts. */
  valueClassName?: string;
}

export const TraceSummaryStrip: React.FC<TraceSummaryStripProps> = ({
  summary,
  className,
  valueClassName = 'text-foreground font-medium',
}) => {
  const parts: React.ReactNode[] = [];

  if (summary.llm > 0) {
    parts.push(
      <span key="llm">
        <span className={valueClassName}>{summary.llm}</span> LLM
      </span>
    );
  }
  if (summary.tool > 0) {
    parts.push(
      <span key="tool">
        <span className={valueClassName}>{summary.tool}</span> tool
      </span>
    );
  }
  if (summary.agent > 0) {
    parts.push(
      <span key="agent">
        <span className={valueClassName}>{summary.agent}</span> agent
      </span>
    );
  }
  if (summary.evalCount > 0) {
    parts.push(
      <span key="eval">
        <span className={valueClassName}>{summary.evalCount}</span> eval
      </span>
    );
  }
  if (summary.errors > 0) {
    parts.push(
      <span
        key="errors"
        className="text-red-500 font-medium"
        title={`${summary.errors} span${summary.errors === 1 ? '' : 's'} ended in ERROR`}
      >
        ● {summary.errors} error{summary.errors === 1 ? '' : 's'}
      </span>
    );
  }
  if (summary.totalTokens > 0) {
    parts.push(
      <span
        key="tokens"
        title={`Input: ${summary.inputTokens.toLocaleString()} tokens — Output: ${summary.outputTokens.toLocaleString()} tokens`}
      >
        <span className={valueClassName}>{formatCompact(summary.totalTokens)}</span> tok
      </span>
    );
  }
  if (summary.models.length > 0) {
    parts.push(
      <span
        key="models"
        className={cn(valueClassName, 'font-mono truncate max-w-[260px]')}
        title={summary.models.join(', ')}
      >
        {summary.models.join(', ')}
      </span>
    );
  }

  if (parts.length === 0) {
    return (
      <div className={cn('flex items-center gap-2 text-[10px] text-muted-foreground italic', className)}>
        no summary attributes available
      </div>
    );
  }

  // Interleave with separator dots.
  const interleaved: React.ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) interleaved.push(<span key={`sep-${i}`}>·</span>);
    interleaved.push(p);
  });

  return (
    <div
      className={cn('flex items-center gap-2 text-[10px] text-muted-foreground min-w-0 flex-wrap', className)}
    >
      {interleaved}
    </div>
  );
};

export default TraceSummaryStrip;
