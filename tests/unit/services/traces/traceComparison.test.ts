/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for traceComparison.ts - trace alignment and comparison
 */

import { Span, CategorizedSpan, AlignedSpanPair } from '@/types';
import {
  calculateSpanSimilarity,
  compareTraces,
  flattenAlignedTree,
  getComparisonTypeInfo,
} from '@/services/traces/traceComparison';

// Helper to create test spans
function createSpan(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    startTime: overrides.startTime || '2024-01-01T00:00:00Z',
    endTime: overrides.endTime || '2024-01-01T00:00:01Z',
    duration: 1000,
    status: 'OK',
    attributes: overrides.attributes || {},
    children: overrides.children,
  };
}

function createCategorizedSpan(
  overrides: Partial<CategorizedSpan> & { spanId: string; category: 'AGENT' | 'LLM' | 'TOOL' | 'ERROR' | 'OTHER' }
): CategorizedSpan {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    displayName: overrides.displayName || overrides.name || 'test-span',
    startTime: overrides.startTime || '2024-01-01T00:00:00Z',
    endTime: overrides.endTime || '2024-01-01T00:00:01Z',
    duration: 1000,
    status: 'OK',
    category: overrides.category,
    categoryLabel: overrides.category,
    categoryColor: '#888888',
    categoryIcon: 'circle',
    attributes: overrides.attributes || {},
    children: overrides.children,
  };
}

describe('calculateSpanSimilarity', () => {
  it('returns high similarity for identical spans', () => {
    const span = createCategorizedSpan({
      spanId: '1',
      name: 'test-span',
      category: 'LLM',
      attributes: { 'gen_ai.operation.name': 'chat' },
    });

    const similarity = calculateSpanSimilarity(span, span);
    expect(similarity).toBeGreaterThan(0.7);
  });

  it('returns lower similarity for different categories', () => {
    const left = createCategorizedSpan({ spanId: '1', category: 'LLM' });
    const right = createCategorizedSpan({ spanId: '2', category: 'TOOL' });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeLessThan(0.5);
  });

  it('includes category match weight (0.3)', () => {
    const left = createCategorizedSpan({ spanId: '1', name: 'different', category: 'LLM' });
    const right = createCategorizedSpan({ spanId: '2', name: 'names', category: 'LLM' });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThanOrEqual(0.3);
  });

  it('includes name/operation match weight (0.3)', () => {
    const left = createCategorizedSpan({ spanId: '1', name: 'same-name', category: 'LLM' });
    const right = createCategorizedSpan({ spanId: '2', name: 'same-name', category: 'TOOL' });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThanOrEqual(0.3);
  });

  it('matches on gen_ai.operation.name attribute', () => {
    const left = createCategorizedSpan({
      spanId: '1',
      name: 'different',
      category: 'LLM',
      attributes: { 'gen_ai.operation.name': 'chat' },
    });
    const right = createCategorizedSpan({
      spanId: '2',
      name: 'names',
      category: 'LLM',
      attributes: { 'gen_ai.operation.name': 'chat' },
    });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('adds weight for matching agent name attribute', () => {
    const left = createCategorizedSpan({
      spanId: '1',
      category: 'AGENT',
      attributes: { 'gen_ai.agent.name': 'RCA-Agent' },
    });
    const right = createCategorizedSpan({
      spanId: '2',
      category: 'AGENT',
      attributes: { 'gen_ai.agent.name': 'RCA-Agent' },
    });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThan(0.5);
  });

  it('adds weight for matching model attribute', () => {
    const left = createCategorizedSpan({
      spanId: '1',
      category: 'LLM',
      attributes: { 'gen_ai.request.model': 'claude-v2' },
    });
    const right = createCategorizedSpan({
      spanId: '2',
      category: 'LLM',
      attributes: { 'gen_ai.request.model': 'claude-v2' },
    });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThan(0.5);
  });

  it('includes duration similarity weight', () => {
    const left = createCategorizedSpan({
      spanId: '1',
      category: 'LLM',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z', // 1s
    });
    const right = createCategorizedSpan({
      spanId: '2',
      category: 'LLM',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z', // 1s (same)
    });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThan(0.4);
  });

  it('handles zero duration spans', () => {
    const left = createCategorizedSpan({
      spanId: '1',
      category: 'LLM',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:00Z', // 0 duration
    });
    const right = createCategorizedSpan({
      spanId: '2',
      category: 'LLM',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:00Z',
    });

    const similarity = calculateSpanSimilarity(left, right);
    expect(similarity).toBeGreaterThan(0);
  });

  it('caps similarity at 1.0', () => {
    const span = createCategorizedSpan({
      spanId: '1',
      name: 'test',
      category: 'LLM',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-v2',
      },
    });

    const similarity = calculateSpanSimilarity(span, span);
    expect(similarity).toBeLessThanOrEqual(1);
  });
});

describe('compareTraces', () => {
  it('returns empty result for two empty arrays', () => {
    const result = compareTraces([], []);

    expect(result.alignedTree).toEqual([]);
    expect(result.stats.totalLeft).toBe(0);
    expect(result.stats.totalRight).toBe(0);
  });

  it('marks all spans as added when left is empty', () => {
    const rightSpans = [
      createSpan({ spanId: '1', name: 'span1' }),
      createSpan({ spanId: '2', name: 'span2' }),
    ];

    const result = compareTraces([], rightSpans);

    expect(result.alignedTree).toHaveLength(2);
    expect(result.alignedTree.every(p => p.type === 'added')).toBe(true);
    expect(result.stats.added).toBe(2);
    expect(result.stats.totalRight).toBe(2);
  });

  it('marks all spans as removed when right is empty', () => {
    const leftSpans = [
      createSpan({ spanId: '1', name: 'span1' }),
      createSpan({ spanId: '2', name: 'span2' }),
    ];

    const result = compareTraces(leftSpans, []);

    expect(result.alignedTree).toHaveLength(2);
    expect(result.alignedTree.every(p => p.type === 'removed')).toBe(true);
    expect(result.stats.removed).toBe(2);
    expect(result.stats.totalLeft).toBe(2);
  });

  it('matches identical spans', () => {
    const spans = [
      createSpan({
        spanId: '1',
        name: 'same-span',
        attributes: { 'gen_ai.operation.name': 'chat' },
      }),
    ];

    const result = compareTraces(spans, spans);

    expect(result.alignedTree).toHaveLength(1);
    expect(result.alignedTree[0].type).toBe('matched');
    expect(result.stats.matched).toBe(1);
  });

  it('identifies modified spans', () => {
    const left = [
      createSpan({
        spanId: '1',
        name: 'span1',
        attributes: { 'gen_ai.operation.name': 'chat', custom: 'value1' },
      }),
    ];
    const right = [
      createSpan({
        spanId: '2',
        name: 'span1',
        attributes: { 'gen_ai.operation.name': 'chat', custom: 'value2' },
      }),
    ];

    const result = compareTraces(left, right);

    expect(result.alignedTree).toHaveLength(1);
    expect(['matched', 'modified']).toContain(result.alignedTree[0].type);
  });

  it('handles nested spans', () => {
    const left = [
      createSpan({
        spanId: '1',
        name: 'parent',
        children: [
          createSpan({ spanId: '1.1', name: 'child1' }),
        ],
      }),
    ];
    const right = [
      createSpan({
        spanId: '2',
        name: 'parent',
        children: [
          createSpan({ spanId: '2.1', name: 'child1' }),
        ],
      }),
    ];

    const result = compareTraces(left, right);

    expect(result.alignedTree).toHaveLength(1);
    expect(result.stats.totalLeft).toBe(2);
    expect(result.stats.totalRight).toBe(2);
  });

  it('counts stats correctly for complex trees', () => {
    const left = [
      createSpan({ spanId: '1', name: 'common' }),
      createSpan({ spanId: '2', name: 'left-only' }),
    ];
    const right = [
      createSpan({ spanId: '3', name: 'common' }),
      createSpan({ spanId: '4', name: 'right-only' }),
    ];

    const result = compareTraces(left, right);

    expect(result.stats.totalLeft).toBe(2);
    expect(result.stats.totalRight).toBe(2);
  });
});

describe('flattenAlignedTree', () => {
  it('returns empty array for empty input', () => {
    expect(flattenAlignedTree([])).toEqual([]);
  });

  it('flattens single level pairs', () => {
    const pairs: AlignedSpanPair[] = [
      { type: 'added', rightSpan: createCategorizedSpan({ spanId: '1', category: 'LLM' }) },
      { type: 'removed', leftSpan: createCategorizedSpan({ spanId: '2', category: 'TOOL' }) },
    ];

    const flat = flattenAlignedTree(pairs);
    expect(flat).toHaveLength(2);
  });

  it('flattens nested pairs', () => {
    const pairs: AlignedSpanPair[] = [
      {
        type: 'matched',
        leftSpan: createCategorizedSpan({ spanId: '1', category: 'AGENT' }),
        rightSpan: createCategorizedSpan({ spanId: '2', category: 'AGENT' }),
        children: [
          { type: 'added', rightSpan: createCategorizedSpan({ spanId: '3', category: 'LLM' }) },
        ],
      },
    ];

    const flat = flattenAlignedTree(pairs);
    expect(flat).toHaveLength(2);
    expect(flat[0].type).toBe('matched');
    expect(flat[1].type).toBe('added');
  });

  it('handles deeply nested structures', () => {
    const pairs: AlignedSpanPair[] = [
      {
        type: 'matched',
        leftSpan: createCategorizedSpan({ spanId: '1', category: 'AGENT' }),
        rightSpan: createCategorizedSpan({ spanId: '2', category: 'AGENT' }),
        children: [
          {
            type: 'matched',
            leftSpan: createCategorizedSpan({ spanId: '3', category: 'LLM' }),
            rightSpan: createCategorizedSpan({ spanId: '4', category: 'LLM' }),
            children: [
              { type: 'added', rightSpan: createCategorizedSpan({ spanId: '5', category: 'TOOL' }) },
            ],
          },
        ],
      },
    ];

    const flat = flattenAlignedTree(pairs);
    expect(flat).toHaveLength(3);
  });
});

describe('getComparisonTypeInfo', () => {
  it('returns info for matched type', () => {
    const info = getComparisonTypeInfo('matched');
    expect(info.label).toBe('Matched');
    expect(info.color).toContain('slate');
    expect(info.bgColor).toBeDefined();
    expect(info.borderColor).toBeDefined();
  });

  it('returns info for added type', () => {
    const info = getComparisonTypeInfo('added');
    expect(info.label).toBe('Added');
    expect(info.color).toContain('green');
  });

  it('returns info for removed type', () => {
    const info = getComparisonTypeInfo('removed');
    expect(info.label).toBe('Removed');
    expect(info.color).toContain('red');
  });

  it('returns info for modified type', () => {
    const info = getComparisonTypeInfo('modified');
    expect(info.label).toBe('Modified');
    expect(info.color).toContain('amber');
  });
});
