/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metrics Service - Compute trace-based metrics from OpenSearch
 *
 * Ported from NovaLanggraphApplication/scripts/experiment/metrics.ts
 */

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
  'status.code'?: number;
  'span.attributes.gen_ai@usage@input_tokens'?: number;
  'span.attributes.gen_ai@usage@output_tokens'?: number;
  'span.attributes.gen_ai@request@model'?: string;
  'span.attributes.gen_ai@tool@name'?: string;
  'span.attributes.tool.name'?: string;
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
 * @param runId - The run ID (gen_ai@request@id)
 * @param osConfig - OpenSearch configuration
 * @returns Computed metrics
 */
export async function computeMetrics(
  runId: string,
  osConfig: OpenSearchConfig
): Promise<MetricsResult> {
  const { endpoint, username, password, indexPattern = 'otel-v1-apm-span-*' } = osConfig;

  // Query spans by run ID
  const query = {
    size: 500,
    sort: [{ startTime: { order: 'asc' } }],
    query: {
      bool: {
        must: [
          { term: { 'span.attributes.gen_ai@request@id': runId } }
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
    // Extract token usage from spans with gen_ai@usage attributes
    const inTokens = Number(span['span.attributes.gen_ai@usage@input_tokens']) || 0;
    const outTokens = Number(span['span.attributes.gen_ai@usage@output_tokens']) || 0;
    inputTokens += inTokens;
    outputTokens += outTokens;

    // Count LLM calls (spans with gen_ai@request@model)
    const spanModel = span['span.attributes.gen_ai@request@model'];
    if (spanModel) {
      llmCalls++;
      modelId = spanModel; // Use the last model ID found
    }

    // Count tool executions
    if (span.name === 'agent.tool.execute' || span.name?.includes('tool')) {
      const toolName = span['span.attributes.gen_ai@tool@name'] ||
                       span['span.attributes.tool.name'] ||
                       span.name;
      if (toolName && toolName !== 'agent.tool.execute') {
        toolsUsed.add(toolName);
      }
    }
  }

  // Calculate cost
  const pricing = getPricing(modelId);
  const costUsd = (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;

  // Calculate duration from root span
  let durationMs = 0;
  if (rootSpan) {
    durationMs = (rootSpan.durationInNanos || 0) / 1e6;
  } else if (spans.length > 0) {
    // Fallback: calculate from first to last span
    const firstSpan = spans[0];
    const lastSpan = spans[spans.length - 1];
    const startTime = new Date(firstSpan.startTime || 0).getTime();
    const endTime = new Date(lastSpan.endTime || lastSpan.startTime || 0).getTime();
    durationMs = endTime - startTime;
  }

  // Determine status from root span or overall
  let status: 'pending' | 'success' | 'error' = 'pending';
  if (rootSpan) {
    status = rootSpan['status.code'] === 2 ? 'error' :
             rootSpan['status.code'] === 1 ? 'success' : 'success';
  } else if (spans.length > 0) {
    // Check if any span has error status
    const hasError = spans.some(s => s['status.code'] === 2);
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
