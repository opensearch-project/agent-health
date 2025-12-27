/**
 * TraceVisualization - Shared component for trace visualization
 *
 * Provides unified view switching between Timeline, Flow, and Intent views.
 * Used by both TracesPage and RunDetailsContent.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Span, TimeRange } from '@/types';
import ViewToggle, { ViewMode } from './ViewToggle';
import TraceTimelineChart from './TraceTimelineChart';
import TraceFlowView from './TraceFlowView';
import TraceIntentView from './TraceIntentView';
import SpanDetailsPanel from './SpanDetailsPanel';

interface TraceVisualizationProps {
  spanTree: Span[];
  timeRange: TimeRange;
  initialViewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  showViewToggle?: boolean;
  /** Height for flow/intent container (default: 100%) */
  height?: string;
  /** Show span details panel for timeline mode */
  showSpanDetailsPanel?: boolean;
  /** External selected span control */
  selectedSpan?: Span | null;
  onSelectSpan?: (span: Span | null) => void;
  /** External expanded spans control (for timeline) */
  expandedSpans?: Set<string>;
  onToggleExpand?: (spanId: string) => void;
}

const TraceVisualization: React.FC<TraceVisualizationProps> = ({
  spanTree,
  timeRange,
  initialViewMode = 'timeline',
  onViewModeChange,
  showViewToggle = true,
  height = '100%',
  showSpanDetailsPanel = false,
  selectedSpan: externalSelectedSpan,
  onSelectSpan: externalOnSelectSpan,
  expandedSpans: externalExpandedSpans,
  onToggleExpand: externalOnToggleExpand,
}) => {
  // Internal state for view mode
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);

  // Internal state for selected span (used if not externally controlled)
  const [internalSelectedSpan, setInternalSelectedSpan] = useState<Span | null>(null);

  // Internal state for expanded spans (used if not externally controlled)
  const [internalExpandedSpans, setInternalExpandedSpans] = useState<Set<string>>(new Set());

  // Use external or internal state
  const selectedSpan = externalSelectedSpan !== undefined ? externalSelectedSpan : internalSelectedSpan;
  const setSelectedSpan = externalOnSelectSpan || setInternalSelectedSpan;
  const expandedSpans = externalExpandedSpans !== undefined ? externalExpandedSpans : internalExpandedSpans;

  // Handle view mode change
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  // Handle expand toggle
  const handleToggleExpand = useCallback((spanId: string) => {
    if (externalOnToggleExpand) {
      externalOnToggleExpand(spanId);
    } else {
      setInternalExpandedSpans(prev => {
        const newSet = new Set(prev);
        if (newSet.has(spanId)) {
          newSet.delete(spanId);
        } else {
          newSet.add(spanId);
        }
        return newSet;
      });
    }
  }, [externalOnToggleExpand]);

  // Auto-expand root spans when span tree changes (for timeline)
  useEffect(() => {
    if (!externalExpandedSpans && spanTree.length > 0) {
      const rootIds = new Set(spanTree.map(s => s.spanId));
      setInternalExpandedSpans(prev => {
        const newSet = new Set(prev);
        rootIds.forEach(id => newSet.add(id));
        return newSet;
      });
    }
  }, [spanTree, externalExpandedSpans]);

  // Sync view mode with external initial value when it changes
  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  if (spanTree.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No spans to display
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* View Toggle */}
      {showViewToggle && (
        <div className="flex justify-end p-2 border-b">
          <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
        </div>
      )}

      {/* View Content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'intent' ? (
          <TraceIntentView
            spanTree={spanTree}
            timeRange={timeRange}
          />
        ) : viewMode === 'flow' ? (
          <div style={{ height }} className="w-full">
            <TraceFlowView
              spanTree={spanTree}
              timeRange={timeRange}
              selectedSpan={selectedSpan}
              onSelectSpan={setSelectedSpan}
            />
          </div>
        ) : (
          <div className="p-4 h-full overflow-auto">
            <TraceTimelineChart
              spanTree={spanTree}
              timeRange={timeRange}
              selectedSpan={selectedSpan}
              onSelect={setSelectedSpan}
              expandedSpans={expandedSpans}
              onToggleExpand={handleToggleExpand}
            />
          </div>
        )}
      </div>

      {/* Span Details Panel (for timeline mode when enabled) */}
      {showSpanDetailsPanel && viewMode === 'timeline' && selectedSpan && (
        <div className="border-t">
          <SpanDetailsPanel
            span={selectedSpan}
            onClose={() => setSelectedSpan(null)}
          />
        </div>
      )}
    </div>
  );
};

export default TraceVisualization;
