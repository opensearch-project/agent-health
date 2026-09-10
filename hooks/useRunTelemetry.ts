/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useRunTelemetry — per-run tokens / cost / LLM calls / tool calls / median
 * time-per-case for a page of benchmark runs, from ONE `POST /api/metrics/batch`
 * per page visit (chunked at {@link TELEMETRY_BATCH_CHUNK} keys) rather than a
 * request per row.
 *
 * Request planning (see lib/runTelemetry.ts for the pure pieces):
 *   - Every report reachable from `runs` is requested under its metrics key
 *     (`report.runId`, else `report.id`) with the Strategy A/C/D hints riding
 *     along (traceId, sessionId, service.name + window) so REST / subprocess
 *     arms that never propagated W3C context still populate.
 *   - Results are cached per key for the lifetime of the hook. A key is
 *     fetched when it is new, or when its run has since reached a TERMINAL
 *     status and the cached value was captured while the run was still live
 *     (a running run's spans keep growing until it finishes). A 5 s poll tick
 *     that changes nothing therefore issues no request; a run finishing does;
 *     a new case starting on a live run fetches only its new key (in-flight
 *     requests are never cancelled — their results are keyed, so they stay
 *     valid).
 *   - Failures are isolated per chunk: a failed chunk caches an `error` entry
 *     for each of ITS keys (cells read "—", tooltip "Metrics unavailable"),
 *     while other chunks' results land normally, and a key that already
 *     holds a good value is never overwritten by an error. Errors are cached
 *     (no retry storm on every poll tick); `refetch()` clears the cache and
 *     is wired to a Retry affordance by the consumers.
 *
 * Both benchmark surfaces (Runs table, run inspector) consume this; the
 * eval-runs list and the inspector's SDK mode can call it next with no change
 * here — they only need a runs array and a reportId → report map.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { fetchBatchMetrics } from '@/services/metrics';
import { fetchChunked } from '@/lib/chunkedFetch';
import { DEFAULT_CONFIG } from '@/lib/constants';
import {
  aggregateAllRunTelemetry,
  buildRunTelemetryCorrelation,
  type RunTelemetry,
  type TelemetryMetricsResult,
  type TelemetryReport,
  type TelemetryRun,
} from '@/lib/runTelemetry';

/** Max metrics keys per `POST /api/metrics/batch` request. */
export const TELEMETRY_BATCH_CHUNK = 200;
/** Parallel chunk requests in flight at once. */
const MAX_CONCURRENT_CHUNKS = 3;

export interface UseRunTelemetryOptions {
  /** When false, nothing is fetched (e.g. the Runs tab is not the active tab). */
  enabled?: boolean;
  /** Override the "still live" predicate (default: status running/pending). */
  isRunning?: (run: TelemetryRun & { status?: string }) => boolean;
  /** Test seam / DI: per-agent OTel service.name override lookup. */
  resolveTraceServiceName?: (agentKey: string | undefined) => string | undefined;
  /** Test seam / DI: the batch call. */
  fetchBatch?: typeof fetchBatchMetrics;
}

export interface UseRunTelemetryResult {
  /** Roll-up per run id (`undefined` when the run has no reports to correlate). */
  byRunId: Record<string, RunTelemetry | undefined>;
  /** True while any on-screen run still has a key without a result. */
  loading: boolean;
  /**
   * Runs with at least one report whose metrics have not come back yet —
   * their cells render a skeleton rather than a premature "—".
   */
  loadingRunIds: Set<string>;
  /** Set when the most recent request had a failed chunk; per-run cells decide what to show. */
  error: string | null;
  /** Drop the cache and re-request everything currently on screen. */
  refetch: () => void;
}

/** One cached batch result; `final` = captured after the run went terminal. */
interface CacheEntry { result: TelemetryMetricsResult; final: boolean }

const defaultIsRunning = (run: TelemetryRun & { status?: string }) =>
  run.status === 'running' || run.status === 'pending';

/**
 * The OTel `service.name` an agent is configured to emit spans under
 * (`AgentConfig.traceServiceName` from agent-health.config.ts), used for the
 * Strategy-C hint. Same lookup the comparison page / Traces tab perform.
 */
export const resolveAgentTraceServiceName = (agentKey: string | undefined): string | undefined =>
  agentKey ? DEFAULT_CONFIG.agents.find(a => a.key === agentKey)?.traceServiceName : undefined;

const pick = <T>(m: Record<string, T>, keys: string[]): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const k of keys) if (m[k] !== undefined) out[k] = m[k];
  return out;
};

export function useRunTelemetry(
  runs: Array<TelemetryRun & { status?: string }>,
  reportsById: Record<string, TelemetryReport | undefined>,
  options: UseRunTelemetryOptions = {},
): UseRunTelemetryResult {
  const {
    enabled = true,
    isRunning = defaultIsRunning,
    resolveTraceServiceName = resolveAgentTraceServiceName,
    fetchBatch = fetchBatchMetrics,
  } = options;

  const [cache, setCache] = useState<ReadonlyMap<string, CacheEntry>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  // Keys with a request in flight. A ref (not state) so the effect can claim
  // keys synchronously — React StrictMode runs effects twice in dev, and the
  // second run must not fire a duplicate request for the same keys.
  const inflightRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const fetchBatchRef = useRef(fetchBatch);
  fetchBatchRef.current = fetchBatch;

  // The page rebuilds `runs` on every poll tick; key the correlation on its
  // CONTENT (ids, statuses, reportIds) so hint derivation — which warns
  // loudly for protocols with no knowable service.name — runs once per
  // actual change, not once per tick.
  const runsKey = useMemo(
    () => runs.map(r => `${r.id}|${r.status ?? ''}|${Object.values(r.results || {}).map(x => x?.reportId || '').join('.')}`).join(';'),
    [runs],
  );
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const { correlation, terminalKeys } = useMemo(() => {
    const correlation = buildRunTelemetryCorrelation(runsRef.current, reportsById, resolveTraceServiceName);
    // Keys belonging to runs that are done (their spans won't change anymore).
    const terminalKeys = new Set<string>();
    for (const run of runsRef.current) {
      if (isRunningRef.current(run)) continue;
      for (const k of correlation.keysByRun[run.id] || []) terminalKeys.add(k);
    }
    return { correlation, terminalKeys };
    // runsKey stands in for `runs` (content, not identity) — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsKey, reportsById, resolveTraceServiceName]);

  // The fetch plan: keys with no result yet, or whose result was captured
  // while the run was live and the run is now terminal. In-flight keys are
  // excluded so a plan change never re-requests what is already on the wire.
  const planKey = useMemo(() => {
    if (!enabled) return '';
    return correlation.keys
      .filter(k => {
        if (inflightRef.current.has(k)) return false;
        const e = cache.get(k);
        return !e || (terminalKeys.has(k) && !e.final);
      })
      .sort()
      .join(',');
  }, [enabled, correlation, terminalKeys, cache]);

  useEffect(() => {
    if (!planKey) return;
    const keys = planKey.split(',').filter(k => !inflightRef.current.has(k));
    if (keys.length === 0) return;
    for (const k of keys) inflightRef.current.add(k);
    const { sessionIdByKey, traceIdByKey, agentsByKey } = correlation;
    // Snapshot which keys are final at request time; a run that finishes
    // mid-flight gets its final refetch on the next plan.
    const finalNow = new Set(keys.filter(k => terminalKeys.has(k)));

    type Outcome = { key: string; result: TelemetryMetricsResult; ok: boolean };
    fetchChunked<Outcome>(keys, TELEMETRY_BATCH_CHUNK, async (chunk) => {
      try {
        const res = await fetchBatchRef.current(chunk, pick(sessionIdByKey, chunk), pick(traceIdByKey, chunk), pick(agentsByKey, chunk));
        const byKey = new Map((res.metrics || []).filter(r => r && r.runId).map(r => [r.runId, r as TelemetryMetricsResult]));
        // A key the server did not echo back is treated as "no spans" so the
        // cell settles on "—" rather than a permanent skeleton.
        return chunk.map(k => ({ key: k, ok: true, result: byKey.get(k) || { runId: k, hasSpans: false, status: 'success' } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'metrics unavailable';
        console.error('[useRunTelemetry] batch metrics request failed:', message);
        return chunk.map(k => ({ key: k, ok: false, result: { runId: k, error: message, status: 'error' } }));
      }
    }, MAX_CONCURRENT_CHUNKS).then(outcomes => {
      for (const k of keys) inflightRef.current.delete(k);
      if (!mountedRef.current) return;
      setCache(prev => {
        const next = new Map(prev);
        for (const o of outcomes) {
          const existing = prev.get(o.key);
          // Never replace a good value with an error: a failed final refresh
          // keeps the (provisional) numbers rather than blanking the row.
          if (!o.ok && existing && !existing.result.error) {
            next.set(o.key, { result: existing.result, final: existing.final || finalNow.has(o.key) });
          } else {
            next.set(o.key, { result: o.result, final: finalNow.has(o.key) });
          }
        }
        return next;
      });
      setError(outcomes.some(o => !o.ok) ? 'metrics unavailable' : null);
    });
    // `correlation` / `terminalKeys` are consistent with `planKey` by
    // construction; the plan string is the semantic dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const byRunId = useMemo(() => {
    const metricsByKey: Record<string, TelemetryMetricsResult | undefined> = {};
    for (const [k, e] of cache) metricsByKey[k] = e.result;
    return aggregateAllRunTelemetry(runs, reportsById, metricsByKey);
  }, [runs, reportsById, cache]);

  const loadingRunIds = useMemo(() => {
    const out = new Set<string>();
    if (!enabled) return out;
    for (const run of runs) {
      if ((correlation.keysByRun[run.id] || []).some(k => !cache.has(k))) out.add(run.id);
    }
    return out;
  }, [enabled, runs, correlation, cache]);

  const refetch = useCallback(() => {
    setCache(new Map());
    setError(null);
  }, []);

  return { byRunId, loading: loadingRunIds.size > 0, loadingRunIds, error, refetch };
}
