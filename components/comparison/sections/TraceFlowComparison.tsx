/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceFlowComparison
 *
 * Side-by-side and merged Flow visualization for trace comparison.
 * Uses React Flow to display DAG visualization of aligned span trees.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Activity, RefreshCw, AlertCircle, GitMerge, Columns, Maximize2, Minimize2 } from 'lucide-react';
import {
  ReactFlow,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  FullScreenDialog,
  FullScreenDialogContent,
  FullScreenDialogHeader,
  FullScreenDialogTitle,
  FullScreenDialogCloseButton,
} from '@/components/ui/fullscreen-dialog';
import {
  EvaluationReport,
  BenchmarkRun,
  Span,
  CategorizedSpan,
  AlignedSpanPair,
  TraceComparisonResult,
  SpanNodeData,
  TimeRange,
} from '@/types';
import {
  fetchTracesByRunIds,
  processSpansIntoTree,
  calculateTimeRange,
  compareTraces,
  categorizeSpanTree,
} from '@/services/traces';
import { spansToFlow, applyDagreLayout } from '@/services/traces/flowTransform';
import { nodeTypes } from '@/components/traces/flow/nodeTypes';
import SpanDetailsPanel from '@/components/traces/SpanDetailsPanel';

type ComparisonMode = 'side-by-side' | 'merged';
type DiffType = 'matched' | 'added' | 'removed' | 'modified';

interface TraceFlowComparisonProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
}

interface TraceData {
  runId: string;
  runName: string;
  spans: Span[];
  spanTree: CategorizedSpan[];
  timeRange: TimeRange;
  loading: boolean;
  error: string | null;
}

/** Extended node data for merged view with diff info */
interface MergedSpanNodeData extends SpanNodeData {
  diffType: DiffType;
  leftSpan?: CategorizedSpan;
  rightSpan?: CategorizedSpan;
}

/**
 * Get diff type styling for node borders
 */
function getDiffBorderStyle(diffType: DiffType): string {
  switch (diffType) {
    case 'added':
      return 'ring-2 ring-green-500 ring-offset-2 ring-offset-background';
    case 'removed':
      return 'ring-2 ring-red-500 ring-offset-2 ring-offset-background';
    case 'modified':
      return 'ring-2 ring-amber-500 ring-offset-2 ring-offset-background';
    case 'matched':
    default:
      return '';
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
 * Mode toggle component
 */
const ModeToggle: React.FC<{
  mode: ComparisonMode;
  onChange: (mode: ComparisonMode) => void;
}> = ({ mode, onChange }) => {
  return (
    <div className="flex items-center gap-1 p-1 bg-muted rounded-md">
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          mode === 'side-by-side' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('side-by-side')}
      >
        <Columns size={14} />
        Side-by-Side
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 px-2 text-xs gap-1.5',
          mode === 'merged' && 'bg-background shadow-sm'
        )}
        onClick={() => onChange('merged')}
      >
        <GitMerge size={14} />
        Merged
      </Button>
    </div>
  );
};

/**
 * Single Flow panel for side-by-side view
 */
const FlowPanel: React.FC<{
  spanTree: CategorizedSpan[];
  timeRange: TimeRange;
  runName: string;
  spanCount: number;
  selectedSpan: CategorizedSpan | null;
  onSelectSpan: (span: CategorizedSpan | null) => void;
}> = ({ spanTree, timeRange, runName, spanCount, selectedSpan, onSelectSpan }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (spanTree.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const { nodes: flowNodes, edges: flowEdges } = spansToFlow(
      spanTree,
      timeRange.duration,
      { direction: 'TB' }
    );

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [spanTree, timeRange.duration, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<SpanNodeData>) => {
      onSelectSpan(node.data.span);
    },
    [onSelectSpan]
  );

  const onPaneClick = useCallback(() => {
    onSelectSpan(null);
  }, [onSelectSpan]);

  const minimapNodeColor = (node: Node<SpanNodeData>): string => {
    const category = node.data?.span?.category;
    switch (category) {
      case 'AGENT': return '#6366f1';
      case 'LLM': return '#a855f7';
      case 'TOOL': return '#f59e0b';
      case 'ERROR': return '#ef4444';
      default: return '#64748b';
    }
  };

  return (
    <div className="flex-1 flex flex-col border-r last:border-r-0">
      <div className="px-3 py-2 bg-muted/50 border-b text-xs font-medium text-center">
        {runName}
        <span className="text-muted-foreground ml-2">({spanCount} spans)</span>
      </div>
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          defaultEdgeOptions={{ type: 'smoothstep' }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={16}
            size={1}
            color="#334155"
          />
          <MiniMap
            nodeColor={minimapNodeColor}
            maskColor="rgba(15, 23, 42, 0.8)"
            className="!bg-slate-900/50 !border-slate-700 !bottom-2 !right-2"
            style={{ width: 100, height: 60 }}
            pannable
            zoomable
          />
        </ReactFlow>
      </div>
    </div>
  );
};

/**
 * Sort AlignedSpanPairs by their span's startTime
 * Adapted from sortByStartTime in executionOrderTransform.ts
 */
function sortAlignedPairsByStartTime(pairs: AlignedSpanPair[]): AlignedSpanPair[] {
  return [...pairs].sort((a, b) => {
    const spanA = a.leftSpan || a.rightSpan;
    const spanB = b.leftSpan || b.rightSpan;
    if (!spanA || !spanB) return 0;
    return new Date(spanA.startTime).getTime() - new Date(spanB.startTime).getTime();
  });
}

/**
 * Get node ID from an AlignedSpanPair
 */
function getNodeIdFromPair(pair: AlignedSpanPair): string {
  return pair.leftSpan?.spanId || pair.rightSpan?.spanId || `pair-${Math.random().toString(36).slice(2)}`;
}

/**
 * Convert aligned span pairs to merged flow nodes/edges
 * Uses sequential sibling edges (chain topology) for vertical layout
 */
function alignedPairsToFlow(
  alignedTree: AlignedSpanPair[],
  totalDuration: number
): { nodes: Node<MergedSpanNodeData>[]; edges: Edge[] } {
  const nodes: Node<MergedSpanNodeData>[] = [];
  const edges: Edge[] = [];

  /**
   * Process siblings at each level using sequential linking pattern.
   * Adapted from spansToExecutionFlow in executionOrderTransform.ts
   */
  const processSiblings = (siblings: AlignedSpanPair[], parentId?: string) => {
    if (siblings.length === 0) return;

    // Sort siblings by start time for execution order
    const sorted = sortAlignedPairsByStartTime(siblings);

    // Create nodes for all siblings at this level
    sorted.forEach(pair => {
      const span = pair.leftSpan || pair.rightSpan;
      if (!span) return;
      const nodeId = getNodeIdFromPair(pair);

      nodes.push({
        id: nodeId,
        type: span.category.toLowerCase(),
        data: {
          span,
          totalDuration,
          diffType: pair.type,
          leftSpan: pair.leftSpan,
          rightSpan: pair.rightSpan,
        },
        position: { x: 0, y: 0 },
        style: { width: 200, height: 70 },
        className: getDiffBorderStyle(pair.type),
      });
    });

    // Create sequential sibling edges: A→B→C (chain topology for vertical layout)
    // Pattern from createSiblingEdges in executionOrderTransform.ts
    for (let i = 0; i < sorted.length - 1; i++) {
      const currentId = getNodeIdFromPair(sorted[i]);
      const nextId = getNodeIdFromPair(sorted[i + 1]);
      edges.push({
        id: `${currentId}-${nextId}`,
        source: currentId,
        target: nextId,
        type: 'smoothstep',
        style: { stroke: '#64748b', strokeWidth: 2 },
      });
    }

    // Create branch edge from parent to first child only
    // Pattern from createBranchEdges in executionOrderTransform.ts
    if (parentId && sorted.length > 0) {
      const firstChildId = getNodeIdFromPair(sorted[0]);
      edges.push({
        id: `${parentId}-branch-${firstChildId}`,
        source: parentId,
        target: firstChildId,
        type: 'smoothstep',
        style: { stroke: '#6366f1', strokeWidth: 1.5, strokeDasharray: '3,3' },
      });
    }

    // Recursively process children of each sibling
    sorted.forEach(pair => {
      if (pair.children && pair.children.length > 0) {
        processSiblings(pair.children, getNodeIdFromPair(pair));
      }
    });
  };

  // Start processing from root level
  processSiblings(alignedTree);

  // Apply dagre layout for positioning (reusing existing function)
  const layoutedResult = applyDagreLayout(
    nodes as Node<SpanNodeData>[],
    edges,
    { direction: 'TB' }
  );

  return {
    nodes: layoutedResult.nodes as Node<MergedSpanNodeData>[],
    edges: layoutedResult.edges,
  };
}

/**
 * Merged Flow view showing diff-colored nodes
 */
const MergedFlowView: React.FC<{
  comparisonResult: TraceComparisonResult;
  totalDuration: number;
  selectedSpan: CategorizedSpan | null;
  onSelectSpan: (span: CategorizedSpan | null) => void;
}> = ({ comparisonResult, totalDuration, selectedSpan, onSelectSpan }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (comparisonResult.alignedTree.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const { nodes: flowNodes, edges: flowEdges } = alignedPairsToFlow(
      comparisonResult.alignedTree,
      totalDuration
    );

    setNodes(flowNodes as Node<SpanNodeData>[]);
    setEdges(flowEdges);
  }, [comparisonResult, totalDuration, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<MergedSpanNodeData>) => {
      onSelectSpan(node.data.span);
    },
    [onSelectSpan]
  );

  const onPaneClick = useCallback(() => {
    onSelectSpan(null);
  }, [onSelectSpan]);

  const minimapNodeColor = (node: Node<MergedSpanNodeData>): string => {
    // Color by diff type for merged view
    switch (node.data?.diffType) {
      case 'added': return '#22c55e';
      case 'removed': return '#ef4444';
      case 'modified': return '#f59e0b';
      default: return '#64748b';
    }
  };

  return (
    <div className="flex-1 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="#334155"
        />
        <MiniMap
          nodeColor={minimapNodeColor}
          maskColor="rgba(15, 23, 42, 0.8)"
          className="!bg-slate-900/50 !border-slate-700"
          pannable
          zoomable
        />
      </ReactFlow>

      {/* Legend */}
      <div className="absolute top-2 right-2 flex items-center gap-3 px-3 py-1.5 bg-background/80 backdrop-blur-sm rounded-md border text-xs">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded border-2 border-green-500" />
          Added
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded border-2 border-red-500" />
          Removed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded border-2 border-amber-500" />
          Modified
        </span>
      </div>
    </div>
  );
};

/**
 * Main TraceFlowComparison component
 */
export const TraceFlowComparison: React.FC<TraceFlowComparisonProps> = ({
  runs,
  reports,
  useCaseId,
}) => {
  const [mode, setMode] = useState<ComparisonMode>('side-by-side');
  const [traceData, setTraceData] = useState<Map<string, TraceData>>(new Map());
  const [selectedSpan, setSelectedSpan] = useState<CategorizedSpan | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

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
        spanTree: [],
        timeRange: { startTime: 0, endTime: 0, duration: 0 },
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
          const categorizedTree = categorizeSpanTree(spanTree);
          const timeRange = calculateTimeRange(result.spans);

          setTraceData(prev => {
            const updated = new Map(prev);
            updated.set(info.experimentRunId, {
              runId: info.agentRunId!,
              runName: info.runName,
              spans: spanTree,
              spanTree: categorizedTree,
              timeRange,
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
              spanTree: [],
              timeRange: { startTime: 0, endTime: 0, duration: 0 },
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

  // Get first two traces for comparison
  const traceArray = Array.from(traceData.values());
  const leftTrace = traceArray[0];
  const rightTrace = traceArray[1];

  // Compute comparison result for merged view
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

  // Calculate max duration for both traces
  const maxDuration = Math.max(leftTrace.timeRange.duration, rightTrace.timeRange.duration);

  return (
    <Card className="bg-card/50 overflow-hidden">
      <CardHeader className="py-2 px-4 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity size={14} />
            Trace Flow Comparison
          </CardTitle>
          <div className="flex items-center gap-2">
            <ModeToggle mode={mode} onChange={setMode} />
            <Button variant="ghost" size="sm" onClick={fetchAllTraces} disabled={isLoading}>
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsFullscreen(true)}
              className="gap-1.5"
            >
              <Maximize2 size={14} />
              Fullscreen
            </Button>
          </div>
        </div>
      </CardHeader>

      {/* Stats Banner */}
      <ComparisonStats stats={comparisonResult.stats} />

      {/* Flow Visualization */}
      <div className="h-[500px] flex">
        {mode === 'side-by-side' ? (
          <>
            <FlowPanel
              spanTree={leftTrace.spanTree}
              timeRange={leftTrace.timeRange}
              runName={leftTrace.runName}
              spanCount={comparisonResult.stats.totalLeft}
              selectedSpan={selectedSpan}
              onSelectSpan={setSelectedSpan}
            />
            <FlowPanel
              spanTree={rightTrace.spanTree}
              timeRange={rightTrace.timeRange}
              runName={rightTrace.runName}
              spanCount={comparisonResult.stats.totalRight}
              selectedSpan={selectedSpan}
              onSelectSpan={setSelectedSpan}
            />
          </>
        ) : (
          <MergedFlowView
            comparisonResult={comparisonResult}
            totalDuration={maxDuration}
            selectedSpan={selectedSpan}
            onSelectSpan={setSelectedSpan}
          />
        )}

        {/* Details panel */}
        {selectedSpan && (
          <div className="w-80 border-l overflow-auto">
            <SpanDetailsPanel
              span={selectedSpan}
              onClose={() => setSelectedSpan(null)}
            />
          </div>
        )}
      </div>

      {/* Fullscreen Dialog */}
      <FullScreenDialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <FullScreenDialogContent>
          <FullScreenDialogHeader>
            <div className="flex items-center gap-3">
              <Activity size={20} className="text-opensearch-blue" />
              <div>
                <FullScreenDialogTitle className="flex items-center gap-2">
                  Trace Flow Comparison
                  <Badge variant="secondary" className="ml-2">
                    {comparisonResult.stats.totalLeft + comparisonResult.stats.totalRight} spans
                  </Badge>
                </FullScreenDialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {leftTrace.runName} vs {rightTrace.runName}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <ModeToggle mode={mode} onChange={setMode} />
              <Button variant="ghost" size="sm" onClick={fetchAllTraces} disabled={isLoading}>
                <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsFullscreen(false)}
                className="gap-1.5"
              >
                <Minimize2 size={16} />
                Exit Fullscreen
              </Button>
              <FullScreenDialogCloseButton />
            </div>
          </FullScreenDialogHeader>

          {/* Stats Banner */}
          <ComparisonStats stats={comparisonResult.stats} />

          {/* Full height visualization */}
          <div className="flex-1 flex overflow-hidden">
            {mode === 'side-by-side' ? (
              <>
                <FlowPanel
                  spanTree={leftTrace.spanTree}
                  timeRange={leftTrace.timeRange}
                  runName={leftTrace.runName}
                  spanCount={comparisonResult.stats.totalLeft}
                  selectedSpan={selectedSpan}
                  onSelectSpan={setSelectedSpan}
                />
                <FlowPanel
                  spanTree={rightTrace.spanTree}
                  timeRange={rightTrace.timeRange}
                  runName={rightTrace.runName}
                  spanCount={comparisonResult.stats.totalRight}
                  selectedSpan={selectedSpan}
                  onSelectSpan={setSelectedSpan}
                />
              </>
            ) : (
              <MergedFlowView
                comparisonResult={comparisonResult}
                totalDuration={maxDuration}
                selectedSpan={selectedSpan}
                onSelectSpan={setSelectedSpan}
              />
            )}

            {/* Details panel */}
            {selectedSpan && (
              <div className="w-96 border-l overflow-auto bg-card">
                <SpanDetailsPanel
                  span={selectedSpan}
                  onClose={() => setSelectedSpan(null)}
                />
              </div>
            )}
          </div>
        </FullScreenDialogContent>
      </FullScreenDialog>
    </Card>
  );
};

export default TraceFlowComparison;
