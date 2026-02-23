/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentMapView - React Flow DAG visualization for Agent Map tab
 *
 * Similar to TraceFlowView but without the left stats panel.
 * Displays agent execution as a directed acyclic graph with collapsible details panel.
 */

import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
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
import { ZoomIn, ZoomOut, Map } from 'lucide-react';
import { Button } from '@/components/ui/button';

import { Span, TimeRange, CategorizedSpan, SpanNodeData } from '@/types';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { spansToFlow } from '@/services/traces/flowTransform';
import { nodeTypes } from './flow/nodeTypes';

interface AgentMapViewProps {
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

export const AgentMapView: React.FC<AgentMapViewProps> = ({
  spanTree,
  timeRange,
  selectedSpan,
  onSelectSpan,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const [showMinimap, setShowMinimap] = useState(true);

  // Categorize spans and convert to flow
  const categorizedTree = useMemo(
    () => categorizeSpanTree(spanTree),
    [spanTree]
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

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    reactFlowInstance.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    reactFlowInstance.current?.zoomOut();
  }, []);

  const toggleMinimap = useCallback(() => {
    setShowMinimap(prev => !prev);
  }, []);

  if (spanTree.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No spans to display
      </div>
    );
  }

  return (
    <div className="h-full w-full relative">
      {/* Floating controls inside the map */}
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
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={toggleMinimap}
          title={showMinimap ? "Hide minimap" : "Show minimap"}
        >
          <Map size={12} />
        </Button>
      </div>

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
        {showMinimap && (
          <MiniMap
            nodeColor={minimapNodeColor}
            maskColor="rgba(15, 23, 42, 0.8)"
            className="!bg-slate-900/50 !border-slate-700"
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
};

export default AgentMapView;
