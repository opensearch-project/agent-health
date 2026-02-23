/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceInfoView
 *
 * Displays trace overview information including span count, duration,
 * start time, distribution bar, and span category breakdown with expandable details.
 * Matches the functionality shown at the top of the trace flyout.
 */

import React, { useMemo, useState } from 'react';
import { Clock, Bot, MessageSquare, Wrench, XCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { Span } from '@/types';
import { cn } from '@/lib/utils';
import { getTheme } from '@/lib/theme';
import { formatDuration } from '@/services/traces/utils';
import {
  flattenSpans,
  calculateCategoryStats,
  extractToolStats,
} from '@/services/traces/traceStats';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { getCategoryColors } from '@/services/traces';

interface TraceInfoViewProps {
  spanTree: Span[];
  runId?: string; // Optional Run ID to display
}

const TraceInfoView: React.FC<TraceInfoViewProps> = ({ spanTree, runId }) => {
  const [expandedSummary, setExpandedSummary] = useState<string | null>(null);

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

  // Calculate time range
  const timeRange = useMemo(() => {
    if (allSpans.length === 0) return { duration: 0 };
    const startTime = Math.min(...allSpans.map(s => new Date(s.startTime).getTime()));
    const endTime = Math.max(...allSpans.map(s => new Date(s.endTime).getTime()));
    return { duration: endTime - startTime };
  }, [allSpans]);

  // Calculate statistics
  const categoryStats = useMemo(
    () => calculateCategoryStats(allSpans, timeRange.duration),
    [allSpans, timeRange.duration]
  );

  // Extract tool information
  const toolStats = useMemo(
    () => extractToolStats(allSpans),
    [allSpans]
  );

  // Calculate span stats by category
  const spanStats = useMemo(() => {
    const byStatus = allSpans.reduce(
      (acc, span) => {
        if (span.status === 'ERROR') acc.error++;
        else if (span.status === 'OK') acc.ok++;
        else acc.unset++;
        return acc;
      },
      { ok: 0, error: 0, unset: 0 }
    );

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
  }, [allSpans, categoryStats]);

  // Get detailed breakdown for each category
  const getCategoryDetails = (category: string) => {
    const spans = allSpans.filter(span => {
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

  // Keep old function for backwards compatibility but mark as deprecated
  const getCategoryDetailColors = (category: string) => {
    switch (category) {
      case 'agent':
        return 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/30';
      case 'llm':
        return 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/30';
      case 'tool':
        return 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30';
      case 'error':
        return 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30';
      default:
        return 'bg-muted text-foreground border-border';
    }
  };

  const handleSummaryClick = (category: string) => {
    setExpandedSummary(expandedSummary === category ? null : category);
  };

  // Calculate total duration and start time
  const totalDuration = useMemo(() => {
    return allSpans.reduce((sum, span) => sum + span.duration, 0);
  }, [allSpans]);

  const startTime = useMemo(() => {
    if (allSpans.length === 0) return null;
    return Math.min(...allSpans.map(s => new Date(s.startTime).getTime()));
  }, [allSpans]);

  const formatTimestamp = (timestamp: number | null) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  if (allSpans.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No trace data available
      </div>
    );
  }

  const hasErrors = spanStats.byStatus.error > 0;

  return (
    <div className="p-6 space-y-6">
      {/* Overview Stats - Single consolidated row with all metadata */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="font-medium">{allSpans.length} spans captured</span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">Duration:</span>
          <span className="font-medium text-amber-700 dark:text-amber-400">{formatDuration(totalDuration)}</span>
          {hasErrors && (
            <>
              <span className="text-muted-foreground">•</span>
              <span className="text-muted-foreground">Errors:</span>
              <span className="text-red-700 dark:text-red-400 font-medium">
                {spanStats.byStatus.error}
              </span>
            </>
          )}
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">Start time:</span>
          <span className="font-medium text-xs">
            {formatTimestamp(startTime)}
          </span>
          {runId && (
            <>
              <span className="text-muted-foreground">•</span>
              <span className="text-muted-foreground">Run ID:</span>
              <span className="font-mono text-xs font-medium">{runId}</span>
            </>
          )}
        </div>
      </div>

      {/* Distribution Bar - Larger with legend */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-muted-foreground" />
            <span className="text-muted-foreground font-medium text-sm">Time Distribution</span>
          </div>
          <span className="text-sm font-medium text-muted-foreground">{formatDuration(totalDuration)}</span>
        </div>
        
        {/* Larger bar */}
        <div className="h-12 rounded-lg overflow-hidden flex border-2">
          {categoryStats.map((stat) => {
            const colors = getCategoryColors(stat.category);
            const widthPercent = Math.max(stat.percentage, 0.5);

            return (
              <div
                key={stat.category}
                className={cn('h-full flex items-center justify-center text-sm font-semibold', colors.bar)}
                style={{ width: `${widthPercent}%` }}
                title={`${stat.category}: ${formatDuration(stat.totalDuration)} (${stat.percentage.toFixed(1)}%)`}
              >
                {stat.percentage >= 10 && (
                  <span className="text-white/95 truncate px-2">
                    {stat.category}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend below bar */}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {categoryStats.map((stat) => {
            const colors = getCategoryColors(stat.category);
            const formattedPercent = stat.percentage < 1 
              ? stat.percentage.toFixed(1) 
              : stat.percentage.toFixed(0);
            
            return (
              <div key={stat.category} className="flex items-center gap-2">
                <div className={cn('w-3 h-3 rounded-sm flex-shrink-0', colors.bar)} />
                <span className="font-medium">{stat.category}</span>
                <span className="text-muted-foreground">
                  {formattedPercent}% ({formatDuration(stat.totalDuration)})
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Span Category Pills */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-medium text-sm">Span category:</span>
        </div>
        <div className="flex flex-row flex-wrap gap-2">
          {spanStats.byCategory.agent?.count > 0 && (
            <button
              onClick={() => handleSummaryClick('agent')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer',
                expandedSummary === 'agent'
                  ? 'bg-blue-100 text-blue-900 border-blue-400 dark:bg-blue-500/20 dark:text-blue-200 dark:border-blue-500/50'
                  : 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/30 hover:bg-blue-100 hover:border-blue-400 hover:shadow-md dark:hover:bg-blue-500/20 dark:hover:border-blue-500/50'
              )}
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
          {spanStats.byCategory.llm?.count > 0 && (
            <button
              onClick={() => handleSummaryClick('llm')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer',
                expandedSummary === 'llm'
                  ? 'bg-purple-100 text-purple-900 border-purple-400 dark:bg-purple-500/20 dark:text-purple-200 dark:border-purple-500/50'
                  : 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/30 hover:bg-purple-100 hover:border-purple-400 hover:shadow-md dark:hover:bg-purple-500/20 dark:hover:border-purple-500/50'
              )}
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
          {spanStats.byCategory.tool?.count > 0 && (
            <button
              onClick={() => handleSummaryClick('tool')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer',
                expandedSummary === 'tool'
                  ? 'bg-amber-100 text-amber-900 border-amber-400 dark:bg-amber-500/20 dark:text-amber-200 dark:border-amber-500/50'
                  : 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30 hover:bg-amber-100 hover:border-amber-400 hover:shadow-md dark:hover:bg-amber-500/20 dark:hover:border-amber-500/50'
              )}
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
          {hasErrors && (
            <button
              onClick={() => handleSummaryClick('error')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 transition-all cursor-pointer',
                expandedSummary === 'error'
                  ? 'bg-red-100 text-red-900 border-red-400 dark:bg-red-500/20 dark:text-red-200 dark:border-red-500/50'
                  : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30 hover:bg-red-100 hover:border-red-400 hover:shadow-md dark:hover:bg-red-500/20 dark:hover:border-red-500/50'
              )}
            >
              <XCircle size={11} className="flex-shrink-0" />
              <span className="font-medium">{spanStats.byStatus.error}</span>
              <span className="font-normal">Error{spanStats.byStatus.error !== 1 ? 's' : ''}</span>
              {expandedSummary === 'error' ? (
                <ChevronDown size={11} />
              ) : (
                <ChevronRight size={11} />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expanded Details Container */}
      {expandedSummary && (
        <div className="p-2.5 rounded-md bg-muted/50 dark:bg-muted/50 border border-border relative">
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
      )}
    </div>
  );
};

export default TraceInfoView;
