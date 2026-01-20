/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for traceStats.ts - trace statistics utilities
 */

import { CategorizedSpan, SpanCategory } from '@/types';
import {
  extractToolName,
  flattenSpans,
  calculateCategoryStats,
  extractToolStats,
} from '@/services/traces/traceStats';

// Helper to create test spans
function createSpan(
  overrides: Partial<CategorizedSpan> & { spanId: string; category: SpanCategory }
): CategorizedSpan {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    displayName: overrides.displayName || overrides.name || 'test-span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    duration: overrides.duration ?? 1000,
    status: 'OK',
    category: overrides.category,
    categoryLabel: overrides.category,
    categoryColor: '#888888',
    categoryIcon: 'circle',
    attributes: overrides.attributes || {},
    children: overrides.children,
    ...overrides,
  };
}

describe('extractToolName', () => {
  it('extracts tool name from gen_ai.tool.name attribute', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'SearchDocs' },
    });
    expect(extractToolName(span)).toBe('SearchDocs');
  });

  it('extracts tool name from execute_tool pattern', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'execute_tool SearchDocs',
    });
    expect(extractToolName(span)).toBe('SearchDocs');
  });

  it('extracts tool name from executeTools pattern', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'executeTools, SearchDocs',
    });
    expect(extractToolName(span)).toBe('SearchDocs');
  });

  it('extracts tool name from tool.execute pattern', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'tool.execute SearchDocs',
    });
    expect(extractToolName(span)).toBe('SearchDocs');
  });

  it('extracts tool name from comma-separated format', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'some_prefix, MyTool',
    });
    expect(extractToolName(span)).toBe('MyTool');
  });

  it('uses displayName when available', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'some_span',
      displayName: 'execute_tool GetMetrics',
    });
    expect(extractToolName(span)).toBe('GetMetrics');
  });

  it('returns null when no tool name pattern matches', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'random_span_name',
    });
    expect(extractToolName(span)).toBeNull();
  });

  it('ignores agent.node in comma-separated format', () => {
    const span = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'prefix, agent.node.process',
    });
    expect(extractToolName(span)).toBeNull();
  });
});

describe('flattenSpans', () => {
  it('returns empty array for empty input', () => {
    expect(flattenSpans([])).toEqual([]);
  });

  it('flattens single level spans', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM' }),
      createSpan({ spanId: '2', category: 'TOOL' }),
    ];
    const result = flattenSpans(spans);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.spanId)).toEqual(['1', '2']);
  });

  it('flattens nested spans', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'AGENT',
        children: [
          createSpan({
            spanId: '1.1',
            category: 'LLM',
            children: [
              createSpan({ spanId: '1.1.1', category: 'OTHER' }),
            ],
          }),
          createSpan({ spanId: '1.2', category: 'TOOL' }),
        ],
      }),
      createSpan({ spanId: '2', category: 'TOOL' }),
    ];

    const result = flattenSpans(spans);
    expect(result).toHaveLength(5);
    expect(result.map(s => s.spanId)).toEqual(['1', '1.1', '1.1.1', '1.2', '2']);
  });

  it('handles spans without children', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', children: undefined }),
      createSpan({ spanId: '2', category: 'TOOL', children: [] }),
    ];
    const result = flattenSpans(spans);
    expect(result).toHaveLength(2);
  });
});

describe('calculateCategoryStats', () => {
  it('returns empty array for empty input', () => {
    expect(calculateCategoryStats([], 1000)).toEqual([]);
  });

  it('calculates stats for single category', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', duration: 500 }),
      createSpan({ spanId: '2', category: 'LLM', duration: 300 }),
    ];

    const result = calculateCategoryStats(spans, 1000);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      category: 'LLM',
      count: 2,
      totalDuration: 800,
      percentage: 100,
    });
  });

  it('calculates stats for multiple categories', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', duration: 600 }),
      createSpan({ spanId: '2', category: 'TOOL', duration: 300 }),
      createSpan({ spanId: '3', category: 'TOOL', duration: 100 }),
    ];

    const result = calculateCategoryStats(spans, 1000);
    expect(result).toHaveLength(2);

    // Sorted by duration descending
    expect(result[0].category).toBe('LLM');
    expect(result[0].count).toBe(1);
    expect(result[0].totalDuration).toBe(600);
    expect(result[0].percentage).toBe(60);

    expect(result[1].category).toBe('TOOL');
    expect(result[1].count).toBe(2);
    expect(result[1].totalDuration).toBe(400);
    expect(result[1].percentage).toBe(40);
  });

  it('handles spans with zero duration', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', duration: 0 }),
    ];

    const result = calculateCategoryStats(spans, 1000);
    expect(result).toHaveLength(1);
    expect(result[0].percentage).toBe(0);
  });

  it('handles undefined duration', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', duration: undefined as unknown as number }),
    ];

    const result = calculateCategoryStats(spans, 1000);
    expect(result).toHaveLength(1);
    expect(result[0].totalDuration).toBe(0);
  });
});

describe('extractToolStats', () => {
  it('returns empty array for empty input', () => {
    expect(extractToolStats([])).toEqual([]);
  });

  it('returns empty array when no TOOL category spans', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', duration: 500 }),
      createSpan({ spanId: '2', category: 'AGENT', duration: 300 }),
    ];
    expect(extractToolStats(spans)).toEqual([]);
  });

  it('extracts tool stats from TOOL category spans', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        duration: 100,
        attributes: { 'gen_ai.tool.name': 'SearchDocs' },
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        duration: 200,
        attributes: { 'gen_ai.tool.name': 'SearchDocs' },
      }),
      createSpan({
        spanId: '3',
        category: 'TOOL',
        duration: 150,
        attributes: { 'gen_ai.tool.name': 'GetMetrics' },
      }),
    ];

    const result = extractToolStats(spans);
    expect(result).toHaveLength(2);

    // Sorted by count descending
    expect(result[0]).toEqual({
      name: 'SearchDocs',
      count: 2,
      totalDuration: 300,
    });
    expect(result[1]).toEqual({
      name: 'GetMetrics',
      count: 1,
      totalDuration: 150,
    });
  });

  it('ignores TOOL spans without extractable tool name', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        name: 'random_span',
        duration: 100,
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        duration: 200,
        attributes: { 'gen_ai.tool.name': 'SearchDocs' },
      }),
    ];

    const result = extractToolStats(spans);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('SearchDocs');
  });

  it('ignores non-TOOL category spans even with tool attributes', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'LLM',
        duration: 100,
        attributes: { 'gen_ai.tool.name': 'SearchDocs' },
      }),
    ];

    const result = extractToolStats(spans);
    expect(result).toHaveLength(0);
  });
});
