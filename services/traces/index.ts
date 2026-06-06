/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traces Service - Fetch and process trace data from OpenSearch
 */

import { Span, TimeRange, TraceQueryParams, TraceSearchResult } from '@/types';
import { getSpanCategory } from './spanCategorization';
import { readEnv } from '@/lib/envCompat';

// Re-export trace grouping utilities
export { groupSpansByTrace, getSpansForTrace } from './traceGrouping';

// Re-export message extraction
export { extractMessagesFromSpans } from './messageExtraction';

/**
 * Get API base URL dynamically
 * Server-side (Node.js): Use localhost with AH_PORT env var (legacy: AGENT_HEALTH_PORT)
 * Client-side (browser): Use relative URLs
 */
function getApiBaseUrl(): string {
  const isServerSide = typeof window === 'undefined';
  if (isServerSide) {
    const port = readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001';
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
 * Fetch traces correlated with a single test-case run, using all available
 * correlation strategies (see AGENTS.md → Trace correlation conventions):
 *
 *   A. traceId  — W3C-propagated agents share traceId with the eval span
 *   B. runId    — agents tag spans with `gen_ai.request.id == runId`
 *   C. agents   — service.name + time-window fallback (opt-in / `includeWindowFallback`)
 *
 * Strategies A and B are always safe (no false positives). Strategy C is
 * opt-in because it can surface concurrent runs of the same agent and
 * cross-team noise on a shared cluster.
 */
export async function fetchTracesForRun(params: {
  runId: string;
  evalTraceId?: string;
  includeWindowFallback?: boolean;
  windowAgents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
  size?: number;
}): Promise<TraceSearchResult> {
  const { runId, evalTraceId, includeWindowFallback, windowAgents, size = 1000 } = params;
  const query: TraceQueryParams = { runIds: [runId], size };
  if (evalTraceId) query.traceId = evalTraceId;
  if (includeWindowFallback && windowAgents && windowAgents.length > 0) {
    query.agents = windowAgents;
  }
  return fetchTraces(query);
}

/**
 * Fetch recent traces for live tailing
 */
export async function fetchRecentTraces(options: {
  minutesAgo?: number;
  sessionId?: string;
  serviceName?: string;
  textSearch?: string;
  size?: number;
  cursor?: string;
}): Promise<TraceSearchResult> {
  const { minutesAgo = 5, sessionId, serviceName, textSearch, size = 100, cursor } = options;

  // Session queries don't need a time range — fetch all spans for the session
  if (sessionId) {
    return fetchTraces({ sessionId, serviceName, textSearch, size, cursor });
  }

  const now = Date.now();
  const startTime = now - (minutesAgo * 60 * 1000);

  return fetchTraces({
    startTime,
    endTime: now,
    serviceName,
    textSearch,
    size,
    cursor,
  });
}

/**
 * Fetch all traces for a Claude Code session by session ID
 */
export async function fetchTracesBySessionId(sessionId: string): Promise<TraceSearchResult> {
  return fetchTraces({ sessionId, size: 1000 });
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
  const category = getSpanCategory(span);

  const CATEGORY_HEX: Record<string, string> = {
    AGENT: '#6366f1',  // indigo
    LLM: '#a855f7',    // purple
    TOOL: '#f59e0b',   // amber
    EVAL: '#10b981',   // emerald
    ERROR: '#ef4444',  // red
    OTHER: '#64748b',  // slate
  };

  return CATEGORY_HEX[category] || CATEGORY_HEX.OTHER;
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

// Trace-level summary (category counts + tokens + models) reused by both
// the inline expansion header and the fullscreen header.
export {
  computeTraceSummary,
  isEmptyTraceSummary,
  type TraceSummary,
} from './traceSummary';
