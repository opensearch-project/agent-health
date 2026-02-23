/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceFullScreenView
 *
 * Fullscreen modal for trace visualization.
 * Supports single trace mode (timeline/flow) and comparison mode (side-by-side/merged).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Minimize2, Network, List, GitBranch, Info } from 'lucide-react';
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
import TraceVisualization from './TraceVisualization';
import { ViewMode } from './ViewToggle';

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
  /** Expanded spans state (controlled) */
  expandedSpans?: Set<string>;
  /** Callback when expanded spans change */
  onToggleExpand?: (spanId: string) => void;
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
  initialViewMode = 'timeline',
  onViewModeChange,
  spanCount,
  expandedSpans: controlledExpandedSpans,
  onToggleExpand: controlledOnToggleExpand,
}) => {
  // Internal state for uncontrolled mode
  const [internalSelectedSpan, setInternalSelectedSpan] = useState<Span | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [internalExpandedSpans, setInternalExpandedSpans] = useState<Set<string>>(new Set());

  // Sync view mode with external prop changes
  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  // Use controlled or uncontrolled span selection
  const selectedSpan = controlledSelectedSpan !== undefined ? controlledSelectedSpan : internalSelectedSpan;
  const handleSelectSpan = useCallback((span: Span | null) => {
    if (onSelectSpan) {
      onSelectSpan(span);
    } else {
      setInternalSelectedSpan(span);
    }
  }, [onSelectSpan]);

  // Use controlled or uncontrolled expanded spans
  const expandedSpans = controlledExpandedSpans !== undefined ? controlledExpandedSpans : internalExpandedSpans;
  const handleToggleExpand = useCallback((spanId: string) => {
    if (controlledOnToggleExpand) {
      controlledOnToggleExpand(spanId);
    } else {
      setInternalExpandedSpans(prev => {
        const next = new Set(prev);
        if (next.has(spanId)) {
          next.delete(spanId);
        } else {
          next.add(spanId);
        }
        return next;
      });
    }
  }, [controlledOnToggleExpand]);

  // Handle view mode change
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  // Auto-expand root spans when opening (only for uncontrolled mode)
  useEffect(() => {
    if (open && spanTree.length > 0 && controlledExpandedSpans === undefined) {
      const rootIds = new Set(spanTree.map(s => s.spanId));
      setInternalExpandedSpans(rootIds);
    }
  }, [open, spanTree, controlledExpandedSpans]);

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
            {/* View Toggle - matching flyout style */}
            <div className="inline-flex items-center rounded-lg border bg-muted p-1 gap-1">
              <Button
                variant={viewMode === 'timeline' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => handleViewModeChange('timeline')}
              >
                <Network size={14} className="mr-1.5" />
                Trace tree
              </Button>
              <Button
                variant={viewMode === 'agent-map' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => handleViewModeChange('agent-map')}
              >
                <GitBranch size={14} className="mr-1.5" />
                Agent map
              </Button>
              <Button
                variant={viewMode === 'gantt' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => handleViewModeChange('gantt')}
              >
                <List size={14} className="mr-1.5" />
                Timeline
              </Button>
              <Button
                variant={viewMode === 'stats' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => handleViewModeChange('stats')}
              >
                <Info size={14} className="mr-1.5" />
                Info
              </Button>
            </div>
            
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
        <div className="flex-1 flex flex-col overflow-hidden">
          {spanTree.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
              <Activity size={48} className="mb-4 opacity-20" />
              <p>No trace data available</p>
            </div>
          ) : (
            <TraceVisualization
              spanTree={spanTree}
              timeRange={timeRange}
              initialViewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              showViewToggle={false}
              selectedSpan={selectedSpan}
              onSelectSpan={handleSelectSpan}
              expandedSpans={expandedSpans}
              onToggleExpand={handleToggleExpand}
              showSpanDetailsPanel={true}
            />
          )}
        </div>
      </FullScreenDialogContent>
    </FullScreenDialog>
  );
};

export default TraceFullScreenView;
