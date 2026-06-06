/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * traceSummary
 *
 * Computes a compact summary for a trace's span tree — the same set of
 * non-redundant signals shown in the Agent Traces inline-expansion header
 * strip and the fullscreen header. Keeping the computation in one place
 * means inline and fullscreen render exactly the same numbers from the
 * same source-of-truth (`categorizeSpanTree` for category buckets,
 * `gen_ai.usage.*` attribute aggregation for tokens, and dedup over
 * `gen_ai.request.model` / `gen_ai.response.model` / `model` for the
 * model name list).
 */
import { Span } from '@/types';
import { categorizeSpanTree, countByCategory } from './spanCategorization';
import { flattenSpans } from './traceStats';

export interface TraceSummary {
  llm: number;
  tool: number;
  agent: number;
  evalCount: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  models: string[];
}

/**
 * Aggregate the headline signals from a span tree.
 *
 * The category counts come from {@link countByCategory} on a categorized
 * tree. The token counters look at every span (including children) and
 * sum the OTel GenAI usage attributes, with `prompt_tokens` /
 * `completion_tokens` accepted as fallbacks for older instrumentation
 * that pre-dates the input/output rename. Models are collected and
 * deduplicated across the trace because some agents fan out to multiple
 * models in one trace (e.g. a planner + a tool-using model).
 */
export function computeTraceSummary(spanTree: Span[]): TraceSummary {
  const categorized = categorizeSpanTree(spanTree);
  const counts = countByCategory(categorized);
  const flat = flattenSpans(categorized);

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const modelSet = new Set<string>();

  for (const s of flat) {
    const a = s.attributes || {};
    const it =
      Number(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? a['input_tokens'] ?? 0) || 0;
    const ot =
      Number(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? a['output_tokens'] ?? 0) || 0;
    inputTokens += it;
    outputTokens += ot;
    totalTokens += it + ot;
    const m = a['gen_ai.request.model'] || a['gen_ai.response.model'] || a['model'];
    if (typeof m === 'string' && m.trim()) modelSet.add(m.trim());
  }

  return {
    llm: counts.LLM,
    tool: counts.TOOL,
    agent: counts.AGENT,
    evalCount: counts.EVAL,
    errors: counts.ERROR,
    inputTokens,
    outputTokens,
    totalTokens,
    models: Array.from(modelSet),
  };
}

/**
 * True when no headline signal is present (no LLM/tool/agent/eval span,
 * no errors, no token counters, no model). Callers can use this to fall
 * back to a "no summary attributes available" placeholder instead of
 * collapsing to an empty bar.
 */
export function isEmptyTraceSummary(s: TraceSummary): boolean {
  return (
    s.llm === 0 &&
    s.tool === 0 &&
    s.agent === 0 &&
    s.evalCount === 0 &&
    s.errors === 0 &&
    s.totalTokens === 0 &&
    s.models.length === 0
  );
}
