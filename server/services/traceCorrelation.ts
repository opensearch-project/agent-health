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
 * (observed live: 3 root spans / 60 spans for a single invocation at
 * concurrency 5). This module keeps Strategy C always-on (an empty Traces tab
 * by default was judged worse than noise) but makes it a FALLBACK:
 *
 *   1. run the direct clauses first (A ∪ B ∪ D);
 *   2. only if they return nothing, run the window query;
 *   3. post-filter the window result: a span that carries a run-id attribute
 *      or `session.id` naming a DIFFERENT run is dropped; spans with no such
 *      attribute are kept (that is exactly the population Strategy C exists
 *      for).
 *
 * The response says which strategy produced the spans so the UI can caption
 * it ("matched by trace id" / "matched by service-name window — N spans from
 * other runs filtered"). Backend-agnostic: it takes the observability
 * module's `traces.query` as a function, so the OpenSearch and file backends
 * get identical semantics.
 */

import type { Span } from '../../types/index.js';
import type { TracesQueryOptions } from '../adapters/types.js';
import { RUN_ID_ATTRIBUTES } from './tracesService.js';

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
  /** Backend hit a scan/row cap (see ITracesOperations.query). Passed through untouched. */
  truncated?: boolean;
  /** Composite backend: sources that failed while the others answered. Passed through untouched. */
  warnings?: Array<{ source: string; message: string }>;
}

export type TraceQueryFn = (options: TracesQueryOptions) => Promise<TraceQueryPage>;

export interface CorrelatedTracesResult {
  spans: Span[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  correlation: CorrelationInfo;
  truncated?: boolean;
  warnings?: Array<{ source: string; message: string }>;
}

type Phase = 'direct' | 'window';

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

/**
 * Every run-id value a span advertises (`agent_health.run.id`,
 * `gen_ai.conversation.id`). Empty when the span carries neither.
 */
export function spanRunIds(span: Span): string[] {
  return RUN_ID_ATTRIBUTES.map((k) => attr(span, k)).filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
}

/**
 * Post-filter for window (Strategy C) results: drop spans that positively
 * identify themselves as belonging to ANOTHER run. A span is dropped when
 *   - it carries a run-id attribute and none of its values is a requested
 *     run id (only checked when the caller asked for run ids), or
 *   - it carries `session.id` and that is not a requested session id (only
 *     checked when the caller asked for one).
 * Spans without those attributes are kept — Strategy C exists for them.
 * `traceId` is deliberately NOT compared: agents that reach the window
 * fallback don't propagate W3C context, so their trace ids never match.
 */
export function filterWindowSpans(
  spans: Span[],
  identity: { runIds: readonly string[]; sessionIds: readonly string[] }
): { kept: Span[]; filtered: number } {
  const runIds = new Set(identity.runIds);
  const sessionIds = new Set(identity.sessionIds);
  const kept = spans.filter((span) => {
    if (runIds.size > 0) {
      const own = spanRunIds(span);
      if (own.length > 0 && !own.some((id) => runIds.has(id))) return false;
    }
    if (sessionIds.size > 0) {
      const sid = attr(span, 'session.id');
      if (typeof sid === 'string' && sid.length > 0 && !sessionIds.has(sid)) return false;
    }
    return true;
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

function windowIdentity(options: TracesQueryOptions): { runIds: string[]; sessionIds: string[] } {
  return {
    runIds: validIds(options.runIds),
    sessionIds: validIds([options.sessionId, ...(options.agents ?? []).map((a) => a.sessionId)]),
  };
}

async function runWindow(query: TraceQueryFn, options: TracesQueryOptions, wrapCursor: boolean): Promise<CorrelatedTracesResult> {
  const page = await query(windowOptions(options));
  const { kept, filtered } = filterWindowSpans(page.spans ?? [], windowIdentity(options));
  const nextCursor = page.nextCursor ?? null;
  return {
    spans: kept,
    total: Math.max(kept.length, (page.total ?? kept.length) - filtered),
    nextCursor: wrapCursor && nextCursor ? encodePhaseCursor('window', nextCursor) : nextCursor,
    hasMore: page.hasMore ?? false,
    correlation: { strategy: 'window', windowFiltered: filtered },
    truncated: page.truncated,
    warnings: page.warnings,
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
    truncated: page.truncated,
    warnings: page.warnings,
  };
}

/**
 * Execute a traces query with precise-first semantics (see module doc).
 *
 * - direct + window correlators → direct first, window only on an empty
 *   direct result (post-filtered); phase-tagged cursors for pagination.
 * - direct only → one query, labelled by the strategy that matched.
 * - window only → one query, post-filtered against `agents[].sessionId`.
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
    const first = await runDirect(query, options, true);
    if (first.spans.length > 0) return first;
    return runWindow(query, options, true);
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
    truncated: page.truncated,
    warnings: page.warnings,
  };
}
