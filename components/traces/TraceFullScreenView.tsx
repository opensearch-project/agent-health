/**
 * TraceFullScreenView
 *
 * Fullscreen modal for trace visualization.
 * Supports single trace mode (timeline/flow) and comparison mode (side-by-side/merged).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Minimize2 } from 'lucide-react';
import {
  FullScreenDialog,
  FullScreenDialogContent,
  FullScreenDialogHeader,
  FullScreenDialogTitle,
  FullScreenDialogCloseButton,
} from '@/components/ui/fullscreen-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Span, TimeRange, CategorizedSpan } from '@/types';
import TraceFlowView from './TraceFlowView';
import TraceTimelineChart from './TraceTimelineChart';
import SpanDetailsPanel from './SpanDetailsPanel';
import ViewToggle, { ViewMode } from './ViewToggle';

interface TraceFullScreenViewProps {
  /** Whether the fullscreen dialog is open */
  open: boolean;
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Title to display in header */
  title?: string;
  /** Subtitle/description */
  subtitle?: string;
  /** The span tree to display */
  spanTree: Span[];
  /** Time range for the trace */
  timeRange: TimeRange;
  /** Currently selected span (controlled) */
  selectedSpan?: Span | null;
  /** Callback when span selection changes */
  onSelectSpan?: (span: Span | null) => void;
  /** Initial view mode */
  initialViewMode?: ViewMode;
  /** Callback when view mode changes */
  onViewModeChange?: (mode: ViewMode) => void;
  /** Number of spans (for badge display) */
  spanCount?: number;
}

export const TraceFullScreenView: React.FC<TraceFullScreenViewProps> = ({
  open,
  onOpenChange,
  title = 'Trace View',
  subtitle,
  spanTree,
  timeRange,
  selectedSpan: controlledSelectedSpan,
  onSelectSpan,
  initialViewMode = 'flow',
  onViewModeChange,
  spanCount,
}) => {
  // Internal state for uncontrolled mode
  const [internalSelectedSpan, setInternalSelectedSpan] = useState<Span | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());

  // Use controlled or uncontrolled span selection
  const selectedSpan = controlledSelectedSpan !== undefined ? controlledSelectedSpan : internalSelectedSpan;
  const handleSelectSpan = useCallback((span: Span | null) => {
    if (onSelectSpan) {
      onSelectSpan(span);
    } else {
      setInternalSelectedSpan(span);
    }
  }, [onSelectSpan]);

  // Handle view mode change
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  // Auto-expand root spans when opening
  useEffect(() => {
    if (open && spanTree.length > 0) {
      const rootIds = new Set(spanTree.map(s => s.spanId));
      setExpandedSpans(rootIds);
    }
  }, [open, spanTree]);

  // Handle toggle expand for timeline view
  const handleToggleExpand = useCallback((spanId: string) => {
    setExpandedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  }, []);

  // Keyboard shortcut to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  const displaySpanCount = spanCount ?? spanTree.length;

  return (
    <FullScreenDialog open={open} onOpenChange={onOpenChange}>
      <FullScreenDialogContent>
        {/* Header */}
        <FullScreenDialogHeader>
          <div className="flex items-center gap-3">
            <Activity size={20} className="text-opensearch-blue" />
            <div>
              <FullScreenDialogTitle className="flex items-center gap-2">
                {title}
                {displaySpanCount > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {displaySpanCount} spans
                  </Badge>
                )}
              </FullScreenDialogTitle>
              {subtitle && (
                <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="gap-1.5"
            >
              <Minimize2 size={16} />
              Exit Fullscreen
            </Button>
            <FullScreenDialogCloseButton />
          </div>
        </FullScreenDialogHeader>

        {/* Main content area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Trace visualization */}
          <div className="flex-1 relative">
            {spanTree.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <Activity size={48} className="mb-4 opacity-20" />
                <p>No trace data available</p>
              </div>
            ) : viewMode === 'timeline' ? (
              <div className="h-full overflow-auto p-4">
                <TraceTimelineChart
                  spanTree={spanTree}
                  timeRange={timeRange}
                  selectedSpan={selectedSpan}
                  onSelect={handleSelectSpan}
                  expandedSpans={expandedSpans}
                  onToggleExpand={handleToggleExpand}
                />
              </div>
            ) : (
              <TraceFlowView
                spanTree={spanTree}
                timeRange={timeRange}
                selectedSpan={selectedSpan}
                onSelectSpan={handleSelectSpan}
              />
            )}
          </div>

          {/* Details panel - only show for timeline mode since flow has integrated panel */}
          {viewMode === 'timeline' && selectedSpan && (
            <div className="w-96 border-l overflow-auto bg-card">
              <SpanDetailsPanel
                span={selectedSpan as CategorizedSpan}
                onClose={() => handleSelectSpan(null)}
              />
            </div>
          )}
        </div>
      </FullScreenDialogContent>
    </FullScreenDialog>
  );
};

export default TraceFullScreenView;
