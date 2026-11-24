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
import { lookupModelRates, computeCost } from './tracesPricing.js';
import { attributeLeafUsage } from '../usageAggregates.js';

/**
 * Where `totalCost` came from:
 *   - `'reported'` — every dollar came from a real cost attribute on a span.
 *   - `'computed'` — no span carried a cost attribute; the whole total was
 *     derived from token counts via the fallback pricing table.
 *   - `'mixed'`    — some spans reported cost, others were computed.
 *   - `'none'`     — no LLM spans, or no cost could be determined at all.
 */
export type CostSource = 'reported' | 'computed' | 'mixed' | 'none';

export interface TracesAccessor {
  /** Sum of all prompt/completion/cache token-usage attrs across LLM spans. */
  totalTokens: number;
  /**
   * Sum of all reported cost attrs, falling back to a computed estimate
   * (from token counts + the model pricing table) when no span reports
   * cost directly. See `costSource` to tell which happened.
   */
  totalCost: number;
  /** Whether `totalCost` was reported by spans, computed, both, or neither. */
  costSource: CostSource;
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
    costSource: 'none',
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
    get costSource(): CostSource { return fail(); },
    get toolCalls(): ReadonlyArray<{ name: string; durationMs: number }> { return fail(); },
    get spans(): ReadonlyArray<Span> { return fail(); },
    spanDuration(_name: string): number { return fail(); },
  } as TracesAccessor;
}

const PROMPT_TOKEN_KEYS = [
  'gen_ai.usage.prompt_tokens',
  'gen_ai.usage.input_tokens',
  'llm.usage.prompt_tokens',
  'input_tokens',
];
const COMPLETION_TOKEN_KEYS = [
  'gen_ai.usage.completion_tokens',
  'gen_ai.usage.output_tokens',
  'llm.usage.completion_tokens',
  'output_tokens',
];
const CACHE_READ_TOKEN_KEYS = [
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cache_read_tokens',
  'cache_read_tokens',
];
const CACHE_CREATION_TOKEN_KEYS = [
  'gen_ai.usage.cache_creation_input_tokens',
  'gen_ai.usage.cache_creation_tokens',
  'cache_creation_tokens',
];
const MODEL_ID_KEYS = ['gen_ai.request.model', 'gen_ai.response.model', 'model'];
const ALL_TOKEN_KEYS = [
  ...PROMPT_TOKEN_KEYS,
  ...COMPLETION_TOKEN_KEYS,
  ...CACHE_READ_TOKEN_KEYS,
  ...CACHE_CREATION_TOKEN_KEYS,
];

/** Build a TracesAccessor from a flat list of spans. */
export function buildTracesAccessor(spans: Span[]): TracesAccessor {
  let totalTokens = 0;
  let reportedCost = 0;
  let computedCost = 0;
  let hadReportedCost = false;
  let hadComputedCost = false;
  let tokenBearingSpanCount = 0;
  // codex_review (PR #440): a span can have recognized tokens yet resolve
  // NEITHER a reported cost NOR a computed one (unpriced/unresolved model) —
  // this counter drives `costUnknowable` below so totalCost refuses to
  // silently under-report just because *some other* span in the same trace
  // happened to be priceable.
  let unresolvedCostSpanCount = 0;
  const toolCalls: { name: string; durationMs: number }[] = [];

  // Leaf-usage invariant (lib/usageAggregates.ts, #653): a parent span whose
  // descendants already carry its usage (an `invoke_agent` roll-up over its
  // `chat` children) contributes nothing, so `totalTokens` / `totalCost` here
  // agree with `/api/metrics` and the Traces tab. Input-side tokens (prompt +
  // cache read + cache creation) and output tokens are attributed separately.
  const rawUsage = (span: Span) => {
    const attrs = span.attributes ?? {};
    return {
      input:
        (pickNumber(attrs, PROMPT_TOKEN_KEYS) ?? 0) +
        (pickNumber(attrs, CACHE_READ_TOKEN_KEYS) ?? 0) +
        (pickNumber(attrs, CACHE_CREATION_TOKEN_KEYS) ?? 0),
      output: pickNumber(attrs, COMPLETION_TOKEN_KEYS) ?? 0,
    };
  };
  const attributed = attributeLeafUsage(spans, rawUsage);

  for (const span of spans) {
    const attrs = span.attributes ?? {};
    const promptTokens = pickNumber(attrs, PROMPT_TOKEN_KEYS);
    const completionTokens = pickNumber(attrs, COMPLETION_TOKEN_KEYS);
    const cacheReadTokens = pickNumber(attrs, CACHE_READ_TOKEN_KEYS);
    const cacheCreationTokens = pickNumber(attrs, CACHE_CREATION_TOKEN_KEYS);

    const hasTokenAttr =
      promptTokens !== undefined ||
      completionTokens !== undefined ||
      cacheReadTokens !== undefined ||
      cacheCreationTokens !== undefined;

    if (hasTokenAttr) tokenBearingSpanCount += 1;
    const counted = attributed.get(span)!;
    const raw = rawUsage(span);
    totalTokens += counted.input + counted.output;

    const reported = pickNumber(attrs, [
      'gen_ai.usage.cost_usd',
      'gen_ai.usage.cost',
      'llm.usage.cost_usd',
    ]);
    if (reported !== undefined) {
      hadReportedCost = true;
      reportedCost += reported;
    } else if (hasTokenAttr && counted.isAggregate) {
      // Pure roll-up of its descendants: the children's cost already covers it.
    } else if (hasTokenAttr) {
      // No reported cost attribute on this span — fall back to a computed
      // estimate from token counts, if we know pricing for the model.
      const modelId = pickString(attrs, MODEL_ID_KEYS);
      const rates = lookupModelRates(modelId);
      if (rates) {
        hadComputedCost = true;
        const isLeaf = counted.input === raw.input && counted.output === raw.output;
        computedCost += computeCost(
          isLeaf
            ? {
                input: promptTokens ?? 0,
                output: completionTokens ?? 0,
                cacheRead: cacheReadTokens ?? 0,
                cacheCreation: cacheCreationTokens ?? 0,
              }
            : // A parent carrying MORE than its descendants: only the remainder
              // is new spend; the cache split of that remainder is unknown, so
              // it is priced at the plain input/output rates.
              { input: counted.input, output: counted.output, cacheRead: 0, cacheCreation: 0 },
          rates,
        );
      } else {
        // This span's tokens contribute to totalTokens but NOT to totalCost —
        // without this counter that would be a silent, plausible-looking
        // undercount rather than the loud failure #230 asks for.
        unresolvedCostSpanCount += 1;
      }
    }

    // Tool spans
    const toolName = pickString(attrs, ['gen_ai.tool.name', 'llm.tool.name']);
    if (toolName) {
      toolCalls.push({ name: toolName, durationMs: spanDurationMs(span) });
    }
  }

  const totalCostValue = reportedCost + computedCost;
  const costSource: CostSource = hadReportedCost && hadComputedCost
    ? 'mixed'
    : hadReportedCost
      ? 'reported'
      : hadComputedCost
        ? 'computed'
        : 'none';

  // Issue class: spans exist, but none of them carry any token-usage
  // attribute we recognize. Reading totalTokens/totalCost would silently
  // return 0, letting matchers like `expect(traces.totalCost).lessThan(2)`
  // pass vacuously (mirrors the #230 fail-loud philosophy). A trace that
  // genuinely has recognized-but-zero-valued attributes is fine and must
  // NOT throw — only the "we found nothing we understand" case throws.
  const noRecognizedTokenAttrs = spans.length > 0 && tokenBearingSpanCount === 0;

  // Issue class: tokens were found, but AT LEAST ONE token-bearing span
  // resolved neither a reported cost nor a computed one (unpriced model,
  // no cost attribute). Pre-codex_review this only threw when EVERY span
  // was unresolved — a trace with 9 priced spans and 1 unpriced span
  // silently under-reported totalCost by exactly the unpriced span's real
  // spend while still returning a plausible-looking number (PR #440 review
  // finding, blocker). Throw only when reading totalCost (tokens themselves
  // are legitimately known in this case) — any unresolved span makes the
  // total untrustworthy, not just a total absence of resolved spans.
  const costUnknowable = totalTokens > 0 && unresolvedCostSpanCount > 0;

  return {
    get totalTokens(): number {
      if (noRecognizedTokenAttrs) {
        throw new Error(
          `traces fixture: ${spans.length} span(s) present but none carried a recognized ` +
          `token-usage attribute (checked ${ALL_TOKEN_KEYS.join(', ')}). Reading totalTokens ` +
          `would silently return 0 — either this agent's spans use an unsupported attribute ` +
          `shape (extend buildTracesAccessor() in lib/matchers/traces.ts), or this test case ` +
          `has no LLM spans and should use traces.spans / traces.toolCalls instead of totalTokens.`
        );
      }
      return totalTokens;
    },
    get totalCost(): number {
      if (noRecognizedTokenAttrs && !hadReportedCost) {
        throw new Error(
          `traces fixture: ${spans.length} span(s) present but none carried a recognized ` +
          `token-usage attribute or a cost attribute, so totalCost cannot be determined. ` +
          `Reading totalCost would silently return 0.`
        );
      }
      if (costUnknowable) {
        throw new Error(
          `traces fixture: ${unresolvedCostSpanCount} of ${tokenBearingSpanCount} span(s) with token usage ` +
          `carried neither a cost attribute nor a model id matching the fallback pricing table (see ` +
          `lib/matchers/tracesPricing.ts). Reading totalCost would silently UNDER-report real spend by ` +
          `omitting those spans rather than reflect it -- add the model(s) to the pricing table or stamp a ` +
          `cost attribute on the span(s), or use traces.spans to inspect per-span usage directly.`
        );
      }
      return totalCostValue;
    },
    get costSource(): CostSource {
      return costSource;
    },
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
