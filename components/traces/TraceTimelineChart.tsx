/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceTimelineChart
 *
 * ECharts-based Gantt timeline for trace visualization.
 * Renders spans as horizontal bars with expand/collapse tree hierarchy.
 *
 * The label column on the left is plain HTML (not ECharts axis labels) so each
 * row can carry real controls: a caret button to expand/collapse, the span
 * name as a button that opens the details drawer (click / Enter / Space, full
 * name in `title`), and the span's absolute start time + offset from the trace
 * root. The column is drag-resizable; the chart grid starts where it ends. The
 * time axis stays relative (`0ms … 14.4s`) and the header pins t=0 to the
 * root's wall-clock start.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Span, TimeRange } from '@/types';
import { getSpanColor, flattenVisibleSpans } from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import { getTraceAnchorMs, getSpanTimeLabels, formatClockTime, formatIsoTime } from '@/services/traces/spanTime';
import { getTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useResizableColumn, estimateNameColumnWidth } from './useResizableColumn';

const ROW_HEIGHT = 20;
/** Header strip above the rows: column title + t=0 anchor. Also the grid's top padding. */
const HEADER_HEIGHT = 22;
/** Room for the relative time axis under the last row. */
const AXIS_HEIGHT = 30;
const INDENT_PX = 12;
/** Sizing for the initial label-column width (see estimateNameColumnWidth). */
const LABEL_ESTIMATE = { indentPx: INDENT_PX, fixedPx: 150, charPx: 6.5, min: 300, max: 560 };

interface TraceTimelineChartProps {
  spanTree: Span[];
  timeRange: TimeRange;
  selectedSpan: Span | null;
  onSelectSpan: (span: Span) => void;
  expandedSpans: Set<string>;
  onToggleExpand: (spanId: string) => void;
}

const TraceTimelineChart: React.FC<TraceTimelineChartProps> = ({
  spanTree,
  timeRange,
  selectedSpan,
  onSelectSpan,
  expandedSpans,
  onToggleExpand
}) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1); // Scale factor
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  // Aggro-style-edit: Theme-aware colors
  const isDarkMode = getTheme() === 'dark';
  const labelColor = isDarkMode ? 'rgb(203, 213, 225)' : 'rgb(51, 65, 81)';
  const axisColor = isDarkMode ? 'rgb(71, 85, 105)' : 'rgb(203, 213, 225)';
  const splitLineColor = isDarkMode ? 'rgb(30, 41, 59)' : 'rgb(226, 232, 240)';
  const tooltipBg = isDarkMode ? 'rgba(30, 41, 59, 0.95)' : 'rgba(255, 255, 255, 0.95)';
  const tooltipBorder = isDarkMode ? 'rgba(51, 65, 85, 0.5)' : 'rgba(203, 213, 225, 0.5)';
  const tooltipText = isDarkMode ? 'rgb(226, 232, 240)' : 'rgb(30, 41, 59)';

  // Flatten tree respecting expanded state
  const visibleSpans = useMemo(
    () => flattenVisibleSpans(spanTree, expandedSpans),
    [spanTree, expandedSpans]
  );

  // Create span map for quick lookup
  const spanMap = useMemo(() => {
    const map: Record<number, Span> = {};
    visibleSpans.forEach((span, idx) => {
      map[idx] = span;
    });
    return map;
  }, [visibleSpans]);

  // Dynamic chart height: exactly one ROW_HEIGHT band per visible span plus
  // header and axis, so the HTML label rows and the ECharts category bands
  // share the same geometry (no minimum-height floor — that would stretch the
  // bands of a 1–2 row trace away from the labels).
  const chartHeight = Math.max(1, visibleSpans.length) * ROW_HEIGHT + HEADER_HEIGHT + AXIS_HEIGHT;

  // t=0 for per-row offsets and the header anchor: the trace root's start.
  const anchorMs = useMemo(
    () => getTraceAnchorMs(spanTree) ?? (timeRange.startTime > 0 ? timeRange.startTime : null),
    [spanTree, timeRange.startTime]
  );

  // Resizable label column; the ECharts grid begins at its right edge. The
  // initial width is sized from the longest name in the tree (≈6.5px per
  // character at this font size, plus indent and the time cell) so typical
  // `execute_tool <name>` rows are not ellipsized out of the box; the cap
  // keeps the bars visible on a laptop width. Dragging overrides it.
  const defaultLabelWidth = useMemo(() => estimateNameColumnWidth(spanTree, LABEL_ESTIMATE), [spanTree]);
  const labelCol = useResizableColumn(defaultLabelWidth, 200, 760, 'Resize span name column');

  // Handle zoom via CSS transform
  const handleZoomIn = () => {
    setZoomLevel(prev => Math.min(prev + 0.2, 3));
  };

  const handleZoomOut = () => {
    setZoomLevel(prev => Math.max(prev - 0.2, 0.5));
  };

  // Handle mouse drag for panning
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPanOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (!chartRef.current || visibleSpans.length === 0) return;

    // Initialize or get existing chart
    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }
    const chart = chartInstance.current;

    // Prepare data for custom series
    const data = visibleSpans.map((span, idx) => {
      const startTime = new Date(span.startTime).getTime();
      const endTime = new Date(span.endTime).getTime();
      return {
        value: [startTime, endTime, idx],
        itemStyle: {
          color: getSpanColor(span),
          borderColor: selectedSpan?.spanId === span.spanId ? '#ffffff' : undefined,
          borderWidth: selectedSpan?.spanId === span.spanId ? 2 : 0,
        },
        span
      };
    });

    // Custom renderItem for Gantt bars
    const renderGanttBar: echarts.CustomSeriesOption['renderItem'] = (params, api) => {
      const startTime = api.value(0) as number;
      const endTime = api.value(1) as number;
      const idx = api.value(2) as number;

      const start = api.coord([startTime, idx]);
      const end = api.coord([endTime, idx]);

      const barHeight = ROW_HEIGHT * 0.7;
      const y = start[1] - barHeight / 2;

      const span = (params as any).data?.span as Span | undefined;
      // ERROR spans are often very short (e.g. a 45ms ShellError) and would
      // render as a sub-pixel sliver that's impossible to spot. Give them a
      // larger minimum width so the red bar is actually visible.
      const minWidth = span?.status === 'ERROR' ? 8 : 4;

      return {
        type: 'rect',
        shape: {
          x: start[0],
          y: y,
          width: Math.max(end[0] - start[0], minWidth),
          height: barHeight,
          r: 2
        },
        style: api.style()
      } as echarts.CustomSeriesRenderItemReturn;
    };

    const option: echarts.EChartsOption = {
      tooltip: {
        trigger: 'item',
        formatter: (params: any) => {
          const span = params.data.span as Span;
          const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
          const t = getSpanTimeLabels(span, anchorMs);
          const esc = (v: string) => v.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
          return `<div style="font-size:12px;font-family:'Rubik',sans-serif;max-width:480px;word-break:break-word">
            <div style="font-weight:600;margin-bottom:4px">${esc(span.name)}</div>
            <div>Start: ${esc(t.clock)}${t.offset ? ` (${esc(t.offset)})` : ''}</div>
            <div style="opacity:.7">${esc(t.iso)}</div>
            <div>Duration: ${formatDuration(duration)}</div>
            <div>Status: ${span.status || 'UNSET'}</div>
          </div>`;
        },
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        textStyle: { 
          color: tooltipText,
          fontFamily: 'Rubik, sans-serif'
        }
      },
      grid: {
        left: labelCol.width,
        right: 20,
        top: HEADER_HEIGHT,
        bottom: AXIS_HEIGHT,
        containLabel: false
      },
      xAxis: {
        type: 'time',
        min: timeRange.startTime,
        max: timeRange.endTime,
        axisLabel: {
          formatter: (val: number) => formatDuration(val - timeRange.startTime),
          fontSize: 11,
          color: labelColor,
          fontFamily: 'Rubik, sans-serif',
          fontWeight: 500
        },
        axisLine: { lineStyle: { color: axisColor } },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } }
      },
      yAxis: {
        type: 'category',
        data: visibleSpans.map((_, idx) => idx),
        inverse: true,
        position: 'left',
        // Labels are rendered as HTML in the overlay column (see below) so
        // the name is a real button and the time cell has a real tooltip.
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [{
        type: 'custom',
        renderItem: renderGanttBar,
        encode: {
          x: [0, 1],
          y: 2
        },
        data: data
      }]
    };

    chart.setOption(option, true);

    // Handle click events
    chart.off('click');
    chart.on('click', (params: any) => {
      if (params.componentType === 'series' && params.data?.span) {
        onSelectSpan(params.data.span);
      }
    });

    // Handle resize
    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [visibleSpans, timeRange, selectedSpan, expandedSpans, spanMap, onSelectSpan, onToggleExpand, anchorMs, labelCol.width]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chartInstance.current) {
        chartInstance.current.dispose();
        chartInstance.current = null;
      }
    };
  }, []);

  // Resize chart when height changes
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.resize();
    }
  }, [chartHeight]);

  return (
    <div
      // overflow-x-hidden preserves the timeline pan UX (drag to translate the
      // chart along the time axis without showing the off-screen chart edges).
      // overflow-y-auto engages a real vertical scrollbar when chartHeight
      // exceeds the parent's viewport — previously this was just `overflow-hidden`
      // which clipped tall traces and made the top of the tree unreachable in
      // fullscreen mode (the only place where the chart's parent has a fixed
      // height short enough for chartHeight to overflow it).
      className="relative overflow-x-hidden overflow-y-auto h-full"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
    >
      {/* Zoom Controls */}
      <div className="absolute top-1 right-1 z-10 flex flex-col gap-1 bg-card border rounded-lg shadow-lg p-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleZoomIn}
          title="Zoom in"
        >
          <ZoomIn size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleZoomOut}
          title="Zoom out"
        >
          <ZoomOut size={12} />
        </Button>
      </div>

      <div
        className="relative"
        style={{ 
          transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
          transformOrigin: 'top left',
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          height: chartHeight,
          width: '100%'
        }}
      >
        <div
          ref={chartRef}
          style={{ height: chartHeight, width: '100%' }}
          className="bg-background"
          data-testid="trace-timeline-chart"
        />

        {/* HTML label column, aligned row-for-row with the ECharts category
            axis (HEADER_HEIGHT + idx * ROW_HEIGHT). Lives inside the same
            transformed wrapper so zoom/pan keep it glued to the bars. */}
        <div
          className="absolute top-0 left-0 select-none"
          style={{ width: labelCol.width, height: chartHeight }}
          data-testid="trace-timeline-labels"
        >
          <div
            className="flex items-center gap-2 px-2 text-[10px] font-mono text-muted-foreground border-b border-border/60 bg-background/80"
            style={{ height: HEADER_HEIGHT }}
            data-testid="trace-list-header"
          >
            <span className="uppercase tracking-wide">Span</span>
            <span>·</span>
            <span data-testid="trace-list-sort-hint" title="Rows are ordered by span start time (ties by span id), at every depth">
              sorted by start time
            </span>
          </div>
          {visibleSpans.map((span, idx) => {
            const isSelected = selectedSpan?.spanId === span.spanId;
            const isError = span.status === 'ERROR';
            const isExpanded = expandedSpans.has(span.spanId);
            const time = getSpanTimeLabels(span, anchorMs);
            return (
              <div
                key={span.spanId}
                className={cn(
                  'absolute left-0 right-0 flex items-center gap-1 pr-1 text-xs cursor-pointer',
                  isSelected ? 'bg-opensearch-blue/20 dark:bg-opensearch-blue/30' : 'hover:bg-muted/50'
                )}
                style={{ top: HEADER_HEIGHT + idx * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 4 + (span.depth || 0) * INDENT_PX }}
                data-testid="timeline-row"
                data-span-id={span.spanId}
                // Clicking anywhere on the label row selects the span (same as
                // the tree table); the caret and name buttons stop propagation.
                onClick={() => onSelectSpan(span)}
              >
                {span.hasChildren ? (
                  <button
                    type="button"
                    className="w-4 h-4 shrink-0 flex items-center justify-center rounded text-opensearch-blue hover:bg-muted font-bold leading-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExpand(span.spanId);
                    }}
                    aria-label={isExpanded ? 'Collapse children' : 'Expand children'}
                    aria-expanded={isExpanded}
                    data-testid="span-row-expand"
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="w-4 h-4 shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={cn(
                    'flex-1 min-w-0 truncate text-left bg-transparent border-0 p-0 cursor-pointer font-medium',
                    'hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-opensearch-blue rounded-sm',
                    isError ? 'text-red-500 dark:text-red-400' : 'text-foreground'
                  )}
                  title={span.name}
                  aria-label={`Open details for ${span.name}`}
                  data-testid="span-row-name"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSpan(span);
                  }}
                >
                  {isError ? '⚠ ' : ''}{span.name}
                </button>
                {time.clock && (
                  <span
                    className="font-mono text-[10px] text-muted-foreground whitespace-nowrap shrink-0 tabular-nums"
                    title={`Started ${time.iso}${time.offset ? ` (${time.offset} from trace start)` : ''}`}
                    data-testid="span-row-time"
                  >
                    <span data-testid="span-row-clock">{time.clock}</span>
                    {time.offset && <span className="ml-1.5 opacity-80" data-testid="span-row-offset">{time.offset}</span>}
                  </span>
                )}
              </div>
            );
          })}
          {/* Column resize handle on the label/grid boundary. */}
          <div
            {...labelCol.handleProps}
            className={cn(
              'absolute top-0 bottom-0 w-1 -right-0.5 cursor-col-resize rounded hover:bg-opensearch-blue/50 focus-visible:outline-none focus-visible:bg-opensearch-blue/70',
              labelCol.isResizing && 'bg-opensearch-blue'
            )}
            data-testid="span-name-col-resize"
          />
        </div>

        {/* Absolute anchor for the relative axis: t=0 is the root's start. */}
        {anchorMs !== null && (
          <div
            className="absolute top-0 flex items-center px-1.5 text-[10px] font-mono text-muted-foreground whitespace-nowrap"
            style={{ left: labelCol.width + 4, height: HEADER_HEIGHT }}
            title={`t=0 is the trace root's start: ${formatIsoTime(anchorMs)}`}
            data-testid="trace-anchor-time"
          >
            t=0 = {formatClockTime(anchorMs)}
          </div>
        )}
      </div>
    </div>
  );
};

export default TraceTimelineChart;
