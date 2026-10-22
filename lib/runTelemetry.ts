/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-run telemetry roll-up for the benchmark pages (Runs table + run
 * inspector strip): tokens · cost · LLM calls · tool calls · median time per
 * case · "spans found for N of M cases".
 *
 * Pure and React-free so the aggregation is unit-testable in isolation. The
 * data path (one `POST /api/metrics/batch` per page visit, keyed by report)
 * lives in hooks/useRunTelemetry.ts; both consumers render whatever this
 * module computes.
 *
 * Correlation: every report is requested under ONE metrics key
 * ({@link metricsKeyForReport}) with the union of the trace-correlation
 * strategies this repo already documents (AGENTS.md → "Trace correlation
 * conventions"): Strategy A (`report.traceId`), B (the key itself ==
 * `report.runId`), D (`report.sessionId`) and C (`service.name` + run window
 * via {@link buildJudgeAgentsHints} — the same helper the trace judge and the
 * Traces tab use). The batch route returns results under whatever key was
 * sent, so a REST-connector report with no runId at all is still matched by
 * its agent's spans in that window and its metrics land back on the right
 * report.
 */

import type { EvaluationReport, TraceMetrics } from '@/types';
import { buildJudgeAgentsHints, type JudgeAgentsHint } from '@/services/traces/judgeAgentsHints';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Roll-up for one run. `undefined` for a run with no loaded reports to
 * correlate (nothing was requested for it).
 */
export interface RunTelemetry {
  /** Sum of `totalTokens` over every report with spans. */
  totalTokens: number;
  /** Sum of `costUsd` over every report with spans. */
  costUsd: number;
  /** Sum of `llmCalls` over every report with spans. */
  llmCalls: number;
  /** Sum of `toolCalls` over every report with spans. */
  toolCalls: number;
  /**
   * Median of `report.performanceMetrics.durationMs` over the run's reports
   * that carry one (wall-clock per test case as measured by the runner —
   * independent of trace ingestion, so it is populated even when no spans
   * were found). `null` when no report has a duration.
   */
  medianDurationMs: number | null;
  /** Reports whose metrics result reported `hasSpans !== false`. */
  spansCases: number;
  /** Reports considered for this run (those with a metrics key). */
  totalCases: number;
  /** Reports whose metrics request failed (per-key error entry). */
  errorCases: number;
  /**
   * Reports whose metrics request has not answered yet (no result cached
   * for the key). While > 0 the trace-derived cells are LOADING, not empty:
   * the roll-up is provisional and must not be read as "no spans".
   */
  pendingCases: number;
  /** The first per-key error message, for the "unavailable" tooltip. */
  errorMessage?: string;
  /**
   * True once every key has answered, at least one report's metrics request
   * failed AND no report had spans — nothing trustworthy is known about this
   * run's spans, so the cells read "unavailable" (Retry) rather than "no traces". A partial
   * failure where OTHER keys did find spans is NOT unavailable: the sums
   * cover the answered keys and the tooltip's "spans found for N of M"
   * tells the rest. (Pre-fix this required EVERY key to fail, so one
   * timed-out chunk out of two read as "this agent was never traced".)
   */
  unavailable: boolean;
  /** True when at least one report had spans. Drives the "—" rendering. */
  hasSpans: boolean;
  /**
   * True when at least one contributing result was flagged `partial` (its
   * OpenSearch query hit the size cap) — the sums above are a lower bound.
   */
  partial: boolean;
}

/** Correlation inputs `fetchBatchMetrics` needs for one page of runs. */
export interface RunTelemetryCorrelation {
  /** Every distinct metrics key across the runs (request `runIds`). */
  keys: string[];
  /** Strategy D — key → agent-emitted session.id. */
  sessionIdByKey: Record<string, string>;
  /** Strategy A — key → the eval span's OTel traceId. */
  traceIdByKey: Record<string, string>;
  /** Strategy C/D — key → service.name + window hints. */
  agentsByKey: Record<string, JudgeAgentsHint[]>;
  /** runId → the metrics keys of its reports (for the aggregation step). */
  keysByRun: Record<string, string[]>;
}

/** A report projected to the fields the telemetry roll-up reads. */
export type TelemetryReport = Pick<
  EvaluationReport,
  'id' | 'runId' | 'traceId' | 'sessionId' | 'agentKey' | 'connectorProtocol' | 'timestamp' | 'performanceMetrics'
>;

/** A run projected to what the roll-up needs: its id + per-case reportIds. */
export interface TelemetryRun {
  id: string;
  results?: Record<string, { reportId?: string }>;
}

// ─── Correlation ─────────────────────────────────────────────────────────────

/**
 * The key a report's trace metrics are requested and returned under:
 * `report.runId` when the connector produced one, else the report's own id
 * (the batch route echoes keys back verbatim, so any stable string works —
 * what matters is that the Strategy-A/C/D hints ride along under the same
 * key). Mirrors `metricsKeyForReport` in services/comparisonService.ts.
 */
export function metricsKeyForReport(report: Pick<EvaluationReport, 'id' | 'runId'>): string | undefined {
  return report.runId || report.id || undefined;
}

/**
 * Gather the ids of every report referenced by `runs` (deduped, in order).
 */
export function collectReportIds(runs: TelemetryRun[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const r of Object.values(run.results || {})) {
      if (r?.reportId) seen.add(r.reportId);
    }
  }
  return [...seen];
}

/**
 * Derive the correlation payload for one page of runs from the reports that
 * were already loaded for them.
 *
 * `resolveTraceServiceName(agentKey)` supplies the per-agent
 * `AgentConfig.traceServiceName` override (from agent-health.config.ts via
 * DEFAULT_CONFIG). Protocols whose service.name is not knowable (generic
 * `rest` / `openai-compatible` … with no override) yield no Strategy-C hint
 * and rely on A/B/D — see `resolveAgentServiceName`.
 */
export function buildRunTelemetryCorrelation(
  runs: TelemetryRun[],
  reportsById: Record<string, TelemetryReport | undefined>,
  resolveTraceServiceName: (agentKey: string | undefined) => string | undefined = () => undefined,
): RunTelemetryCorrelation {
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const sessionIdByKey: Record<string, string> = {};
  const traceIdByKey: Record<string, string> = {};
  const agentsByKey: Record<string, JudgeAgentsHint[]> = {};
  const keysByRun: Record<string, string[]> = {};

  for (const run of runs) {
    const runKeys: string[] = [];
    for (const result of Object.values(run.results || {})) {
      const report = result?.reportId ? reportsById[result.reportId] : undefined;
      if (!report) continue;
      const key = metricsKeyForReport(report);
      if (!key) continue;
      runKeys.push(key);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      keys.push(key);
      if (report.sessionId) sessionIdByKey[key] = report.sessionId;
      if (report.traceId) traceIdByKey[key] = report.traceId;
      const hints = buildJudgeAgentsHints(report, resolveTraceServiceName(report.agentKey));
      if (hints.length > 0) agentsByKey[key] = hints;
    }
    keysByRun[run.id] = runKeys;
  }
  return { keys, sessionIdByKey, traceIdByKey, agentsByKey, keysByRun };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** Median of a non-empty numeric array; `null` for an empty one. */
export function median(values: number[]): number | null {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * The subset of a batch-metrics result the roll-up reads. `error` marks a
 * per-key failure shape (`{ runId, error, status: 'error' }`) the route emits
 * when the observability source is unconfigured or the query threw.
 * `partial` is the size-cap flag newer servers stamp (counts are a lower
 * bound); declared locally so this module does not depend on the field
 * existing on `TraceMetrics`.
 */
export type TelemetryMetricsResult = Partial<Pick<TraceMetrics,
  'totalTokens' | 'costUsd' | 'llmCalls' | 'toolCalls' | 'hasSpans' | 'status'
>> & { runId: string; error?: string; partial?: boolean };

/**
 * Roll a run's per-report metrics results up into one {@link RunTelemetry}.
 *
 * Semantics:
 *   - A result counts as "has spans" when it is not an error, not `pending`,
 *     and `hasSpans !== false` (older servers omit the flag; treat present
 *     numbers as real).
 *   - Sums are over span-bearing results only, so a run where 3/62 cases
 *     found spans reports the tokens for those 3 and `spansCases: 3`.
 *   - Duration is from the runner's `performanceMetrics.durationMs` (not the
 *     trace), so it is populated regardless of span ingestion.
 *   - Returns `undefined` when the run has no reports with a metrics key
 *     (nothing to say — the cell renders "—" with a "no reports" tooltip).
 */
export function aggregateRunTelemetry(
  run: TelemetryRun,
  reportsById: Record<string, TelemetryReport | undefined>,
  metricsByKey: Record<string, TelemetryMetricsResult | undefined>,
): RunTelemetry | undefined {
  let totalTokens = 0, costUsd = 0, llmCalls = 0, toolCalls = 0;
  let spansCases = 0, totalCases = 0, errorCases = 0, pendingCases = 0, partial = false;
  let errorMessage: string | undefined;
  const durations: number[] = [];

  for (const result of Object.values(run.results || {})) {
    const report = result?.reportId ? reportsById[result.reportId] : undefined;
    if (!report) continue;
    const key = metricsKeyForReport(report);
    if (!key) continue;
    totalCases++;
    const d = report.performanceMetrics?.durationMs;
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) durations.push(d);

    const m = metricsByKey[key];
    if (m?.error) { errorCases++; errorMessage ??= m.error; continue; }
    if (!m) { pendingCases++; continue; }
    // The server's `status: 'pending'` is its "queried, found nothing" shape
    // (computeMetricsFromSpans on zero spans) — that IS "no spans", not
    // "still loading"; only a key with no result at all is pending here.
    if (m.status === 'pending' || m.hasSpans === false) continue;
    spansCases++;
    totalTokens += m.totalTokens || 0;
    costUsd += m.costUsd || 0;
    llmCalls += m.llmCalls || 0;
    toolCalls += m.toolCalls || 0;
    if (m.partial) partial = true;
  }

  if (totalCases === 0) return undefined;
  return {
    totalTokens, costUsd, llmCalls, toolCalls,
    medianDurationMs: median(durations),
    spansCases, totalCases, errorCases, pendingCases, errorMessage,
    unavailable: pendingCases === 0 && errorCases > 0 && spansCases === 0,
    hasSpans: spansCases > 0,
    partial,
  };
}

/** {@link aggregateRunTelemetry} for every run, keyed by run id. */
export function aggregateAllRunTelemetry(
  runs: TelemetryRun[],
  reportsById: Record<string, TelemetryReport | undefined>,
  metricsByKey: Record<string, TelemetryMetricsResult | undefined>,
): Record<string, RunTelemetry | undefined> {
  const out: Record<string, RunTelemetry | undefined> = {};
  for (const run of runs) out[run.id] = aggregateRunTelemetry(run, reportsById, metricsByKey);
  return out;
}

// ─── Empty states ────────────────────────────────────────────────────────────
//
// The trace-derived cells (Tokens · Cost · LLM calls · Tool calls) have three
// honest empty states, and each must SAY WHICH (owner, 2026-10-22: a page of
// bare "—" told him nothing — were the agents untraced, or did the query
// fail?). Shared by the Runs table and the run inspector strip.

/** Short cell text per empty state. */
export const TELEMETRY_EMPTY_LABEL = {
  /** Every key answered; no case had spans — the agent was not traced. */
  noTraces: 'no traces',
  /** The trace-store query failed for some key and none found spans. */
  unavailable: 'unavailable',
  /** Nothing to correlate / the metric is not recorded. */
  none: '—',
} as const;

export const TELEMETRY_NO_SPANS_TITLE = 'No traces for this run';
export const TELEMETRY_UNAVAILABLE_TITLE = 'Metrics unavailable';

/** Tooltip for the "no traces" state: what it means and how to fix it. */
export function describeNoTraces(t: Pick<RunTelemetry, 'totalCases'>): string {
  const cases = t.totalCases === 1 ? '1 case' : `${t.totalCases} cases`;
  return `${TELEMETRY_NO_SPANS_TITLE} — no spans were found for any of its ${cases}, so this agent's runs were not traced. ` +
    'Enable trace mode on the agent (useTraces: true) and OTel instrumentation that propagates the eval trace context or stamps session.id / agent_health.run.id ' +
    '(set traceServiceName to the agent\'s OTel service.name for the time-window fallback) to populate Tokens · Cost · LLM calls.';
}

/** Tooltip for the "unavailable" state: the failure, its scope, the way out. */
export function describeUnavailable(t: Pick<RunTelemetry, 'totalCases' | 'errorCases' | 'errorMessage'>): string {
  const scope = t.totalCases > 0 ? ` for ${t.errorCases} of ${t.totalCases} cases` : '';
  const why = t.errorMessage ? ` (${t.errorMessage})` : '';
  return `${TELEMETRY_UNAVAILABLE_TITLE} — the trace-store query failed${scope}${why}. Spans may well exist; use Retry.`;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** 5900000 → "5.9M", 12345 → "12.3K", 312 → "312". */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

/**
 * "$20.19"; sub-cent amounts keep 4 decimals so a $0.0042 run does not read
 * as free. `null` when the spans carried no cost at all (unknown pricing) —
 * callers render "—".
 */
export function formatCostUsd(costUsd: number): string | null {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

/** 44_000 → "44 s", 125_000 → "2m 05s", 800 → "0.8 s". */
export function formatDurationCompact(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
