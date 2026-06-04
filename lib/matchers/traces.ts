/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `traces` fixture — read-only access to the OTel traces emitted by the
 * agent during this run. Pre-loaded by the runner before the test body
 * starts; sync access from inside the body.
 *
 * Three construction modes (the runner picks one):
 *   - `buildTracesAccessor(spans)` — real spans available, real numbers.
 *   - `emptyTracesAccessor()` — agent opted out (`useTraces=false`).
 *     Every accessor returns 0/[] so user matchers don't blow up.
 *   - `unavailableTracesAccessor(reason)` — agent opted in (`useTraces=true`)
 *     but spans were not fetchable (no runId, fetch failed, or polling
 *     timed out). Every accessor *throws* so silent false-passes like
 *     `expect(traces.totalTokens).to.be.lessThan(10_000)` against an
 *     empty fixture become loud failures (see issue #230).
 *
 * Built on top of `services/traces/index.ts:fetchTracesByRunIds` —
 * the runner is responsible for invoking that and constructing the
 * accessor.
 */

import type { Span } from '../../types/index.js';

export interface TracesAccessor {
  /** Sum of all `gen_ai.usage.prompt_tokens + completion_tokens` across LLM spans. */
  totalTokens: number;
  /** Sum of all `gen_ai.usage.cost_usd` (or derived) across LLM spans. */
  totalCost: number;
  /** Tool invocation summary derived from spans. */
  toolCalls: ReadonlyArray<{ name: string; durationMs: number }>;
  /** Duration of the first span matching the given name, or 0 when not found. */
  spanDuration(name: string): number;
  /** All spans (read-only). */
  spans: ReadonlyArray<Span>;
}

/**
 * Empty accessor — silent zeros. Used when the agent opted out of traces
 * (`useTraces: false`). Reading any accessor returns `0` / `[]` so user
 * matchers in opt-out scenarios don't throw.
 */
export function emptyTracesAccessor(): TracesAccessor {
  return {
    totalTokens: 0,
    totalCost: 0,
    toolCalls: [],
    spanDuration: () => 0,
    spans: [],
  };
}

/**
 * Loud-failure accessor — every read throws. Used when the agent opted
 * in to traces (`useTraces: true`) but spans were not retrievable. This
 * turns the silent false-pass described in issue #230 into an actionable
 * error, e.g.:
 *
 *   Error: traces fixture unavailable: no spans found for runId=…
 *
 * Construction never throws — only attribute / method access does.
 */
export function unavailableTracesAccessor(reason: string): TracesAccessor {
  const fail = (): never => {
    throw new Error(`traces fixture unavailable: ${reason}`);
  };
  return {
    get totalTokens(): number { return fail(); },
    get totalCost(): number { return fail(); },
    get toolCalls(): ReadonlyArray<{ name: string; durationMs: number }> { return fail(); },
    get spans(): ReadonlyArray<Span> { return fail(); },
    spanDuration(_name: string): number { return fail(); },
  } as TracesAccessor;
}

/** Build a TracesAccessor from a flat list of spans. */
export function buildTracesAccessor(spans: Span[]): TracesAccessor {
  let totalTokens = 0;
  let totalCost = 0;
  const toolCalls: { name: string; durationMs: number }[] = [];

  for (const span of spans) {
    const attrs = span.attributes ?? {};
    const promptTokens = pickNumber(attrs, [
      'gen_ai.usage.prompt_tokens',
      'gen_ai.usage.input_tokens',
      'llm.usage.prompt_tokens',
    ]);
    const completionTokens = pickNumber(attrs, [
      'gen_ai.usage.completion_tokens',
      'gen_ai.usage.output_tokens',
      'llm.usage.completion_tokens',
    ]);
    if (promptTokens) totalTokens += promptTokens;
    if (completionTokens) totalTokens += completionTokens;

    const cost = pickNumber(attrs, [
      'gen_ai.usage.cost_usd',
      'gen_ai.usage.cost',
      'llm.usage.cost_usd',
    ]);
    if (cost) totalCost += cost;

    // Tool spans
    const toolName = pickString(attrs, ['gen_ai.tool.name', 'llm.tool.name']);
    if (toolName) {
      toolCalls.push({ name: toolName, durationMs: spanDurationMs(span) });
    }
  }

  return {
    totalTokens,
    totalCost,
    toolCalls,
    spanDuration(name: string): number {
      const hit = spans.find(s => s.name === name);
      return hit ? spanDurationMs(hit) : 0;
    },
    spans,
  };
}

function spanDurationMs(span: Span): number {
  const start = (span as any).startTimeUnixNano ?? (span as any).startTime;
  const end = (span as any).endTimeUnixNano ?? (span as any).endTime;
  if (typeof start === 'number' && typeof end === 'number') {
    // Heuristic: nanosecond timestamps when 13+ digits, else ms
    const factor = Math.abs(start) > 1e15 ? 1e6 : 1;
    return Math.max(0, Math.round((end - start) / factor));
  }
  if (typeof (span as any).durationMs === 'number') return (span as any).durationMs;
  return 0;
}

function pickNumber(attrs: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function pickString(attrs: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
