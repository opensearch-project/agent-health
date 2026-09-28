/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for traceSummary.ts — the shared trace summary helper used by
 * the inline-expansion header and the fullscreen header.
 */

import { Span } from '@/types';
import { computeTraceSummary, isEmptyTraceSummary } from '@/services/traces/traceSummary';

const baseSpan = (overrides: Partial<Span> = {}): Span => ({
  traceId: 't1',
  spanId: 's1',
  parentSpanId: undefined,
  name: 'span',
  serviceName: 'svc',
  startTime: '2024-01-01T00:00:00.000Z',
  endTime: '2024-01-01T00:00:01.000Z',
  duration: 1000,
  status: 'OK',
  attributes: {},
  events: [],
  children: [],
  ...overrides,
});

describe('computeTraceSummary', () => {
  it('returns zero counts and empty arrays for an empty tree', () => {
    const s = computeTraceSummary([]);
    expect(s.llm).toBe(0);
    expect(s.tool).toBe(0);
    expect(s.agent).toBe(0);
    expect(s.evalCount).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.models).toEqual([]);
    expect(isEmptyTraceSummary(s)).toBe(true);
  });

  it('counts category buckets by walking the whole tree (incl. children)', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'root',
        name: 'invoke_agent observio',
        attributes: { 'gen_ai.operation.name': 'invoke_agent' },
        children: [
          baseSpan({
            spanId: 'llm-1',
            name: 'claude_code.llm_request',
            attributes: { 'gen_ai.operation.name': 'chat' },
          }),
          baseSpan({
            spanId: 'tool-1',
            name: 'web_search',
            attributes: { 'gen_ai.operation.name': 'execute_tool' },
          }),
          baseSpan({
            spanId: 'eval-1',
            name: 'test_case',
            attributes: { 'gen_ai.operation.name': 'evaluation' },
          }),
        ],
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(s.agent).toBeGreaterThan(0);
    expect(s.llm).toBe(1);
    expect(s.tool).toBe(1);
    expect(s.evalCount).toBe(1);
  });

  it('flags errors when any span has status=ERROR', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'root',
        children: [baseSpan({ spanId: 'bad', status: 'ERROR' })],
      }),
    ];
    expect(computeTraceSummary(tree).errors).toBeGreaterThan(0);
  });

  it('aggregates GenAI input/output tokens across the tree', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'root',
        children: [
          baseSpan({
            spanId: 'llm-1',
            attributes: {
              'gen_ai.usage.input_tokens': 100,
              'gen_ai.usage.output_tokens': 200,
            },
          }),
          baseSpan({
            spanId: 'llm-2',
            attributes: {
              'gen_ai.usage.input_tokens': 50,
              'gen_ai.usage.output_tokens': 75,
            },
          }),
        ],
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(s.inputTokens).toBe(150);
    expect(s.outputTokens).toBe(275);
    expect(s.totalTokens).toBe(425);
    // peakInputTokens is the MAX single-span input count (100), not the sum (150)
    expect(s.peakInputTokens).toBe(100);
  });

  it('does not double-count an aggregate parent whose children also carry usage (leaf-usage invariant)', () => {
    // An invoke_agent-style wrapper stamped with the SUM of its chat children.
    const tree: Span[] = [
      baseSpan({
        spanId: 'agent',
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.usage.input_tokens': 150,
          'gen_ai.usage.output_tokens': 275,
        },
        children: [
          baseSpan({
            spanId: 'llm-1', parentSpanId: 'agent',
            attributes: { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 200 },
          }),
          baseSpan({
            spanId: 'llm-2', parentSpanId: 'agent',
            attributes: { 'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 75 },
          }),
        ],
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(s.inputTokens).toBe(150);
    expect(s.outputTokens).toBe(275);
    expect(s.totalTokens).toBe(425);
    // The aggregate's 150 is not "one request" — peak comes from leaves only.
    expect(s.peakInputTokens).toBe(100);
  });

  it('counts the remainder when a parent carries more usage than its children (nothing dropped)', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'req',
        attributes: { 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 100 },
        children: [baseSpan({ spanId: 'stream', parentSpanId: 'req', attributes: { 'gen_ai.usage.input_tokens': 700 } })],
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(s.inputTokens).toBe(1000);
    expect(s.outputTokens).toBe(100);
    // The parent is a real request → it is the peak.
    expect(s.peakInputTokens).toBe(1000);
  });

  it('still counts a parent that carries usage when no descendant does', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'agent',
        attributes: { 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5 },
        children: [baseSpan({ spanId: 'tool', parentSpanId: 'agent', attributes: { 'gen_ai.tool.name': 'search' } })],
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(s.totalTokens).toBe(15);
    expect(s.peakInputTokens).toBe(10);
  });

  it('falls back to legacy prompt_tokens / completion_tokens attribute names', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'root',
        attributes: {
          // legacy / pre-OTel-rename naming
          'gen_ai.usage.prompt_tokens': 10,
          'gen_ai.usage.completion_tokens': 20,
        },
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(s.inputTokens).toBe(10);
    expect(s.outputTokens).toBe(20);
    expect(s.totalTokens).toBe(30);
  });

  it('collects deduplicated model names from gen_ai.request.model / response.model / model', () => {
    const tree: Span[] = [
      baseSpan({
        spanId: 'root',
        children: [
          baseSpan({ attributes: { 'gen_ai.request.model': 'claude-haiku' } }),
          baseSpan({ attributes: { 'gen_ai.request.model': 'claude-haiku' } }), // dup
          baseSpan({ attributes: { 'gen_ai.response.model': 'claude-sonnet' } }),
          baseSpan({ attributes: { model: 'gpt-4o' } }),
        ],
      }),
    ];
    const s = computeTraceSummary(tree);
    expect(new Set(s.models)).toEqual(new Set(['claude-haiku', 'claude-sonnet', 'gpt-4o']));
  });

  it('ignores blank / whitespace-only model strings', () => {
    const tree: Span[] = [
      baseSpan({
        attributes: { 'gen_ai.request.model': '   ' },
      }),
    ];
    expect(computeTraceSummary(tree).models).toEqual([]);
  });
});

describe('isEmptyTraceSummary', () => {
  it('is false when any signal is non-zero', () => {
    expect(
      isEmptyTraceSummary({
        llm: 0,
        tool: 0,
        agent: 0,
        evalCount: 0,
        errors: 0,
        inputTokens: 5,
        outputTokens: 0,
        totalTokens: 5,
        models: [],
      })
    ).toBe(false);
  });

  it('is true when all signals are zero / empty', () => {
    expect(
      isEmptyTraceSummary({
        llm: 0,
        tool: 0,
        agent: 0,
        evalCount: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        models: [],
      })
    ).toBe(true);
  });
});
