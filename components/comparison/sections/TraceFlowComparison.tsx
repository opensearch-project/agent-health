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

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Activity, RefreshCw, AlertCircle, GitMerge, Columns, Maximize2, Minimize2 } from 'lucide-react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  BackgroundVariant,
  type ReactFlowInstance,
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
  fetchTracesForRun,
  processSpansIntoTree,
  calculateTimeRange,
  compareTraces,
  categorizeSpanTree,
} from '@/services/traces';
import { applyDagreLayout } from '@/services/traces/flowTransform';
import { nodeTypes } from '@/components/traces/flow/nodeTypes';
import SpanDetailsPanel from '@/components/traces/SpanDetailsPanel';
import TraceVisualization from '@/components/traces/TraceVisualization';

type ComparisonMode = 'side-by-side' | 'merged';
type DiffType = 'matched' | 'added' | 'removed' | 'modified';

interface TraceFlowComparisonProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  useCaseId: string;
  /** Trace-window hints per agent runId (Strategy C) so closed-source spans render. */
  windowAgentsByRunId?: Map<string, { serviceName?: string; startedAt: number; endedAt: number }>;
  /** A span citation clicked in the deep-dive → select/highlight that span. */
  highlight?: { runId: string; spanId: string; nonce: number } | null;
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
 * Single Flow panel for side-by-side view.
 * Each panel gets its own ReactFlowProvider to isolate internal stores.
 */
const FlowPanel: React.FC<{
  spanTree: CategorizedSpan[];
  timeRange: TimeRange;
  runName: string;
  spanCount: number;
  selectedSpan: CategorizedSpan | null;
  onSelectSpan: (span: CategorizedSpan | null) => void;
}> = ({ spanTree, timeRange, runName, spanCount, selectedSpan, onSelectSpan }) => {
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 border-r last:border-r-0">
      <div className="px-3 py-2 bg-muted/50 border-b text-xs font-medium text-center shrink-0">
        {runName}
        <span className="text-muted-foreground ml-2">({spanCount} spans)</span>
      </div>
      {/* Render each run's spans as a TIMELINE (tree/gantt waterfall) via the
          shared TraceVisualization instead of the react-flow DAG — the DAG hid
          individual spans and the user couldn't reach them. Selection is
          controlled by the parent so deep-dive span citations highlight here
          and surface the SpanDetailsPanel. */}
      <div className="flex-1 min-h-0 min-w-0 relative overflow-auto">
        <TraceVisualization
          spanTree={spanTree as Span[]}
          timeRange={timeRange}
          initialViewMode="tree"
          showViewToggle
          selectedSpan={selectedSpan as Span | null}
          onSelectSpan={(s) => onSelectSpan(s as CategorizedSpan | null)}
        />
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
 * Inner content for merged flow view (must be inside ReactFlowProvider)
 */
const MergedFlowViewInner: React.FC<{
  comparisonResult: TraceComparisonResult;
  totalDuration: number;
  selectedSpan: CategorizedSpan | null;
  onSelectSpan: (span: CategorizedSpan | null) => void;
}> = ({ comparisonResult, totalDuration, selectedSpan, onSelectSpan }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

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

    // Fit view after nodes are set (with small delay to ensure render)
    setTimeout(() => {
      if (reactFlowInstance.current) {
        reactFlowInstance.current.fitView({ padding: 0.2, maxZoom: 1 });
      }
    }, 100);
  }, [comparisonResult, totalDuration, setNodes, setEdges]);

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
    setTimeout(() => {
      instance.fitView({ padding: 0.2, maxZoom: 1 });
    }, 100);
  }, []);

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
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onInit={onInit}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.1}
      maxZoom={2}
      defaultEdgeOptions={{ type: 'smoothstep' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={16}
        size={1}
        color="hsl(var(--border))"
      />
      <MiniMap
        nodeColor={minimapNodeColor}
        maskColor="hsl(var(--background) / 0.8)"
        className="!bg-card/80 !border !border-border"
        pannable
        zoomable
      />
    </ReactFlow>
  );
};

/**
 * Merged Flow view showing diff-colored nodes.
 * Wrapped in its own ReactFlowProvider to isolate from side-by-side panels.
 */
const MergedFlowView: React.FC<{
  comparisonResult: TraceComparisonResult;
  totalDuration: number;
  selectedSpan: CategorizedSpan | null;
  onSelectSpan: (span: CategorizedSpan | null) => void;
}> = (props) => {
  return (
    <div className="flex-1 relative">
      <ReactFlowProvider>
        <MergedFlowViewInner {...props} />
      </ReactFlowProvider>

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
  windowAgentsByRunId,
  highlight,
}) => {
  const [mode, setMode] = useState<ComparisonMode>('side-by-side');
  const [traceData, setTraceData] = useState<Map<string, TraceData>>(new Map());
  const [selectedSpan, setSelectedSpan] = useState<CategorizedSpan | null>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  // When the most recent fetch completed (null = never fetched). Lets the empty
  // state say "checked at HH:MM:SS" so the user can tell "no traces present"
  // (terminal) apart from "still loading" (the spinner).
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Get run IDs from reports. Deliberately NOT filtered by agentRunId
  // presence (bug fix): a run whose report has no runId/traceId/sessionId at
  // all (e.g. a REST connector with no OTel instrumentation) must still get a
  // traceData entry so the component can resolve to the honest "no traces"
  // empty state — dropping it here left `runInfos` empty and `fetchAllTraces`
  // bailed out before ever setting `isLoading`/`traceData`, so the Traces tab
  // was stuck showing the loading spinner FOREVER with zero network activity
  // (repro: stark-retail comparison, a REST agent with no runId anywhere).
  const runInfos = useMemo(() => {
    return runs.map(run => {
      const result = run.results[useCaseId];
      const report = result?.reportId ? reports[result.reportId] : null;
      return {
        experimentRunId: run.id,
        runName: run.name,
        reportId: result?.reportId || null,
        agentRunId: report?.runId || null,
        // Direct correlators (deep-dive-independent): an agent's own traceId
        // (Strategy A, e.g. pi) / session.id (Strategy D, e.g. Claude Code).
        traceId: report?.traceId || null,
        sessionId: report?.sessionId || null,
      };
    });
  }, [runs, reports, useCaseId]);

  // Fetch traces for all runs
  const fetchAllTraces = useCallback(async () => {
    if (runInfos.length === 0) return;

    setIsLoading(true);

    const newTraceData = new Map<string, TraceData>();

    for (const info of runInfos) {
      newTraceData.set(info.experimentRunId, {
        runId: info.agentRunId || info.experimentRunId,
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
        // Look the Strategy-C window up by reportId first (stable across the
        // runId/traceId mapping), falling back to the run id for safety.
        const wa = windowAgentsByRunId?.get(info.reportId || '') || (info.agentRunId ? windowAgentsByRunId?.get(info.agentRunId) : undefined);
        const hasAnyCorrelator = !!(info.agentRunId || info.traceId || info.sessionId || wa?.serviceName);

        // No correlator of ANY kind for this run+case (no runId, no traceId,
        // no session.id, no Strategy-C window) — a query would just 400/no-op
        // server-side anyway. Resolve immediately to "no spans" instead of
        // issuing a network call we already know can't succeed; this is what
        // used to leave the tab loading forever.
        if (!hasAnyCorrelator) {
          setTraceData(prev => {
            const updated = new Map(prev);
            updated.set(info.experimentRunId, {
              runId: info.agentRunId || info.experimentRunId,
              runName: info.runName,
              spans: [],
              spanTree: [],
              timeRange: { startTime: 0, endTime: 0, duration: 0 },
              loading: false,
              error: null,
            });
            return updated;
          });
          return;
        }

        try {
          const result = await fetchTracesForRun({
            runId: info.agentRunId || undefined,
            // Strategy A / D: the run's own traceId / session.id correlate
            // immediately, without waiting for the deep-dive's window hints.
            traceId: info.traceId || undefined,
            sessionId: info.sessionId || undefined,
            includeWindowFallback: true,
            windowAgents: wa?.serviceName
              ? [{ serviceName: wa.serviceName, startedAt: wa.startedAt, endedAt: wa.endedAt, sessionId: info.sessionId || undefined }]
              : undefined,
          });
          const spanTree = processSpansIntoTree(result.spans);
          const categorizedTree = categorizeSpanTree(spanTree);
          const timeRange = calculateTimeRange(result.spans);

          setTraceData(prev => {
            const updated = new Map(prev);
            updated.set(info.experimentRunId, {
              runId: info.agentRunId || info.experimentRunId,
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
              runId: info.agentRunId || info.experimentRunId,
              runName: info.runName,
              spans: [],
              spanTree: [],
              timeRange: { startTime: 0, endTime: 0, duration: 0 },
              loading: false,
              // fetchTraces() (services/traces/index.ts) now times out on its
              // own (default 20s) rather than hanging indefinitely, so this
              // catch is reachable for a genuinely slow/unresponsive backend
              // too — not just 4xx/5xx — and always resolves to the error
              // state below (with its existing Retry button) instead of an
              // indefinite spinner.
              error: error instanceof Error ? error.message : 'Failed to fetch traces',
            });
            return updated;
          });
        }
      })
    );

    setIsLoading(false);
    setLastFetchedAt(Date.now());
  }, [runInfos, windowAgentsByRunId]);

  // Fetch traces on mount
  useEffect(() => {
    fetchAllTraces();
  }, [fetchAllTraces]);

  // Deep-link: a span citation was clicked in the deep-dive → select that span
  // in its run's trace so its details/evidence surface for the user.
  useEffect(() => {
    if (!highlight) return;
    const findById = (nodes: CategorizedSpan[]): CategorizedSpan | null => {
      for (const n of nodes) {
        if (n.spanId === highlight.spanId) return n;
        const kids = (n.children as CategorizedSpan[] | undefined) || [];
        const hit = kids.length ? findById(kids) : null;
        if (hit) return hit;
      }
      return null;
    };
    // Resolve the cited span. The deep-dive cites a span by the AGENT's runId,
    // but the client keys runs by `report.runId` — which toTestCaseRun maps to
    // the OTel traceId, not the agent runId — so a direct runId match usually
    // misses. spanIds are globally unique, so prefer the cited run when its id
    // matches and otherwise fall back to locating the span in EITHER run's tree.
    let hit: CategorizedSpan | null = null;
    for (const td of traceData.values()) {
      if (td.runId === highlight.runId) {
        hit = findById(td.spanTree);
        if (hit) break;
      }
    }
    if (!hit) {
      for (const td of traceData.values()) {
        hit = findById(td.spanTree);
        if (hit) break;
      }
    }
    if (hit) setSelectedSpan(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce, traceData]);

  // After a deep-link selects a span, scroll its details panel into view. The
  // panel renders to the RIGHT of the side-by-side flow inside a horizontally
  // scrolling table, so without this the user lands on the Traces tab but the
  // span they clicked is off-screen to the right.
  useEffect(() => {
    if (!highlight || !selectedSpan) return;
    const t = setTimeout(() => {
      detailPanelRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce, selectedSpan?.spanId]);

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
        <CardContent className="py-8 text-center" data-testid="trace-flow-loading">
          <RefreshCw size={24} className="mx-auto mb-2 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading traces… <span className="opacity-70">querying spans for both runs</span></p>
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

  // Show empty state — TERMINAL: the fetch completed and matched no spans. This
  // is deliberately distinct from the loading spinner above so "not present"
  // can't be mistaken for "still loading". We stamp when we last checked, and
  // name the per-run span counts (an errored run that produced 0 spans reads as
  // "0 spans", not a perpetual "propagating…").
  if (!comparisonResult || comparisonResult.alignedTree.length === 0) {
    const leftN = leftTrace?.spans?.length ?? 0;
    const rightN = rightTrace?.spans?.length ?? 0;
    const checked = lastFetchedAt ? new Date(lastFetchedAt).toLocaleTimeString() : null;
    return (
      <Card className="bg-card/50">
        <CardContent className="py-8 text-center" data-testid="trace-flow-empty">
          <Activity size={32} className="mx-auto mb-2 text-muted-foreground opacity-50" />
          <p className="text-sm text-foreground">No traces found for these runs</p>
          <p className="text-xs text-muted-foreground mt-1">
            {checked ? `Checked ${checked} — ` : ''}
            <span data-testid="trace-flow-empty-counts">{leftTrace?.runName ?? 'A'}: {leftN} spans · {rightTrace?.runName ?? 'B'}: {rightN} spans</span>.
            This is final — not still loading.
          </p>
          <p className="text-[0.7rem] text-muted-foreground/70 mt-1">
            A run that errored emits no trace. If a run just finished, spans can lag a few seconds while indexing — Refresh to re-check.
          </p>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={fetchAllTraces} data-testid="trace-flow-refresh">
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
    <Card className="bg-card/50 overflow-hidden" data-testid="trace-flow-comparison">
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
          <div
            ref={detailPanelRef}
            className="w-80 border-l overflow-auto ring-1 ring-inset ring-opensearch-blue/40"
            data-selected-span-id={selectedSpan.spanId}
          >
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
