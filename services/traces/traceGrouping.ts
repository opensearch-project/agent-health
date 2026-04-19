/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace Grouping Utility
 *
 * Groups flat spans by traceId and calculates summary statistics
 * for trace list display.
 */

import { Span, TraceSummary } from '@/types';
import { debug } from '@/lib/debug';

/**
 * Extract service name from span attributes
 */
function extractServiceName(span: Span): string {
  return (
    span.attributes?.['service.name'] ||
    span.attributes?.['gen_ai.system'] ||
    'unknown'
  );
}

/**
 * Find the root span (no parentSpanId) from a list of spans
 */
function findRootSpan(spans: Span[]): Span | undefined {
  return spans.find(span => !span.parentSpanId);
}

/**
 * Calculate total duration from spans (max endTime - min startTime)
 */
function calculateDuration(spans: Span[]): number {
  if (spans.length === 0) return 0;

  let minStart = Infinity;
  let maxEnd = -Infinity;

  for (const span of spans) {
    const startTime = new Date(span.startTime).getTime();
    const endTime = new Date(span.endTime).getTime();
    if (startTime < minStart) minStart = startTime;
    if (endTime > maxEnd) maxEnd = endTime;
  }

  return maxEnd - minStart;
}

/**
 * Check if any span in the list has an error status
 */
function hasErrors(spans: Span[]): boolean {
  return spans.some(span => span.status === 'ERROR');
}

/**
 * Get earliest start time from spans
 */
function getEarliestStartTime(spans: Span[]): string {
  if (spans.length === 0) return new Date().toISOString();

  let earliest = spans[0].startTime;
  for (const span of spans) {
    if (new Date(span.startTime).getTime() < new Date(earliest).getTime()) {
      earliest = span.startTime;
    }
  }
  return earliest;
}

/**
 * Group flat spans by traceId and calculate summary statistics
 *
 * @param spans - Flat array of spans from API
 * @returns Array of TraceSummary objects, sorted by startTime descending (newest first)
 */
export function groupSpansByTrace(spans: Span[]): TraceSummary[] {
  if (!spans || spans.length === 0) return [];
  debug('TraceGrouping', 'Grouping', spans.length, 'spans by traceId');

  // Group spans by traceId
  const traceGroups = new Map<string, Span[]>();

  for (const span of spans) {
    const existing = traceGroups.get(span.traceId) || [];
    existing.push(span);
    traceGroups.set(span.traceId, existing);
  }

  // Convert to TraceSummary objects
  const summaries: TraceSummary[] = [];

  for (const [traceId, traceSpans] of traceGroups) {
    const rootSpan = findRootSpan(traceSpans);
    const serviceName = rootSpan
      ? extractServiceName(rootSpan)
      : extractServiceName(traceSpans[0]);

    summaries.push({
      traceId,
      serviceName,
      spanCount: traceSpans.length,
      rootSpanName: rootSpan?.name || traceSpans[0]?.name || 'Unknown',
      startTime: getEarliestStartTime(traceSpans),
      duration: calculateDuration(traceSpans),
      hasErrors: hasErrors(traceSpans),
      hasEvalSpans: traceSpans.some(s =>
        s.attributes?.['gen_ai.operation.name'] === 'evaluation' ||
        s.name?.includes('test_case')
      ),
      spans: traceSpans,
    });
  }

  // Sort by startTime descending (newest first)
  summaries.sort((a, b) =>
    new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );

  debug('TraceGrouping', 'Grouped into', summaries.length, 'traces');
  return summaries;
}

/**
 * Get spans for a specific trace from grouped data
 */
export function getSpansForTrace(summaries: TraceSummary[], traceId: string): Span[] {
  const summary = summaries.find(s => s.traceId === traceId);
  return summary?.spans || [];
}
