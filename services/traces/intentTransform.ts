/**
 * Intent Transform Service
 *
 * Transforms span trees into time-series compressed nodes for Intent view.
 * Groups only CONSECUTIVE same-category spans, preserving execution order.
 *
 * Example: LLM, TOOL, LLM, TOOL, TOOL, LLM
 * Result:  [LLM], [TOOL], [LLM], [TOOL ×2], [LLM]
 */

import { CategorizedSpan, IntentNode, SpanCategory } from '@/types';
import { hasAnyWarnings, getCategoryMeta } from './spanCategorization';
import { isContainerSpan } from './executionOrderTransform';

/**
 * Flatten span tree into execution order, skipping container spans
 * Container span children are promoted to their parent's level
 */
function flattenInExecutionOrder(spanTree: CategorizedSpan[]): CategorizedSpan[] {
  const result: CategorizedSpan[] = [];

  const processSpan = (span: CategorizedSpan) => {
    // Safely extract children with default empty array
    const children = (span.children ?? []) as CategorizedSpan[];
    const sortedChildren = children.length > 0
      ? [...children].sort(
          (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        )
      : [];

    if (isContainerSpan(span)) {
      // Skip container, process children directly
      for (const child of sortedChildren) {
        processSpan(child);
      }
    } else {
      // Include this span, then process children
      result.push(span);
      for (const child of sortedChildren) {
        processSpan(child);
      }
    }
  };

  // Sort root spans by start time
  const sortedRoots = [...spanTree].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
  for (const root of sortedRoots) {
    processSpan(root);
  }

  return result;
}

/**
 * Build subtitle for an IntentNode from its spans
 */
function buildSubtitle(spans: CategorizedSpan[]): string {
  if (spans.length === 1) {
    return spans[0].displayName || spans[0].name;
  }
  // For multiple spans, show first few names
  const names = spans.slice(0, 3).map(s => s.displayName || s.name);
  if (spans.length > 3) {
    return `${names.join(', ')}...`;
  }
  return names.join(', ');
}

/**
 * Group consecutive same-category spans into IntentNodes
 */
function groupConsecutive(spans: CategorizedSpan[]): IntentNode[] {
  if (spans.length === 0) return [];

  const nodes: IntentNode[] = [];
  let currentGroup: CategorizedSpan[] = [spans[0]];
  let currentCategory: SpanCategory = spans[0].category;
  let currentStartIndex = 0; // Track global span index

  for (let i = 1; i < spans.length; i++) {
    const span = spans[i];
    if (span.category === currentCategory) {
      // Same category - add to current group
      currentGroup.push(span);
    } else {
      // Different category - close current group, start new one
      nodes.push(createIntentNode(currentGroup, nodes.length, currentStartIndex));
      currentStartIndex += currentGroup.length;
      currentGroup = [span];
      currentCategory = span.category;
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    nodes.push(createIntentNode(currentGroup, nodes.length, currentStartIndex));
  }

  return nodes;
}

/**
 * Create an IntentNode from a group of consecutive spans
 */
function createIntentNode(
  spans: CategorizedSpan[],
  order: number,
  startIndex: number
): IntentNode {
  const category = spans[0].category;
  const meta = getCategoryMeta(category);
  const count = spans.length;

  // Calculate total duration for all spans in this node
  const totalDuration = spans.reduce((sum, span) => sum + (span.duration ?? 0), 0);

  return {
    id: `intent-${category}-${order}`,
    category,
    spans,
    count,
    displayName: count > 1 ? `${meta.label} ×${count}` : meta.label,
    subtitle: buildSubtitle(spans),
    hasWarnings: hasAnyWarnings(spans),
    executionOrder: order,
    startIndex,
    totalDuration,
  };
}

/**
 * Transform a categorized span tree into IntentNodes for the Intent view.
 * Groups only consecutive same-category spans, preserving execution order.
 */
export function spansToIntentNodes(spanTree: CategorizedSpan[]): IntentNode[] {
  // 1. Flatten all spans in execution order (skip container spans)
  const flatSpans = flattenInExecutionOrder(spanTree);

  // 2. Group consecutive same-category spans
  return groupConsecutive(flatSpans);
}

/**
 * Get the root/container span for display as header (if exists)
 */
export function getRootContainerSpan(spanTree: CategorizedSpan[]): CategorizedSpan | null {
  if (spanTree.length === 0) return null;

  // Find first container span (usually the agent.run)
  for (const span of spanTree) {
    if (isContainerSpan(span)) {
      return span;
    }
  }

  // Fallback to first span if no container found
  return spanTree[0];
}
