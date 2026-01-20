/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for traceGrouping utilities
 */

import { groupSpansByTrace, getSpansForTrace } from '@/services/traces/traceGrouping';
import type { Span } from '@/types';

describe('groupSpansByTrace', () => {
  const createSpan = (overrides: Partial<Span> = {}): Span => ({
    traceId: 'trace-1',
    spanId: `span-${Math.random().toString(36).slice(2)}`,
    parentSpanId: undefined,
    name: 'test-span',
    startTime: '2024-01-15T10:00:00.000Z',
    endTime: '2024-01-15T10:00:01.000Z',
    duration: 1000,
    status: 'OK',
    attributes: {},
    events: [],
    ...overrides,
  });

  it('returns empty array for null or empty input', () => {
    expect(groupSpansByTrace(null as any)).toEqual([]);
    expect(groupSpansByTrace([])).toEqual([]);
  });

  it('groups spans by traceId', () => {
    const spans = [
      createSpan({ traceId: 'trace-1', spanId: 'span-1' }),
      createSpan({ traceId: 'trace-1', spanId: 'span-2', parentSpanId: 'span-1' }),
      createSpan({ traceId: 'trace-2', spanId: 'span-3' }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result).toHaveLength(2);
    expect(result.find(t => t.traceId === 'trace-1')?.spanCount).toBe(2);
    expect(result.find(t => t.traceId === 'trace-2')?.spanCount).toBe(1);
  });

  it('extracts service name from root span', () => {
    const spans = [
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        attributes: { 'service.name': 'my-service' },
      }),
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-2',
        parentSpanId: 'span-1',
        attributes: { 'service.name': 'other-service' },
      }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].serviceName).toBe('my-service');
  });

  it('falls back to gen_ai.system for service name', () => {
    const spans = [
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        attributes: { 'gen_ai.system': 'bedrock' },
      }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].serviceName).toBe('bedrock');
  });

  it('uses "unknown" when no service name available', () => {
    const spans = [
      createSpan({ traceId: 'trace-1', spanId: 'span-1', attributes: {} }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].serviceName).toBe('unknown');
  });

  it('uses root span name for rootSpanName', () => {
    const spans = [
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'root-operation',
      }),
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-2',
        parentSpanId: 'span-1',
        name: 'child-operation',
      }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].rootSpanName).toBe('root-operation');
  });

  it('falls back to first span name when no root span', () => {
    // All spans have parents (orphaned spans scenario)
    const spans = [
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        parentSpanId: 'missing-parent',
        name: 'first-span',
      }),
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-2',
        parentSpanId: 'span-1',
        name: 'second-span',
      }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].rootSpanName).toBe('first-span');
  });

  it('calculates duration as maxEnd - minStart', () => {
    const spans = [
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-1',
        startTime: '2024-01-15T10:00:00.000Z',
        endTime: '2024-01-15T10:00:02.000Z',
      }),
      createSpan({
        traceId: 'trace-1',
        spanId: 'span-2',
        parentSpanId: 'span-1',
        startTime: '2024-01-15T10:00:01.000Z',
        endTime: '2024-01-15T10:00:05.000Z',
      }),
    ];

    const result = groupSpansByTrace(spans);

    // Duration should be from 10:00:00 to 10:00:05 = 5000ms
    expect(result[0].duration).toBe(5000);
  });

  it('detects errors in trace', () => {
    const spansWithError = [
      createSpan({ traceId: 'trace-1', spanId: 'span-1', status: 'OK' }),
      createSpan({ traceId: 'trace-1', spanId: 'span-2', parentSpanId: 'span-1', status: 'ERROR' }),
    ];

    const spansWithoutError = [
      createSpan({ traceId: 'trace-2', spanId: 'span-3', status: 'OK' }),
    ];

    const result = groupSpansByTrace([...spansWithError, ...spansWithoutError]);

    expect(result.find(t => t.traceId === 'trace-1')?.hasErrors).toBe(true);
    expect(result.find(t => t.traceId === 'trace-2')?.hasErrors).toBe(false);
  });

  it('sorts traces by startTime descending (newest first)', () => {
    const spans = [
      createSpan({ traceId: 'trace-old', spanId: 'span-1', startTime: '2024-01-01T10:00:00.000Z' }),
      createSpan({ traceId: 'trace-new', spanId: 'span-2', startTime: '2024-01-15T10:00:00.000Z' }),
      createSpan({ traceId: 'trace-mid', spanId: 'span-3', startTime: '2024-01-10T10:00:00.000Z' }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].traceId).toBe('trace-new');
    expect(result[1].traceId).toBe('trace-mid');
    expect(result[2].traceId).toBe('trace-old');
  });

  it('includes original spans in result', () => {
    const spans = [
      createSpan({ traceId: 'trace-1', spanId: 'span-1' }),
      createSpan({ traceId: 'trace-1', spanId: 'span-2', parentSpanId: 'span-1' }),
    ];

    const result = groupSpansByTrace(spans);

    expect(result[0].spans).toHaveLength(2);
    expect(result[0].spans.map(s => s.spanId)).toContain('span-1');
    expect(result[0].spans.map(s => s.spanId)).toContain('span-2');
  });
});

describe('getSpansForTrace', () => {
  const createSummary = (traceId: string, spans: Span[]) => ({
    traceId,
    serviceName: 'test',
    spanCount: spans.length,
    rootSpanName: 'root',
    startTime: '2024-01-15T10:00:00.000Z',
    duration: 1000,
    hasErrors: false,
    spans,
  });

  it('returns spans for matching traceId', () => {
    const spans1: Span[] = [
      { traceId: 't1', spanId: 's1', name: 'test' } as Span,
    ];
    const spans2: Span[] = [
      { traceId: 't2', spanId: 's2', name: 'test' } as Span,
    ];

    const summaries = [
      createSummary('t1', spans1),
      createSummary('t2', spans2),
    ];

    const result = getSpansForTrace(summaries, 't1');

    expect(result).toBe(spans1);
  });

  it('returns empty array when traceId not found', () => {
    const summaries = [
      createSummary('t1', []),
    ];

    const result = getSpansForTrace(summaries, 'non-existent');

    expect(result).toEqual([]);
  });

  it('returns empty array for empty summaries', () => {
    const result = getSpansForTrace([], 't1');

    expect(result).toEqual([]);
  });
});
