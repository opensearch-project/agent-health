/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionTracesView
 *
 * Fetches and displays all OTel traces for a Claude Code session.
 * Groups spans by traceId, orders traces chronologically,
 * and allows expanding a trace to see its visualization.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Activity, RefreshCw, ChevronRight, ChevronDown, CheckCircle2, XCircle, Clock, Layers } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Span, TraceSummary } from '@/types';
import {
  fetchTracesBySessionId,
  groupSpansByTrace,
  processSpansIntoTree,
  calculateTimeRange,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceVisualization from '@/components/traces/TraceVisualization';

interface SessionTracesViewProps {
  sessionId: string;
}

const SessionTracesView: React.FC<SessionTracesViewProps> = ({ sessionId }) => {
  const [spans, setSpans] = useState<Span[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);

  const loadTraces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTracesBySessionId(sessionId);
      setSpans(result.spans);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch traces');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadTraces();
  }, [loadTraces]);

  const traces = useMemo(() => {
    const groups = groupSpansByTrace(spans);
    // Sort by startTime ascending (chronological turn order)
    return groups.sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
  }, [spans]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={20} className="animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading traces...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={loadTraces}>
          Retry
        </Button>
      </div>
    );
  }

  if (traces.length === 0) {
    return (
      <div className="text-center py-8">
        <Activity size={36} className="mx-auto mb-3 opacity-20" />
        <p className="text-sm text-muted-foreground">No traces found for this session</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Traces may not be available if telemetry is not configured or data hasn&apos;t propagated yet.
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={loadTraces}>
          <RefreshCw size={12} className="mr-1.5" />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted-foreground">
          {traces.length} trace{traces.length !== 1 ? 's' : ''} &middot; {spans.length} total spans
        </span>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={loadTraces}>
          <RefreshCw size={10} className="mr-1" />
          Refresh
        </Button>
      </div>

      {traces.map((trace, idx) => (
        <TraceListEntry
          key={trace.traceId}
          trace={trace}
          turnNumber={idx + 1}
          isExpanded={expandedTraceId === trace.traceId}
          onToggle={() => setExpandedTraceId(
            expandedTraceId === trace.traceId ? null : trace.traceId
          )}
        />
      ))}
    </div>
  );
};

interface TraceListEntryProps {
  trace: TraceSummary;
  turnNumber: number;
  isExpanded: boolean;
  onToggle: () => void;
}

const TraceListEntry: React.FC<TraceListEntryProps> = ({
  trace,
  turnNumber,
  isExpanded,
  onToggle,
}) => {
  const spanTree = useMemo(() => processSpansIntoTree(trace.spans), [trace.spans]);
  const timeRange = useMemo(() => calculateTimeRange(trace.spans), [trace.spans]);

  return (
    <div className="border rounded-md overflow-hidden">
      {/* Trace summary row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown size={14} className="flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="flex-shrink-0 text-muted-foreground" />
        )}

        <span className="text-xs font-medium text-muted-foreground w-6">
          #{turnNumber}
        </span>

        {trace.hasErrors ? (
          <XCircle size={12} className="text-red-700 dark:text-red-400 flex-shrink-0" />
        ) : (
          <CheckCircle2 size={12} className="text-green-700 dark:text-green-400 flex-shrink-0" />
        )}

        <span className="text-sm truncate flex-1" title={trace.rootSpanName}>
          {trace.rootSpanName}
        </span>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Layers size={10} />
            {trace.spanCount}
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock size={10} />
            {formatDuration(trace.duration)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {new Date(trace.startTime).toLocaleTimeString()}
          </span>
        </div>
      </button>

      {/* Expanded trace visualization */}
      {isExpanded && (
        <div className="border-t h-[400px]">
          <TraceVisualization
            spanTree={spanTree}
            timeRange={timeRange}
            initialViewMode="timeline"
            showViewToggle={true}
            showSpanDetailsPanel={true}
            flatSpans={trace.spans}
            serviceName={trace.serviceName}
          />
        </div>
      )}
    </div>
  );
};

export default SessionTracesView;
