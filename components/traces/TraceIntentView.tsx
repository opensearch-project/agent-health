/**
 * TraceIntentView - Summary dashboard for agent execution
 *
 * Shows a high-level overview of agent execution:
 * - Summary stats (LLM calls, tool calls, errors)
 * - List of unique tools used
 * - Time distribution bar by category
 *
 * This provides a quick "intent" understanding without overwhelming
 * with detailed phase blocks (which Timeline/Flow views provide).
 */

import React, { useMemo } from 'react';
import { Bot, Zap, Wrench, AlertCircle, Clock } from 'lucide-react';
import { Span, TimeRange, CategorizedSpan, SpanCategory } from '@/types';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { getRootContainerSpan } from '@/services/traces/intentTransform';
import { formatDuration } from '@/services/traces/utils';
import { getCategoryColors } from '@/services/traces';
import { cn } from '@/lib/utils';

interface TraceIntentViewProps {
  spanTree: Span[];
  timeRange: TimeRange;
}

interface CategoryStats {
  category: SpanCategory;
  count: number;
  totalDuration: number;
  percentage: number;
}

interface ToolInfo {
  name: string;
  count: number;
  totalDuration: number;
}

/**
 * Extract tool name from a span
 */
function extractToolName(span: CategorizedSpan): string | null {
  // Try gen_ai.tool.name attribute first
  const toolName = span.attributes?.['gen_ai.tool.name'];
  if (toolName) return toolName;

  // Parse from displayName or name
  const name = span.displayName || span.name || '';

  // Look for tool name patterns
  const patterns = [
    /execute_tool\s+(\S+)/i,
    /executeTools,\s*(\S+)/i,
    /tool\.execute\s+(\S+)/i,
  ];

  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) return match[1];
  }

  // Try to get the last meaningful part after comma
  if (name.includes(',')) {
    const parts = name.split(',');
    const lastPart = parts[parts.length - 1].trim();
    if (lastPart && !lastPart.includes('agent.node')) {
      return lastPart;
    }
  }

  return null;
}

/**
 * Flatten span tree and collect all spans
 */
function flattenSpans(spans: CategorizedSpan[]): CategorizedSpan[] {
  const result: CategorizedSpan[] = [];

  const collect = (spanList: CategorizedSpan[]) => {
    for (const span of spanList) {
      result.push(span);
      if (span.children && span.children.length > 0) {
        collect(span.children as CategorizedSpan[]);
      }
    }
  };

  collect(spans);
  return result;
}

/**
 * Calculate category statistics from spans
 */
function calculateCategoryStats(spans: CategorizedSpan[], totalDuration: number): CategoryStats[] {
  const categoryMap = new Map<SpanCategory, { count: number; duration: number }>();

  for (const span of spans) {
    const existing = categoryMap.get(span.category) || { count: 0, duration: 0 };
    categoryMap.set(span.category, {
      count: existing.count + 1,
      duration: existing.duration + (span.duration || 0),
    });
  }

  const stats: CategoryStats[] = [];
  categoryMap.forEach((data, category) => {
    const rawPercentage = totalDuration > 0 ? (data.duration / totalDuration) * 100 : 0;
    stats.push({
      category,
      count: data.count,
      totalDuration: data.duration,
      percentage: Math.min(rawPercentage, 100),
    });
  });

  // Sort by duration descending
  return stats.sort((a, b) => b.totalDuration - a.totalDuration);
}

/**
 * Extract unique tools with usage stats
 */
function extractToolStats(spans: CategorizedSpan[]): ToolInfo[] {
  const toolMap = new Map<string, { count: number; duration: number }>();

  for (const span of spans) {
    if (span.category === 'TOOL') {
      const toolName = extractToolName(span);
      if (toolName) {
        const existing = toolMap.get(toolName) || { count: 0, duration: 0 };
        toolMap.set(toolName, {
          count: existing.count + 1,
          duration: existing.duration + (span.duration || 0),
        });
      }
    }
  }

  const tools: ToolInfo[] = [];
  toolMap.forEach((data, name) => {
    tools.push({
      name,
      count: data.count,
      totalDuration: data.duration,
    });
  });

  // Sort by usage count descending
  return tools.sort((a, b) => b.count - a.count);
}

/**
 * Stat card component
 */
const StatCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number | string;
  subtext?: string;
  colorClass?: string;
}> = ({ icon, label, value, subtext, colorClass = 'text-muted-foreground' }) => (
  <div className="bg-muted/30 rounded-lg p-4 flex flex-col gap-1">
    <div className={cn('flex items-center gap-2 text-sm', colorClass)}>
      {icon}
      <span>{label}</span>
    </div>
    <div className="text-2xl font-bold">{value}</div>
    {subtext && <div className="text-xs text-muted-foreground">{subtext}</div>}
  </div>
);

/**
 * Time distribution bar component
 */
const TimeDistributionBar: React.FC<{
  stats: CategoryStats[];
  totalDuration: number;
}> = ({ stats, totalDuration }) => {
  if (stats.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground flex items-center gap-2">
          <Clock size={14} />
          Time Distribution
        </span>
        <span className="font-mono text-muted-foreground">{formatDuration(totalDuration)}</span>
      </div>

      {/* Bar */}
      <div className="h-8 rounded-md overflow-hidden flex bg-muted/30">
        {stats.map((stat) => {
          const colors = getCategoryColors(stat.category);
          const widthPercent = Math.max(stat.percentage, 1); // Min 1% for visibility

          return (
            <div
              key={stat.category}
              className={cn('h-full flex items-center justify-center text-xs font-medium', colors.bar)}
              style={{ width: `${widthPercent}%` }}
              title={`${stat.category}: ${formatDuration(stat.totalDuration)} (${stat.percentage.toFixed(1)}%)`}
            >
              {stat.percentage >= 8 && (
                <span className="text-white/90 truncate px-1">
                  {stat.category}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        {stats.map((stat) => {
          const colors = getCategoryColors(stat.category);
          return (
            <div key={stat.category} className="flex items-center gap-2">
              <div className={cn('w-3 h-3 rounded-sm', colors.bar)} />
              <span className={colors.text}>{stat.category}</span>
              <span className="text-muted-foreground">
                {stat.percentage.toFixed(0)}% ({formatDuration(stat.totalDuration)})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const TraceIntentView: React.FC<TraceIntentViewProps> = ({
  spanTree,
  timeRange,
}) => {
  // Categorize spans
  const categorizedTree = useMemo(
    () => categorizeSpanTree(spanTree),
    [spanTree]
  );

  // Get root container for header
  const rootContainer = useMemo(
    () => getRootContainerSpan(categorizedTree),
    [categorizedTree]
  );

  // Flatten all spans for analysis
  const allSpans = useMemo(
    () => flattenSpans(categorizedTree),
    [categorizedTree]
  );

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

  // Get counts by category
  const llmCount = categoryStats.find(s => s.category === 'LLM')?.count || 0;
  const toolCount = categoryStats.find(s => s.category === 'TOOL')?.count || 0;
  const errorCount = categoryStats.find(s => s.category === 'ERROR')?.count || 0;
  const llmDuration = categoryStats.find(s => s.category === 'LLM')?.totalDuration || 0;
  const toolDuration = categoryStats.find(s => s.category === 'TOOL')?.totalDuration || 0;

  if (spanTree.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No spans to display
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      {rootContainer && (
        <div className="flex items-center justify-between px-4 py-3 border-b bg-background/50">
          <div className="flex items-center gap-2">
            <Bot className="text-indigo-400" size={18} />
            <span className="font-semibold text-sm">
              {rootContainer.displayName || rootContainer.name}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{allSpans.length} spans</span>
            <span className="font-mono">{formatDuration(timeRange.duration)}</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon={<Zap size={16} />}
            label="LLM Calls"
            value={llmCount}
            subtext={formatDuration(llmDuration)}
            colorClass="text-purple-400"
          />
          <StatCard
            icon={<Wrench size={16} />}
            label="Tool Calls"
            value={toolCount}
            subtext={formatDuration(toolDuration)}
            colorClass="text-amber-400"
          />
          <StatCard
            icon={<Wrench size={16} />}
            label="Unique Tools"
            value={toolStats.length}
            colorClass="text-amber-400"
          />
          <StatCard
            icon={<AlertCircle size={16} />}
            label="Errors"
            value={errorCount}
            colorClass={errorCount > 0 ? 'text-red-400' : 'text-muted-foreground'}
          />
        </div>

        {/* Tools Used */}
        {toolStats.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Wrench size={14} />
              Tools Used
            </h3>
            <div className="flex flex-wrap gap-2">
              {toolStats.map((tool) => (
                <div
                  key={tool.name}
                  className="bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-1.5 text-sm"
                >
                  <span className="text-amber-400 font-medium">{tool.name}</span>
                  {tool.count > 1 && (
                    <span className="text-amber-400/70 ml-1">×{tool.count}</span>
                  )}
                  <span className="text-muted-foreground ml-2 text-xs">
                    {formatDuration(tool.totalDuration)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Time Distribution */}
        <TimeDistributionBar stats={categoryStats} totalDuration={timeRange.duration} />
      </div>
    </div>
  );
};

export default TraceIntentView;
