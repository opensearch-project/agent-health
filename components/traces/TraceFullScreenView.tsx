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

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Activity, Network, List, GitBranch, Info, MessageSquare, X as XIcon } from 'lucide-react';
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
import { computeTraceSummary } from '@/services/traces';
import TraceVisualization from './TraceVisualization';
import { ViewMode } from './ViewToggle';
import SimpleSpanAttributesTable from './SimpleSpanAttributesTable';
import TraceSummaryStrip from './TraceSummaryStrip';

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
  /** Flat spans for message extraction */
  flatSpans?: Span[];
  /** Service name for message extraction heuristics */
  serviceName?: string;
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
  flatSpans,
  serviceName,
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

  // Keyboard shortcut to close — if a span-details drawer is currently
  // showing inside fullscreen, ESC should close the drawer first (matches
  // typical nested-modal expectations) and only close the fullscreen on a
  // second press.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        if (selectedSpan && onSelectSpan) {
          onSelectSpan(null);
          e.stopPropagation();
        } else {
          onOpenChange(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange, selectedSpan, onSelectSpan]);

  const displaySpanCount = spanCount ?? spanTree.length;

  // Same headline summary as the inline expansion shows above the
  // tree (category breakdown / errors / tokens / models). Reusing
  // the TraceSummaryStrip component keeps inline and fullscreen
  // header content visually identical — if the user opens fullscreen
  // they don't lose the at-a-glance signal they were looking at.
  const headerSummary = useMemo(() => computeTraceSummary(spanTree), [spanTree]);

  return (
    <FullScreenDialog open={open} onOpenChange={onOpenChange}>
      <FullScreenDialogContent>
        {/* Header */}
        <FullScreenDialogHeader>
          <div className="flex items-center gap-3 min-w-0">
            <Activity size={20} className="text-opensearch-blue" />
            <div className="min-w-0">
              <FullScreenDialogTitle className="flex items-center gap-2">
                {title}
                {displaySpanCount > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {displaySpanCount} spans
                  </Badge>
                )}
              </FullScreenDialogTitle>
              {/* Summary strip — same content the inline expansion shows. */}
              <TraceSummaryStrip
                summary={headerSummary}
                className="text-xs mt-1"
              />
              {subtitle && (
                <p className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</p>
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
              <Button
                variant={viewMode === 'messages' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => handleViewModeChange('messages')}
              >
                <MessageSquare size={14} className="mr-1.5" />
                Messages
              </Button>
            </div>

            {/* Single close affordance — the dialog already provides Esc
                and the FullScreenDialogCloseButton X. The previous design
                had both an 'Exit Fullscreen' text button AND the X which
                was redundant; the X (top-right corner) is the universally
                expected place to dismiss a fullscreen overlay. */}
            <FullScreenDialogCloseButton />
          </div>
        </FullScreenDialogHeader>

        {/* Main content area.
            `min-h-0` is required so this flex child can shrink below its
            content height — without it, a tall trace tree silently
            overflows past the dialog viewport and the user can't scroll
            up to the top of the tree (the inner overflow-auto on the
            chart wrapper never receives a constrained parent height,
            so its scrollbar never engages). */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
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
              showSpanDetailsPanel={false}
              flatSpans={flatSpans}
              serviceName={serviceName}
            />
          )}

          {/* Span details bottom drawer rendered INSIDE the fullscreen
              container (absolute, not fixed) so it slides up from the
              bottom of the fullscreen overlay rather than the page body.
              This means it never overlaps the trace list behind the
              fullscreen and the user gets the same flat-attribute UX in
              both inline and fullscreen modes.

              The fullscreen dialog already owns the only close (X) in
              this overlay — putting another X on the drawer was redundant
              and confusing. To dismiss the drawer the user clicks the
              span row again (deselect) or hits Esc. */}
          {selectedSpan && (
            <div
              className="absolute inset-x-0 bottom-0 h-[55vh] bg-background border-t shadow-2xl flex flex-col z-20 animate-in slide-in-from-bottom-4 duration-200"
              role="dialog"
              aria-label="Span details"
            >
              <SimpleSpanAttributesTable span={selectedSpan} />
            </div>
          )}
        </div>
      </FullScreenDialogContent>
    </FullScreenDialog>
  );
};

export default TraceFullScreenView;
