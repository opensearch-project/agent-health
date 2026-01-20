/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for @xyflow/react module used in tests
 * @xyflow/react is a React flow diagram library (browser-only)
 */

export interface Node<T = unknown> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: T;
  width?: number;
  height?: number;
}

export interface Edge<T = unknown> {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: T;
  markerEnd?: unknown;
}

export const MarkerType = {
  Arrow: 'arrow',
  ArrowClosed: 'arrowclosed',
};

export const Position = {
  Left: 'left',
  Right: 'right',
  Top: 'top',
  Bottom: 'bottom',
};

// Mock React component
export const ReactFlow = () => null;
export const Background = () => null;
export const Controls = () => null;
export const MiniMap = () => null;
export const Handle = () => null;

// Mock hooks
export const useNodesState = (initialNodes: Node[]) => [initialNodes, () => {}, () => {}];
export const useEdgesState = (initialEdges: Edge[]) => [initialEdges, () => {}, () => {}];
export const useReactFlow = () => ({
  fitView: () => {},
  getNodes: () => [],
  getEdges: () => [],
  setNodes: () => {},
  setEdges: () => {},
});

export default {
  MarkerType,
  Position,
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  useNodesState,
  useEdgesState,
  useReactFlow,
};
