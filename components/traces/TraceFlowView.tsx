/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TraceFlowView - React Flow DAG visualization for traces
 *
 * Displays agent execution as a directed acyclic graph using
 * execution-order linking (like AWS Step Functions):
 * - Main flow: siblings linked by execution order (startTime)
 * - Container spans (agent.run): excluded, only children shown
 * - Branch edges: parent → child for detail/implementation spans
 * - Parallel detection: among siblings with overlapping times
 *
 * Also displays summary stats above the flow and time distribution below.
 * Uses dagre for automatic layout positioning with TB (top-to-bottom) direction.
 */

import React, { useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Span, TimeRange, CategorizedSpan, SpanNodeData } from '@/types';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { spansToFlow } from '@/services/traces/flowTransform';
import { getRootContainerSpan } from '@/services/traces/intentTransform';
import {
  flattenSpans,
  calculateCategoryStats,
  extractToolStats,
} from '@/services/traces/traceStats';
import { nodeTypes } from './flow/nodeTypes';
import SpanDetailsPanel from './SpanDetailsPanel';
import {
  TraceSummaryHeader,
  SummaryStatsGrid,
  ToolsUsedSection,
  TimeDistributionBar,
} from './TraceSummary';

interface TraceFlowViewProps {
  spanTree: Span[];
  timeRange: TimeRange;
  selectedSpan: Span | null;
  onSelectSpan: (span: Span | null) => void;
}

/**
 * MiniMap node color based on category
 */
const minimapNodeColor = (node: Node): string => {
  const data = node.data as Record<string, unknown> | undefined;
  const span = data?.span as { category?: string } | undefined;
  const category = span?.category;
  switch (category) {
    case 'AGENT':
      return '#6366f1'; // indigo
    case 'LLM':
      return '#a855f7'; // purple
    case 'TOOL':
      return '#f59e0b'; // amber
    case 'ERROR':
      return '#ef4444'; // red
    default:
      return '#64748b'; // slate
  }
};

export const TraceFlowView: React.FC<TraceFlowViewProps> = ({
  spanTree,
  timeRange,
  selectedSpan,
  onSelectSpan,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

  // Categorize spans and convert to flow
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

  // Transform to React Flow nodes/edges - always use TB (top to bottom) direction
  useEffect(() => {
    if (categorizedTree.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const { nodes: flowNodes, edges: flowEdges } = spansToFlow(
      categorizedTree,
      timeRange.duration,
      { direction: 'TB' }
    );

    setNodes(flowNodes);
    setEdges(flowEdges);

    // Fit view after nodes are set (with small delay to ensure render)
    setTimeout(() => {
      if (reactFlowInstance.current) {
        reactFlowInstance.current.fitView({ padding: 0.1, maxZoom: 1 });
      }
    }, 100);
  }, [categorizedTree, timeRange.duration, setNodes, setEdges]);

  // Handle React Flow initialization
  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
    // Fit view on init
    setTimeout(() => {
      instance.fitView({ padding: 0.1, maxZoom: 1 });
    }, 100);
  }, []);

  // Handle node click
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const data = node.data as SpanNodeData | undefined;
      if (data?.span) {
        onSelectSpan(data.span);
      }
    },
    [onSelectSpan]
  );

  // Handle background click (deselect)
  const onPaneClick = useCallback(() => {
    onSelectSpan(null);
  }, [onSelectSpan]);

  // Find selected span in categorized tree for details panel
  const selectedCategorizedSpan = useMemo(() => {
    if (!selectedSpan) return null;

    const findSpan = (spans: CategorizedSpan[]): CategorizedSpan | null => {
      for (const span of spans) {
        if (span.spanId === selectedSpan.spanId) return span;
        if (span.children) {
          const found = findSpan(span.children as CategorizedSpan[]);
          if (found) return found;
        }
      }
      return null;
    };

    return findSpan(categorizedTree);
  }, [selectedSpan, categorizedTree]);

  if (spanTree.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No spans to display
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Summary section (above flow) */}
      <div className="shrink-0 border-b">
        <TraceSummaryHeader
          rootContainer={rootContainer}
          spanCount={allSpans.length}
          totalDuration={timeRange.duration}
        />
        <div className="p-4 space-y-4">
          <SummaryStatsGrid categoryStats={categoryStats} toolStats={toolStats} />
          <ToolsUsedSection toolStats={toolStats} />
          {/* Time Distribution (above flow) */}
          <TimeDistributionBar stats={categoryStats} totalDuration={timeRange.duration} />
        </div>
      </div>

      {/* Flow canvas (middle) */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 relative">
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
            fitViewOptions={{
              padding: 0.1,
              minZoom: 0.1,
              maxZoom: 1,
            }}
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
              type: 'smoothstep',
            }}
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
        </div>

        {/* Details panel */}
        {selectedCategorizedSpan && (
          <div className="w-96 border-l overflow-auto">
            <SpanDetailsPanel
              span={selectedCategorizedSpan}
              onClose={() => onSelectSpan(null)}
            />
          </div>
        )}
      </div>

    </div>
  );
};

export default TraceFlowView;
