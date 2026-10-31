/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Composite Observability Module — several sources read side by side.
 *
 * A user may keep their own OpenSearch cluster AND read a CloudWatch account
 * (or two clusters) at the same time. This module fans a request out to every
 * configured source and presents one result:
 *
 *  - traces / logs: results are merged, deduped by span id (an agent that
 *    dual-ships appears once — the first source in configured order wins),
 *    every span tagged `agent_health.source = <source name>` so the UI can show
 *    where it came from, sorted newest-first and paged with an offset cursor.
 *    A source that fails is reported in `warnings` (named) instead of
 *    blanking the page; the result is `truncated` if any source was.
 *  - metrics: NEVER summed across sources (that would double-count a
 *    dual-shipping agent). Per run, the first source in configured order that
 *    holds the run's spans wins; a source error is surfaced only when no
 *    source found spans for that run.
 *  - health: ok when every source is ok; otherwise the first failing source's
 *    status, prefixed with its name.
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
import { ATTR_AGENT_HEALTH_SOURCE, ATTR_AGENT_HEALTH_SOURCE_TYPE } from '../../../types/index.js';
import { spanMs } from './traceQueryMatch.js';

export interface NamedSource {
  id: string;
  name: string;
  module: IObservabilityModule;
}

export interface SourceWarning {
  source: string;
  message: string;
}

/** Offset cursor shared with the file/CloudWatch backends. */
function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const n = JSON.parse(decodeURIComponent(cursor))?.offset;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
const encodeOffset = (offset: number): string => encodeURIComponent(JSON.stringify({ offset }));

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Each source is asked for the whole matching set; the composite pages. */
const PER_SOURCE_SIZE = 10_000;

class CompositeTracesOperations implements ITracesOperations {
  constructor(private readonly sources: NamedSource[]) {}

  async query(options: TracesQueryOptions) {
    const { size = 100, cursor } = options;
    const { cursor: _c, size: _s, ...rest } = options;
    const warnings: SourceWarning[] = [];
    let truncated = false;
    const seen = new Set<string>();
    const merged: Span[] = [];

    const results = await Promise.all(
      this.sources.map(async (src) => {
        try {
          return { src, res: await src.module.traces.query({ ...rest, size: PER_SOURCE_SIZE }) };
        } catch (e) {
          warnings.push({ source: src.name, message: errMessage(e) });
          return { src, res: null };
        }
      })
    );
    for (const { src, res } of results) {
      if (!res) continue;
      if (res.truncated) truncated = true;
      for (const span of res.spans) {
        const key = `${span.traceId}:${span.spanId}`; // span ids are unique only within a trace
        if (seen.has(key)) continue; // dual-shipped span: first configured source wins
        seen.add(key);
        merged.push({ ...span, attributes: { ...(span.attributes || {}), [ATTR_AGENT_HEALTH_SOURCE]: src.name, [ATTR_AGENT_HEALTH_SOURCE_TYPE]: src.module.describe().type } });
      }
    }
    merged.sort((x, y) => spanMs(y) - spanMs(x));

    const offset = decodeOffset(cursor);
    const page = merged.slice(offset, offset + size);
    const hasMore = merged.length > offset + size;
    return { spans: page, total: merged.length, nextCursor: hasMore ? encodeOffset(offset + size) : null, hasMore, truncated, warnings };
  }

  async getByTraceId(traceId: string): Promise<Span[]> {
    return (await this.query({ traceId, size: PER_SOURCE_SIZE })).spans;
  }

  async getByRunIds(runIds: string[]): Promise<Span[]> {
    const valid = runIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (!valid.length) return [];
    return (await this.query({ runIds: valid, size: PER_SOURCE_SIZE })).spans;
  }
}

class CompositeLogsOperations implements ILogsOperations {
  constructor(private readonly sources: NamedSource[]) {}

  async query(options: LogsQueryOptions) {
    const size = options.size ?? 100;
    const warnings: SourceWarning[] = [];
    let truncated = false;
    const results = await Promise.all(
      this.sources.map(async (src) => {
        try {
          return { src, res: await src.module.logs.query({ ...options, size }) };
        } catch (e) {
          warnings.push({ source: src.name, message: errMessage(e) });
          return { src, res: null };
        }
      })
    );
    const logs: OpenSearchLog[] = [];
    for (const { src, res } of results) {
      if (!res) continue;
      if (res.truncated) truncated = true;
      for (const l of res.logs) logs.push({ ...l, [ATTR_AGENT_HEALTH_SOURCE]: src.name, [ATTR_AGENT_HEALTH_SOURCE_TYPE]: src.module.describe().type });
    }
    logs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const page = logs.slice(0, size);
    return { logs: page, total: logs.length, truncated: truncated || logs.length > size, warnings };
  }
}

/**
 * Did this source's trace-store query FAIL for the run? True when the call
 * threw, or when the source answered the `failedMetricsResult` shape — the
 * `error` message is the contract: `MetricsResult.error` is set on EVERY store
 * failure (query threw / timed out / was rejected; `hasSpans` left undefined)
 * and ONLY then — never on a result computed from spans, whatever its
 * `status`. This field — not `status` — is how consumers (this composite, the
 * run telemetry roll-up) tell a store failure from an agent run that itself
 * errored: `status: 'error'` on a span-bearing result is the run's own outcome.
 */
function isStoreFailure(c: { m: MetricsResult | undefined; error: string | null }): boolean {
  return c.error !== null || c.m?.error !== undefined;
}

/** The "looked, found nothing" shape (same as `computeMetricsFromSpans(runId, [])`). */
function noSpansResult(runId: string): MetricsResult {
  return { runId, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending', hasSpans: false };
}

class CompositeMetricsOperations implements IMetricsOperations {
  constructor(private readonly sources: NamedSource[]) {}

  async forRun(runId: string, hints?: RunMetricsHints): Promise<MetricsResult> {
    return (await this.forRuns([runId], {
      sessionIdByRunId: hints?.sessionId ? { [runId]: hints.sessionId } : undefined,
      traceIdByRunId: hints?.traceId ? { [runId]: hints.traceId } : undefined,
      agentsByRunId: hints?.agents?.length ? { [runId]: hints.agents } : undefined,
    }))[0];
  }

  /**
   * Per run: the first source (configured order) that holds spans wins. If no
   * source found spans, an error from any source is surfaced (unknown, retry);
   * otherwise the run is reported as having no spans.
   *
   * "Holds spans" is decided by `hasSpans` / the counters, NEVER by
   * `m.status`: that field is the agent run's outcome as the trace tells it
   * (root span ERROR, or — pre-fix — ANY span ERROR), not the health of the
   * store query. Treating `status: 'error'` as a store failure dropped the only
   * source holding a run whose agent had one failing tool call, and the run
   * then read "<source>: trace-store query failed" with 300K tokens attached.
   * A store failure is a thrown query or a result shaped by
   * `failedMetricsResult` (`error` set, `hasSpans` unknown).
   */
  async forRuns(runIds: string[], hints?: BatchMetricsHints): Promise<MetricsResult[]> {
    const perSource = await Promise.all(
      this.sources.map(async (src) => {
        try {
          return { src, results: await src.module.metrics.forRuns(runIds, hints), error: null as string | null };
        } catch (e) {
          return { src, results: null, error: errMessage(e) };
        }
      })
    );
    return runIds.map((runId, i) => {
      const candidates = perSource.map((p) => ({ src: p.src, m: p.results?.[i], error: p.error }));
      // Sources that hold the run's spans (explicit hasSpans, else any non-zero counter); a complete
      // result beats a partial one, then configured order. A source whose query FAILED never holds.
      const holding = candidates.filter((c) => c.m && !isStoreFailure(c) && c.m.hasSpans !== false && (c.m.hasSpans === true || c.m.totalTokens > 0 || c.m.llmCalls > 0 || c.m.toolCalls > 0 || c.m.durationMs > 0));
      const withSpans = holding.find((c) => !c.m!.partial) ?? holding[0];
      if (withSpans?.m) return { ...withSpans.m, source: withSpans.src.name } as MetricsResult;
      const errored = candidates.find(isStoreFailure);
      if (errored) {
        // Every source threw → no result to base on: zero counters, flagged unknown (never a bare `{ runId }`).
        const base = errored.m ?? candidates.find((c) => c.m)?.m ?? noSpansResult(runId);
        const message = errored.error ?? errored.m?.error ?? 'trace-store query failed';
        return { ...base, runId, status: 'error', error: `${errored.src.name}: ${message}`, hasSpans: undefined } as MetricsResult;
      }
      return (candidates.find((c) => c.m)?.m as MetricsResult) ?? ({ runId, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending', hasSpans: false } as MetricsResult);
    });
  }
}

export class CompositeObservabilityModule implements IObservabilityModule {
  readonly traces: ITracesOperations;
  readonly logs: ILogsOperations;
  readonly metrics: IMetricsOperations;

  constructor(readonly sources: NamedSource[]) {
    if (sources.length === 0) throw new Error('CompositeObservabilityModule needs at least one source');
    this.traces = new CompositeTracesOperations(sources);
    this.logs = new CompositeLogsOperations(sources);
    this.metrics = new CompositeMetricsOperations(sources);
  }

  async health(): Promise<HealthStatus> {
    const statuses = await Promise.all(
      this.sources.map(async (s) => {
        try {
          return { s, h: await s.module.health() };
        } catch (e) {
          return { s, h: { status: 'error', error: errMessage(e) } as HealthStatus };
        }
      })
    );
    const bad = statuses.find((x) => x.h.status !== 'ok');
    if (!bad) return { status: 'ok', index: this.sources.map((s) => `${s.name}: ${s.module.describe().target}`).join(', ') };
    return { ...bad.h, error: `${bad.s.name}: ${bad.h.error ?? bad.h.status}` };
  }

  /** Per-source health, for Settings. */
  async healthBySource(): Promise<Array<{ id: string; name: string; type: ObservabilityBackendInfo['type']; health: HealthStatus }>> {
    return Promise.all(
      this.sources.map(async (s) => {
        let health: HealthStatus;
        try {
          health = await s.module.health();
        } catch (e) {
          health = { status: 'error', error: errMessage(e) };
        }
        return { id: s.id, name: s.name, type: s.module.describe().type, health };
      })
    );
  }

  isConfigured(): boolean {
    return this.sources.every((s) => s.module.isConfigured());
  }

  describe(): ObservabilityBackendInfo {
    if (this.sources.length === 1) return this.sources[0].module.describe();
    return { type: 'composite', target: this.sources.map((s) => `${s.name} (${s.module.describe().type})`).join(' + ') };
  }
}
