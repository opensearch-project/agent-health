/**
 * TraceTreeComparison
 *
 * Side-by-side trace tree comparison view for the Comparison page.
 * Shows aligned span trees with diff highlighting (matched, added, removed, modified).
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Activity, RefreshCw, AlertCircle, ChevronRight, ChevronDown, Bot, Zap, Wrench, Circle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  EvaluationReport,
  ExperimentRun,
  Span,
  CategorizedSpan,
  AlignedSpanPair,
  TraceComparisonResult,
  SpanCategory,
} from '@/types';
import {
  fetchTracesByRunIds,
  processSpansIntoTree,
  compareTraces,
  getComparisonTypeInfo,
  categorizeSpanTree,
  getCategoryMeta,
} from '@/services/traces';
import { formatDuration } from '@/services/traces/utils';

interface TraceTreeComparisonProps {
  runs: ExperimentRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
}

interface TraceData {
  runId: string;
  runName: string;
  spans: Span[];
  loading: boolean;
  error: string | null;
}

/**
 * Get the icon component for a category
 */
function getCategoryIcon(category: SpanCategory): React.ReactNode {
  const iconProps = { size: 12, className: 'shrink-0' };
  switch (category) {
    case 'AGENT':
      return <Bot {...iconProps} />;
    case 'LLM':
      return <Zap {...iconProps} />;
    case 'TOOL':
      return <Wrench {...iconProps} />;
    default:
      return <Circle {...iconProps} />;
  }
}

/**
 * Stats banner showing comparison summary
 */
const ComparisonStats: React.FC<{ stats: TraceComparisonResult['stats'] }> = ({ stats }) => {
  return (
    <div className="flex items-center gap-4 px-3 py-2 bg-muted/30 border-b text-xs">
      <span className="text-muted-foreground">
        Left: <span className="font-mono">{stats.totalLeft}</span> spans
      </span>
      <span className="text-muted-foreground">
        Right: <span className="font-mono">{stats.totalRight}</span> spans
      </span>
      <div className="flex-1" />
      <Badge variant="outline" className="bg-slate-500/10 text-slate-400 border-slate-500/30">
        {stats.matched} matched
      </Badge>
      {stats.added > 0 && (
        <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/30">
          +{stats.added} added
        </Badge>
      )}
      {stats.removed > 0 && (
        <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30">
          -{stats.removed} removed
        </Badge>
      )}
      {stats.modified > 0 && (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/30">
          ~{stats.modified} modified
        </Badge>
      )}
    </div>
  );
};

/**
 * Aligned span row showing left and right spans with diff styling
 */
interface AlignedSpanRowProps {
  pair: AlignedSpanPair;
  depth: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const AlignedSpanRow: React.FC<AlignedSpanRowProps> = ({
  pair,
  depth,
  isExpanded,
  onToggleExpand,
}) => {
  const hasChildren = (pair.children?.length || 0) > 0;
  const typeInfo = getComparisonTypeInfo(pair.type);

  const renderSpanContent = (span: CategorizedSpan | undefined, side: 'left' | 'right') => {
    if (!span) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs italic">
          {side === 'left' && pair.type === 'added' && '—'}
          {side === 'right' && pair.type === 'removed' && '—'}
        </div>
      );
    }

    const meta = getCategoryMeta(span.category);
    const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();

    return (
      <div className="flex-1 flex items-center gap-2 min-w-0">
        {/* Category Badge */}
        <Badge
          variant="outline"
          className={cn(
            'h-5 px-1.5 gap-1 text-[10px] font-medium shrink-0',
            meta.bgColor,
            meta.color
          )}
        >
          {getCategoryIcon(span.category)}
          <span className="hidden lg:inline">{span.categoryLabel}</span>
        </Badge>

        {/* Span Display Name */}
        <span
          className="text-xs font-mono truncate flex-1"
          title={span.displayName}
        >
          {span.displayName}
        </span>

        {/* Duration */}
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
          {formatDuration(duration)}
        </span>
      </div>
    );
  };

  return (
    <div
      className={cn(
        'flex items-stretch border-b border-border/50 hover:bg-muted/30 transition-colors',
        typeInfo.bgColor
      )}
      style={{ paddingLeft: `${depth * 16}px` }}
    >
      {/* Expand/Collapse */}
      <button
        className={cn(
          'w-6 h-8 flex items-center justify-center shrink-0',
          !hasChildren && 'invisible'
        )}
        onClick={onToggleExpand}
        disabled={!hasChildren}
      >
        {hasChildren && (
          isExpanded ? (
            <ChevronDown size={12} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="text-muted-foreground" />
          )
        )}
      </button>

      {/* Left span */}
      <div className="flex-1 flex items-center gap-2 py-1 pr-2 border-r border-border/50">
        {renderSpanContent(pair.leftSpan, 'left')}
      </div>

      {/* Right span */}
      <div className="flex-1 flex items-center gap-2 py-1 pl-2">
        {renderSpanContent(pair.rightSpan, 'right')}
      </div>
    </div>
  );
};

/**
 * Recursive tree renderer for aligned pairs
 */
function renderAlignedTree(
  pairs: AlignedSpanPair[],
  depth: number,
  expandedPairs: Set<string>,
  onToggleExpand: (id: string) => void
): React.ReactNode[] {
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const pairId = `${depth}-${i}-${pair.leftSpan?.spanId || ''}-${pair.rightSpan?.spanId || ''}`;
    const isExpanded = expandedPairs.has(pairId);
    const hasChildren = (pair.children?.length || 0) > 0;

    elements.push(
      <AlignedSpanRow
        key={pairId}
        pair={pair}
        depth={depth}
        isExpanded={isExpanded}
        onToggleExpand={() => onToggleExpand(pairId)}
      />
    );

    // Render children if expanded
    if (hasChildren && isExpanded && pair.children) {
      elements.push(
        ...renderAlignedTree(pair.children, depth + 1, expandedPairs, onToggleExpand)
      );
    }
  }

  return elements;
}

/**
 * Main TraceTreeComparison component
 */
export const TraceTreeComparison: React.FC<TraceTreeComparisonProps> = ({
  runs,
  reports,
  useCaseId,
}) => {
  const [traceData, setTraceData] = useState<Map<string, TraceData>>(new Map());
  const [expandedPairs, setExpandedPairs] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);

  // Get run IDs from reports
  const runInfos = useMemo(() => {
    return runs.map(run => {
      const result = run.results[useCaseId];
      const report = result?.reportId ? reports[result.reportId] : null;
      return {
        experimentRunId: run.id,
        runName: run.name,
        agentRunId: report?.runId || null,
      };
    }).filter(info => info.agentRunId);
  }, [runs, reports, useCaseId]);

  // Fetch traces for all runs
  const fetchAllTraces = useCallback(async () => {
    if (runInfos.length === 0) return;

    setIsLoading(true);

    const newTraceData = new Map<string, TraceData>();

    for (const info of runInfos) {
      if (!info.agentRunId) continue;

      newTraceData.set(info.experimentRunId, {
        runId: info.agentRunId,
        runName: info.runName,
        spans: [],
        loading: true,
        error: null,
      });
    }
    setTraceData(new Map(newTraceData));

    // Fetch traces in parallel
    await Promise.all(
      runInfos.map(async (info) => {
        if (!info.agentRunId) return;

        try {
          const result = await fetchTracesByRunIds([info.agentRunId]);
          const spanTree = processSpansIntoTree(result.spans);

          setTraceData(prev => {
            const updated = new Map(prev);
            updated.set(info.experimentRunId, {
              runId: info.agentRunId!,
              runName: info.runName,
              spans: spanTree,
              loading: false,
              error: null,
            });
            return updated;
          });
        } catch (error) {
          setTraceData(prev => {
            const updated = new Map(prev);
            updated.set(info.experimentRunId, {
              runId: info.agentRunId!,
              runName: info.runName,
              spans: [],
              loading: false,
              error: error instanceof Error ? error.message : 'Failed to fetch traces',
            });
            return updated;
          });
        }
      })
    );

    setIsLoading(false);
  }, [runInfos]);

  // Fetch traces on mount
  useEffect(() => {
    fetchAllTraces();
  }, [fetchAllTraces]);

  // Initialize expanded state when comparison changes
  useEffect(() => {
    // Expand all by default
    const allIds = new Set<string>();
    const collectIds = (pairs: AlignedSpanPair[], depth: number) => {
      pairs.forEach((pair, i) => {
        if (pair.children && pair.children.length > 0) {
          const pairId = `${depth}-${i}-${pair.leftSpan?.spanId || ''}-${pair.rightSpan?.spanId || ''}`;
          allIds.add(pairId);
          collectIds(pair.children, depth + 1);
        }
      });
    };

    // Build comparison from first two runs
    const traceArray = Array.from(traceData.values());
    if (traceArray.length >= 2 && !traceArray[0].loading && !traceArray[1].loading) {
      const comparison = compareTraces(traceArray[0].spans, traceArray[1].spans);
      collectIds(comparison.alignedTree, 0);
      setExpandedPairs(allIds);
    }
  }, [traceData]);

  // Toggle expand handler
  const handleToggleExpand = useCallback((id: string) => {
    setExpandedPairs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  // Get first two traces for comparison
  const traceArray = Array.from(traceData.values());
  const leftTrace = traceArray[0];
  const rightTrace = traceArray[1];

  // Compute comparison result
  const comparisonResult = useMemo(() => {
    if (!leftTrace || !rightTrace || leftTrace.loading || rightTrace.loading) {
      return null;
    }
    if (leftTrace.error || rightTrace.error) {
      return null;
    }
    return compareTraces(leftTrace.spans, rightTrace.spans);
  }, [leftTrace, rightTrace]);

  // Show message if not enough runs
  if (runs.length < 2) {
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8 text-center">
          <Activity size={32} className="mx-auto mb-2 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">
            Select at least 2 runs to compare traces
          </p>
        </CardContent>
      </Card>
    );
  }

  // Show loading state
  if (isLoading || !leftTrace || !rightTrace || leftTrace.loading || rightTrace.loading) {
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8 text-center">
          <RefreshCw size={24} className="mx-auto mb-2 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading traces...</p>
        </CardContent>
      </Card>
    );
  }

  // Show error state
  if (leftTrace.error || rightTrace.error) {
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2 text-red-400 mb-4">
            <AlertCircle size={16} />
            <span className="text-sm">Failed to load traces</span>
          </div>
          {leftTrace.error && (
            <p className="text-xs text-muted-foreground text-center mb-1">
              {leftTrace.runName}: {leftTrace.error}
            </p>
          )}
          {rightTrace.error && (
            <p className="text-xs text-muted-foreground text-center mb-1">
              {rightTrace.runName}: {rightTrace.error}
            </p>
          )}
          <div className="text-center mt-4">
            <Button variant="outline" size="sm" onClick={fetchAllTraces}>
              <RefreshCw size={14} className="mr-1.5" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show empty state
  if (!comparisonResult || comparisonResult.alignedTree.length === 0) {
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8 text-center">
          <Activity size={32} className="mx-auto mb-2 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">
            No trace data available for comparison
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Traces may take a few minutes to propagate after agent execution
          </p>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={fetchAllTraces}>
              <RefreshCw size={14} className="mr-1.5" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50 overflow-hidden">
      <CardHeader className="py-2 px-4 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity size={14} />
            Trace Comparison
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchAllTraces} disabled={isLoading}>
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </CardHeader>

      {/* Stats Banner */}
      <ComparisonStats stats={comparisonResult.stats} />

      {/* Column Headers */}
      <div className="flex items-center border-b bg-muted/50 text-xs font-medium">
        <div className="w-6" /> {/* Spacer for chevron */}
        <div className="flex-1 py-2 px-2 border-r border-border/50 text-center">
          {leftTrace.runName}
          <span className="text-muted-foreground ml-2">({comparisonResult.stats.totalLeft} spans)</span>
        </div>
        <div className="flex-1 py-2 px-2 text-center">
          {rightTrace.runName}
          <span className="text-muted-foreground ml-2">({comparisonResult.stats.totalRight} spans)</span>
        </div>
      </div>

      {/* Aligned Tree */}
      <ScrollArea className="h-[400px]">
        <div>
          {renderAlignedTree(
            comparisonResult.alignedTree,
            0,
            expandedPairs,
            handleToggleExpand
          )}
        </div>
      </ScrollArea>
    </Card>
  );
};

export default TraceTreeComparison;
