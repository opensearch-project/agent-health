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
import { attributeLeafUsage } from '@/lib/usageAggregates';

export interface TraceSummary {
  llm: number;
  tool: number;
  agent: number;
  evalCount: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Largest single-span input-token count in the trace. Used for
      context-window utilization (Ctx%) — the peak request, not the sum. */
  peakInputTokens: number;
  models: string[];
}

/**
 * Aggregate the headline signals from a span tree.
 *
 * The category counts come from {@link countByCategory} on a categorized
 * tree. The token counters look at every span (including children) and
 * sum the OTel GenAI usage attributes, with `prompt_tokens` /
 * `completion_tokens` accepted as fallbacks for older instrumentation
 * that pre-dates the input/output rename. Each span contributes only the
 * usage its descendants don't already account for (leaf-usage invariant,
 * see lib/usageAggregates.ts) so agent-level roll-ups aren't added on top
 * of the per-call numbers; a pure roll-up is excluded from the peak, since
 * its "input" is not one request. Models are collected and
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
  let peakInputTokens = 0;
  const modelSet = new Set<string>();

  const readIn = (a: Record<string, any>) =>
    Number(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? a['input_tokens'] ?? 0) || 0;
  const readOut = (a: Record<string, any>) =>
    Number(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? a['output_tokens'] ?? 0) || 0;
  const usage = attributeLeafUsage(flat, s => {
    const a = s.attributes || {};
    return { input: readIn(a), output: readOut(a) };
  });

  for (const s of flat) {
    const a = s.attributes || {};
    const counted = usage.get(s)!;
    inputTokens += counted.input;
    outputTokens += counted.output;
    totalTokens += counted.input + counted.output;
    // Peak = largest single request. A pure roll-up is not a request; a
    // parent with real (remaining) usage is.
    if (!counted.isAggregate && readIn(a) > peakInputTokens) peakInputTokens = readIn(a);
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
    peakInputTokens,
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
