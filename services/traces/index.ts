/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traces Service - Fetch and process trace data from OpenSearch
 */

import { Span, TimeRange, TraceQueryParams, TraceSearchResult } from '@/types';

// Re-export trace grouping utilities
export { groupSpansByTrace, getSpansForTrace } from './traceGrouping';

/**
 * Get API base URL dynamically
 * Server-side (Node.js): Use localhost with PORT env var
 * Client-side (browser): Use relative URLs
 */
function getApiBaseUrl(): string {
  const isServerSide = typeof window === 'undefined';
  if (isServerSide) {
    const port = process.env?.PORT || '4001';
    return `http://localhost:${port}`;
  }
  return ''; // Relative URLs in browser
}

/**
 * Fetch traces from the backend API
 * Backend handles config resolution (file or env vars) - no headers needed from frontend
 */
export async function fetchTraces(params: TraceQueryParams): Promise<TraceSearchResult> {
  const response = await fetch(`${getApiBaseUrl()}/api/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch traces by trace ID
 */
export async function fetchTraceById(traceId: string): Promise<TraceSearchResult> {
  return fetchTraces({ traceId });
}

/**
 * Fetch traces by run IDs
 */
export async function fetchTracesByRunIds(runIds: string[]): Promise<TraceSearchResult> {
  return fetchTraces({ runIds });
}

/**
 * Fetch recent traces for live tailing
 */
export async function fetchRecentTraces(options: {
  minutesAgo?: number;
  serviceName?: string;
  textSearch?: string;
  size?: number;
}): Promise<TraceSearchResult> {
  const { minutesAgo = 5, serviceName, textSearch, size = 500 } = options;
  const now = Date.now();
  const startTime = now - (minutesAgo * 60 * 1000);

  return fetchTraces({
    startTime,
    endTime: now,
    serviceName,
    textSearch,
    size,
  });
}

/**
 * Check traces API health
 * Backend handles config resolution (file or env vars) - no headers needed from frontend
 */
export async function checkTracesHealth(): Promise<{ status: string; index?: string; error?: string }> {
  const response = await fetch(`${getApiBaseUrl()}/api/traces/health`);
  return response.json();
}

/**
 * Process flat spans into a hierarchical tree structure
 */
export function processSpansIntoTree(flatSpans: Span[]): Span[] {
  if (!flatSpans || flatSpans.length === 0) return [];

  const spanMap = new Map<string, Span>();
  const roots: Span[] = [];

  // First pass: index all spans
  flatSpans.forEach(span => {
    spanMap.set(span.spanId, { ...span, children: [] });
  });

  // Second pass: build tree structure
  spanMap.forEach(span => {
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      const parent = spanMap.get(span.parentSpanId)!;
      parent.children = parent.children || [];
      parent.children.push(span);
    } else {
      roots.push(span);
    }
  });

  // Sort children by startTime
  const sortChildren = (spans: Span[]) => {
    spans.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    spans.forEach(span => {
      if (span.children && span.children.length > 0) {
        sortChildren(span.children);
      }
    });
  };

  sortChildren(roots);
  return roots;
}

/**
 * Calculate global time range across all spans
 */
export function calculateTimeRange(spans: Span[]): TimeRange {
  if (!spans || spans.length === 0) {
    return { startTime: 0, endTime: 0, duration: 0 };
  }

  let startTime = Infinity;
  let endTime = -Infinity;

  spans.forEach(span => {
    const spanStart = new Date(span.startTime).getTime();
    const spanEnd = new Date(span.endTime).getTime();
    if (spanStart < startTime) startTime = spanStart;
    if (spanEnd > endTime) endTime = spanEnd;
  });

  return {
    startTime,
    endTime,
    duration: endTime - startTime
  };
}

/**
 * Get color for a span based on its type/name
 */
export function getSpanColor(span: Span): string {
  const name = span.name?.toLowerCase() || '';
  const status = span.status;

  // Error spans are always red
  if (status === 'ERROR') return '#ef4444';

  // Agent run root spans
  if (name.includes('agent.run') || name.includes('run')) return '#6366f1';

  // LLM/Bedrock calls
  if (name.includes('bedrock') || name.includes('llm') || name.includes('converse')) return '#a855f7';

  // Tool executions
  if (name.includes('tool')) return '#f59e0b';

  // Graph nodes
  if (name.includes('node') || name.includes('process')) return '#3b82f6';

  // Default
  return '#64748b';
}

/**
 * Flatten tree into visible spans based on expanded state
 */
export function flattenVisibleSpans(
  spans: Span[],
  expandedSpans: Set<string>,
  depth = 0
): Span[] {
  const result: Span[] = [];

  for (const span of spans) {
    const hasChildren = (span.children?.length || 0) > 0;
    result.push({ ...span, depth, hasChildren });

    if (hasChildren && expandedSpans.has(span.spanId)) {
      result.push(...flattenVisibleSpans(span.children!, expandedSpans, depth + 1));
    }
  }

  return result;
}

// Re-export categorization functions
export {
  categorizeSpan,
  categorizeSpans,
  categorizeSpanTree,
  getSpanCategory,
  getCategoryMeta,
  filterSpansByCategory,
  filterSpanTreeByCategory,
  countByCategory,
  buildDisplayName,
  checkOTelCompliance,
  hasAnyWarnings,
} from './spanCategorization';

// Re-export tool similarity functions
export {
  extractCommonArgKeys,
  groupToolSpans,
  calculateToolSimilarity,
  getToolGroupStats,
} from './toolSimilarity';

// Re-export trace comparison functions
export {
  calculateSpanSimilarity,
  compareTraces,
  flattenAlignedTree,
  getComparisonTypeInfo,
} from './traceComparison';

// Re-export flow transform functions
export {
  spansToFlow,
  applyDagreLayout,
  detectParallelExecution,
  countSpansInTree,
} from './flowTransform';

// Re-export execution order transform functions
export {
  spansToExecutionFlow,
  isContainerSpan,
  findMainFlowSpans,
  sortByStartTime,
} from './executionOrderTransform';

// Re-export intent transform functions
export {
  spansToIntentNodes,
  getRootContainerSpan,
} from './intentTransform';

// Re-export category styles
export {
  CATEGORY_COLORS,
  getCategoryColors,
  type CategoryColorConfig,
} from './categoryStyles';

// Re-export trace stats utilities
export {
  flattenSpans,
  calculateCategoryStats,
  extractToolName,
  extractToolStats,
  type CategoryStats,
  type ToolInfo,
} from './traceStats';
