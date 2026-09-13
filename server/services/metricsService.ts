/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metrics Service - Compute trace-based metrics from OpenSearch
 *
 * Ported from NovaLanggraphApplication/scripts/experiment/metrics.ts
 */

import { Client } from '@opensearch-project/opensearch';
import { MetricsResult, AggregateMetrics, OpenSearchConfig, Span } from '@/types';
import { getSampleSpansForRunIds } from '../../cli/demo/sampleTraces.js';
import { transformSpan, buildRunIdShouldClauses, buildSessionIdShouldClauses, buildAgentHintClause, type ServiceWindowHint } from './tracesService.js';

// ============================================================================
// Model Pricing
// ============================================================================

interface ModelPricing {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens
}

// Model pricing per 1M tokens (USD)
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 4.x models
  'anthropic.claude-sonnet-4-20250514-v1:0': { input: 3.0, output: 15.0 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3.0, output: 15.0 },
  'anthropic.claude-haiku-4-5-20250514-v1:0': { input: 0.80, output: 4.0 },
  // Claude 3.x models
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3.0, output: 15.0 },
  'anthropic.claude-3-7-sonnet-20250219-v1:0': { input: 3.0, output: 15.0 },
  // Generic model name patterns
  'anthropic.claude-sonnet-4': { input: 3.0, output: 15.0 },
  'anthropic.claude-sonnet-4.5': { input: 3.0, output: 15.0 },
  'anthropic.claude-haiku-4': { input: 0.80, output: 4.0 },
  // Default fallback
  'default': { input: 3.0, output: 15.0 },
};

/**
 * Get pricing for a model ID, with fallback to default
 */
export function getPricing(modelId?: string): ModelPricing {
  if (!modelId) return MODEL_PRICING['default'];

  // Try exact match first
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Try partial match (model ID might have region prefix)
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.includes(key) || key.includes(modelId)) {
      return pricing;
    }
  }

  return MODEL_PRICING['default'];
}

// ============================================================================
// OpenSearch Trace Query
// ============================================================================

interface OpenSearchSpanSource {
  name?: string;
  traceId?: string;
  startTime?: string;
  endTime?: string;
  durationInNanos?: number;
  status?: { code?: number; message?: string };
  // Plain-raw (OTEL-faithful) schema: span attributes are a nested object
  // keyed by the literal dotted OTel attribute name, e.g.
  // attributes['agent_health.run.id'] for the runId. (Data Prepper trace-analytics-plain-raw.)
  attributes?: Record<string, any>;
}

/**
 * Read a span's attributes tolerant of BOTH OpenSearch schemas this cluster
 * (and others in the wild) may use for the SAME logical span:
 *   - plain-raw: a nested `attributes` object keyed by literal dotted OTel
 *     names (`attributes['gen_ai.request.model']`).
 *   - legacy @-raw (this is what the live `otel-v1-apm-span-*` index this
 *     bug was hunted against actually uses, confirmed read-only): flat
 *     `span.attributes.<key>` / `resource.attributes.<key>` fields with dots
 *     in the attribute name encoded as `@` (`span.attributes.gen_ai@request@model`).
 * `transformSpan` (already used by the Traces tab / `/api/traces` via
 * tracesService.ts, which is why that endpoint found these spans' attributes
 * fine while this file read an empty object) merges both shapes into one
 * plain dotted-key map. Reusing it here — rather than re-deriving the same
 * merge — keeps the two readers in agreement by construction.
 */
function readAttrs(span: OpenSearchSpanSource): Record<string, any> {
  return transformSpan(span as any).attributes;
}

/**
 * Token / model reads tolerant of vendor SDK naming.
 *
 * Root cause (live comparison-page bug hunt, read-only, against a real
 * Claude Code trace-mode run): Claude Code's own OTel spans
 * (`claude_code.llm_request`) stamp `gen_ai.request.model` correctly but
 * report usage under bare `input_tokens` / `output_tokens` — NOT the OTel
 * Gen AI registry names `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
 * this file previously read exclusively. The spans were being found by
 * correlation just fine; every token/cost read against them silently landed
 * on `0`. See AGENTS.md's "OpenTelemetry Instrumentation Standards" note and
 * `lib/matchers/traces.ts` / `services/traces/traceSummary.ts`, which already
 * carry this exact fallback for the Traces tab and the SDK `traces` fixture —
 * this file was the one remaining reader using registry-only keys.
 */
function readInputTokens(attrs: Record<string, any>): number {
  return Number(
    attrs['gen_ai.usage.input_tokens'] ?? attrs['gen_ai.usage.prompt_tokens'] ?? attrs['input_tokens'] ?? 0,
  ) || 0;
}

function readOutputTokens(attrs: Record<string, any>): number {
  return Number(
    attrs['gen_ai.usage.output_tokens'] ?? attrs['gen_ai.usage.completion_tokens'] ?? attrs['output_tokens'] ?? 0,
  ) || 0;
}

/**
 * True when a span is one of AGENT HEALTH's OWN eval/judge spans (the
 * `test_case` / `test_suite_run` eval spans, or a judge LLM call tagged
 * `gen_ai.operation.name = 'evaluation'`). Strategy A (traceId) correlation
 * below pulls in every span on the shared trace, which can include these —
 * they are not the agent's own work and must not inflate its token/cost/LLM
 * counts.
 */
function isEvalOrJudgeSpan(attrs: Record<string, any>, spanName?: string): boolean {
  return (
    attrs['gen_ai.operation.name'] === 'evaluation' ||
    spanName === 'test_case' ||
    spanName === 'test_suite_run' ||
    (typeof spanName === 'string' && spanName.startsWith('test_suite_run '))
  );
}

/**
 * Correlation `should` clauses for a single runId — Strategy B
 * (`agent_health.run.id` / the OTEL-standard `gen_ai.conversation.id`, under
 * BOTH index schemas via the shared {@link buildRunIdShouldClauses}) OR'd
 * with Strategy A (`traceId`, the eval span's own OTel trace id, propagated
 * via W3C TRACEPARENT to subprocess/HTTP connectors — see AGENTS.md's trace
 * correlation conventions). `traceId` is a plain top-level span field in both
 * the plain-raw and legacy @-raw schemas, so no attribute-encoding tolerance
 * is needed for it.
 *
 * Pre-fix this file spelled out its own Strategy-B `term` clauses against the
 * nested `attributes.*` path only — the same schema mismatch PR #469 fixed on
 * the READ side of this file (via `readAttrs` → `transformSpan`) was still
 * present on the QUERY side, so on the flat-@ `otel-v1-apm-span-*` index
 * Strategy B never matched and metrics only ever correlated via A/D.
 *
 * Without Strategy A here, REST-connector runs (which never get a native
 * runId — `RESTConnector.execute()` returns none — so `report.runId` falls
 * back to `report.traceId`) and subprocess agents whose vendor SDK never
 * adopts `agent_health.run.id` (Claude Code) both 0-correlate even though
 * `/api/traces` finds their spans instantly via the same traceId.
 *
 * Safety of matching on a bare traceId (adversarial-review follow-up):
 * `startTestCaseSpan` (services/traces/index.ts) mints a FRESH OTel span —
 * and therefore a fresh, effectively-unique traceId — for every single
 * test-case invocation; it is never reused across runs or shared between
 * concurrent test cases. This is the same guarantee `/api/traces` and every
 * existing Strategy-A consumer (services/traces/tracesService.ts) already
 * rely on — this file did not previously use `traceId` as a correlator at
 * all, so it inherits an existing invariant rather than introducing a new
 * one. Spans on that ONE trace that are agent-health's own (the eval/judge
 * spans, possible when Strategy A pulls in the whole trace) are excluded
 * via {@link isEvalOrJudgeSpan} above so they can't inflate the agent's own
 * token/LLM-call count.
 */
function buildCorrelationShouldClauses(runId: string, sessionId?: string, traceId?: string, agents?: ServiceWindowHint[]): Record<string, unknown>[] {
  return buildBatchCorrelationShouldClauses([runId], sessionId ? [sessionId] : [], traceId ? [traceId] : [], agents ?? []);
}

/** Batch (terms) form of {@link buildCorrelationShouldClauses} — Strategy B OR
 *  Strategy D (`session.id`, the precise per-run correlator real
 *  closed-source connectors like Claude Code actually stamp on every span;
 *  `.keyword` + raw + flat-@ paths via the shared
 *  {@link buildSessionIdShouldClauses}, mirroring tracesService.ts)
 *  OR Strategy A (`traceId`) OR Strategy C (one `service.name` + run-window
 *  clause per hint, via the shared {@link buildAgentHintClause} — the exact
 *  clause `/api/traces` / the trace judge use, so a run whose report carries
 *  NO correlation id at all still gets metrics from the spans its agent
 *  emitted in that window). The single-run path delegates here with
 *  one-element arrays — a `terms` clause with one value is functionally a `term`. */
function buildBatchCorrelationShouldClauses(
  runIds: string[],
  sessionIds: string[],
  traceIds: string[],
  agents: ServiceWindowHint[] = []
): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = runIds.length > 0 ? buildRunIdShouldClauses(runIds) : [];
  if (sessionIds.length > 0) {
    clauses.push(...buildSessionIdShouldClauses(sessionIds));
  }
  if (traceIds.length > 0) clauses.push({ terms: { traceId: traceIds } });
  for (const hint of agents) clauses.push(buildAgentHintClause(hint));
  return clauses;
}

/**
 * Read a span's `startTime` as epoch millis (both index schemas store it as an
 * ISO-8601 string with nanosecond precision, which `Date.parse` truncates to
 * millis — plenty for window membership).
 */
function spanStartMs(span: OpenSearchSpanSource): number {
  const t = Date.parse(span.startTime || '');
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Strategy-C attribution for the batch path: which requested key does a span
 * belong to, given ONLY its service name + start time? A span is a candidate
 * for every key whose hint has the same `serviceName` and whose window
 * contains the span's start. When several keys' windows overlap (the same
 * agent run concurrently against many test cases, or one hint's slack
 * spilling into the neighbouring run's window), the span goes to the key
 * whose window MIDPOINT is nearest — so a span is counted for exactly ONE key
 * (never double-counted into a run's totals) and, since real windows are
 * centred on the run they describe, almost always the right one. Returns
 * `undefined` when no hint matches (the span came from another strategy or
 * is noise the union pulled in).
 */
function resolveSpanKeyByServiceWindow(
  span: OpenSearchSpanSource,
  hintsByServiceName: Map<string, Array<{ key: string; hint: ServiceWindowHint }>>
): string | undefined {
  if (hintsByServiceName.size === 0) return undefined;
  const attrs = readAttrs(span);
  const serviceName = (span as any).serviceName ?? attrs['serviceName'] ?? attrs['gen_ai.agent.name'];
  if (typeof serviceName !== 'string') return undefined;
  const candidates = hintsByServiceName.get(serviceName);
  if (!candidates || candidates.length === 0) return undefined;
  const start = spanStartMs(span);
  if (!Number.isFinite(start)) return undefined;
  let best: { key: string; distance: number } | undefined;
  for (const { key, hint } of candidates) {
    if (start < hint.startedAt || start > hint.endedAt) continue;
    const distance = Math.abs(start - (hint.startedAt + hint.endedAt) / 2);
    if (!best || distance < best.distance) best = { key, distance };
  }
  return best?.key;
}

/**
 * Resolve which requested key a span actually matched (and via which
 * strategy), for grouping spans back to their key in the batch path. Tries Strategy B by either
 * attribute, then Strategy D (session.id), then Strategy A via the traceId ->
 * runId reverse lookup, and finally Strategy C (service.name + window) via
 * {@link resolveSpanKeyByServiceWindow}. Precise strategies win over the
 * window on purpose: a span that names its run can't be mis-attributed to a
 * neighbouring run whose window happens to overlap.
 *
 * Pre-fix this only ever checked `agent_health.run.id`, silently dropping any
 * span that matched the OR'd `gen_ai.conversation.id` clause from grouping
 * (it was still fetched, just never attributed to a runId).
 */
function resolveSpanAttribution(
  span: OpenSearchSpanSource,
  idSet: Set<string>,
  sessionIdToRunId: Map<string, string>,
  traceIdToRunId: Map<string, string>,
  hintsByServiceName: Map<string, Array<{ key: string; hint: ServiceWindowHint }>>
): { key: string; via: 'ids' | 'window' } | undefined {
  const attrs = readAttrs(span);
  const byRunIdAttr = attrs['agent_health.run.id'] as string | undefined;
  if (byRunIdAttr && idSet.has(byRunIdAttr)) return { key: byRunIdAttr, via: 'ids' };
  const byConversationId = attrs['gen_ai.conversation.id'] as string | undefined;
  if (byConversationId && idSet.has(byConversationId)) return { key: byConversationId, via: 'ids' };
  if (sessionIdToRunId.size > 0) {
    const sessionId = (attrs['session.id'] as string | undefined) ?? (attrs['session@id'] as string | undefined);
    if (sessionId && sessionIdToRunId.has(sessionId)) return { key: sessionIdToRunId.get(sessionId)!, via: 'ids' };
  }
  if (traceIdToRunId.size > 0 && span.traceId && traceIdToRunId.has(span.traceId)) {
    return { key: traceIdToRunId.get(span.traceId)!, via: 'ids' };
  }
  const byWindow = resolveSpanKeyByServiceWindow(span, hintsByServiceName);
  return byWindow ? { key: byWindow, via: 'window' } : undefined;
}

/**
 * Per-chunk correlation lookups for the batch path, derived from the
 * optional per-key correlator maps. Shared by the SDK-client and legacy
 * raw-fetch branches so they cannot drift.
 *
 * `runIdCorrelators` is the subset of the chunk's keys that are sent to
 * OpenSearch as Strategy-B run ids. A key that only has a service-window hint
 * and no id-based correlator (no traceId, no sessionId) is a SURROGATE key —
 * the caller's own report id standing in for a run id the connector never
 * produced — and must NOT be used as a run-id `terms` value: it is not a run
 * id, and querying it as one would let an unrelated span that happened to
 * carry the same string (or, for sloppy callers, a real run's id) be attributed
 * to this key. Keys are still always returned in the result set.
 */
function buildChunkLookups(
  chunk: string[],
  sessionIdByRunId?: Record<string, string>,
  traceIdByRunId?: Record<string, string>,
  agentsByRunId?: Record<string, ServiceWindowHint[]>
) {
  const sessionIdToRunId = new Map<string, string>();
  const traceIdToRunId = new Map<string, string>();
  const hintsByServiceName = new Map<string, Array<{ key: string; hint: ServiceWindowHint }>>();
  const agentHints: ServiceWindowHint[] = [];
  const runIdCorrelators: string[] = [];
  for (const rid of chunk) {
    const sid = sessionIdByRunId?.[rid];
    if (sid) sessionIdToRunId.set(sid, rid);
    const tid = traceIdByRunId?.[rid];
    if (tid) traceIdToRunId.set(tid, rid);
    const hints = agentsByRunId?.[rid] ?? [];
    for (const hint of hints) {
      agentHints.push(hint);
      const list = hintsByServiceName.get(hint.serviceName) ?? [];
      list.push({ key: rid, hint });
      hintsByServiceName.set(hint.serviceName, list);
      // A hint's session id is a precise correlator for that key too
      // (Strategy D) — register it so attribution prefers it over the window.
      if (hint.sessionId && !sessionIdToRunId.has(hint.sessionId)) sessionIdToRunId.set(hint.sessionId, rid);
    }
    const hasIdCorrelator = !!sid || !!tid || hints.some((h) => !!h.sessionId);
    // Window-only key => surrogate; everything else is (or may be) a real run id.
    if (hints.length === 0 || hasIdCorrelator) runIdCorrelators.push(rid);
  }
  return { sessionIdToRunId, traceIdToRunId, hintsByServiceName, agentHints, runIdCorrelators };
}

/**
 * Group a chunk's returned spans back to their keys and compute one
 * MetricsResult per key, stamping `correlatedBy` (ids / window / mixed) and
 * `partial` (the query hit its size cap, so every key's counts are a lower
 * bound — we cannot know which keys lost spans). Shared by both transport
 * branches.
 */
function groupAndCompute(
  chunk: string[],
  allSpans: OpenSearchSpanSource[],
  lookups: ReturnType<typeof buildChunkLookups>,
  truncated: boolean
): MetricsResult[] {
  const idSet = new Set(lookups.runIdCorrelators);
  const spansByRunId = new Map<string, OpenSearchSpanSource[]>();
  const viaByRunId = new Map<string, Set<'ids' | 'window'>>();
  for (const rid of chunk) { spansByRunId.set(rid, []); viaByRunId.set(rid, new Set()); }
  for (const span of allSpans) {
    const hit = resolveSpanAttribution(span, idSet, lookups.sessionIdToRunId, lookups.traceIdToRunId, lookups.hintsByServiceName);
    if (hit && spansByRunId.has(hit.key)) {
      spansByRunId.get(hit.key)!.push(span);
      viaByRunId.get(hit.key)!.add(hit.via);
    }
  }
  return chunk.map((runId) => {
    const m = computeMetricsFromSpans(runId, spansByRunId.get(runId) || []);
    const via = viaByRunId.get(runId)!;
    if (via.size > 0) m.correlatedBy = via.size === 2 ? 'mixed' : (via.has('window') ? 'window' : 'ids');
    if (truncated) m.partial = true;
    return m;
  });
}

/** The `size` cap of the batch query; results are flagged `partial` when hit. */
const BATCH_QUERY_SIZE = 10000;

function totalHitsOf(hits: any, fallback: number): number {
  const total = hits?.total;
  return (typeof total === 'object' ? total?.value : total) ?? fallback;
}

interface OpenSearchResponse {
  hits?: {
    hits?: Array<{
      _source: OpenSearchSpanSource;
    }>;
  };
}

/**
 * Compute metrics from sample/demo trace spans for a run
 *
 * Used when the run ID matches demo data (demo-agent-run-*).
 * Computes the same metrics as computeMetrics but from in-memory sample spans.
 */
export function computeMetricsFromSampleSpans(runId: string): MetricsResult | null {
  const spans = getSampleSpansForRunIds([runId]);
  if (spans.length === 0) return null;

  // Find root span (the one with run.id attribute)
  const rootSpan = spans.find(s => s.attributes?.['run.id'] === runId);

  let inputTokens = 0;
  let outputTokens = 0;
  let llmCalls = 0;
  const toolsUsed = new Set<string>();
  let modelId = 'default';

  for (const span of spans) {
    const attrs = span.attributes || {};

    // Extract token usage from LLM spans
    const inTokens = (attrs['gen_ai.usage.input_tokens'] as number) || 0;
    const outTokens = (attrs['gen_ai.usage.output_tokens'] as number) || 0;
    inputTokens += inTokens;
    outputTokens += outTokens;

    // Count LLM calls (spans with gen_ai.operation.name = 'chat')
    if (attrs['gen_ai.operation.name'] === 'chat') {
      llmCalls++;
      if (attrs['gen_ai.request.model']) {
        modelId = attrs['gen_ai.request.model'] as string;
      }
    }

    // Count tool executions (spans with tools/call in name)
    if (span.name.startsWith('tools/call')) {
      const toolName = (attrs['gen_ai.tool.name'] as string) || span.name;
      toolsUsed.add(toolName);
    }
  }

  // Calculate cost
  const pricing = getPricing(modelId);
  const costUsd = (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;

  // Calculate duration from root span
  let durationMs = 0;
  if (rootSpan?.duration) {
    durationMs = rootSpan.duration;
  } else if (rootSpan) {
    const startTime = new Date(rootSpan.startTime).getTime();
    const endTime = new Date(rootSpan.endTime).getTime();
    durationMs = endTime - startTime;
  }

  // Determine traceId from root span
  const traceId = rootSpan?.traceId || spans[0]?.traceId || null;

  return {
    runId,
    traceId,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    durationMs,
    llmCalls,
    toolCalls: toolsUsed.size,
    toolsUsed: Array.from(toolsUsed),
    status: 'success',
  };
}

/**
 * Compute metrics from OpenSearch traces for a run
 *
 * @param runId - The run ID (stored as the agent_health.run.id span attribute)
 * @param osConfig - OpenSearch configuration
 * @returns Computed metrics
 */
// Fields needed for metrics computation (used for _source projection in bulk
// queries). Tolerant of BOTH OpenSearch schemas (see readAttrs): the
// plain-raw nested `attributes` object, AND the legacy @-raw flattened
// `span.attributes.*` / `resource.attributes.*` fields — confirmed live to be
// what this cluster's `otel-v1-apm-span-*` index actually uses. Pre-fix this
// list omitted the wildcard patterns entirely, so the BATCH query's _source
// projection silently stripped every token/model attribute out of the
// response even though the single-run query (no _source restriction) read
// them fine — the comparison page's batch metrics call always saw zeros.
const METRICS_SOURCE_FIELDS = [
  'attributes',
  'resource',
  'span.attributes.*',
  'resource.attributes.*',
  'name',
  'traceId',
  // Top-level OTel resource service name (both schemas). Needed to attribute
  // a span back to its Strategy-C hint (service.name + window) in the batch
  // path — without it in the projection the query MATCHES the span but the
  // grouping step can't see which service it came from and drops it (the
  // same projection-strips-what-we-need failure mode #469 fixed for the
  // token attributes above).
  'serviceName',
  'startTime',
  'endTime',
  'durationInNanos',
  'status',
];

/**
 * Compute metrics from an array of OpenSearch span sources (pure function).
 * Shared by both single-run and batch-run code paths.
 */
export function computeMetricsFromSpans(
  runId: string,
  spans: OpenSearchSpanSource[]
): MetricsResult {
  if (spans.length === 0) {
    return {
      runId,
      traceId: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      toolsUsed: [],
      status: 'pending',
      hasSpans: false,
    };
  }

  // Find the root agent.run span
  const rootSpan = spans.find(s => s.name === 'agent.run');

  // Aggregate metrics from all spans
  let inputTokens = 0;
  let outputTokens = 0;
  let llmCalls = 0;
  const toolsUsed = new Set<string>();
  let modelId = 'default';

  for (const span of spans) {
    const attrs = readAttrs(span);
    // Strategy A correlation (below) pulls in the whole shared trace, which
    // can include agent-health's own eval/judge spans — exclude them so the
    // agent's own tokens/cost/LLM-call count aren't inflated by ours.
    if (isEvalOrJudgeSpan(attrs, span.name)) continue;
    const inTokens = readInputTokens(attrs);
    const outTokens = readOutputTokens(attrs);
    inputTokens += inTokens;
    outputTokens += outTokens;

    const spanModel = attrs['gen_ai.request.model'];
    if (spanModel) {
      llmCalls++;
      modelId = spanModel;
    }

    if (span.name === 'agent.tool.execute' || span.name?.includes('tool')) {
      const toolName = attrs['gen_ai.tool.name'] ||
                       attrs['tool.name'] ||
                       span.name;
      if (toolName && toolName !== 'agent.tool.execute') {
        toolsUsed.add(toolName);
      }
    }
  }

  const pricing = getPricing(modelId);
  const costUsd = (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;

  let durationMs = 0;
  if (rootSpan) {
    durationMs = (rootSpan.durationInNanos || 0) / 1e6;
  } else if (spans.length > 0) {
    const firstSpan = spans[0];
    const lastSpan = spans[spans.length - 1];
    const startTime = new Date(firstSpan.startTime || 0).getTime();
    const endTime = new Date(lastSpan.endTime || lastSpan.startTime || 0).getTime();
    durationMs = endTime - startTime;
  }

  let status: 'pending' | 'success' | 'error' = 'pending';
  if (rootSpan) {
    status = rootSpan.status?.code === 2 ? 'error' :
             rootSpan.status?.code === 1 ? 'success' : 'success';
  } else if (spans.length > 0) {
    const hasError = spans.some(s => s.status?.code === 2);
    status = hasError ? 'error' : 'success';
  }

  return {
    runId,
    traceId: rootSpan?.traceId || spans[0]?.traceId || null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    durationMs,
    llmCalls,
    toolCalls: toolsUsed.size,
    toolsUsed: Array.from(toolsUsed),
    status,
    hasSpans: true,
  };
}

/**
 * Compute metrics from OpenSearch traces for a single run
 *
 * @param sessionId - Optional Strategy-D correlator (e.g. Claude Code's
 *   `session.id`) to OR into the query alongside Strategy B, for agents that
 *   never stamp our own `agent_health.run.id` / `gen_ai.conversation.id`.
 * @param traceId - Optional Strategy-A correlator (the eval span's own OTel
 *   trace id) — see {@link buildCorrelationShouldClauses}.
 * @param agents - Optional Strategy-C/D hints (`service.name` + run window,
 *   optional `session.id`) — the same `agents[]` the Traces tab / trace judge
 *   send to `/api/traces`, so a report with NO correlation id still gets
 *   metrics from the spans its agent emitted in that window.
 */
export async function computeMetrics(
  runId: string,
  osConfig: OpenSearchConfig | { client: Client; indexPattern?: string },
  sessionId?: string,
  traceId?: string,
  agents?: ServiceWindowHint[]
): Promise<MetricsResult> {
  // Same surrogate-key rule as the batch path (see buildChunkLookups): a key
  // that has ONLY a window hint is not a run id and must not be queried as one.
  const hints = agents ?? [];
  const isSurrogate = hints.length > 0 && !sessionId && !traceId && !hints.some((h) => !!h.sessionId);
  const should = isSurrogate
    ? buildBatchCorrelationShouldClauses([], [], [], hints)
    : buildCorrelationShouldClauses(runId, sessionId, traceId, hints);
  const body = {
    size: SINGLE_QUERY_SIZE,
    sort: [{ startTime: { order: 'asc' as const } }],
    query: { bool: { must: [{ bool: { should, minimum_should_match: 1 } }] } },
  };

  let spans: OpenSearchSpanSource[];
  let totalHits: number;
  if ('client' in osConfig) {
    const indexPattern = osConfig.indexPattern || 'otel-v1-apm-span-*';
    const response = await osConfig.client.search({ index: indexPattern, body });
    spans = response.body.hits?.hits?.map((h: any) => h._source) || [];
    totalHits = totalHitsOf(response.body.hits, spans.length);
  } else {
    // Legacy: raw fetch with Basic auth
    const { endpoint, username, password, indexPattern = 'otel-v1-apm-span-*' } = osConfig;
    const response = await fetch(`${endpoint}/${indexPattern}/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenSearch query failed: ${response.status} - ${errorText}`);
    }

    const data: OpenSearchResponse = await response.json();
    spans = data.hits?.hits?.map(h => h._source) || [];
    totalHits = totalHitsOf(data.hits, spans.length);
  }

  const m = computeMetricsFromSpans(runId, spans);
  if (spans.length > 0) m.correlatedBy = isSurrogate ? 'window' : (hints.length > 0 ? 'mixed' : 'ids');
  if (totalHits > SINGLE_QUERY_SIZE || spans.length >= SINGLE_QUERY_SIZE) m.partial = true;
  return m;
}

/** The `size` cap of the single-run query; results are flagged `partial` when hit. */
const SINGLE_QUERY_SIZE = 500;

/**
 * Compute metrics for multiple runs using bulk OpenSearch terms query.
 * Issues one query per chunk instead of one query per run ID.
 *
 * @param sessionIdByRunId - Optional Strategy-D correlator map (runId ->
 *   agent-emitted session.id), OR'd into each chunk's query alongside
 *   Strategy B — see {@link buildCorrelationShouldClauses}.
 * @param agentsByRunId - Optional Strategy-C/D hints per key (runId ->
 *   `[{serviceName, startedAt, endedAt, sessionId?}]`). Keys here need not be
 *   real run ids: a caller whose report carries no correlation id at all may
 *   key by its own report id and rely on the window alone; the result comes
 *   back under that same key.
 */
export async function computeBatchMetrics(
  runIds: string[],
  osConfig: OpenSearchConfig | { client: Client; indexPattern?: string },
  sessionIdByRunId?: Record<string, string>,
  traceIdByRunId?: Record<string, string>,
  agentsByRunId?: Record<string, ServiceWindowHint[]>
): Promise<MetricsResult[]> {
  if (runIds.length === 0) return [];

  const CHUNK_SIZE = 50;
  const allResults: MetricsResult[] = [];

  const chunks: string[][] = [];
  for (let i = 0; i < runIds.length; i += CHUNK_SIZE) {
    chunks.push(runIds.slice(i, i + CHUNK_SIZE));
  }

  if ('client' in osConfig) {
    const indexPattern = osConfig.indexPattern || 'otel-v1-apm-span-*';
    const chunkResults = await Promise.all(chunks.map(async (chunk) => {
      const lookups = buildChunkLookups(chunk, sessionIdByRunId, traceIdByRunId, agentsByRunId);
      try {
        const response = await osConfig.client.search({
          index: indexPattern,
          body: {
            size: BATCH_QUERY_SIZE,
            sort: [{ startTime: { order: 'asc' } }],
            _source: METRICS_SOURCE_FIELDS,
            query: {
              bool: {
                must: [
                  { bool: {
                    should: buildBatchCorrelationShouldClauses(
                      lookups.runIdCorrelators,
                      Array.from(lookups.sessionIdToRunId.keys()),
                      Array.from(lookups.traceIdToRunId.keys()),
                      lookups.agentHints,
                    ),
                    minimum_should_match: 1,
                  } }
                ]
              }
            }
          }
        });

        const allSpans = response.body.hits?.hits?.map((h: any) => h._source) || [];
        const totalHits = totalHitsOf(response.body.hits, allSpans.length);
        const truncated = totalHits > BATCH_QUERY_SIZE || allSpans.length >= BATCH_QUERY_SIZE;
        if (truncated) {
          console.warn(
            `OpenSearch batch metrics query returned ${allSpans.length} of ${totalHits} spans ` +
            `for chunk of ${chunk.length} run IDs. Metrics are flagged partial (lower bound).`
          );
        }
        return groupAndCompute(chunk, allSpans, lookups, truncated);
      } catch (e: any) {
        console.warn(
          `OpenSearch metrics query failed for chunk (${chunk.length} run IDs): ${e.message}`
        );
        return chunk.map(runId => computeMetricsFromSpans(runId, []));
      }
    }));

    for (const results of chunkResults) {
      allResults.push(...results);
    }
    return allResults;
  }

  // Legacy: raw fetch with Basic auth
  const { endpoint, username, password, indexPattern = 'otel-v1-apm-span-*' } = osConfig;

  const chunkResults = await Promise.all(chunks.map(async (chunk) => {
    const lookups = buildChunkLookups(chunk, sessionIdByRunId, traceIdByRunId, agentsByRunId);
    const query = {
      size: BATCH_QUERY_SIZE,
      sort: [{ startTime: { order: 'asc' } }],
      _source: METRICS_SOURCE_FIELDS,
      query: {
        bool: {
          must: [
            { bool: {
              should: buildBatchCorrelationShouldClauses(
                lookups.runIdCorrelators,
                Array.from(lookups.sessionIdToRunId.keys()),
                Array.from(lookups.traceIdToRunId.keys()),
                lookups.agentHints,
              ),
              minimum_should_match: 1,
            } }
          ]
        }
      }
    };

    const response = await fetch(`${endpoint}/${indexPattern}/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      const responseBody = await response.text();
      console.warn(
        `OpenSearch metrics query failed for chunk (${chunk.length} run IDs): ` +
        `${response.status} ${response.statusText}. Response body: ${responseBody}`
      );
      return chunk.map(runId => computeMetricsFromSpans(runId, []));
    }

    const data: OpenSearchResponse = await response.json();
    const allSpans = data.hits?.hits?.map(h => h._source) || [];
    const totalHits = totalHitsOf(data.hits, allSpans.length);
    const truncated = totalHits > BATCH_QUERY_SIZE || allSpans.length >= BATCH_QUERY_SIZE;
    if (truncated) {
      console.warn(
        `OpenSearch batch metrics query returned ${allSpans.length} of ${totalHits} spans ` +
        `for chunk of ${chunk.length} run IDs. Metrics are flagged partial (lower bound).`
      );
    }
    return groupAndCompute(chunk, allSpans, lookups, truncated);
  }));

  for (const results of chunkResults) {
    allResults.push(...results);
  }

  return allResults;
}

/**
 * Compute aggregate metrics from an array of individual metrics
 *
 * @param metricsArray - Array of individual metrics
 * @returns Aggregated metrics
 */
export function computeAggregateMetrics(metricsArray: MetricsResult[]): AggregateMetrics {
  if (!metricsArray || metricsArray.length === 0) {
    return {
      totalRuns: 0,
      successRate: 0,
      totalCostUsd: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      avgTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      avgLlmCalls: 0,
      avgToolCalls: 0
    };
  }

  const n = metricsArray.length;
  const costs = metricsArray.map(m => m.costUsd || 0);
  const durations = metricsArray.map(m => m.durationMs || 0).sort((a, b) => a - b);
  const successCount = metricsArray.filter(m => m.status === 'success').length;

  return {
    totalRuns: n,
    successRate: n > 0 ? successCount / n : 0,
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
    avgCostUsd: n > 0 ? costs.reduce((a, b) => a + b, 0) / n : 0,
    avgDurationMs: n > 0 ? durations.reduce((a, b) => a + b, 0) / n : 0,
    p50DurationMs: durations[Math.floor(n * 0.5)] || 0,
    p95DurationMs: durations[Math.floor(n * 0.95)] || 0,
    avgTokens: n > 0 ? metricsArray.reduce((a, m) => a + (m.totalTokens || 0), 0) / n : 0,
    totalInputTokens: metricsArray.reduce((a, m) => a + (m.inputTokens || 0), 0),
    totalOutputTokens: metricsArray.reduce((a, m) => a + (m.outputTokens || 0), 0),
    avgLlmCalls: n > 0 ? metricsArray.reduce((a, m) => a + (m.llmCalls || 0), 0) / n : 0,
    avgToolCalls: n > 0 ? metricsArray.reduce((a, m) => a + (m.toolCalls || 0), 0) / n : 0
  };
}
