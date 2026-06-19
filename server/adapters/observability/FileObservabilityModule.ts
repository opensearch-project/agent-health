/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed observability module.
 *
 * Realizes `IObservabilityModule` over the on-disk `TraceStore`
 * (`agent-health-data/traces/`). This is the zero-config default when **no**
 * OpenSearch observability cluster is configured — so local evaluations get a
 * working Traces view out of the box, with no external infra.
 *
 * The trace query replicates the OpenSearch correlation semantics in-memory
 * (see services/tracesService.ts + AGENTS.md → Trace correlation conventions):
 *   A. traceId                         — W3C-propagated agents share the eval traceId
 *   B. runIds   → gen_ai.request.id    — agents tag spans with the runId
 *   C. agents   → service.name / gen_ai.agent.name within a time window
 * plus must-filters: sessionId (session.id), time range, serviceName, textSearch.
 * 2+ correlation clauses are OR-unioned (minimum_should_match: 1); a single
 * clause is required. Sorted newest-first; offset cursor for pagination.
 */

import type {
  IObservabilityModule,
  ILogsOperations,
  ITracesOperations,
  IMetricsOperations,
  TracesQueryOptions,
  LogsQueryOptions,
} from '../types.js';
import type { Span, HealthStatus, OpenSearchLog } from '../../../types/index.js';
import { TraceStore } from '../file/TraceStore.js';

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== '') return n; // numeric string = epoch ms
    const p = Date.parse(v);
    return Number.isNaN(p) ? 0 : p;
  }
  return 0;
}

function spanMs(s: Span): number {
  return Date.parse(s.startTime);
}

/** Whether a span's service identity matches `name` (service.name / serviceName / gen_ai.agent.name). */
function serviceMatches(s: Span, name: string): boolean {
  const a = s.attributes || {};
  return a['service.name'] === name || a['serviceName'] === name || a['gen_ai.agent.name'] === name;
}

export function computeUseUnion(options: TracesQueryOptions): boolean {
  const { traceId, runIds, agents } = options;
  return (
    [!!traceId, !!(runIds && runIds.length > 0)].filter(Boolean).length + (agents?.length ?? 0) > 1
  );
}

/** Replicates the OpenSearch bool query (must filters + must/should correlation). */
export function matchesQuery(s: Span, options: TracesQueryOptions, useUnion: boolean): boolean {
  const { traceId, runIds, sessionId, startTime, endTime, serviceName, textSearch, agents } = options;
  const a = s.attributes || {};

  // ---- must-filters (always required) ----
  if (sessionId && a['session.id'] !== sessionId) return false;
  if (startTime !== undefined && spanMs(s) < toMs(startTime)) return false;
  if (endTime !== undefined && spanMs(s) > toMs(endTime)) return false;
  if (serviceName && !serviceMatches(s, serviceName)) return false;
  if (textSearch) {
    const q = textSearch.toLowerCase();
    const hit =
      (s.name || '').toLowerCase().includes(q) ||
      Object.values(a).some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    if (!hit) return false;
  }

  // ---- correlation clauses (A/B/C) ----
  const clauses: boolean[] = [];
  if (traceId) clauses.push(s.traceId === traceId);
  if (runIds && runIds.length > 0) {
    const valid = runIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    clauses.push(valid.includes(a['gen_ai.request.id']));
  }
  if (agents && agents.length > 0) {
    for (const ag of agents) {
      clauses.push(serviceMatches(s, ag.serviceName) && spanMs(s) >= ag.startedAt && spanMs(s) <= ag.endedAt);
    }
  }

  // useUnion → at least one correlation clause (should); else → all clauses (must).
  // No correlation clauses (pure time-range browse) → matches on must-filters alone.
  return useUnion ? clauses.some(Boolean) : clauses.every(Boolean);
}

function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const n = JSON.parse(decodeURIComponent(cursor))?.offset;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function encodeOffset(offset: number): string {
  return encodeURIComponent(JSON.stringify({ offset }));
}

class FileTracesOperations implements ITracesOperations {
  constructor(private readonly store: TraceStore) {}

  async query(options: TracesQueryOptions) {
    const { traceId, runIds, sessionId, startTime, endTime, size = 100, cursor, agents } = options;
    const hasTimeRange = startTime !== undefined || endTime !== undefined;
    const hasIdFilter = !!(traceId || (runIds && runIds.length > 0) || sessionId || (agents && agents.length > 0));
    if (!hasIdFilter && !hasTimeRange) {
      throw new Error('Either traceId, runIds, sessionId, agents, or time range is required');
    }

    const useUnion = computeUseUnion(options);

    // Fast path: a single trace lookup reads just that file.
    const candidates: Span[] =
      traceId && !useUnion ? await this.store.readTrace(traceId) : await this.store.readAll();

    const matched = candidates
      .filter((s) => matchesQuery(s, options, useUnion))
      .sort((x, y) => spanMs(y) - spanMs(x)); // newest first

    const offset = decodeOffset(cursor);
    const page = matched.slice(offset, offset + size);
    const hasMore = matched.length > offset + size;

    return {
      spans: page,
      total: matched.length,
      nextCursor: hasMore ? encodeOffset(offset + size) : null,
      hasMore,
    };
  }

  async getByTraceId(traceId: string): Promise<Span[]> {
    return this.store.readTrace(traceId);
  }

  async getByRunIds(runIds: string[]): Promise<Span[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (!valid.length) return [];
    return (await this.query({ runIds: valid, size: 100000 })).spans;
  }
}

class FileLogsOperations implements ILogsOperations {
  // Logs file backend is a future addition; traces are the focus.
  async query(_options: LogsQueryOptions): Promise<{ logs: OpenSearchLog[]; total: number }> {
    return { logs: [], total: 0 };
  }
}

class NoopMetricsOperations implements IMetricsOperations {}

export class FileObservabilityModule implements IObservabilityModule {
  readonly traces: ITracesOperations;
  readonly logs: ILogsOperations;
  readonly metrics: IMetricsOperations;
  private readonly store: TraceStore;

  constructor(baseDir?: string) {
    this.store = new TraceStore(baseDir);
    this.traces = new FileTracesOperations(this.store);
    this.logs = new FileLogsOperations();
    this.metrics = new NoopMetricsOperations();
  }

  /** Ingest spans (used by the embedded OTLP receiver). */
  async ingest(spans: Span[]): Promise<void> {
    await this.store.writeSpans(spans);
  }

  async health(): Promise<HealthStatus> {
    return { status: 'ok', index: this.store.directory };
  }

  isConfigured(): boolean {
    return true;
  }
}
