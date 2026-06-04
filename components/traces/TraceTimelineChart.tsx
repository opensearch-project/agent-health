/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceTimelineChart
 *
 * ECharts-based Gantt timeline for trace visualization.
 * Renders spans as horizontal bars with expand/collapse tree hierarchy.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { ZoomIn, ZoomOut, ChevronRight, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Span, TimeRange } from '@/types';
import { getSpanColor, flattenVisibleSpans } from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import { truncate } from '@/lib/utils';
import { getTheme } from '@/lib/theme';

const ROW_HEIGHT = 20;

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

  // Dynamic chart height based on visible spans
  const chartHeight = Math.max(100, visibleSpans.length * ROW_HEIGHT + 40);

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

      return {
        type: 'rect',
        shape: {
          x: start[0],
          y: y,
          width: Math.max(end[0] - start[0], 4),
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
          return `<div style="font-size:12px;font-family:'Rubik',sans-serif">
            <div style="font-weight:600;margin-bottom:4px">${span.name}</div>
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
        left: 180,
        right: 20,
        top: 10,
        bottom: 30,
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
        axisLabel: {
          inside: false,
          formatter: (value: string | number) => {
            const idx = typeof value === 'string' ? parseInt(value, 10) : value;
            const span = spanMap[idx];
            if (!span) return '';
            const indent = '  '.repeat(span.depth || 0);
            // Use rich text formatting for bigger caret
            const icon = span.hasChildren 
              ? (expandedSpans.has(span.spanId) ? '{caret|▾}' : '{caret|▸}') 
              : ' ';
            const label = span.name?.split('.').pop() || 'span';
            const truncatedLabel = truncate(label, 25);
            return `${indent}${icon} ${truncatedLabel}`;
          },
          fontSize: 12,
          color: labelColor,
          fontFamily: 'Rubik, sans-serif',
          fontWeight: 500,
          margin: 12,
          // Rich text styles for bigger, more visible caret
          rich: {
            caret: {
              color: isDarkMode ? 'rgb(96, 165, 250)' : 'rgb(59, 130, 246)',
              fontSize: 14,
              fontWeight: 'bold',
              padding: [0, 2, 0, 0]
            }
          }
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        triggerEvent: true // Enable click events on axis labels
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
      } else if (params.componentType === 'yAxis') {
        // Click on y-axis label to toggle expand
        const span = spanMap[params.value];
        if (span?.hasChildren) {
          onToggleExpand(span.spanId);
        }
      }
    });

    // Change cursor on hover over y-axis labels with children
    chart.off('mousemove');
    chart.on('mousemove', (params: any) => {
      if (params.componentType === 'yAxis') {
        const span = spanMap[params.value];
        if (span?.hasChildren) {
          chartRef.current!.style.cursor = 'pointer';
        } else {
          chartRef.current!.style.cursor = isDragging ? 'grabbing' : 'grab';
        }
      } else {
        chartRef.current!.style.cursor = isDragging ? 'grabbing' : 'grab';
      }
    });

    // Handle resize
    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [visibleSpans, timeRange, selectedSpan, expandedSpans, spanMap, onSelectSpan, onToggleExpand]);

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
      </div>
    </div>
  );
};

export default TraceTimelineChart;
