/**
 * Execution Order Transform Service
 *
 * Transforms span trees to React Flow format using execution-order linking
 * (like AWS Step Functions) instead of parent-child hierarchy.
 *
 * Key differences from hierarchy mode:
 * - Siblings at each level linked by execution order (startTime)
 * - Container spans (like agent.run) excluded from flow nodes
 * - Parent→child shown as branch edges (detail), not main flow
 * - Parallel detection only among siblings with overlapping times
 */

import { Node, Edge, MarkerType } from '@xyflow/react';
import dagre from 'dagre';
import {
  CategorizedSpan,
  SpanNodeData,
  FlowTransformResult,
  FlowTransformOptions,
} from '@/types';

/**
 * Edge types for visual styling
 */
type EdgeType = 'sequential' | 'parallel' | 'branch';

const DEFAULT_OPTIONS: Required<FlowTransformOptions> = {
  direction: 'TB',
  mode: 'execution-order',
  nodeWidth: 200,
  nodeHeight: 70,
  nodeSpacingX: 50,
  nodeSpacingY: 80,
};

/**
 * Detect if a span is a container span (wrapper for entire execution).
 * Container spans are excluded from flow nodes - only their children are shown.
 *
 * Uses multiple heuristics to support different agent implementations:
 * 1. OTEL GenAI semantic convention (gen_ai.operation.name)
 * 2. Name-based pattern matching
 * 3. Duration heuristic (span covers 90%+ of children duration)
 */
function isContainerSpan(span: CategorizedSpan): boolean {
  // 1. OTEL GenAI convention: invoke_agent/create_agent are container operations
  const operationName = span.attributes?.['gen_ai.operation.name'];
  if (operationName === 'invoke_agent' || operationName === 'create_agent') {
    return true;
  }

  // 2. Name-based heuristic for agents that don't use OTEL attributes
  const name = span.name?.toLowerCase() || '';
  if (name.includes('agent.run') || name.includes('invoke_agent')) {
    return true;
  }

  // 3. Single root with children that spans entire trace
  if (!span.parentSpanId && span.children && span.children.length > 1) {
    const spanStart = new Date(span.startTime).getTime();
    const spanEnd = new Date(span.endTime).getTime();
    const spanDuration = spanEnd - spanStart;

    // Get min start and max end from children
    const children = span.children as CategorizedSpan[];
    let minChildStart = Infinity;
    let maxChildEnd = -Infinity;

    children.forEach(child => {
      const childStart = new Date(child.startTime).getTime();
      const childEnd = new Date(child.endTime).getTime();
      minChildStart = Math.min(minChildStart, childStart);
      maxChildEnd = Math.max(maxChildEnd, childEnd);
    });

    const childrenSpan = maxChildEnd - minChildStart;

    // If span encompasses children (90%+ coverage), it's likely a container
    if (childrenSpan > 0 && spanDuration >= childrenSpan * 0.9) {
      return true;
    }
  }

  return false;
}

/**
 * Find the main flow spans (entry point for execution flow).
 * Adapts to different agent span structures.
 */
function findMainFlowSpans(spanTree: CategorizedSpan[]): CategorizedSpan[] {
  const roots = spanTree.filter(s => !s.parentSpanId);

  // Case 1: Single root that's a container → main flow is its children
  if (roots.length === 1 && isContainerSpan(roots[0])) {
    return (roots[0].children as CategorizedSpan[]) || [];
  }

  // Case 2: Multiple roots OR single non-container root → roots are main flow
  return roots;
}

/**
 * Sort spans by startTime for execution order
 */
function sortByStartTime(spans: CategorizedSpan[]): CategorizedSpan[] {
  return [...spans].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
}

/**
 * Create a flow node from a categorized span
 */
function createNode(
  span: CategorizedSpan,
  totalDuration: number,
  options: Required<FlowTransformOptions>
): Node<SpanNodeData> {
  return {
    id: span.spanId,
    type: span.category.toLowerCase(),
    data: {
      span,
      totalDuration,
    },
    position: { x: 0, y: 0 }, // Will be set by dagre layout
    style: {
      width: options.nodeWidth,
      height: options.nodeHeight,
    },
  };
}

/**
 * Create an edge between two nodes with appropriate styling
 */
function createEdge(
  sourceId: string,
  targetId: string,
  edgeType: EdgeType
): Edge {
  const baseStyle = {
    strokeWidth: 2,
  };

  switch (edgeType) {
    case 'sequential':
      return {
        id: `${sourceId}-${targetId}`,
        source: sourceId,
        target: targetId,
        type: 'smoothstep',
        animated: false,
        style: {
          ...baseStyle,
          stroke: '#64748b', // slate
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: '#64748b',
        },
      };

    case 'parallel':
      return {
        id: `${sourceId}-${targetId}`,
        source: sourceId,
        target: targetId,
        type: 'smoothstep',
        animated: true,
        style: {
          ...baseStyle,
          stroke: '#f59e0b', // amber
          strokeDasharray: '5,5',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: '#f59e0b',
        },
      };

    case 'branch':
      return {
        id: `${sourceId}-branch-${targetId}`,
        source: sourceId,
        target: targetId,
        type: 'smoothstep',
        animated: false,
        style: {
          ...baseStyle,
          stroke: '#6366f1', // indigo
          strokeDasharray: '3,3',
          strokeWidth: 1.5,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 10,
          height: 10,
          color: '#6366f1',
        },
      };
  }
}

/**
 * Create edges between siblings in execution order.
 * Detects parallel execution when spans overlap in time.
 */
function createSiblingEdges(siblings: CategorizedSpan[]): Edge[] {
  if (siblings.length < 2) return [];

  const edges: Edge[] = [];
  const sorted = sortByStartTime(siblings);

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    // Check for parallel execution (overlapping times)
    const currentEnd = new Date(current.endTime).getTime();
    const nextStart = new Date(next.startTime).getTime();

    // Allow small overlap threshold (10ms) for timing jitter
    const isParallel = nextStart < currentEnd - 10;

    edges.push(
      createEdge(
        current.spanId,
        next.spanId,
        isParallel ? 'parallel' : 'sequential'
      )
    );
  }

  return edges;
}

/**
 * Create branch edges from parent to its first child.
 * Shows nesting/detail relationship, not main execution flow.
 */
function createBranchEdges(span: CategorizedSpan): Edge[] {
  if (!span.children || span.children.length === 0) return [];

  const children = span.children as CategorizedSpan[];
  const sorted = sortByStartTime(children);

  // Edge from parent to first child only (branch off point)
  return [createEdge(span.spanId, sorted[0].spanId, 'branch')];
}

/**
 * Main transform function: Convert span tree to execution-order flow.
 *
 * Algorithm:
 * 1. Find main flow spans (skip container root if present)
 * 2. Process each level: create nodes, sequential edges between siblings
 * 3. For spans with children: create branch edges, recurse into children
 * 4. Apply dagre layout for positioning
 */
export function spansToExecutionFlow(
  spanTree: CategorizedSpan[],
  totalDuration: number,
  options: FlowTransformOptions = {}
): FlowTransformResult {
  const opts = { ...DEFAULT_OPTIONS, ...options } as Required<FlowTransformOptions>;
  const nodes: Node<SpanNodeData>[] = [];
  const edges: Edge[] = [];

  // Find the main flow entry point
  const mainFlowSpans = findMainFlowSpans(spanTree);

  if (mainFlowSpans.length === 0) {
    return { nodes: [], edges: [] };
  }

  /**
   * Process a level of siblings in the span hierarchy.
   * Creates nodes and edges for this level, then recurses into children.
   */
  function processLevel(siblings: CategorizedSpan[]) {
    if (siblings.length === 0) return;

    const sorted = sortByStartTime(siblings);

    // Create nodes for all spans at this level
    sorted.forEach(span => {
      nodes.push(createNode(span, totalDuration, opts));
    });

    // Create sequential edges between siblings
    edges.push(...createSiblingEdges(sorted));

    // Process children for each span
    sorted.forEach(span => {
      if (span.children && span.children.length > 0) {
        const children = span.children as CategorizedSpan[];

        // Create branch edge from parent to children
        edges.push(...createBranchEdges(span));

        // Recursively process children
        processLevel(children);
      }
    });
  }

  // Start processing from main flow level
  processLevel(mainFlowSpans);

  // Apply dagre layout for positioning
  return applyDagreLayout(nodes, edges, opts);
}

/**
 * Apply dagre layout algorithm to position nodes.
 * Uses TB (top-to-bottom) direction for vertical flow.
 */
function applyDagreLayout(
  nodes: Node<SpanNodeData>[],
  edges: Edge[],
  options: Required<FlowTransformOptions>
): FlowTransformResult {
  if (nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: options.direction, // TB for vertical flow
    nodesep: options.nodeSpacingX,
    ranksep: options.nodeSpacingY,
    marginx: 20,
    marginy: 20,
  });

  // Add nodes to dagre
  nodes.forEach(node => {
    dagreGraph.setNode(node.id, {
      width: options.nodeWidth,
      height: options.nodeHeight,
    });
  });

  // Add edges to dagre
  edges.forEach(edge => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  // Run layout algorithm
  dagre.layout(dagreGraph);

  // Apply calculated positions to nodes
  const layoutedNodes = nodes.map(node => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - options.nodeWidth / 2,
        y: nodeWithPosition.y - options.nodeHeight / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

/**
 * Export utility functions for testing
 */
export { isContainerSpan, findMainFlowSpans, sortByStartTime };
