/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceTreeTable - Tree view of trace spans with hierarchy
 *
 * Displays spans in a tree structure with:
 * - Visual tree branches showing parent-child relationships
 * - Expand/collapse functionality
 * - Span icons, names, durations, and status
 * - Click to select span for details
 */

import React from 'react';
import { ChevronDown, ChevronRight, Coins, Bot, Zap, Wrench, ClipboardCheck, AlertCircle, Circle } from 'lucide-react';
import { Span, TimeRange } from '@/types';
import { getSpanColor, flattenVisibleSpans } from '@/services/traces';
import { getSpanCategory, getCategoryMeta } from '@/services/traces/spanCategorization';
import { formatDuration } from '@/services/traces/utils';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// Icon mapping
const ICON_MAP = {
  Bot,
  Zap,
  Wrench,
  ClipboardCheck,
  AlertCircle,
  Circle,
};

const getSpanIcon = (span: Span) => {
  const category = getSpanCategory(span);
  const meta = getCategoryMeta(category);
  return ICON_MAP[meta.icon as keyof typeof ICON_MAP] || Circle;
};

// Helper function to get duration color based on time
const getDurationColor = (durationMs: number): string => {
  if (durationMs < 500) return 'text-green-500'; // Fast: < 500ms
  if (durationMs < 2000) return 'text-yellow-500'; // Medium: 500ms - 2s
  if (durationMs < 5000) return 'text-orange-500'; // Slow: 2s - 5s
  return 'text-red-500'; // Very slow: > 5s
};

interface TraceTreeTableProps {
  spanTree: Span[];
  selectedSpan: Span | null;
  onSelect: (span: Span) => void;
  expandedSpans: Set<string>;
  onToggleExpand: (spanId: string) => void;
  /**
   * When provided, render a per-row timeline bar in the right-hand area
   * showing each span's relative start/duration within the parent trace.
   * Without this prop the tree behaves identically to the original
   * (no timeline column).
   */
  timeRange?: TimeRange;
}

const TraceTreeTable: React.FC<TraceTreeTableProps> = ({
  spanTree,
  selectedSpan,
  onSelect,
  expandedSpans,
  onToggleExpand,
  timeRange,
}) => {
  const [hoveredSpan, setHoveredSpan] = React.useState<string | null>(null);
  
  // Flatten tree respecting expanded state
  const visibleSpans = flattenVisibleSpans(spanTree, expandedSpans);

  // Keyboard navigation
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedSpan) return;
      
      const currentIndex = visibleSpans.findIndex(s => s.spanId === selectedSpan.spanId);
      if (currentIndex === -1) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        // Move to next span if not at the end
        if (currentIndex < visibleSpans.length - 1) {
          onSelect(visibleSpans[currentIndex + 1]);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        // Move to previous span if not at the beginning
        if (currentIndex > 0) {
          onSelect(visibleSpans[currentIndex - 1]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSpan, visibleSpans, onSelect]);

  // Helper to check if a span is in the ancestry path of selected span
  const isInSelectedPath = (span: Span): boolean => {
    if (!selectedSpan) return false;
    
    // Check if this span is an ancestor of the selected span
    let current: Span | undefined = selectedSpan;
    while (current) {
      if (current.spanId === span.spanId) return true;
      // Find parent in visible spans
      current = visibleSpans.find(s => s.spanId === current?.parentSpanId);
    }
    return false;
  };

  // Helper to check if a span is in the ancestry path of hovered span
  const isInHoveredPath = (span: Span): boolean => {
    if (!hoveredSpan) return false;
    
    // Check if this span is an ancestor of the hovered span
    const hoveredSpanObj = visibleSpans.find(s => s.spanId === hoveredSpan);
    if (!hoveredSpanObj) return false;
    
    let current: Span | undefined = hoveredSpanObj;
    while (current) {
      if (current.spanId === span.spanId) return true;
      // Find parent in visible spans
      current = visibleSpans.find(s => s.spanId === current?.parentSpanId);
    }
    return false;
  };

  // Helper to check if there are more siblings after this span at the same depth
  const hasNextSiblingAtDepth = (currentIndex: number, depth: number): boolean => {
    for (let i = currentIndex + 1; i < visibleSpans.length; i++) {
      const nextDepth = visibleSpans[i].depth || 0;
      if (nextDepth < depth) return false; // Gone back to parent level
      if (nextDepth === depth) return true; // Found a sibling
    }
    return false;
  };

  return (
    <div className="space-y-0">{visibleSpans.map((span, index) => {
        const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
        const isSelected = selectedSpan?.spanId === span.spanId;
        const isHovered = hoveredSpan === span.spanId;
        const isExpanded = expandedSpans.has(span.spanId);
        const SpanIcon = getSpanIcon(span);
        const isError = span.status === 'ERROR';
        const depth = span.depth || 0;
        const inSelectedPath = isInSelectedPath(span);
        const inHoveredPath = isInHoveredPath(span);

        return (
          <div
            key={span.spanId}
            data-error-span={isError ? 'true' : undefined}
            className={cn(
              'flex items-center gap-2 py-2 rounded cursor-pointer transition-colors relative group',
              isSelected
                ? 'bg-opensearch-blue/20 dark:bg-opensearch-blue/30'
                : isError
                ? 'bg-red-500/10 hover:bg-red-500/20'
                : 'hover:bg-muted/50'
            )}
            onClick={() => onSelect(span)}
            onMouseEnter={() => setHoveredSpan(span.spanId)}
            onMouseLeave={() => setHoveredSpan(null)}
            style={{ paddingLeft: `${8}px` }}
          >
            {/* Reddit-style tree lines */}
            {depth > 0 && (
              <div className="absolute left-0 top-0 bottom-0 flex pointer-events-none">
                {Array.from({ length: depth }).map((_, levelIndex) => {
                  const isLastLevel = levelIndex === depth - 1;
                  
                  // Check if there are more siblings at this level
                  const hasMoreSiblings = hasNextSiblingAtDepth(index, depth);
                  
                  // Check if this level is in the selected or hovered path
                  const ancestorAtLevel = (() => {
                    let current: Span | undefined = span;
                    let stepsBack = depth - levelIndex;
                    while (current && stepsBack > 0) {
                      current = visibleSpans.find(s => s.spanId === current?.parentSpanId);
                      stepsBack--;
                    }
                    return current;
                  })();
                  
                  // Highlight the entire L-shaped path from parent to selected child
                  // This includes the vertical line down from parent and the curve to the child
                  const levelInHoveredPath = ancestorAtLevel && isInHoveredPath(ancestorAtLevel);
                  
                  // Determine line color - use solid colors (no blue for selected)
                  const lineColor = levelInHoveredPath
                    ? '#808080' // Solid gray for hovered
                    : '#d0d0d0'; // Light solid gray default
                  
                  const lineWidth = 2;
                  const curveRadius = 16;
                  
                  return (
                    <div
                      key={levelIndex}
                      className="relative"
                      style={{ width: '24px', marginLeft: levelIndex === 0 ? '4px' : '0' }}
                    >
                      {/* Vertical line for non-last levels - continuous between siblings */}
                      {!isLastLevel && (
                        <div
                          className="absolute transition-colors"
                          style={{
                            left: '12px',
                            width: `${lineWidth}px`,
                            top: 0,
                            bottom: 0,
                            backgroundColor: lineColor,
                          }}
                        />
                      )}
                      
                      {/* For last level: curved line pointing to icon center */}
                      {isLastLevel && (
                        <>
                          {/* Vertical line from top to curve start - this should be blue for selected */}
                          <div
                            className="absolute transition-colors"
                            style={{
                              left: '12px',
                              width: `${lineWidth}px`,
                              top: 0,
                              height: `calc(50% - ${curveRadius}px)`,
                              backgroundColor: lineColor,
                            }}
                          />
                          
                          {/* Curved corner using border-radius - this should be blue for selected */}
                          <div
                            className="absolute transition-colors"
                            style={{
                              left: '12px',
                              top: `calc(50% - ${curveRadius}px)`,
                              width: `${curveRadius}px`,
                              height: `${curveRadius}px`,
                              borderLeft: `${lineWidth}px solid ${lineColor}`,
                              borderBottom: `${lineWidth}px solid ${lineColor}`,
                              borderBottomLeftRadius: `${curveRadius}px`,
                            }}
                          />
                          
                          {/* Vertical line from curve end to bottom - this should NOT be blue, always gray */}
                          {hasMoreSiblings && (
                            <div
                              className="absolute transition-colors"
                              style={{
                                left: '12px',
                                top: '50%',
                                width: `${lineWidth}px`,
                                bottom: 0,
                                backgroundColor: levelInHoveredPath ? '#808080' : '#d0d0d0', // Never blue
                              }}
                            />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Content with proper left padding.
                When timeRange is provided we use a 3-column layout:
                  [name (fixed width — depth padding goes INSIDE so all
                   timelines align at the same x position)] |
                  [timeline bar — flex-1, fills the entire space between
                   name and actions, all the way to the right edge] |
                  [actions: eval badge + duration + chevron]
                Without timeRange we fall back to the original two-column
                flex-1 name layout so other call-sites (fullscreen view,
                etc.) are unaffected. */}
            {timeRange ? (
              <div className="flex items-center gap-2 w-full">
                {/* Name column — narrow flex-basis (~220px) so the gap
                    between the end of the span name and the start of
                    the timeline bar stays small even for short names,
                    while keeping all timelines aligned at the same x
                    position regardless of tree depth. Long names
                    truncate with the existing ellipsis (full name is
                    available on hover via the row tooltip). */}
                <div
                  className="flex items-center gap-2 flex-shrink-0 min-w-0"
                  style={{
                    width: 220,
                    paddingLeft: `${depth * 24 + (depth > 0 ? 12 : 0)}px`,
                  }}
                >
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: getSpanColor(span) + '40' }}
                  >
                    <SpanIcon size={14} style={{ color: getSpanColor(span) }} />
                  </div>
                  <div className={cn('flex-1 min-w-0 font-medium text-sm truncate', isError && 'text-red-500 dark:text-red-400')} title={span.name}>
                    {span.name}
                  </div>
                </div>

                {/* Timeline column — flex-1 fills all remaining horizontal
                    space (from end of name column to the start of the
                    actions column on the right). The bar inside it spans
                    the full width of this column. */}
                {timeRange.duration > 0 && (() => {
                  const startMs = new Date(span.startTime).getTime();
                  const endMs = new Date(span.endTime).getTime();
                  const offsetPct = Math.max(0, Math.min(100,
                    ((startMs - timeRange.startTime) / timeRange.duration) * 100
                  ));
                  const widthPct = Math.max(0.5, Math.min(100 - offsetPct,
                    ((endMs - startMs) / timeRange.duration) * 100
                  ));
                  return (
                    <div className="flex-1 min-w-0 px-3">
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="trace-row-timeline relative h-2 w-full bg-muted/40 rounded-sm overflow-hidden">
                              <div
                                className="absolute top-0 bottom-0 rounded-sm"
                                style={{
                                  left: `${offsetPct}%`,
                                  width: `${widthPct}%`,
                                  backgroundColor: getSpanColor(span),
                                }}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[10px]">
                            <div>start +{formatDuration(startMs - timeRange.startTime)}</div>
                            <div>duration {formatDuration(duration)}</div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  );
                })()}

                {/* Actions column — fixed width on the right edge */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {span.attributes?.['gen_ai.usage.output_tokens'] && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 flex items-center gap-0.5">
                      <Coins size={9} />
                      {span.attributes['gen_ai.usage.output_tokens']}
                    </Badge>
                  )}
                  <div className={cn(
                    "text-xs font-mono min-w-14 text-right whitespace-nowrap",
                    getDurationColor(duration)
                  )}>
                    {formatDuration(duration)}
                  </div>
                  <div className="w-6 flex items-center justify-center">
                    {span.hasChildren && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleExpand(span.spanId);
                        }}
                        className="hover:bg-muted rounded p-0.5"
                      >
                        <ChevronDown
                          size={14}
                          className={cn(
                            'text-muted-foreground transition-transform',
                            !isExpanded && '-rotate-90'
                          )}
                        />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-1 min-w-0" style={{ paddingLeft: `${depth * 24 + (depth > 0 ? 12 : 0)}px` }}>
                {/* Span icon */}
                <div
                  className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: getSpanColor(span) + '40' }}
                >
                  <SpanIcon size={14} style={{ color: getSpanColor(span) }} />
                </div>

                {/* Span name - allows truncation */}
                <div className={cn('flex-1 min-w-0 font-medium text-sm truncate', isError && 'text-red-500 dark:text-red-400')}>
                  {span.name}
                </div>

                {/* Right side elements - fixed width container */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {span.attributes?.['gen_ai.usage.output_tokens'] && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 flex items-center gap-0.5">
                      <Coins size={9} />
                      {span.attributes['gen_ai.usage.output_tokens']}
                    </Badge>
                  )}
                  <div className={cn(
                    "text-xs font-mono min-w-14 text-right whitespace-nowrap",
                    getDurationColor(duration)
                  )}>
                    {formatDuration(duration)}
                  </div>
                  <div className="w-6 flex items-center justify-center">
                    {span.hasChildren && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleExpand(span.spanId);
                        }}
                        className="hover:bg-muted rounded p-0.5"
                      >
                        <ChevronDown
                          size={14}
                          className={cn(
                            'text-muted-foreground transition-transform',
                            !isExpanded && '-rotate-90'
                          )}
                        />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default TraceTreeTable;
