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
// queries). We pull the whole nested `attributes` object: in the plain-raw
// schema its keys are literal dotted OTel names (e.g. "gen_ai.usage.input_tokens")
// which _source field-filtering cannot address individually.
const METRICS_SOURCE_FIELDS = [
  'attributes',
  'name',
  'traceId',
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
      status: 'pending'
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
    const attrs = span.attributes || {};
    const inTokens = Number(attrs['gen_ai.usage.input_tokens']) || 0;
    const outTokens = Number(attrs['gen_ai.usage.output_tokens']) || 0;
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
    status
  };
}

/**
 * Build the `should` clauses matching ANY of a run's known trace-correlation
 * identities — Strategy B (`agent_health.run.id` / `gen_ai.conversation.id`,
 * requires the agent to have adopted our attribute convention) OR Strategy D
 * (`session.id`, the precise per-run correlator real closed-source connectors
 * like Claude Code actually stamp on every span — see AGENTS.md's trace
 * correlation conventions / services/traces/tracesService.ts). Without
 * Strategy D, agents that only ever emit `session.id` (never our custom
 * attribute) always miss this query and the batch metrics show `--`
 * indefinitely, even though the SAME spans are found by the Traces tab.
 */
function buildRunIdShouldClauses(ids: string[], sessionIds: string[]): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [
    { terms: { 'attributes.agent_health.run.id': ids } },
    { terms: { 'attributes.gen_ai.conversation.id': ids } },
  ];
  if (sessionIds.length > 0) {
    // `.keyword` sub-field for exact match on a hyphenated UUID (a bare
    // analyzed text field would tokenize on the hyphens and match nothing) —
    // mirrors tracesService.ts's Strategy D handling. Also try the raw
    // (non-keyword) field and the Data-Prepper plain-raw `@`-encoded key,
    // since the attribute lands under a different literal key per schema.
    clauses.push(
      { terms: { 'attributes.session.id.keyword': sessionIds } },
      { terms: { 'attributes.session.id': sessionIds } },
      { terms: { 'span.attributes.session@id': sessionIds } }
    );
  }
  return clauses;
}

/** Resolve which requested id a span actually matched, for grouping spans
 *  back to the runId that requested them (Strategy B by either attribute,
 *  else Strategy D via the sessionId -> runId reverse lookup). */
function resolveSpanRunId(
  span: OpenSearchSpanSource,
  idSet: Set<string>,
  sessionIdToRunId: Map<string, string>
): string | undefined {
  const attrs = span.attributes || {};
  const byRunIdAttr = attrs['agent_health.run.id'] as string | undefined;
  if (byRunIdAttr && idSet.has(byRunIdAttr)) return byRunIdAttr;
  const byConversationId = attrs['gen_ai.conversation.id'] as string | undefined;
  if (byConversationId && idSet.has(byConversationId)) return byConversationId;
  if (sessionIdToRunId.size > 0) {
    const sessionId = (attrs['session.id'] as string | undefined) ?? (attrs['session@id'] as string | undefined);
    if (sessionId && sessionIdToRunId.has(sessionId)) return sessionIdToRunId.get(sessionId);
  }
  return undefined;
}

/**
 * Compute metrics from OpenSearch traces for a single run
 *
 * @param sessionId - Optional Strategy-D correlator (e.g. Claude Code's
 *   `session.id`) to OR into the query alongside Strategy B, for agents that
 *   never stamp our own `agent_health.run.id` / `gen_ai.conversation.id`.
 */
export async function computeMetrics(
  runId: string,
  osConfig: OpenSearchConfig | { client: Client; indexPattern?: string },
  sessionId?: string
): Promise<MetricsResult> {
  const sessionIds = sessionId ? [sessionId] : [];
  if ('client' in osConfig) {
    const indexPattern = osConfig.indexPattern || 'otel-v1-apm-span-*';
    const response = await osConfig.client.search({
      index: indexPattern,
      body: {
        size: 500,
        sort: [{ startTime: { order: 'asc' } }],
        query: {
          bool: {
            must: [
              { bool: { should: buildRunIdShouldClauses([runId], sessionIds), minimum_should_match: 1 } }
            ]
          }
        }
      }
    });
    const spans = response.body.hits?.hits?.map((h: any) => h._source) || [];
    return computeMetricsFromSpans(runId, spans);
  }

  // Legacy: raw fetch with Basic auth
  const { endpoint, username, password, indexPattern = 'otel-v1-apm-span-*' } = osConfig;

  const query = {
    size: 500,
    sort: [{ startTime: { order: 'asc' } }],
    query: {
      bool: {
        must: [
          { bool: { should: buildRunIdShouldClauses([runId], sessionIds), minimum_should_match: 1 } }
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
    const errorText = await response.text();
    throw new Error(`OpenSearch query failed: ${response.status} - ${errorText}`);
  }

  const data: OpenSearchResponse = await response.json();
  const spans = data.hits?.hits?.map(h => h._source) || [];

  return computeMetricsFromSpans(runId, spans);
}

/**
 * Compute metrics for multiple runs using bulk OpenSearch terms query.
 * Issues one query per chunk instead of one query per run ID.
 *
 * @param sessionIdByRunId - Optional Strategy-D correlator map (runId ->
 *   agent-emitted session.id), OR'd into each chunk's query alongside
 *   Strategy B — see {@link buildRunIdShouldClauses}.
 */
export async function computeBatchMetrics(
  runIds: string[],
  osConfig: OpenSearchConfig | { client: Client; indexPattern?: string },
  sessionIdByRunId?: Record<string, string>
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
      const idSet = new Set(chunk);
      const sessionIdToRunId = new Map<string, string>();
      if (sessionIdByRunId) {
        for (const rid of chunk) {
          const sid = sessionIdByRunId[rid];
          if (sid) sessionIdToRunId.set(sid, rid);
        }
      }
      try {
        const response = await osConfig.client.search({
          index: indexPattern,
          body: {
            size: 10000,
            sort: [{ startTime: { order: 'asc' } }],
            _source: METRICS_SOURCE_FIELDS,
            query: {
              bool: {
                must: [
                  { bool: {
                    should: buildRunIdShouldClauses(chunk, Array.from(sessionIdToRunId.keys())),
                    minimum_should_match: 1,
                  } }
                ]
              }
            }
          }
        });

        const allSpans = response.body.hits?.hits?.map((h: any) => h._source) || [];
        const total = response.body.hits?.total;
        const totalHits = (typeof total === 'object' ? total?.value : total) ?? allSpans.length;
        if (totalHits > 10000) {
          console.warn(
            `OpenSearch batch metrics query returned ${allSpans.length} of ${totalHits} spans ` +
            `for chunk of ${chunk.length} run IDs. Metrics may be incomplete.`
          );
        }

        const spansByRunId = new Map<string, OpenSearchSpanSource[]>();
        for (const rid of chunk) spansByRunId.set(rid, []);
        for (const span of allSpans) {
          const rid = resolveSpanRunId(span, idSet, sessionIdToRunId);
          if (rid && spansByRunId.has(rid)) {
            spansByRunId.get(rid)!.push(span);
          }
        }

        return chunk.map(runId => computeMetricsFromSpans(runId, spansByRunId.get(runId) || []));
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
    const idSet = new Set(chunk);
    const sessionIdToRunId = new Map<string, string>();
    if (sessionIdByRunId) {
      for (const rid of chunk) {
        const sid = sessionIdByRunId[rid];
        if (sid) sessionIdToRunId.set(sid, rid);
      }
    }
    const query = {
      size: 10000,
      sort: [{ startTime: { order: 'asc' } }],
      _source: METRICS_SOURCE_FIELDS,
      query: {
        bool: {
          must: [
            { bool: {
              should: buildRunIdShouldClauses(chunk, Array.from(sessionIdToRunId.keys())),
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

    const totalHits = (data.hits as any)?.total?.value ?? allSpans.length;
    if (totalHits > 10000) {
      console.warn(
        `OpenSearch batch metrics query returned ${allSpans.length} of ${totalHits} spans ` +
        `for chunk of ${chunk.length} run IDs. Metrics may be incomplete.`
      );
    }

    const spansByRunId = new Map<string, OpenSearchSpanSource[]>();
    for (const rid of chunk) spansByRunId.set(rid, []);
    for (const span of allSpans) {
      const rid = resolveSpanRunId(span, idSet, sessionIdToRunId);
      if (rid && spansByRunId.has(rid)) {
        spansByRunId.get(rid)!.push(span);
      }
    }

    return chunk.map(runId => computeMetricsFromSpans(runId, spansByRunId.get(runId) || []));
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
