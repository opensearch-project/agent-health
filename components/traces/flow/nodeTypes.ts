/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node Types Registry for React Flow
 *
 * Maps span category names to node components.
 * All categories use the same SpanNode component which
 * applies category-specific styling based on span.category.
 */

import type { NodeTypes } from '@xyflow/react';
import { SpanNode } from './SpanNode';
import type { SpanCategory } from '@/types';

/**
 * Custom node types for React Flow
 * Keys must match span.category.toLowerCase()
 */
/**
 * One React Flow node type per SpanCategory (lower-cased — see
 * flowTransform's `type: span.category.toLowerCase()`). Typed against
 * `Lowercase<SpanCategory>` so adding a category without registering its node
 * type is a compile error instead of a blank default node in the Agent map.
 */
export type NodeType = Lowercase<SpanCategory>;

export const nodeTypes: Record<NodeType, typeof SpanNode> & NodeTypes = {
  agent: SpanNode,
  llm: SpanNode,
  tool: SpanNode,
  retrieval: SpanNode,
  eval: SpanNode,
  error: SpanNode,
  other: SpanNode,
};
