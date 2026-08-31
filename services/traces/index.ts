/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traces Service - Fetch and process trace data from OpenSearch
 */

import { Span, TimeRange, TraceQueryParams, TraceSearchResult } from '@/types';
import { getSpanCategory } from './spanCategorization';
import { getBackendUrl } from '@/lib/portConfig';

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
    // Server-side self-call — use the canonical backend URL (AH_PORT is kept
    // in lockstep with the actual bound port; see server lifecycle).
    return getBackendUrl();
  }
  return ''; // Relative URLs in browser
}

/**
 * Fetch traces from the backend API
 * Backend handles config resolution (file or env vars) - no headers needed from frontend
 *
 * Bounded by a client-side timeout (default 20s, see {@link TRACE_FETCH_TIMEOUT_MS}):
 * a hung/unresponsive trace backend must surface as a clear error the caller
 * can retry, never an indefinite pending fetch (the Traces tab's loading
 * spinner has no other way to resolve if the network call itself never
 * settles).
 */
export const TRACE_FETCH_TIMEOUT_MS = 20000;

export async function fetchTraces(params: TraceQueryParams, timeoutMs: number = TRACE_FETCH_TIMEOUT_MS): Promise<TraceSearchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Traces request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
 *   B. runId    — agents tag spans with `agent_health.run.id == runId` (or the
 *                 OTEL-standard `gen_ai.conversation.id`); the server query
 *                 unions both. NOT `gen_ai.request.id` — that is not a
 *                 registered Gen AI semconv attribute. See AGENTS.md → Strategy B.
 *   C. agents   — service.name + time-window fallback (opt-in / `includeWindowFallback`)
 *
 * Strategies A and B are always safe (no false positives). Strategy C is
 * opt-in because it can surface concurrent runs of the same agent and
 * cross-team noise on a shared cluster.
 */
export async function fetchTracesForRun(params: {
  /**
   * Agent run id (Strategy B correlation). Optional — runs persisted via the
   * deferred trace-mode path may not carry one; in that case correlation
   * falls back to the time-window `windowAgents` clause (Strategy C).
   */
  runId?: string;
  evalTraceId?: string;
  /**
   * Strategy A (direct): the report's own `traceId`. Agents that emit their
   * own OTel trace (e.g. pi) carry it on every span but NOT our connector
   * `runId`, so a direct `traceId` lookup returns the run's spans immediately
   * — independent of the deep-dive's window hints.
   */
  traceId?: string;
  /**
   * Strategy D (direct): the report's `session.id`. Claude Code stamps it on
   * every span; a direct `sessionId` lookup correlates without needing a
   * window. (Server matches both the analyzed field and its `.keyword`.)
   */
  sessionId?: string;
  includeWindowFallback?: boolean;
  windowAgents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>;
  size?: number;
}): Promise<TraceSearchResult> {
  const { runId, evalTraceId, traceId, sessionId, includeWindowFallback, windowAgents, size = 1000 } = params;
  // Only include the runIds clause when runId is a non-empty string. A
  // `[undefined]` array makes the server build a `terms: [null]` query that
  // OpenSearch rejects wholesale (taking the Strategy C window fallback down
  // with it). Runs persisted via the deferred trace-mode path may not carry
  // a runId, so this guard is load-bearing for the Traces tab. See #264.
  const query: TraceQueryParams = { size };
  if (typeof runId === 'string' && runId.length > 0) {
    query.runIds = [runId];
  }
  // traceId: explicit param wins, else the eval-span traceId (both → query.traceId).
  if (traceId || evalTraceId) query.traceId = traceId || evalTraceId;
  if (typeof sessionId === 'string' && sessionId.length > 0) query.sessionId = sessionId;
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
 * Compute the initial expanded-spans set for a trace: every root, plus
 * every ancestor of any ERROR-status span so the failing span is visible
 * on load instead of hidden behind collapsed parents (TraceTree and
 * Timeline both key off this set).
 */
export function getInitialExpandedSpans(spanTree: Span[]): Set<string> {
  const expanded = new Set<string>();
  const walk = (spans: Span[], ancestors: string[]): void => {
    for (const span of spans) {
      if (!span.parentSpanId) expanded.add(span.spanId);
      if (span.status === 'ERROR') {
        for (const id of ancestors) expanded.add(id);
      }
      if (span.children?.length) {
        walk(span.children, [...ancestors, span.spanId]);
      }
    }
  };
  walk(spanTree, []);
  return expanded;
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
