/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceVisualization - Shared component for trace visualization
 *
 * Provides unified view switching between Timeline and Flow views.
 * Used by both TracesPage and RunDetailsContent.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Span, TimeRange } from '@/types';
import { Button } from '@/components/ui/button';
import ViewToggle, { ViewMode } from './ViewToggle';
import TraceTimelineChart from './TraceTimelineChart';
import TraceTreeTable from './TraceTreeTable';
import TraceFlowView from './TraceFlowView';
import AgentMapView from './AgentMapView';
import SpanDetailsPanel from './SpanDetailsPanel';
import TraceInfoView from './TraceInfoView';
import TraceStatsView from './TraceStatsView';

interface TraceVisualizationProps {
  spanTree: Span[];
  timeRange: TimeRange;
  initialViewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  showViewToggle?: boolean;
  /** Height for flow container (default: 100%) */
  height?: string;
  /** Show span details panel for timeline mode */
  showSpanDetailsPanel?: boolean;
  /** External selected span control */
  selectedSpan?: Span | null;
  onSelectSpan?: (span: Span | null) => void;
  /** External expanded spans control (for timeline) */
  expandedSpans?: Set<string>;
  onToggleExpand?: (spanId: string) => void;
  /** Optional Run ID to display in info view */
  runId?: string;
}

const TraceVisualization: React.FC<TraceVisualizationProps> = ({
  spanTree,
  timeRange,
  initialViewMode = 'info',
  onViewModeChange,
  showViewToggle = true,
  height = '100%',
  showSpanDetailsPanel = false,
  selectedSpan: externalSelectedSpan,
  onSelectSpan: externalOnSelectSpan,
  expandedSpans: externalExpandedSpans,
  onToggleExpand: externalOnToggleExpand,
  runId,
}) => {
  // Internal state for view mode
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);

  // Internal state for selected span (used if not externally controlled)
  const [internalSelectedSpan, setInternalSelectedSpan] = useState<Span | null>(null);

  // Internal state for expanded spans (used if not externally controlled)
  const [internalExpandedSpans, setInternalExpandedSpans] = useState<Set<string>>(new Set());

  // State for details panel collapse
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);

  // State for resizable divider
  const [timelineWidth, setTimelineWidth] = useState(50); // percentage - default 50%
  const [isResizing, setIsResizing] = useState(false);

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

  // Auto-select first span when switching views or when no span is selected
  useEffect(() => {
    if (spanTree.length > 0 && !selectedSpan) {
      setSelectedSpan(spanTree[0]);
    }
  }, [viewMode, spanTree, selectedSpan, setSelectedSpan]);

  // Sync view mode with external initial value when it changes
  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  // Reset collapsed state when switching views
  useEffect(() => {
    setDetailsCollapsed(false);
  }, [viewMode]);

  // Handle resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const container = document.querySelector('.timeline-container');
      if (!container) return;
      
      const rect = container.getBoundingClientRect();
      const newWidth = ((e.clientX - rect.left) / rect.width) * 100;
      
      // Constrain between 40% and 70% to ensure tree displays nicely
      setTimelineWidth(Math.max(40, Math.min(70, newWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

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
        {viewMode === 'info' ? (
          /* Info view - trace overview and statistics */
          <div className="h-full w-full overflow-auto">
            <TraceInfoView spanTree={spanTree} runId={runId} />
          </div>
        ) : viewMode === 'stats' ? (
          /* Stats view - summary statistics only (left panel from TraceFlowView) */
          <div className="h-full w-full overflow-auto">
            <TraceStatsView spanTree={spanTree} timeRange={timeRange} />
          </div>
        ) : viewMode === 'flow' ? (
          <div className="h-full w-full">
            <TraceFlowView
              spanTree={spanTree}
              timeRange={timeRange}
              selectedSpan={selectedSpan}
              onSelectSpan={setSelectedSpan}
            />
          </div>
        ) : viewMode === 'tree' || viewMode === 'gantt' ? (
          /* Gantt chart timeline view - shown for 'tree' (Timeline button) and 'gantt' modes */
          showSpanDetailsPanel ? (
            <div className="flex h-full w-full min-w-0 overflow-hidden">
              <div 
                className="overflow-auto p-4 min-w-0"
                style={{ 
                  width: detailsCollapsed ? '100%' : '60%'
                }}
              >
                <TraceTimelineChart
                  spanTree={spanTree}
                  timeRange={timeRange}
                  selectedSpan={selectedSpan}
                  onSelectSpan={setSelectedSpan}
                  expandedSpans={expandedSpans}
                  onToggleExpand={handleToggleExpand}
                />
              </div>
              {!detailsCollapsed && selectedSpan ? (
                <div className="w-[400px] border-l shrink-0 overflow-auto">
                  <SpanDetailsPanel
                    span={selectedSpan}
                    onClose={() => setSelectedSpan(null)}
                    onCollapse={() => setDetailsCollapsed(true)}
                  />
                </div>
              ) : detailsCollapsed && selectedSpan ? (
                /* Collapsed state - show expand button */
                <div className="w-12 border-l flex items-start justify-center pt-2 bg-muted/30">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 hover:bg-muted"
                    onClick={() => setDetailsCollapsed(false)}
                    title="Expand details panel"
                  >
                    <PanelRightOpen size={14} />
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="p-4 h-full w-full overflow-auto">
              <TraceTimelineChart
                spanTree={spanTree}
                timeRange={timeRange}
                selectedSpan={selectedSpan}
                onSelectSpan={setSelectedSpan}
                expandedSpans={expandedSpans}
                onToggleExpand={handleToggleExpand}
              />
            </div>
          )
        ) : (viewMode === 'timeline' || viewMode === 'agent-map') && showSpanDetailsPanel ? (
          /* Side-by-side layout for tree table/agent map with details panel */
          <div className="flex h-full timeline-container relative">
            {/* Tree table or Agent Map on left */}
            <div 
              className="overflow-auto p-4 border-r"
              style={{ 
                width: detailsCollapsed ? '100%' : `${timelineWidth}%`
              }}
            >
              {viewMode === 'agent-map' ? (
                <AgentMapView
                  spanTree={spanTree}
                  timeRange={timeRange}
                  selectedSpan={selectedSpan}
                  onSelectSpan={setSelectedSpan}
                />
              ) : (
                <TraceTreeTable
                  spanTree={spanTree}
                  selectedSpan={selectedSpan}
                  onSelect={setSelectedSpan}
                  expandedSpans={expandedSpans}
                  onToggleExpand={handleToggleExpand}
                />
              )}
            </div>
            
            {/* Resizable divider */}
            {!detailsCollapsed && selectedSpan && (
              <div
                onMouseDown={handleMouseDown}
                className="absolute top-0 bottom-0 w-1 cursor-ew-resize hover:bg-opensearch-blue/50 active:bg-opensearch-blue transition-colors z-10"
                style={{
                  left: `${timelineWidth}%`,
                  background: isResizing ? 'hsl(var(--primary))' : 'transparent',
                }}
              >
                <div className="absolute left-0 top-0 bottom-0 w-4 -translate-x-1.5" />
              </div>
            )}
            
            {/* Details panel on right */}
            {!detailsCollapsed && selectedSpan ? (
              <div 
                className="overflow-auto relative"
                style={{ width: `${100 - timelineWidth}%` }}
              >
                <SpanDetailsPanel
                  span={selectedSpan}
                  onClose={() => setSelectedSpan(null)}
                  onCollapse={() => setDetailsCollapsed(true)}
                />
              </div>
            ) : detailsCollapsed && selectedSpan ? (
              /* Collapsed state - show expand button */
              <div className="w-12 border-l flex items-start justify-center pt-2 bg-muted/30">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-muted"
                  onClick={() => setDetailsCollapsed(false)}
                  title="Expand details panel"
                >
                  <PanelRightOpen size={14} />
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          /* Full width tree table or agent map without details panel */
          <div className="p-4 h-full overflow-auto">
            {viewMode === 'agent-map' ? (
              <AgentMapView
                spanTree={spanTree}
                timeRange={timeRange}
                selectedSpan={selectedSpan}
                onSelectSpan={setSelectedSpan}
              />
            ) : (
              <TraceTreeTable
                spanTree={spanTree}
                selectedSpan={selectedSpan}
                onSelect={setSelectedSpan}
                expandedSpans={expandedSpans}
                onToggleExpand={handleToggleExpand}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TraceVisualization;
