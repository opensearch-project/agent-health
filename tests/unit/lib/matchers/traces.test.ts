/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `traces` fixture accessor factories.
 *
 * Particularly important: the regression coverage for issue #230, where
 * `buildFixtures()` always returned `emptyTracesAccessor()`, making
 * matchers like `expect(traces.totalTokens).to.be.lessThan(10_000)`
 * silently pass against `0` even with `useTraces: true`.
 */
import {
  buildTracesAccessor,
  emptyTracesAccessor,
  unavailableTracesAccessor,
} from '@/lib/matchers/traces';
import type { Span } from '@/types';

function span(overrides: Partial<Span> & { name: string; spanId?: string }): Span {
  return {
    traceId: 'trace-1',
    spanId: overrides.spanId ?? `span-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name,
    startTime: '2024-01-01T00:00:00.000Z',
    endTime: '2024-01-01T00:00:01.000Z',
    status: 'OK',
    ...overrides,
  } as Span;
}

describe('emptyTracesAccessor', () => {
  it('returns silent zeros for opt-out scenarios', () => {
    const t = emptyTracesAccessor();
    expect(t.totalTokens).toBe(0);
    expect(t.totalCost).toBe(0);
    expect(t.toolCalls).toEqual([]);
    expect(t.spans).toEqual([]);
    expect(t.spanDuration('anything')).toBe(0);
  });
});

describe('unavailableTracesAccessor (issue #230 loud-failure mode)', () => {
  it('does not throw on construction', () => {
    expect(() => unavailableTracesAccessor('boom')).not.toThrow();
  });

  it('throws on totalTokens read with the given reason', () => {
    const t = unavailableTracesAccessor('no spans found for runId=abc');
    expect(() => t.totalTokens).toThrow(
      'traces fixture unavailable: no spans found for runId=abc'
    );
  });

  it('throws on totalCost, toolCalls, spans reads', () => {
    const t = unavailableTracesAccessor('reason-x');
    expect(() => t.totalCost).toThrow('traces fixture unavailable: reason-x');
    expect(() => t.toolCalls).toThrow('traces fixture unavailable: reason-x');
    expect(() => t.spans).toThrow('traces fixture unavailable: reason-x');
  });

  it('throws on spanDuration() call', () => {
    const t = unavailableTracesAccessor('reason-y');
    expect(() => t.spanDuration('search_logs')).toThrow(
      'traces fixture unavailable: reason-y'
    );
  });

  it('regression #230: lessThan(N) against unavailable accessor must FAIL, not silently pass', () => {
    const t = unavailableTracesAccessor('no traces');
    // Pre-fix this comparison silently passed against 0. Post-fix it
    // throws — which the matcher session converts into a failed
    // MatcherResult, surfacing the issue to the user.
    expect(() => {
      const value = t.totalTokens; // <-- this is what `expect(traces.totalTokens)` does
      void value;
    }).toThrow(/traces fixture unavailable/);
  });
});

describe('buildTracesAccessor', () => {
  it('aggregates prompt + completion tokens via gen_ai.usage attrs', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm.call.1',
        attributes: {
          'gen_ai.usage.prompt_tokens': 1200,
          'gen_ai.usage.completion_tokens': 300,
        },
      }),
      span({
        name: 'llm.call.2',
        attributes: {
          'gen_ai.usage.prompt_tokens': 800,
          'gen_ai.usage.completion_tokens': 200,
        },
      }),
    ]);
    expect(t.totalTokens).toBe(2500);
  });

  it('falls back to gen_ai.usage.input_tokens / output_tokens aliases', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: {
          'gen_ai.usage.input_tokens': 100,
          'gen_ai.usage.output_tokens': 50,
        },
      }),
    ]);
    expect(t.totalTokens).toBe(150);
  });

  it('falls back to legacy llm.usage.* aliases', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: {
          'llm.usage.prompt_tokens': 10,
          'llm.usage.completion_tokens': 5,
        },
      }),
    ]);
    expect(t.totalTokens).toBe(15);
  });

  it('reads bare (non-namespaced) input_tokens / output_tokens attrs (Claude Code shape)', () => {
    const t = buildTracesAccessor([
      span({
        name: 'claude_code.llm_request',
        attributes: {
          input_tokens: 204_817,
          output_tokens: 2_508,
        },
      }),
    ]);
    expect(t.totalTokens).toBe(207_325);
  });

  it('includes bare cache_read_tokens / cache_creation_tokens in totalTokens', () => {
    const t = buildTracesAccessor([
      span({
        name: 'claude_code.llm_request',
        attributes: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_tokens: 500,
          cache_creation_tokens: 250,
        },
      }),
    ]);
    expect(t.totalTokens).toBe(1850);
  });

  it('includes gen_ai.usage.cache_read_input_tokens / cache_creation_input_tokens aliases', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: {
          'gen_ai.usage.prompt_tokens': 100,
          'gen_ai.usage.completion_tokens': 20,
          'gen_ai.usage.cache_read_input_tokens': 40,
          'gen_ai.usage.cache_creation_input_tokens': 10,
        },
      }),
    ]);
    expect(t.totalTokens).toBe(170);
  });

  it('parses string numeric attribute values', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: {
          'gen_ai.usage.prompt_tokens': '40',
          'gen_ai.usage.completion_tokens': '60',
        },
      }),
    ]);
    expect(t.totalTokens).toBe(100);
  });

  it('aggregates total cost across multiple spans', () => {
    const t = buildTracesAccessor([
      span({ name: 'a', attributes: { 'gen_ai.usage.cost_usd': 0.01 } }),
      span({ name: 'b', attributes: { 'gen_ai.usage.cost_usd': 0.02 } }),
      span({ name: 'c', attributes: { 'gen_ai.usage.cost': 0.005 } }),
    ]);
    expect(t.totalCost).toBeCloseTo(0.035, 5);
  });

  it('extracts toolCalls from spans with gen_ai.tool.name', () => {
    const t = buildTracesAccessor([
      span({
        name: 'tool.search_logs',
        attributes: { 'gen_ai.tool.name': 'search_logs' },
        // numeric ms timestamps so spanDurationMs returns a real number
        startTime: 1000 as unknown as string,
        endTime: 1500 as unknown as string,
      }),
    ]);
    expect(t.toolCalls).toEqual([{ name: 'search_logs', durationMs: 500 }]);
  });

  it('spanDuration returns the duration of the first matching span name (ms timestamps)', () => {
    const t = buildTracesAccessor([
      span({
        name: 'search_logs',
        startTime: 2000 as unknown as string,
        endTime: 2750 as unknown as string,
      }),
      span({ name: 'other' }),
    ]);
    expect(t.spanDuration('search_logs')).toBe(750);
    expect(t.spanDuration('not_there')).toBe(0);
  });

  it('handles nanosecond timestamps via the >1e15 heuristic', () => {
    const startNs = 1_700_000_000_000_000_000; // > 1e15
    const endNs = startNs + 250_000_000; // +250ms
    const t = buildTracesAccessor([
      span({
        name: 'big.ns.span',
        startTime: startNs as unknown as string,
        endTime: endNs as unknown as string,
      }),
    ]);
    expect(t.spanDuration('big.ns.span')).toBe(250);
  });

  it('exposes raw spans for power-user access', () => {
    const spans = [span({ name: 's1' }), span({ name: 's2' })];
    const t = buildTracesAccessor(spans);
    expect(t.spans).toHaveLength(2);
    expect(t.spans[0].name).toBe('s1');
  });

  describe('leaf-usage invariant (#653) — the fixture agrees with /api/metrics and the Traces tab', () => {
    const MODEL = 'claude-sonnet-4-6'; // Sonnet class: $3 in / $15 out per MTok
    it('an invoke_agent span carrying exactly the sum of its chat children is not counted again (tokens AND computed cost)', () => {
      const t = buildTracesAccessor([
        span({ name: 'invoke_agent', spanId: 'agent', attributes: { 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 300, 'gen_ai.usage.output_tokens': 30 } }),
        span({ name: 'chat', spanId: 'c1', parentSpanId: 'agent', attributes: { 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10 } }),
        span({ name: 'chat', spanId: 'c2', parentSpanId: 'agent', attributes: { 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 200, 'gen_ai.usage.output_tokens': 20 } }),
      ]);
      expect(t.totalTokens).toBe(330);
      expect(t.totalCost).toBeCloseTo((300 * 3 + 30 * 15) / 1e6, 12);
      expect(t.costSource).toBe('computed');
    });

    it('a parent carrying MORE than its children contributes the remainder (priced at the plain input/output rates)', () => {
      const t = buildTracesAccessor([
        span({ name: 'request', spanId: 'req', attributes: { 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 100 } }),
        span({ name: 'stream', spanId: 'st', parentSpanId: 'req', attributes: { 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 700, 'gen_ai.usage.output_tokens': 100 } }),
      ]);
      expect(t.totalTokens).toBe(1100);
      expect(t.totalCost).toBeCloseTo((1000 * 3 + 100 * 15) / 1e6, 12);
    });

    it('a parent carrying usage while no descendant does is counted in full, cache tokens included', () => {
      const t = buildTracesAccessor([
        span({ name: 'invoke_agent', spanId: 'agent', attributes: { 'gen_ai.request.model': MODEL, input_tokens: 100, output_tokens: 10, cache_read_tokens: 1000 } }),
        span({ name: 'execute_tool search', spanId: 'tool', parentSpanId: 'agent', attributes: { 'gen_ai.tool.name': 'search' } }),
      ]);
      expect(t.totalTokens).toBe(1110);
      expect(t.totalCost).toBeCloseTo((100 * 3 + 10 * 15 + 1000 * 0.3) / 1e6, 12);
    });

    it('a roll-up parent with an unpriced model does not make totalCost unknowable (children priced)', () => {
      const t = buildTracesAccessor([
        span({ name: 'invoke_agent', spanId: 'agent', attributes: { 'gen_ai.request.model': '/opt/unpriced', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10 } }),
        span({ name: 'chat', spanId: 'c1', parentSpanId: 'agent', attributes: { 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10 } }),
      ]);
      expect(t.totalTokens).toBe(110);
      expect(() => t.totalCost).not.toThrow();
    });
  });

  it('costSource is "reported" when spans carry a real cost attribute', () => {
    const t = buildTracesAccessor([
      span({ name: 'a', attributes: { 'gen_ai.usage.cost_usd': 0.01 } }),
    ]);
    expect(t.costSource).toBe('reported');
  });

  it('computes totalCost from tokens + model pricing when no cost attr is reported (Claude Code shape)', () => {
    const t = buildTracesAccessor([
      span({
        name: 'claude_code.llm_request',
        attributes: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
          cache_creation_tokens: 1_000_000,
          'gen_ai.request.model': 'claude-sonnet-4-6',
        },
      }),
    ]);
    // Sonnet estimate: $3 in / $15 out / $0.30 cache-read / $3.75 cache-write per MTok
    expect(t.totalCost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 5);
    expect(t.costSource).toBe('computed');
  });

  it('resolves model id from gen_ai.response.model or bare "model" as fallbacks', () => {
    const viaResponseModel = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          'gen_ai.response.model': 'claude-haiku-4-5',
        },
      }),
    ]);
    expect(viaResponseModel.totalCost).toBeCloseTo(0.8, 5);

    const viaBareModel = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: { input_tokens: 1_000_000, output_tokens: 0, model: 'claude-opus-4-6' },
      }),
    ]);
    expect(viaBareModel.totalCost).toBeCloseTo(15, 5);
  });

  it('costSource is "mixed" when some spans report cost and others are computed', () => {
    const t = buildTracesAccessor([
      span({ name: 'a', attributes: { 'gen_ai.usage.cost_usd': 0.01 } }),
      span({
        name: 'b',
        attributes: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          'gen_ai.request.model': 'claude-sonnet-4-6',
        },
      }),
    ]);
    expect(t.costSource).toBe('mixed');
    expect(t.totalCost).toBeCloseTo(0.01 + 3, 5);
  });

  it('genuine zero-value token attrs do not throw on totalTokens or totalCost', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: { 'gen_ai.usage.prompt_tokens': 0, 'gen_ai.usage.completion_tokens': 0 },
      }),
    ]);
    expect(t.totalTokens).toBe(0);
    expect(t.totalCost).toBe(0);
    expect(t.costSource).toBe('none');
  });

  it('fail-loud: throws reading totalTokens when spans exist but none carry a recognized token attribute', () => {
    const t = buildTracesAccessor([
      span({ name: 'tool.search_logs', attributes: { 'gen_ai.tool.name': 'search_logs' } }),
    ]);
    expect(() => t.totalTokens).toThrow(/none carried a recognized/);
  });

  it('fail-loud: throws reading totalCost when spans exist but neither tokens nor cost are recognized', () => {
    const t = buildTracesAccessor([
      span({ name: 'tool.search_logs', attributes: { 'gen_ai.tool.name': 'search_logs' } }),
    ]);
    expect(() => t.totalCost).toThrow(/none carried a recognized/);
  });

  it('does NOT throw on totalCost when tokens are absent but a real cost attribute is reported', () => {
    const t = buildTracesAccessor([
      span({ name: 'a', attributes: { 'gen_ai.usage.cost_usd': 0.05 } }),
      span({ name: 'b', attributes: { 'gen_ai.usage.cost_usd': 0.02 } }),
    ]);
    expect(t.totalCost).toBeCloseTo(0.07, 5);
    expect(() => t.totalTokens).toThrow(/none carried a recognized/);
  });

  it('fail-loud: throws reading totalCost when tokens matched but the model is unpriced and no cost attr exists', () => {
    const t = buildTracesAccessor([
      span({
        name: 'llm',
        attributes: { input_tokens: 500, output_tokens: 100, 'gen_ai.request.model': 'some-unknown-model-xyz' },
      }),
    ]);
    // Tokens themselves are known and must not throw.
    expect(t.totalTokens).toBe(600);
    expect(() => t.totalCost).toThrow(/pricing table/);
  });

  it('fail-loud: throws reading totalCost when tokens matched but no model attr is present at all', () => {
    const t = buildTracesAccessor([
      span({ name: 'llm', attributes: { input_tokens: 500, output_tokens: 100 } }),
    ]);
    expect(t.totalTokens).toBe(600);
    expect(() => t.totalCost).toThrow(/pricing table/);
  });

  it('regression: the exact dogfood shape (bare tokens, no cost attr) surfaces nonzero totals, not a vacuous pass', () => {
    // Mirrors the redkite-cost.eval.js dogfood finding: 5 claude_code.llm_request
    // spans with bare token attrs and NO cost attribute anywhere. Pre-fix this
    // read totalTokens=0 / totalCost=0, so `expect(traces.totalCost).lessThan(2)`
    // passed vacuously.
    const spans = [
      span({
        name: 'claude_code.llm_request',
        attributes: {
          input_tokens: 40_000,
          output_tokens: 500,
          cache_read_tokens: 1000,
          cache_creation_tokens: 200,
          'gen_ai.request.model': 'claude-sonnet-4-6',
        },
      }),
    ];
    const t = buildTracesAccessor(spans);
    expect(t.totalTokens).toBeGreaterThan(0);
    expect(t.totalCost).toBeGreaterThan(0);
    expect(t.costSource).toBe('computed');
  });

  it('fail-loud (codex_review PR #440 blocker fix): throws reading totalCost when SOME spans are priced/reported but at least one token-bearing span is unpriced -- must not silently under-report', () => {
    const t = buildTracesAccessor([
      // Priced normally -- would make costUnknowable false under the old
      // "only throw if EVERY span is unresolved" logic.
      span({
        name: 'a',
        attributes: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          'gen_ai.request.model': 'claude-sonnet-4-6',
        },
      }),
      // Unpriced model, no cost attribute -- its real spend would be
      // silently dropped from totalCost pre-fix.
      span({
        name: 'b',
        attributes: { input_tokens: 500, output_tokens: 100, 'gen_ai.request.model': 'some-unknown-model-xyz' },
      }),
    ]);
    // Tokens are legitimately known across both spans -- must not throw.
    expect(t.totalTokens).toBe(1_000_600);
    expect(() => t.totalCost).toThrow(/pricing table/);
    expect(() => t.totalCost).toThrow(/UNDER-report/);
  });

  it('does NOT throw reading totalCost when every token-bearing span is fully resolved (reported+computed mix)', () => {
    const t = buildTracesAccessor([
      span({ name: 'a', attributes: { 'gen_ai.usage.cost_usd': 0.01 } }),
      span({
        name: 'b',
        attributes: { input_tokens: 1_000_000, output_tokens: 0, 'gen_ai.request.model': 'claude-sonnet-4-6' },
      }),
    ]);
    expect(() => t.totalCost).not.toThrow();
    expect(t.totalCost).toBeCloseTo(0.01 + 3, 5);
  });

  it('design note (reviewed, kept as documented): a trace with ONLY tool spans (no LLM span at all) throws on totalTokens, directing callers to traces.toolCalls/traces.spans instead of a silent 0', () => {
    // Pins the deliberate tradeoff discussed in PR #440 review: this is the
    // SAME `noRecognizedTokenAttrs` path as "none carried a recognized token
    // attribute" (an agent whose spans use an unsupported shape) -- the
    // fixture cannot distinguish "unsupported shape" from "no LLM call
    // happened" without span-kind/operation-name classification, which is
    // out of scope here. A body that legitimately expects zero LLM spend
    // should assert on traces.toolCalls/traces.spans, not traces.totalTokens.
    const t = buildTracesAccessor([
      span({ name: 'tool.read_file', attributes: { 'gen_ai.tool.name': 'read_file' } }),
      span({ name: 'tool.write_file', attributes: { 'gen_ai.tool.name': 'write_file' } }),
    ]);
    expect(t.toolCalls).toEqual([
      { name: 'read_file', durationMs: 0 },
      { name: 'write_file', durationMs: 0 },
    ]);
    expect(() => t.totalTokens).toThrow(/none carried a recognized/);
    expect(() => t.totalCost).toThrow(/none carried a recognized/);
  });
});
