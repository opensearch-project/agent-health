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
 *   - Results are cached for the lifetime of the hook. A key is fetched when
 *     it is new, or when its run has since reached a TERMINAL status and the
 *     cached value was captured while the run was still live (a running run's
 *     spans keep growing until it finishes). A 5 s poll tick that changes
 *     nothing therefore issues no request; a run finishing does.
 *   - A failed batch call caches an `error` entry for every key it covered so
 *     the cells read "—" (tooltip: metrics unavailable) instead of a blank
 *     page or a retry storm; `refetch()` clears the cache.
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
  /** True while at least one batch request is in flight. */
  loading: boolean;
  /**
   * Runs with at least one report whose metrics have not come back yet —
   * their cells render a skeleton rather than a premature "—".
   */
  loadingRunIds: Set<string>;
  /** Set when the most recent batch request failed; cells read "—". */
  error: string | null;
  /** Drop the cache and re-request everything currently on screen. */
  refetch: () => void;
}

const defaultIsRunning = (run: TelemetryRun & { status?: string }) =>
  run.status === 'running' || run.status === 'pending';

/**
 * The OTel `service.name` an agent is configured to emit spans under
 * (`AgentConfig.traceServiceName` from agent-health.config.ts), used for the
 * Strategy-C hint. Same lookup the comparison page / Traces tab perform.
 */
export const resolveAgentTraceServiceName = (agentKey: string | undefined): string | undefined =>
  agentKey ? DEFAULT_CONFIG.agents.find(a => a.key === agentKey)?.traceServiceName : undefined;

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

  // Cache of fetched results by metrics key, plus the set of keys whose value
  // was captured AFTER their run went terminal (i.e. final). Refs so the fetch
  // plan below can read them synchronously during render; `version` bumps
  // re-render consumers when the cache changes.
  const cacheRef = useRef<Map<string, TelemetryMetricsResult>>(new Map());
  const finalKeysRef = useRef<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [inflight, setInflight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
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
  const correlation = useMemo(
    () => buildRunTelemetryCorrelation(runsRef.current, reportsById, resolveTraceServiceName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runsKey, reportsById, resolveTraceServiceName],
  );

  // Keys belonging to runs that are done (their spans won't change anymore).
  const terminalKeys = useMemo(() => {
    const out = new Set<string>();
    for (const run of runsRef.current) {
      if (isRunningRef.current(run)) continue;
      for (const k of correlation.keysByRun[run.id] || []) out.add(k);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsKey, correlation]);

  // The fetch plan: keys not cached yet, or cached provisionally while their
  // run was live and now terminal. Serialized so the effect below keys on
  // CONTENT, not on array identity (the page rebuilds `runs` every poll).
  // Reading refs during render is safe here: they only change inside the
  // effect, which then bumps `version` to force this recomputation.
  const planKey = useMemo(() => {
    if (!enabled) return '';
    const cache = cacheRef.current;
    const finals = finalKeysRef.current;
    const toFetch = correlation.keys.filter(k => !cache.has(k) || (terminalKeys.has(k) && !finals.has(k)));
    return toFetch.sort().join(',');
    // `version` is a deliberate dependency: cache mutations happen in the
    // effect and must invalidate this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, correlation, terminalKeys, version]);

  useEffect(() => {
    if (!planKey) return;
    const keys = planKey.split(',');
    const { sessionIdByKey, traceIdByKey, agentsByKey } = correlation;
    // Snapshot which of these keys are final at request time; a run that
    // finishes mid-flight will re-plan on the next render anyway.
    const finalNow = new Set(keys.filter(k => terminalKeys.has(k)));
    let cancelled = false;
    setInflight(n => n + 1);
    setError(null);

    const pick = <T>(m: Record<string, T>, chunk: string[]) => {
      const out: Record<string, T> = {};
      for (const k of chunk) if (m[k] !== undefined) out[k] = m[k];
      return out;
    };

    fetchChunked(keys, TELEMETRY_BATCH_CHUNK, async (chunk) => {
      const res = await fetchBatchRef.current(
        chunk,
        pick(sessionIdByKey, chunk),
        pick(traceIdByKey, chunk),
        pick(agentsByKey, chunk),
      );
      return (res.metrics || []) as TelemetryMetricsResult[];
    }, MAX_CONCURRENT_CHUNKS)
      .then(results => {
        if (cancelled) return;
        const byKey = new Map(results.filter(r => r && r.runId).map(r => [r.runId, r]));
        for (const k of keys) {
          // A key the server did not echo back is treated as "no spans" so the
          // cell settles on "—" rather than a permanent skeleton.
          cacheRef.current.set(k, byKey.get(k) || { runId: k, hasSpans: false, status: 'success' });
          if (finalNow.has(k)) finalKeysRef.current.add(k);
        }
      })
      .catch(err => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'metrics unavailable';
        console.error('[useRunTelemetry] batch metrics request failed:', message);
        // Cache an error entry per key so the plan settles (no retry storm) and
        // the cells read "—" with the unavailable tooltip.
        for (const k of keys) {
          cacheRef.current.set(k, { runId: k, error: message, status: 'error' });
          if (finalNow.has(k)) finalKeysRef.current.add(k);
        }
        setError('metrics unavailable');
      })
      .finally(() => {
        if (cancelled) return;
        setInflight(n => Math.max(0, n - 1));
        setVersion(v => v + 1);
      });

    return () => { cancelled = true; setInflight(n => Math.max(0, n - 1)); };
    // The plan string is the semantic dependency; `correlation`/`terminalKeys`
    // are read for their hint maps and are consistent with the plan by
    // construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const byRunId = useMemo(() => {
    const metricsByKey: Record<string, TelemetryMetricsResult | undefined> = {};
    for (const [k, v] of cacheRef.current) metricsByKey[k] = v;
    return aggregateAllRunTelemetry(runs, reportsById, metricsByKey);
    // `version` invalidates on cache change (see planKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, reportsById, version]);

  const loadingRunIds = useMemo(() => {
    const out = new Set<string>();
    if (!enabled) return out;
    const cache = cacheRef.current;
    for (const run of runs) {
      const keys = correlation.keysByRun[run.id] || [];
      if (keys.some(k => !cache.has(k))) out.add(run.id);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, runs, correlation, version]);

  const refetch = useCallback(() => {
    cacheRef.current = new Map();
    finalKeysRef.current = new Set();
    setError(null);
    setVersion(v => v + 1);
  }, []);

  return { byRunId, loading: inflight > 0, loadingRunIds, error, refetch };
}
