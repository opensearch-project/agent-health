/**
 * Flow Transform Service
 *
 * Converts span trees to React Flow nodes and edges for DAG visualization.
 * Uses dagre for automatic layout positioning.
 *
 * Supports two modes:
 * - 'hierarchy': Traditional parent-child edges (legacy)
 * - 'execution-order': Sibling execution-order edges like AWS Step Functions (default)
 */

import dagre from 'dagre';
import { Node, Edge, MarkerType } from '@xyflow/react';
import {
  CategorizedSpan,
  SpanNodeData,
  FlowTransformResult,
  FlowTransformOptions,
  ParallelGroup,
} from '@/types';
import { spansToExecutionFlow } from './executionOrderTransform';

const DEFAULT_OPTIONS: Required<FlowTransformOptions> = {
  direction: 'TB',
  mode: 'execution-order',
  nodeWidth: 200,
  nodeHeight: 70,
  nodeSpacingX: 50,
  nodeSpacingY: 80,
};

/**
 * Convert a categorized span tree to React Flow nodes and edges.
 *
 * @param spanTree - Categorized span tree to transform
 * @param totalDuration - Total trace duration for relative sizing
 * @param options - Transform options including mode
 * @returns Flow nodes and edges for React Flow
 */
export function spansToFlow(
  spanTree: CategorizedSpan[],
  totalDuration: number,
  options: FlowTransformOptions = {}
): FlowTransformResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Use execution-order mode by default (Step Functions style)
  if (opts.mode === 'execution-order') {
    return spansToExecutionFlow(spanTree, totalDuration, opts);
  }

  // Legacy hierarchy mode (parent-child edges)
  return spansToHierarchyFlow(spanTree, totalDuration, opts);
}

/**
 * Legacy hierarchy mode: parent-child edges
 */
function spansToHierarchyFlow(
  spanTree: CategorizedSpan[],
  totalDuration: number,
  opts: Required<FlowTransformOptions>
): FlowTransformResult {
  const nodes: Node<SpanNodeData>[] = [];
  const edges: Edge[] = [];

  // Build nodes and edges from span tree
  const processSpan = (span: CategorizedSpan, parentId?: string) => {
    // Create node
    const node: Node<SpanNodeData> = {
      id: span.spanId,
      type: span.category.toLowerCase(),
      data: {
        span,
        totalDuration,
      },
      position: { x: 0, y: 0 }, // Will be set by layout
      style: {
        width: opts.nodeWidth,
        height: opts.nodeHeight,
      },
    };
    nodes.push(node);

    // Create edge from parent
    if (parentId) {
      const isParallel = false; // Will be determined later
      edges.push(createEdge(parentId, span.spanId, isParallel));
    }

    // Process children
    if (span.children && span.children.length > 0) {
      const children = span.children as CategorizedSpan[];

      // Detect parallel execution among siblings
      const parallelGroups = detectParallelExecution(children);
      const parallelSpanIds = new Set(
        parallelGroups.flatMap(g => g.spans.map(s => s.spanId))
      );

      // Update edges for parallel spans
      children.forEach(child => {
        processSpan(child, span.spanId);

        // Mark edge as parallel if span is in a parallel group
        if (parallelSpanIds.has(child.spanId)) {
          const edge = edges.find(
            e => e.source === span.spanId && e.target === child.spanId
          );
          if (edge) {
            edge.animated = true;
            edge.style = {
              ...edge.style,
              stroke: '#f59e0b',
              strokeDasharray: '5,5',
            };
          }
        }
      });
    }
  };

  // Process all root spans
  spanTree.forEach(span => processSpan(span));

  // Apply layout
  const layoutedResult = applyDagreLayout(nodes, edges, opts);

  return layoutedResult;
}

/**
 * Create an edge between two nodes
 */
function createEdge(sourceId: string, targetId: string, isParallel: boolean): Edge {
  return {
    id: `${sourceId}-${targetId}`,
    source: sourceId,
    target: targetId,
    type: 'smoothstep',
    animated: isParallel,
    style: {
      stroke: isParallel ? '#f59e0b' : '#64748b',
      strokeWidth: 2,
      strokeDasharray: isParallel ? '5,5' : undefined,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 12,
      height: 12,
      color: isParallel ? '#f59e0b' : '#64748b',
    },
  };
}

/**
 * Detect parallel execution among sibling spans by checking time overlap
 */
export function detectParallelExecution(spans: CategorizedSpan[]): ParallelGroup[] {
  if (spans.length < 2) return [];

  // Sort by start time
  const sorted = [...spans].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );

  const groups: ParallelGroup[] = [];
  let currentGroup: CategorizedSpan[] = [sorted[0]];
  let groupEndTime = new Date(sorted[0].endTime).getTime();

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    const spanStart = new Date(span.startTime).getTime();
    const spanEnd = new Date(span.endTime).getTime();

    // Check if this span overlaps with the current group
    // Using a threshold of 10% of the span's duration to account for minor timing differences
    const overlapThreshold = Math.min(
      (groupEndTime - new Date(currentGroup[0].startTime).getTime()) * 0.1,
      100 // Max 100ms threshold
    );

    if (spanStart < groupEndTime + overlapThreshold) {
      // Overlaps - add to current group
      currentGroup.push(span);
      groupEndTime = Math.max(groupEndTime, spanEnd);
    } else {
      // No overlap - save current group if it has multiple spans
      if (currentGroup.length > 1) {
        groups.push({
          spans: currentGroup,
          startTime: new Date(currentGroup[0].startTime).getTime(),
          endTime: groupEndTime,
        });
      }
      // Start new group
      currentGroup = [span];
      groupEndTime = spanEnd;
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 1) {
    groups.push({
      spans: currentGroup,
      startTime: new Date(currentGroup[0].startTime).getTime(),
      endTime: groupEndTime,
    });
  }

  return groups;
}

/**
 * Apply dagre layout algorithm to position nodes
 */
export function applyDagreLayout(
  nodes: Node<SpanNodeData>[],
  edges: Edge[],
  options: FlowTransformOptions = {}
): FlowTransformResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: opts.direction,
    nodesep: opts.nodeSpacingX,
    ranksep: opts.nodeSpacingY,
    marginx: 20,
    marginy: 20,
  });

  // Add nodes to dagre
  nodes.forEach(node => {
    dagreGraph.setNode(node.id, {
      width: opts.nodeWidth,
      height: opts.nodeHeight,
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
        x: nodeWithPosition.x - opts.nodeWidth / 2,
        y: nodeWithPosition.y - opts.nodeHeight / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

/**
 * Get total span count from a tree (for stats display)
 */
export function countSpansInTree(spans: CategorizedSpan[]): number {
  let count = 0;
  const countRecursive = (nodes: CategorizedSpan[]) => {
    for (const node of nodes) {
      count++;
      if (node.children) {
        countRecursive(node.children as CategorizedSpan[]);
      }
    }
  };
  countRecursive(spans);
  return count;
}
