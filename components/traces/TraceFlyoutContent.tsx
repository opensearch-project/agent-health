/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceFlyoutContent - Detailed trace view shown in flyout panel
 *
 * Displays trace visualization with:
 * - Trace overview with metrics
 * - Timeline/Flow view of spans
 * - Span details panel with input/output from OTEL conventions
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  Clock,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Maximize2,
  MessageSquare,
  Wrench,
  Bot,
  Network,
  List,
  GitBranch,
  Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Span, TimeRange } from '@/types';
import { processSpansIntoTree, calculateTimeRange, getCategoryColors } from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';
import TraceVisualization from './TraceVisualization';
import TraceTimelineChart from './TraceTimelineChart';
import ViewToggle, { ViewMode } from './ViewToggle';
import TraceFullScreenView from './TraceFullScreenView';
import { SpanInputOutput } from './SpanInputOutput';
import SpanDetailsPanel from './SpanDetailsPanel';
import {
  flattenSpans,
  calculateCategoryStats,
  extractToolStats,
} from '@/services/traces/traceStats';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { cn } from '@/lib/utils';

interface TraceTableRow {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  startTime: Date;
  duration: number;
  spanCount: number;
  hasErrors: boolean;
  spans: Span[];
}

interface TraceFlyoutContentProps {
  trace: TraceTableRow;
  onClose: () => void;
}

export const TraceFlyoutContent: React.FC<TraceFlyoutContentProps> = ({
  trace,
  onClose,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('timeline'); // Start with Trace Tree view
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copiedTraceId, setCopiedTraceId] = useState(false);
  const [expandedSummary, setExpandedSummary] = useState<string | null>(null);

  // Process spans into tree
  const spanTree = useMemo(() => processSpansIntoTree(trace.spans), [trace.spans]);
  const timeRange = useMemo(() => calculateTimeRange(trace.spans), [trace.spans]);

  // Categorize spans for summary stats
  const categorizedTree = useMemo(
    () => categorizeSpanTree(spanTree),
    [spanTree]
  );

  // Flatten all spans for analysis
  const allSpans = useMemo(
    () => flattenSpans(categorizedTree),
    [categorizedTree]
  );

  // Calculate statistics for Info tab
  const categoryStats = useMemo(
    () => calculateCategoryStats(allSpans, timeRange.duration),
    [allSpans, timeRange.duration]
  );

  // Extract tool information for Info tab
  const toolStats = useMemo(
    () => extractToolStats(allSpans),
    [allSpans]
  );

  // Auto-select first span when switching view modes or when trace changes
  useEffect(() => {
    if (spanTree.length > 0) {
      // Always select first span when trace changes (spanTree changes)
      // or when switching view modes and no span is selected
      if (!selectedSpan) {
        setSelectedSpan(spanTree[0]);
      }
    }
  }, [selectedSpan, spanTree]);

  // Reset selected span when trace changes (traceId changes)
  useEffect(() => {
    // When trace changes, reset to first span
    if (spanTree.length > 0) {
      setSelectedSpan(spanTree[0]);
    }
  }, [trace.traceId, spanTree]);

  // Auto-expand root spans
  useEffect(() => {
    const rootIds = new Set(spanTree.map(s => s.spanId));
    setExpandedSpans(rootIds);
  }, [spanTree]);

  // Handle expand toggle
  const handleToggleExpand = (spanId: string) => {
    setExpandedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  // Copy trace ID to clipboard
  const handleCopyTraceId = async () => {
    try {
      await navigator.clipboard.writeText(trace.traceId);
      setCopiedTraceId(true);
      setTimeout(() => setCopiedTraceId(false), 2000);
    } catch (err) {
      console.error('Failed to copy trace ID to clipboard:', err);
    }
  };

  // Calculate span stats using the same categorization as Info tab
  const spanStats = useMemo(() => {
    const byStatus = trace.spans.reduce(
      (acc, span) => {
        if (span.status === 'ERROR') acc.error++;
        else if (span.status === 'OK') acc.ok++;
        else acc.unset++;
        return acc;
      },
      { ok: 0, error: 0, unset: 0 }
    );

    // Use categoryStats for consistent data
    const byCategory = categoryStats.reduce(
      (acc, stat) => {
        acc[stat.category.toLowerCase()] = {
          count: stat.count,
          duration: stat.totalDuration,
        };
        return acc;
      },
      {} as Record<string, { count: number; duration: number }>
    );

    return { byStatus, byCategory };
  }, [trace.spans, categoryStats]);

  // Get detailed breakdown for each category
  const getCategoryDetails = (category: string) => {
    const spans = trace.spans.filter(span => {
      const name = span.name.toLowerCase();
      if (category === 'agent') return name.includes('agent');
      if (category === 'llm') return name.includes('llm') || name.includes('bedrock') || name.includes('converse');
      if (category === 'tool') return name.includes('tool') || span.attributes?.['gen_ai.tool.name'];
      if (category === 'error') return span.status === 'ERROR';
      return false;
    });

    // For tools, extract unique tool names and their call counts
    if (category === 'tool') {
      const toolCounts = spans.reduce((acc, span) => {
        const toolName = span.attributes?.['gen_ai.tool.name'] as string || span.name;
        acc[toolName] = (acc[toolName] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return Object.entries(toolCounts).map(([name, count]) => ({
        name,
        count,
        duration: spans
          .filter(s => (s.attributes?.['gen_ai.tool.name'] || s.name) === name)
          .reduce((sum, s) => sum + (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()), 0),
      }));
    }

    // For other categories, group by span name
    const nameCounts = spans.reduce((acc, span) => {
      acc[span.name] = (acc[span.name] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(nameCounts).map(([name, count]) => ({
      name,
      count,
      duration: spans
        .filter(s => s.name === name)
        .reduce((sum, s) => sum + (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()), 0),
    }));
  };

  // Aggro-style-edit: Get inline styles for category detail pills (theme-aware)
  // Note: This function checks theme on each call to ensure it's always current
  const getCategoryDetailStyle = (category: string): React.CSSProperties => {
    // Check theme every time to ensure reactivity
    const isDarkMode = document.documentElement.classList.contains('dark');
    
    switch (category) {
      case 'agent':
        return isDarkMode
          ? { backgroundColor: 'rgba(59, 130, 246, 0.15)', color: 'rgb(147, 197, 253)', border: '1px solid rgba(59, 130, 246, 0.4)' }
          : { backgroundColor: 'rgb(219, 234, 254)', color: 'rgb(29, 78, 216)', border: '1px solid rgb(147, 197, 253)' };
      case 'llm':
        return isDarkMode
          ? { backgroundColor: 'rgba(168, 85, 247, 0.15)', color: 'rgb(192, 132, 252)', border: '1px solid rgba(168, 85, 247, 0.4)' }
          : { backgroundColor: 'rgb(243, 232, 255)', color: 'rgb(107, 33, 168)', border: '1px solid rgb(216, 180, 254)' };
      case 'tool':
        return isDarkMode
          ? { backgroundColor: 'rgba(245, 158, 11, 0.15)', color: 'rgb(251, 191, 36)', border: '1px solid rgba(245, 158, 11, 0.4)' }
          : { backgroundColor: 'rgb(254, 243, 199)', color: 'rgb(146, 64, 14)', border: '1px solid rgb(252, 211, 77)' };
      case 'error':
        return isDarkMode
          ? { backgroundColor: 'rgba(239, 68, 68, 0.15)', color: 'rgb(248, 113, 113)', border: '1px solid rgba(239, 68, 68, 0.4)' }
          : { backgroundColor: 'rgb(254, 226, 226)', color: 'rgb(153, 27, 27)', border: '1px solid rgb(252, 165, 165)' };
      default:
        return isDarkMode
          ? { backgroundColor: 'rgba(107, 114, 128, 0.1)', color: 'rgb(156, 163, 175)', border: '1px solid rgba(107, 114, 128, 0.3)' }
          : { backgroundColor: 'rgb(243, 244, 246)', color: 'rgb(55, 65, 81)', border: '1px solid rgb(209, 213, 219)' };
    }
  };

  const handleSummaryClick = (category: string) => {
    setExpandedSummary(expandedSummary === category ? null : category);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Compact Header */}
      <div className="px-4 py-4 border-b bg-card">
        {/* Title Row with Trace ID */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {trace.hasErrors ? (
              <XCircle size={18} className="text-red-700 dark:text-red-400 flex-shrink-0" />
            ) : (
              <CheckCircle2 size={18} className="text-green-700 dark:text-green-400 flex-shrink-0" />
            )}
            <h2 className="text-base font-semibold truncate">{trace.rootSpanName}</h2>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-mono">trace-{trace.traceId.slice(0, 8)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleCopyTraceId}
                title="Copy full trace ID"
              >
                {copiedTraceId ? (
                  <Check size={12} className="text-green-700 dark:text-green-400" />
                ) : (
                  <Copy size={12} />
                )}
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button 
              variant="outline" 
              size="icon" 
              className="h-8 w-8 border-border hover:bg-muted hover:border-muted-foreground/30" 
              onClick={() => setFullscreenOpen(true)}
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </Button>
            <Button 
              variant="outline" 
              size="icon" 
              className="h-8 w-8 border-border hover:bg-muted hover:border-muted-foreground/30" 
              onClick={onClose}
              title="Close"
            >
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* Unified Metrics Row - All key metrics as pills */}
        <div className="flex items-center gap-3 text-sm mb-4">
          {/* Core metrics */}
          <div className="flex items-center gap-2">
            <span className="font-medium">{trace.spanCount} spans</span>
            <span className="text-muted-foreground">•</span>
            <span className="font-medium text-amber-700 dark:text-amber-400">{formatDuration(trace.duration)}</span>
            {trace.hasErrors && (
              <>
                <span className="text-muted-foreground">•</span>
                <span className="text-red-700 dark:text-red-400 font-medium">
                  {spanStats.byStatus.error} {spanStats.byStatus.error === 1 ? 'error' : 'errors'}
                </span>
              </>
            )}
          </div>
          
          {/* Divider */}
          <div className="h-4 w-px bg-border" />
          
          {/* Start time */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Start time:</span>
            <span className="font-medium">{trace.startTime.toLocaleString()}</span>
          </div>
        </div>

        {/* Trace Summary Pills - Interactive and expandable */}
        <div className="space-y-2.5">
          {/* Compact Time Distribution Bar - No legend, hover for details */}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground font-medium text-xs whitespace-nowrap flex items-center gap-1">
              <Clock size={12} />
              Distribution:
            </span>
            <div className="flex-1">
              {/* Bar with comprehensive tooltip */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="h-5 rounded-md overflow-hidden flex bg-muted/30 border cursor-default">
                      {categoryStats.map((stat) => {
                        const colors = getCategoryColors(stat.category);
                        const widthPercent = Math.max(stat.percentage, 0.5);

                        return (
                          <div
                            key={stat.category}
                            className={cn('h-full flex items-center justify-center text-[10px] font-medium', colors.bar)}
                            style={{ width: `${widthPercent}%` }}
                          >
                            {stat.percentage >= 8 && (
                              <span className="text-white/90 truncate px-1">
                                {stat.percentage >= 12 ? stat.category : stat.category.slice(0, 3)}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent 
                    side="bottom" 
                    className="bg-gray-900 dark:bg-gray-800 border-gray-800 p-3 max-w-xs text-white [&>svg]:fill-gray-900 dark:[&>svg]:fill-gray-800"
                  >
                    <div className="space-y-1.5">
                      <div className="text-xs font-semibold mb-2">Time Distribution</div>
                      {categoryStats.map((stat) => {
                        const colors = getCategoryColors(stat.category);
                        const formattedPercent = stat.percentage < 1 
                          ? stat.percentage.toFixed(1) 
                          : stat.percentage.toFixed(0);
                        return (
                          <div key={stat.category} className="flex items-center justify-between gap-4 text-xs">
                            <div className="flex items-center gap-2">
                              <div className={cn('w-2.5 h-2.5 rounded-sm flex-shrink-0', colors.bar)} />
                              <span className="font-medium">{stat.category}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-300">
                              <span>{formatDuration(stat.totalDuration)}</span>
                              <span className="text-gray-400">({formattedPercent}%)</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Span Category Pills - Reduced padding */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground font-medium whitespace-nowrap">Span category:</span>
            <div className="flex items-center gap-2 flex-1">
              {spanStats.byCategory.llm?.count > 0 && (
                <button
                  onClick={() => handleSummaryClick('llm')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer flex-1"
                  style={
                    expandedSummary === 'llm'
                      ? document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(168, 85, 247, 0.25)', color: 'rgb(216, 180, 254)', border: '2px solid rgba(168, 85, 247, 0.6)' }
                        : { backgroundColor: 'rgb(233, 213, 255)', color: 'rgb(88, 28, 135)', border: '2px solid rgb(192, 132, 252)' }
                      : document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(168, 85, 247, 0.12)', color: 'rgb(192, 132, 252)', border: '2px solid rgba(168, 85, 247, 0.35)' }
                        : { backgroundColor: 'rgb(250, 245, 255)', color: 'rgb(107, 33, 168)', border: '2px solid rgb(216, 180, 254)' }
                  }
                  onMouseEnter={(e) => {
                    if (expandedSummary !== 'llm') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(168, 85, 247, 0.2)' : 'rgb(243, 232, 255)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(168, 85, 247, 0.5)' : 'rgb(192, 132, 252)';
                      e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (expandedSummary !== 'llm') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(168, 85, 247, 0.12)' : 'rgb(250, 245, 255)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(168, 85, 247, 0.35)' : 'rgb(216, 180, 254)';
                      e.currentTarget.style.boxShadow = 'none';
                    }
                  }}
                >
                  <MessageSquare size={11} className="flex-shrink-0" />
                  <span className="font-medium">{spanStats.byCategory.llm.count}</span>
                  <span className="font-normal">LLM</span>
                  <span className="text-[10px] opacity-70 ml-auto">{formatDuration(spanStats.byCategory.llm.duration)}</span>
                  {expandedSummary === 'llm' ? (
                    <ChevronDown size={11} />
                  ) : (
                    <ChevronRight size={11} />
                  )}
                </button>
              )}
              {spanStats.byCategory.agent?.count > 0 && (
                <button
                  onClick={() => handleSummaryClick('agent')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer flex-1"
                  style={
                    expandedSummary === 'agent'
                      ? document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(59, 130, 246, 0.25)', color: 'rgb(147, 197, 253)', border: '2px solid rgba(59, 130, 246, 0.6)' }
                        : { backgroundColor: 'rgb(191, 219, 254)', color: 'rgb(30, 64, 175)', border: '2px solid rgb(96, 165, 250)' }
                      : document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(59, 130, 246, 0.12)', color: 'rgb(96, 165, 250)', border: '2px solid rgba(59, 130, 246, 0.35)' }
                        : { backgroundColor: 'rgb(239, 246, 255)', color: 'rgb(29, 78, 216)', border: '2px solid rgb(147, 197, 253)' }
                  }
                  onMouseEnter={(e) => {
                    if (expandedSummary !== 'agent') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(59, 130, 246, 0.2)' : 'rgb(219, 234, 254)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(59, 130, 246, 0.5)' : 'rgb(96, 165, 250)';
                      e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (expandedSummary !== 'agent') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(59, 130, 246, 0.12)' : 'rgb(239, 246, 255)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(59, 130, 246, 0.35)' : 'rgb(147, 197, 253)';
                      e.currentTarget.style.boxShadow = 'none';
                    }
                  }}
                >
                  <Bot size={11} className="flex-shrink-0" />
                  <span className="font-medium">{spanStats.byCategory.agent.count}</span>
                  <span className="font-normal">Agent</span>
                  <span className="text-[10px] opacity-70 ml-auto">{formatDuration(spanStats.byCategory.agent.duration)}</span>
                  {expandedSummary === 'agent' ? (
                    <ChevronDown size={11} />
                  ) : (
                    <ChevronRight size={11} />
                  )}
                </button>
              )}
              {spanStats.byCategory.tool?.count > 0 && (
                <button
                  onClick={() => handleSummaryClick('tool')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer flex-1"
                  style={
                    expandedSummary === 'tool'
                      ? document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(245, 158, 11, 0.25)', color: 'rgb(252, 211, 77)', border: '2px solid rgba(245, 158, 11, 0.6)' }
                        : { backgroundColor: 'rgb(254, 243, 199)', color: 'rgb(120, 53, 15)', border: '2px solid rgb(251, 191, 36)' }
                      : document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(245, 158, 11, 0.12)', color: 'rgb(251, 191, 36)', border: '2px solid rgba(245, 158, 11, 0.35)' }
                        : { backgroundColor: 'rgb(255, 251, 235)', color: 'rgb(146, 64, 14)', border: '2px solid rgb(252, 211, 77)' }
                  }
                  onMouseEnter={(e) => {
                    if (expandedSummary !== 'tool') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(245, 158, 11, 0.2)' : 'rgb(254, 243, 199)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(245, 158, 11, 0.5)' : 'rgb(251, 191, 36)';
                      e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (expandedSummary !== 'tool') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(245, 158, 11, 0.12)' : 'rgb(255, 251, 235)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(245, 158, 11, 0.35)' : 'rgb(252, 211, 77)';
                      e.currentTarget.style.boxShadow = 'none';
                    }
                  }}
                >
                  <Wrench size={11} className="flex-shrink-0" />
                  <span className="font-medium">{spanStats.byCategory.tool.count}</span>
                  <span className="font-normal">Tool Calls</span>
                  <span className="text-[10px] opacity-70 ml-auto">{formatDuration(spanStats.byCategory.tool.duration)}</span>
                  {expandedSummary === 'tool' ? (
                    <ChevronDown size={11} />
                  ) : (
                    <ChevronRight size={11} />
                  )}
                </button>
              )}
              {trace.hasErrors && (
                <button
                  onClick={() => handleSummaryClick('error')}
                  className="inline-flex items-center justify-between gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer flex-1"
                  style={
                    expandedSummary === 'error'
                      ? document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(239, 68, 68, 0.25)', color: 'rgb(252, 165, 165)', border: '2px solid rgba(239, 68, 68, 0.6)' }
                        : { backgroundColor: 'rgb(254, 226, 226)', color: 'rgb(127, 29, 29)', border: '2px solid rgb(248, 113, 113)' }
                      : document.documentElement.classList.contains('dark')
                        ? { backgroundColor: 'rgba(239, 68, 68, 0.12)', color: 'rgb(248, 113, 113)', border: '2px solid rgba(239, 68, 68, 0.35)' }
                        : { backgroundColor: 'rgb(255, 241, 242)', color: 'rgb(153, 27, 27)', border: '2px solid rgb(252, 165, 165)' }
                  }
                  onMouseEnter={(e) => {
                    if (expandedSummary !== 'error') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgb(254, 226, 226)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(239, 68, 68, 0.5)' : 'rgb(248, 113, 113)';
                      e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (expandedSummary !== 'error') {
                      const isDark = document.documentElement.classList.contains('dark');
                      e.currentTarget.style.backgroundColor = isDark ? 'rgba(239, 68, 68, 0.12)' : 'rgb(255, 241, 242)';
                      e.currentTarget.style.borderColor = isDark ? 'rgba(239, 68, 68, 0.35)' : 'rgb(252, 165, 165)';
                      e.currentTarget.style.boxShadow = 'none';
                    }
                  }}
                >
                  <div className="inline-flex items-center gap-1.5">
                    <XCircle size={11} className="flex-shrink-0" />
                    <span className="font-medium">{spanStats.byStatus.error}</span>
                    <span className="font-normal">Error{spanStats.byStatus.error !== 1 ? 's' : ''}</span>
                  </div>
                  {expandedSummary === 'error' ? (
                    <ChevronDown size={11} className="flex-shrink-0" />
                  ) : (
                    <ChevronRight size={11} className="flex-shrink-0" />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Expanded Details Container - Below Span Category */}
          {expandedSummary && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground font-medium text-xs whitespace-nowrap invisible">Span category:</span>
              <div className="flex-1 p-2.5 rounded-md bg-muted/50 dark:bg-muted/50 border border-border relative">
                <button
                  onClick={() => setExpandedSummary(null)}
                  className="absolute top-2 right-2 p-1 rounded-md hover:bg-background/80 transition-colors"
                  title="Close"
                >
                  <X size={14} className="text-muted-foreground" />
                </button>
                {expandedSummary === 'tool' ? (
                  // Special layout for tools: show unique tools count + individual tool pills
                  <div className="pr-8">
                    <div className="flex items-center gap-2 mb-2 text-xs">
                      <Wrench size={12} className="text-amber-700 dark:text-amber-400" />
                      <span className="font-medium text-muted-foreground">Unique Tools:</span>
                      <span className="font-semibold">{toolStats.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {getCategoryDetails(expandedSummary).map((item, idx) => (
                        <div
                          key={idx}
                          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md text-xs font-medium"
                          style={getCategoryDetailStyle(expandedSummary)}
                        >
                          <span>{item.name}</span>
                          {item.count > 1 && (
                            <span className="opacity-70">×{item.count}</span>
                          )}
                          <span className="opacity-70">{formatDuration(item.duration)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  // Standard layout for other categories
                  <div className="flex flex-wrap gap-2 pr-8">
                    {getCategoryDetails(expandedSummary).map((item, idx) => (
                      <div
                        key={idx}
                        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md text-xs font-medium"
                        style={getCategoryDetailStyle(expandedSummary)}
                      >
                        <span>{item.name}</span>
                        {item.count > 1 && (
                          <span className="opacity-70">×{item.count}</span>
                        )}
                        <span className="opacity-70">{formatDuration(item.duration)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content - View Toggle + Visualization */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* View Toggle */}
        <div className="px-4 py-3 border-b bg-card">
          <div className="inline-flex items-center rounded-lg border bg-muted p-1 gap-1">
            <Button
              variant={viewMode === 'timeline' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setViewMode('timeline')}
            >
              <Network size={14} className="mr-1.5" />
              Trace tree
            </Button>
            <Button
              variant={viewMode === 'agent-map' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setViewMode('agent-map')}
            >
              <GitBranch size={14} className="mr-1.5" />
              Agent map
            </Button>
            <Button
              variant={viewMode === 'gantt' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setViewMode('gantt')}
            >
              <List size={14} className="mr-1.5" />
              Timeline
            </Button>
            {/* Info tab hidden - keep code for potential future use
            <Button
              variant={viewMode === 'stats' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => setViewMode('stats')}
            >
              <Info size={14} className="mr-1.5" />
              Info
            </Button>
            */}
          </div>
        </div>
        
        {/* Visualization Content */}
        <div className="flex-1 overflow-hidden">
          <TraceVisualization
            spanTree={spanTree}
            timeRange={timeRange}
            initialViewMode={viewMode}
            onViewModeChange={setViewMode}
            showViewToggle={false}
            selectedSpan={selectedSpan}
            onSelectSpan={setSelectedSpan}
            expandedSpans={expandedSpans}
            onToggleExpand={handleToggleExpand}
            showSpanDetailsPanel={true}
          />
        </div>
      </div>

      {/* Fullscreen View */}
      <TraceFullScreenView
        open={fullscreenOpen}
        onOpenChange={setFullscreenOpen}
        title={trace.rootSpanName}
        subtitle={`Trace ID: ${trace.traceId.slice(0, 16)}...`}
        spanTree={spanTree}
        timeRange={timeRange}
        selectedSpan={selectedSpan}
        onSelectSpan={setSelectedSpan}
        initialViewMode={viewMode}
        onViewModeChange={setViewMode}
        spanCount={trace.spanCount}
      />
    </div>
  );
};

export default TraceFlyoutContent;
