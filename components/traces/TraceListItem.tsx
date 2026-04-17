/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceListItem Component
 *
 * Displays a single trace in the trace list sidebar.
 * Shows service name, span count, duration, and error status.
 */

import React from 'react';
import { AlertCircle, Layers, Clock, ClipboardCheck } from 'lucide-react';
import { TraceSummary } from '@/types';
import { formatDuration } from '@/services/traces/utils';
import { cn } from '@/lib/utils';

interface TraceListItemProps {
  trace: TraceSummary;
  isSelected: boolean;
  onClick: () => void;
}

/**
 * Format time as HH:MM:SS
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export const TraceListItem: React.FC<TraceListItemProps> = ({
  trace,
  isSelected,
  onClick,
}) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors',
        'hover:bg-muted/50 focus:outline-none focus:bg-muted/50',
        isSelected && 'bg-muted border-l-2 border-l-opensearch-blue'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {/* Service/Root Span Name */}
          <div className="flex items-center gap-1.5">
            {trace.hasErrors && (
              <AlertCircle size={12} className="text-red-500 flex-shrink-0" />
            )}
            <span
              className={cn(
                'text-sm font-medium truncate',
                trace.hasErrors && 'text-red-600 dark:text-red-400'
              )}
            >
              {trace.rootSpanName}
            </span>
            {trace.hasEvalSpans && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex-shrink-0">
                <ClipboardCheck size={9} />
                Eval
              </span>
            )}
          </div>

          {/* Service Name */}
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {trace.serviceName}
          </div>

          {/* Stats Row */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Layers size={10} />
              {trace.spanCount} span{trace.spanCount !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatDuration(trace.duration)}
            </span>
          </div>
        </div>

        {/* Timestamp */}
        <div className="text-[10px] text-muted-foreground whitespace-nowrap">
          {formatTime(trace.startTime)}
        </div>
      </div>
    </button>
  );
};

export default TraceListItem;
