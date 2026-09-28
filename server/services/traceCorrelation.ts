/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Precise-first trace correlation for `POST /api/traces`.
 *
 * Callers that want "the spans of ONE agent run" send every correlator they
 * have (see AGENTS.md → Trace correlation conventions):
 *
 *   direct — A `traceId`, B `runIds` (`agent_health.run.id` /
 *            `gen_ai.conversation.id`), D `sessionId` (`session.id`). These
 *            are exact: a span either carries the run's id or it doesn't.
 *   window — C `agents[]` (service.name + wall-clock window). This is a
 *            DISCOVERY fallback for agents that emit none of the above; it is
 *            inherently fuzzy and, on a shared cluster with concurrency > 1,
 *            it also matches neighbouring runs of the same agent.
 *
 * Pre-fix the server OR'd all of them into one `bool.should`, so a run that
 * correlated perfectly by trace id STILL had its neighbours' spans unioned in
 * (observed live: 3 root spans / 72 spans for a single invocation at
 * concurrency 5). This module keeps Strategy C always-on (an empty Traces tab
 * by default was judged worse than noise) but makes it a FALLBACK:
 *
 *   1. run the direct clauses first (A ∪ B ∪ D);
 *   2. if they found any of the AGENT's spans, that is the answer — the
 *      window is never consulted. Agent Health's own eval/judge spans do not
 *      count as a hit: the eval `test_case` span sits on the requested trace
 *      and carries the run id itself, so for an agent that emits none of
 *      A/B/D the direct query returns exactly that one span — which must
 *      not suppress the fallback that is the only way to find the agent;
 *   3. otherwise run the window query and post-filter it: a trace that
 *      carries Agent Health's own `agent_health.run.id` naming a DIFFERENT
 *      run is dropped whole; everything else is kept (that is exactly the
 *      population Strategy C exists for). Only our own attribute is used as
 *      negative evidence — `gen_ai.conversation.id` and `session.id` are
 *      OTEL-standard ids a third-party agent may legitimately fill with its
 *      own thread/session id, so a mismatch there proves nothing.
 *
 * The response says which strategy produced the spans so the UI can caption
 * it ("matched by trace id" / "matched by service-name window — N spans from
 * other runs filtered"). Backend-agnostic: it takes the observability
 * module's `traces.query` as a function, so the OpenSearch and file backends
 * get identical semantics.
 */

import type { Span } from '../../types/index.js';
import type { TracesQueryOptions } from '../adapters/types.js';
import { RUN_ID_ATTRIBUTES, isEvalOrJudgeSpan } from './tracesService.js';

export type CorrelationStrategy = 'traceId' | 'runIds' | 'sessionId' | 'window' | 'none';

export interface CorrelationInfo {
  /** Which correlation strategy produced `spans`. */
  strategy: CorrelationStrategy;
  /**
   * Number of window-matched spans dropped by the run-identity post-filter
   * (only ever non-zero for `strategy: 'window'`).
   */
  windowFiltered: number;
}

export interface TraceQueryPage {
  spans: Span[];
  total: number;
  nextCursor?: string | null;
  hasMore?: boolean;
}

export type TraceQueryFn = (options: TracesQueryOptions) => Promise<TraceQueryPage>;

export interface CorrelatedTracesResult {
  spans: Span[];
  total: number;
  nextCursor: string | null;
  /**
   * Whether the BACKEND has more results for the phase that produced this
   * page. In the window phase the post-filter may shrink a page (even to
   * zero) without changing this flag — a paginating caller keeps following
   * `nextCursor` until it is null.
   */
  hasMore: boolean;
  correlation: CorrelationInfo;
}

type Phase = 'direct' | 'window';

/** Agent Health's OWN run-id attribute — the only one safe to use as negative evidence. */
const OWN_RUN_ID_ATTRIBUTE = 'agent_health.run.id';

function validIds(ids: readonly unknown[] | undefined): string[] {
  return (ids ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Whether the query carries any exact (non-window) correlator. */
export function hasDirectCorrelator(options: TracesQueryOptions): boolean {
  return !!options.traceId || validIds(options.runIds).length > 0 || !!options.sessionId;
}

function attr(span: Span, key: string): unknown {
  return (span.attributes as Record<string, unknown> | undefined)?.[key];
}

function stringAttr(span: Span, key: string): string | undefined {
  const v = attr(span, key);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Every run-id value a span advertises (`agent_health.run.id`,
 * `gen_ai.conversation.id`) — used for POSITIVE matching/labelling only.
 */
export function spanRunIds(span: Span): string[] {
  return RUN_ID_ATTRIBUTES.map((k) => stringAttr(span, k)).filter((v): v is string => !!v);
}

/** True when at least one span is the agent's own work (not an eval/judge span). */
export function hasAgentSpans(spans: Span[]): boolean {
  return spans.some((s) => !isEvalOrJudgeSpan(s.attributes as Record<string, unknown>, s.name));
}

/**
 * Post-filter for window (Strategy C) results: drop traces that positively
 * identify themselves as belonging to ANOTHER Agent Health run. Identity is
 * resolved per TRACE — a run's root usually carries the run id while its
 * HTTP/DB children don't, and those children must follow their root
 * (measured live: 13 of 72 window spans were identity-less children of
 * other runs' roots). A trace is dropped when any of its spans carries
 * `agent_health.run.id` and none of those values is a requested run id;
 * a span without a traceId is judged on its own attributes. Nothing else is
 * negative evidence: traces without the attribute are kept whole (Strategy C
 * exists for them), `gen_ai.conversation.id` / `session.id` may carry a
 * third-party agent's own ids, and `traceId` equality is not required
 * (window-fallback agents don't propagate W3C context).
 */
export function filterWindowSpans(
  spans: Span[],
  identity: { runIds: readonly string[] }
): { kept: Span[]; filtered: number } {
  const runIds = new Set(identity.runIds);
  if (runIds.size === 0) return { kept: spans, filtered: 0 };

  const traceRunIds = new Map<string, Set<string>>();
  for (const span of spans) {
    const own = stringAttr(span, OWN_RUN_ID_ATTRIBUTE);
    if (!own || !span.traceId) continue;
    const set = traceRunIds.get(span.traceId) ?? new Set<string>();
    set.add(own);
    traceRunIds.set(span.traceId, set);
  }

  const kept = spans.filter((span) => {
    const own = span.traceId ? traceRunIds.get(span.traceId) : undefined;
    const ids = own ?? new Set([stringAttr(span, OWN_RUN_ID_ATTRIBUTE)].filter((v): v is string => !!v));
    if (ids.size === 0) return true; // no identity → Strategy C's population
    return [...ids].some((id) => runIds.has(id));
  });
  return { kept, filtered: spans.length - kept.length };
}

/**
 * Name the direct strategy that matched, by inspecting the returned spans in
 * precedence order (A > B > D). Falls back to the first correlator present
 * when no span is attributable (should not happen for an exact query, but a
 * label is still owed to the caller).
 */
export function pickDirectStrategy(spans: Span[], options: TracesQueryOptions): CorrelationStrategy {
  const runIds = new Set(validIds(options.runIds));
  if (options.traceId && spans.some((s) => s.traceId === options.traceId)) return 'traceId';
  if (runIds.size > 0 && spans.some((s) => spanRunIds(s).some((id) => runIds.has(id)))) return 'runIds';
  if (options.sessionId && spans.some((s) => attr(s, 'session.id') === options.sessionId)) return 'sessionId';
  if (options.traceId) return 'traceId';
  if (runIds.size > 0) return 'runIds';
  if (options.sessionId) return 'sessionId';
  return 'none';
}

// ---------------------------------------------------------------------------
// Pagination: a cursor handed out in precise-first mode must come back to the
// SAME phase's query (a window-query `search_after` is meaningless against the
// direct query and vice-versa), so the phase is wrapped into the cursor.
// ---------------------------------------------------------------------------

function encodePhaseCursor(phase: Phase, cursor: string): string {
  return encodeURIComponent(JSON.stringify({ phase, cursor }));
}

function decodePhaseCursor(cursor?: string): { phase: Phase; cursor: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor));
    if (parsed && (parsed.phase === 'direct' || parsed.phase === 'window') && typeof parsed.cursor === 'string') {
      return { phase: parsed.phase, cursor: parsed.cursor };
    }
  } catch {
    /* not a phase cursor — fall through */
  }
  return null;
}

function directOptions(options: TracesQueryOptions): TracesQueryOptions {
  const { agents: _agents, ...rest } = options;
  return rest;
}

function windowOptions(options: TracesQueryOptions): TracesQueryOptions {
  const { traceId: _t, runIds: _r, sessionId: _s, ...rest } = options;
  return rest;
}

async function runWindow(query: TraceQueryFn, options: TracesQueryOptions, wrapCursor: boolean): Promise<CorrelatedTracesResult> {
  const page = await query(windowOptions(options));
  const { kept, filtered } = filterWindowSpans(page.spans ?? [], { runIds: validIds(options.runIds) });
  const nextCursor = page.nextCursor ?? null;
  return {
    spans: kept,
    total: Math.max(kept.length, (page.total ?? kept.length) - filtered),
    nextCursor: wrapCursor && nextCursor ? encodePhaseCursor('window', nextCursor) : nextCursor,
    hasMore: page.hasMore ?? false,
    correlation: { strategy: 'window', windowFiltered: filtered },
  };
}

async function runDirect(query: TraceQueryFn, options: TracesQueryOptions, wrapCursor: boolean): Promise<CorrelatedTracesResult> {
  const page = await query(directOptions(options));
  const spans = page.spans ?? [];
  const nextCursor = page.nextCursor ?? null;
  return {
    spans,
    total: page.total ?? spans.length,
    nextCursor: wrapCursor && nextCursor ? encodePhaseCursor('direct', nextCursor) : nextCursor,
    hasMore: page.hasMore ?? false,
    correlation: { strategy: pickDirectStrategy(spans, options), windowFiltered: 0 },
  };
}

/**
 * Execute a traces query with precise-first semantics (see module doc).
 *
 * - direct + window correlators → direct first; if it found any agent span
 *   that is the result. Otherwise the window (post-filtered), with the
 *   direct query's own eval/judge spans kept in front of it — they ARE this
 *   run's — de-duplicated by spanId. Phase-tagged cursors for pagination.
 * - direct only → one query, labelled by the strategy that matched.
 * - window only → one query (no run id to filter against → nothing dropped).
 * - neither (time-range browse) → one query, `strategy: 'none'`.
 */
export async function queryTracesPreciseFirst(
  query: TraceQueryFn,
  options: TracesQueryOptions
): Promise<CorrelatedTracesResult> {
  const direct = hasDirectCorrelator(options);
  const window = (options.agents?.length ?? 0) > 0;

  if (direct && window) {
    const phased = decodePhaseCursor(options.cursor);
    if (phased) {
      const continued = { ...options, cursor: phased.cursor };
      return phased.phase === 'direct' ? runDirect(query, continued, true) : runWindow(query, continued, true);
    }
    const exact = await runDirect(query, options, true);
    if (hasAgentSpans(exact.spans)) return exact;

    const fallback = await runWindow(query, options, true);
    if (exact.spans.length === 0) return fallback;
    if (fallback.spans.length === 0) return exact; // only our own eval spans exist — say how they were found
    const seen = new Set(exact.spans.map((s) => s.spanId));
    const windowOnly = fallback.spans.filter((s) => !seen.has(s.spanId));
    return {
      ...fallback,
      spans: [...exact.spans, ...windowOnly],
      total: fallback.total + exact.spans.length,
    };
  }

  if (direct) return runDirect(query, options, false);
  if (window) return runWindow(query, options, false);

  const page = await query(options);
  return {
    spans: page.spans ?? [],
    total: page.total ?? (page.spans ?? []).length,
    nextCursor: page.nextCursor ?? null,
    hasMore: page.hasMore ?? false,
    correlation: { strategy: 'none', windowFiltered: 0 },
  };
}
