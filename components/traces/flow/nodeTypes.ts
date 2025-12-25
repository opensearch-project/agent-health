/**
 * Node Types Registry for React Flow
 *
 * Maps span category names to node components.
 * All categories use the same SpanNode component which
 * applies category-specific styling based on span.category.
 */

import type { NodeTypes } from '@xyflow/react';
import { SpanNode } from './SpanNode';

/**
 * Custom node types for React Flow
 * Keys must match span.category.toLowerCase()
 */
export const nodeTypes: NodeTypes = {
  agent: SpanNode,
  llm: SpanNode,
  tool: SpanNode,
  error: SpanNode,
  other: SpanNode,
};

export type NodeType = 'agent' | 'llm' | 'tool' | 'error' | 'other';
