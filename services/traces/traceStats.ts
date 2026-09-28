/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace Statistics Utilities
 *
 * Shared helper functions for calculating trace statistics.
 * Used by TraceFlowView.
 */

import { CategorizedSpan, SpanCategory } from '@/types';
import { ATTR_GEN_AI_TOOL_NAME } from '@opentelemetry/semantic-conventions/incubating';

/**
 * Category statistics for trace analysis
 */
export interface CategoryStats {
  category: SpanCategory;
  count: number;
  /**
   * Inclusive time: the plain sum of every span's own duration in this
   * category. A wrapper span (an agent loop containing LLM + tool children)
   * counts its children's time AGAIN here, so these numbers can exceed the
   * trace's wall-clock and must not be used as shares of the trace.
   */
  totalDuration: number;
  /**
   * Self time: each span's duration minus the interval UNION of its direct
   * children's durations (clamped at 0). Nested time is attributed to the
   * innermost span only, so the self times of all categories partition the
   * trace and `percentage` is a true share.
   */
  selfDuration: number;
  /** Share of the trace's self time held by this category (sums to 100). */
  percentage: number;
}

/**
 * Tool usage information
 */
export interface ToolInfo {
  name: string;
  count: number;
  totalDuration: number;
}

/**
 * Extract tool name from a span
 */
export function extractToolName(span: CategorizedSpan): string | null {
  // Try gen_ai.tool.name attribute first (OTel semantic convention)
  const toolName = span.attributes?.[ATTR_GEN_AI_TOOL_NAME];
  if (toolName) return toolName;

  // Parse from displayName or name
  const name = span.displayName || span.name || '';

  // Look for tool name patterns
  const patterns = [
    /execute_tool\s+(\S+)/i,
    /executeTools,\s*(\S+)/i,
    /tool\.execute\s+(\S+)/i,
  ];

  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) return match[1];
  }

  // Try to get the last meaningful part after comma
  if (name.includes(',')) {
    const parts = name.split(',');
    const lastPart = parts[parts.length - 1].trim();
    if (lastPart && !lastPart.includes('agent.node')) {
      return lastPart;
    }
  }

  return null;
}

/**
 * Flatten span tree and collect all spans
 */
export function flattenSpans(spans: CategorizedSpan[]): CategorizedSpan[] {
  const result: CategorizedSpan[] = [];

  const collect = (spanList: CategorizedSpan[]) => {
    for (const span of spanList) {
      result.push(span);
      if (span.children && span.children.length > 0) {
        collect(span.children as CategorizedSpan[]);
      }
    }
  };

  collect(spans);
  return result;
}

interface SpanInterval {
  start: number;
  end: number;
}

function toMs(value: string | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

/**
 * Inclusive duration of a span in ms: the explicit `duration` when present
 * (what the API and every fixture carry), otherwise derived from the
 * timestamps. This is the ONE length basis used for both a parent's own time
 * and its children's occupancy — see {@link spanInterval}.
 */
function inclusiveDuration(span: Pick<CategorizedSpan, 'startTime' | 'endTime' | 'duration'>): number {
  if (typeof span.duration === 'number' && !Number.isNaN(span.duration)) return Math.max(0, span.duration);
  const start = toMs(span.startTime);
  const end = toMs(span.endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return end - start;
}

/**
 * A span's [start, end] in epoch ms, placed at its start timestamp and
 * extended by {@link inclusiveDuration}. Deliberately NOT `endTime`: the
 * child-occupancy union and the parent's inclusive time must be measured on
 * the same clock, otherwise a `duration` that disagrees with the timestamps
 * would produce self times the numbers don't support.
 */
function spanInterval(span: Pick<CategorizedSpan, 'startTime' | 'endTime' | 'duration'>): SpanInterval | null {
  const start = toMs(span.startTime);
  if (Number.isNaN(start)) return null;
  return { start, end: start + inclusiveDuration(span) };
}

/**
 * Total length covered by the UNION of the given intervals (overlaps counted
 * once), clipped to `bounds`.
 */
function unionLength(intervals: SpanInterval[], bounds: SpanInterval): number {
  const clipped = intervals
    .map(i => ({ start: Math.max(i.start, bounds.start), end: Math.min(i.end, bounds.end) }))
    .filter(i => i.end > i.start)
    .sort((a, b) => a.start - b.start);

  let covered = 0;
  let current: SpanInterval | null = null;
  for (const interval of clipped) {
    if (!current || interval.start > current.end) {
      if (current) covered += current.end - current.start;
      current = { ...interval };
    } else if (interval.end > current.end) {
      current.end = interval.end;
    }
  }
  if (current) covered += current.end - current.start;
  return covered;
}

/**
 * Self time per span: inclusive duration minus the interval union of its
 * DIRECT children (found via `parentSpanId` within the same trace), clamped
 * at 0. Children whose parent is not in `spans` (orphans) simply have no
 * parent to subtract from, and count their own full self time.
 *
 * Keyed by `spanId`; spans without an id fall back to their inclusive
 * duration (they cannot be anyone's parent). Spans without a `traceId` are
 * only matched with children that also lack one — callers are expected to
 * pass one trace at a time, as every trace view does.
 */
export function calculateSelfDurations(spans: CategorizedSpan[]): Map<CategorizedSpan, number> {
  const childrenByParent = new Map<string, CategorizedSpan[]>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const key = `${span.traceId ?? ''}:${span.parentSpanId}`;
    const siblings = childrenByParent.get(key);
    if (siblings) siblings.push(span);
    else childrenByParent.set(key, [span]);
  }

  const result = new Map<CategorizedSpan, number>();
  for (const span of spans) {
    const inclusive = inclusiveDuration(span);
    const children = span.spanId ? childrenByParent.get(`${span.traceId ?? ''}:${span.spanId}`) : undefined;
    const bounds = spanInterval(span);
    if (!children || children.length === 0 || !bounds) {
      result.set(span, inclusive);
      continue;
    }
    const childIntervals = children
      .map(spanInterval)
      .filter((i): i is SpanInterval => i !== null);
    const childTime = unionLength(childIntervals, bounds);
    result.set(span, Math.max(0, inclusive - childTime));
  }
  return result;
}

/**
 * Calculate category statistics from spans.
 *
 * `percentage` is the category's share of SELF time (see
 * {@link CategoryStats.selfDuration}): a wrapper span only contributes the
 * time none of its children cover, so nested work is not double-counted and
 * the shares sum to 100%. `totalDuration` keeps the inclusive sum for callers
 * that want a per-category "time spent inside" figure.
 *
 * The second argument (trace wall-clock duration) is unused — shares are
 * relative to the sum of self times, which is robust to gaps and to traces
 * whose root span is missing.
 */
export function calculateCategoryStats(spans: CategorizedSpan[], _totalDuration?: number): CategoryStats[] {
  const selfDurations = calculateSelfDurations(spans);
  const categoryMap = new Map<SpanCategory, { count: number; inclusive: number; self: number }>();

  for (const span of spans) {
    const existing = categoryMap.get(span.category) || { count: 0, inclusive: 0, self: 0 };
    categoryMap.set(span.category, {
      count: existing.count + 1,
      inclusive: existing.inclusive + inclusiveDuration(span),
      self: existing.self + (selfDurations.get(span) ?? 0),
    });
  }

  let totalSelf = 0;
  categoryMap.forEach((data) => {
    totalSelf += data.self;
  });

  const stats: CategoryStats[] = [];
  categoryMap.forEach((data, category) => {
    stats.push({
      category,
      count: data.count,
      totalDuration: data.inclusive,
      selfDuration: data.self,
      percentage: totalSelf > 0 ? (data.self / totalSelf) * 100 : 0,
    });
  });

  // Sort by self time descending (inclusive as tie-breaker)
  return stats.sort((a, b) => (b.selfDuration - a.selfDuration) || (b.totalDuration - a.totalDuration));
}

/**
 * Extract unique tools with usage stats
 */
export function extractToolStats(spans: CategorizedSpan[]): ToolInfo[] {
  const toolMap = new Map<string, { count: number; duration: number }>();

  for (const span of spans) {
    if (span.category === 'TOOL') {
      const toolName = extractToolName(span);
      if (toolName) {
        const existing = toolMap.get(toolName) || { count: 0, duration: 0 };
        toolMap.set(toolName, {
          count: existing.count + 1,
          duration: existing.duration + (span.duration || 0),
        });
      }
    }
  }

  const tools: ToolInfo[] = [];
  toolMap.forEach((data, name) => {
    tools.push({
      name,
      count: data.count,
      totalDuration: data.duration,
    });
  });

  // Sort by usage count descending
  return tools.sort((a, b) => b.count - a.count);
}
