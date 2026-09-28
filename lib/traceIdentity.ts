/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * W3C trace-id hygiene for persisted reports.
 *
 * `report.traceId` is the Strategy-A trace correlator (AGENTS.md → "Trace
 * correlation conventions"): the trace poller queries the traces backend by
 * it AND post-filters fetched spans with `span.traceId === report.traceId`.
 * A value that is not a real 32-hex W3C trace id therefore does worse than
 * nothing — it makes the exact-match filter reject every span the other
 * strategies found, and the report times out with "Traces never arrived".
 *
 * That is exactly what happened when a connector/hook-provided run id
 * (`conv-…`, `subprocess-…`) was written into the storage `traceId` field:
 * `report.runId` and `report.traceId` came back as the same non-hex string
 * and 0/N reports of every `useTraces` benchmark run resolved. Connector ids
 * belong in `runId` / `sessionId`; `traceId` is reserved for the OTel id.
 */

const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const W3C_ALL_ZERO_TRACE_ID = '0'.repeat(32);

/** True only for a syntactically valid, non-zero W3C trace id (32 hex chars). */
export function isW3CTraceId(value: unknown): value is string {
  return typeof value === 'string' && W3C_TRACE_ID_RE.test(value) && value.toLowerCase() !== W3C_ALL_ZERO_TRACE_ID;
}

/**
 * Pick the trace id to persist on a report.
 *
 *  - When the eval `test_case` span exists its trace id ALWAYS wins: that is
 *    the trace the agent adopted via the propagated `traceparent`, and the
 *    id the poller must look up.
 *  - Otherwise keep a caller-provided candidate only when it is a real W3C
 *    trace id (e.g. copied from already-fetched spans on the code-eval path).
 *  - Anything else (connector run ids, session ids, `undefined`) → `undefined`.
 */
export function resolveReportTraceId(evalSpanTraceId: string | undefined, candidate: unknown): string | undefined {
  if (isW3CTraceId(evalSpanTraceId)) return evalSpanTraceId.toLowerCase();
  if (isW3CTraceId(candidate)) return candidate.toLowerCase();
  return undefined;
}
