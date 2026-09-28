/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exact-match ("fail-closed") filter the trace poller applies to fetched spans.
 *
 * The fetch unions every correlation strategy the report allows — A (eval
 * `traceId`), B (`runId` → `agent_health.run.id` / `gen_ai.conversation.id`),
 * C (service-name + time window), D (`session.id`). Strategy C is a discovery
 * fallback that can return spans of CONCURRENT runs of the same agent, so when
 * the report carries a strict correlator only spans matching one may be judged.
 *
 * Rules:
 *  - STRICT correlators are `session.id` (D) and a *valid W3C* eval `traceId`
 *    (A). Agents that emit either stamp it on every span of the run, so a span
 *    that matches neither is not this run's. When the report has no strict
 *    correlator every fetched span is kept (window / run-id fetch as-is) —
 *    unchanged behaviour.
 *  - `runId` (B) is POSITIVE evidence only: a span carrying the report's run id
 *    is always kept, but a span lacking it is not rejected on that basis (many
 *    agents never stamp the run id; the window fallback exists for them).
 *  - A `traceId` that is not a W3C trace id is ignored. Pre-fix it was still
 *    used as the strict filter, so a report whose `traceId` had been stamped
 *    with a connector run id (`conv-…`) rejected every span Strategy B had
 *    found and timed out with "Traces never arrived".
 */

import type { Span } from '@/types';
import { isW3CTraceId } from '@/lib/traceIdentity';

/** Span attributes that carry the agent run id (mirrors server RUN_ID_ATTRIBUTES). */
export const RUN_ID_SPAN_ATTRIBUTES = ['agent_health.run.id', 'gen_ai.conversation.id'] as const;

export interface PreciseCorrelators {
  /** Report `sessionId` (Strategy D). */
  sessionId?: string | null;
  /** Report `traceId` — the eval `test_case` span's W3C trace id (Strategy A). */
  evalTraceId?: string | null;
  /** Report `runId` — connector/hook-provided agent run id (Strategy B). */
  runId?: string | null;
}

export type StrictCorrelatorKind = 'sessionId' | 'traceId';

function attr(span: Span, key: string): unknown {
  return (span.attributes as Record<string, unknown> | undefined)?.[key];
}

/** True when the span carries `runId` in any run-id attribute. */
export function spanMatchesRunId(span: Span, runId: string): boolean {
  return RUN_ID_SPAN_ATTRIBUTES.some((key) => attr(span, key) === runId);
}

/** Which strict correlators the report carries (see module doc). */
export function strictCorrelators(c: PreciseCorrelators): StrictCorrelatorKind[] {
  const out: StrictCorrelatorKind[] = [];
  if (typeof c.sessionId === 'string' && c.sessionId.length > 0) out.push('sessionId');
  if (isW3CTraceId(c.evalTraceId)) out.push('traceId');
  return out;
}

/**
 * Keep the spans that belong to this run. With no strict correlator every span
 * is kept; otherwise a span must match a strict correlator or carry the
 * report's run id.
 */
export function filterSpansByPreciseCorrelators(
  spans: Span[],
  c: PreciseCorrelators
): { spans: Span[]; strict: StrictCorrelatorKind[] } {
  const strict = strictCorrelators(c);
  if (strict.length === 0) return { spans, strict };

  const evalTraceId = strict.includes('traceId') ? String(c.evalTraceId).toLowerCase() : undefined;
  const runId = typeof c.runId === 'string' && c.runId.length > 0 ? c.runId : undefined;
  const kept = spans.filter((span) => {
    if (strict.includes('sessionId') && attr(span, 'session.id') === c.sessionId) return true;
    if (evalTraceId && typeof span.traceId === 'string' && span.traceId.toLowerCase() === evalTraceId) return true;
    if (runId && spanMatchesRunId(span, runId)) return true;
    return false;
  });
  return { spans: kept, strict };
}
