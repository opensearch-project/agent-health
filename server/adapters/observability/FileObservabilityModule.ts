/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed observability module.
 *
 * Realizes `IObservabilityModule` over the on-disk `TraceStore`
 * (`.agent-health/data/traces/`). This is the zero-config default when **no**
 * OpenSearch observability cluster is configured — so local evaluations get a
 * working Traces view out of the box, with no external infra.
 *
 * The trace query replicates the OpenSearch correlation semantics in-memory
 * (see services/tracesService.ts + AGENTS.md → Trace correlation conventions):
 *   A. traceId                         — W3C-propagated agents share the eval traceId
 *   B. runIds   → agent_health.run.id   — agents tag spans with the runId
 *   C. agents   → service.name / gen_ai.agent.name within a time window
 *   D. sessionId → session.id (a correlation clause, unioned like the others —
 *                  NOT a must-filter, mirroring tracesService.ts, so a stale
 *                  report sessionId can't zero out a traceId/runId match)
 * plus must-filters: time range, serviceName, textSearch.
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
  ObservabilityBackendInfo,
  RunMetricsHints,
  BatchMetricsHints,
} from '../types.js';
import type { Span, HealthStatus, OpenSearchLog, MetricsResult } from '../../../types/index.js';
import { TraceStore } from '../file/TraceStore.js';
import { computeUseUnion, matchesQuery, spanMs } from './traceQueryMatch.js';

export { computeUseUnion, matchesQuery } from './traceQueryMatch.js';
import { buildChunkLookups, groupAndCompute, type MetricsSpanSource } from '../../services/metricsService.js';

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

/** Normalized `Span` → the plain-raw shape the shared metrics math consumes. */
export function spanToMetricsSource(s: Span): MetricsSpanSource {
  const startMs = Date.parse(s.startTime);
  const endMs = Date.parse(s.endTime);
  const durationMs = s.duration ?? (Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0);
  return {
    name: s.name,
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    startTime: s.startTime,
    endTime: s.endTime,
    durationInNanos: durationMs * 1e6,
    status: { code: s.status === 'ERROR' ? 2 : s.status === 'OK' ? 1 : 0 },
    attributes: s.attributes || {},
    // Service identity the shared window attribution reads (`serviceName`), from
    // whichever key the normalized span carries.
    serviceName: s.attributes?.['serviceName'] ?? s.attributes?.['service.name'] ?? s.attributes?.['gen_ai.agent.name'],
  };
}

class FileMetricsOperations implements IMetricsOperations {
  constructor(private readonly traces: ITracesOperations) {}

  async forRun(runId: string, hints?: RunMetricsHints): Promise<MetricsResult> {
    return (await this.forRuns([runId], {
      sessionIdByRunId: hints?.sessionId ? { [runId]: hints.sessionId } : undefined,
      traceIdByRunId: hints?.traceId ? { [runId]: hints.traceId } : undefined,
      agentsByRunId: hints?.agents?.length ? { [runId]: hints.agents } : undefined,
    }))[0];
  }

  /** Union every correlator into one traces query, then the shared attribution + math. */
  async forRuns(runIds: string[], hints?: BatchMetricsHints): Promise<MetricsResult[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (valid.length === 0) return [];
    const lookups = buildChunkLookups(valid, hints?.sessionIdByRunId, hints?.traceIdByRunId, hints?.agentsByRunId);
    const spans: Span[] = [];
    const seen = new Set<string>();
    const add = (list: Span[]) => { for (const s of list) if (!seen.has(s.spanId)) { seen.add(s.spanId); spans.push(s); } };
    if (lookups.runIdCorrelators.length) add((await this.traces.query({ runIds: lookups.runIdCorrelators, size: 100000 })).spans);
    for (const tid of lookups.traceIdToRunId.keys()) add(await this.traces.getByTraceId(tid));
    for (const sid of lookups.sessionIdToRunId.keys()) add((await this.traces.query({ sessionId: sid, size: 100000 })).spans);
    if (lookups.agentHints.length) add((await this.traces.query({ agents: lookups.agentHints, size: 100000 })).spans);
    const sources = spans.sort((a, b) => spanMs(a) - spanMs(b)).map(spanToMetricsSource);
    return groupAndCompute(valid, sources, lookups, false);
  }
}

export class FileObservabilityModule implements IObservabilityModule {
  readonly traces: ITracesOperations;
  readonly logs: ILogsOperations;
  readonly metrics: IMetricsOperations;
  private readonly store: TraceStore;

  constructor(baseDir?: string) {
    this.store = new TraceStore(baseDir);
    this.traces = new FileTracesOperations(this.store);
    this.logs = new FileLogsOperations();
    this.metrics = new FileMetricsOperations(this.traces);
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

  describe(): ObservabilityBackendInfo {
    return { type: 'file', target: this.store.directory };
  }
}
