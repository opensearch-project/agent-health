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
});
