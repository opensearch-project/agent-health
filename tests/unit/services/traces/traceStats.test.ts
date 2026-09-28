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
  calculateSelfDurations,
  type CategoryStats,
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
      selfDuration: 800,
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

  it('derives duration from timestamps when the duration field is missing', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM', duration: undefined as unknown as number }),
    ];

    const result = calculateCategoryStats(spans, 1000);
    expect(result).toHaveLength(1);
    // createSpan's default timestamps are 1s apart.
    expect(result[0].totalDuration).toBe(1000);
    expect(result[0].selfDuration).toBe(1000);
  });

  it('treats a span with neither duration nor usable timestamps as 0', () => {
    const spans = [
      createSpan({
        spanId: '1', category: 'LLM',
        duration: undefined as unknown as number,
        startTime: 'not-a-date', endTime: 'not-a-date',
      }),
    ];

    const result = calculateCategoryStats(spans, 1000);
    expect(result).toHaveLength(1);
    expect(result[0].totalDuration).toBe(0);
    expect(result[0].selfDuration).toBe(0);
    expect(result[0].percentage).toBe(0);
  });
});

describe('calculateCategoryStats — self time (nested spans are not double-counted)', () => {
  const T0 = Date.parse('2024-01-01T00:00:00.000Z');
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
  const timed = (
    spanId: string, category: SpanCategory, start: number, end: number, parentSpanId?: string,
  ) => createSpan({
    spanId, category, parentSpanId,
    startTime: iso(start), endTime: iso(end), duration: end - start,
  });

  const byCategory = (stats: CategoryStats[]) =>
    Object.fromEntries(stats.map(s => [s.category, s])) as Record<string, CategoryStats>;

  it('nested chain: agent > llm > tool attributes each level only its own self time', () => {
    // AGENT 0-1000 wraps LLM 100-700 which wraps TOOL 200-400.
    const spans = [
      timed('agent', 'AGENT', 0, 1000),
      timed('llm', 'LLM', 100, 700, 'agent'),
      timed('tool', 'TOOL', 200, 400, 'llm'),
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    expect(stats.AGENT.selfDuration).toBe(400);  // 1000 - 600
    expect(stats.LLM.selfDuration).toBe(400);    // 600 - 200
    expect(stats.TOOL.selfDuration).toBe(200);
    // Inclusive numbers are preserved for callers that want them.
    expect(stats.AGENT.totalDuration).toBe(1000);
    expect(stats.LLM.totalDuration).toBe(600);
    expect(stats.TOOL.totalDuration).toBe(200);
    // Shares are of self time: 40 / 40 / 20, summing to 100.
    expect(stats.AGENT.percentage).toBeCloseTo(40);
    expect(stats.LLM.percentage).toBeCloseTo(40);
    expect(stats.TOOL.percentage).toBeCloseTo(20);
    const sum = Object.values(stats).reduce((acc, s) => acc + s.percentage, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it('wrapper spans whose children cover them fully have zero self time', () => {
    // Real-world shape: an agent loop-cycle span containing one LLM call and one
    // tool call back to back. Inclusive summing would give AGENT 50% here.
    const spans = [
      timed('cycle', 'AGENT', 0, 1000),
      timed('chat', 'LLM', 0, 800, 'cycle'),
      timed('tool', 'TOOL', 800, 1000, 'cycle'),
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    expect(stats.AGENT.selfDuration).toBe(0);
    expect(stats.AGENT.percentage).toBe(0);
    expect(stats.LLM.percentage).toBeCloseTo(80);
    expect(stats.TOOL.percentage).toBeCloseTo(20);
  });

  it('overlapping siblings are subtracted as an interval union, not a naive sum', () => {
    // Two concurrent tool calls 100-600 and 300-800 under a 0-1000 parent.
    // Union covers 100-800 = 700 → parent self = 300 (a naive sum of 500+500
    // would clamp the parent to 0).
    const spans = [
      timed('parent', 'AGENT', 0, 1000),
      timed('t1', 'TOOL', 100, 600, 'parent'),
      timed('t2', 'TOOL', 300, 800, 'parent'),
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    expect(stats.AGENT.selfDuration).toBe(300);
    expect(stats.TOOL.selfDuration).toBe(1000);
    expect(stats.TOOL.totalDuration).toBe(1000);
  });

  it('children extending past their parent are clipped and self time never goes negative', () => {
    // Child 500-1500 under parent 0-1000 (clock skew): only 500ms of the
    // child falls inside the parent.
    const spans = [
      timed('parent', 'AGENT', 0, 1000),
      timed('child', 'LLM', 500, 1500, 'parent'),
      // Pathological: child claims more than the parent's whole window.
      timed('p2', 'AGENT', 2000, 2100),
      timed('c2', 'LLM', 1900, 2300, 'p2'),
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    for (const s of Object.values(stats)) expect(s.selfDuration).toBeGreaterThanOrEqual(0);
    // parent: 1000 - 500 = 500; p2: 100 - 100 = 0
    expect(stats.AGENT.selfDuration).toBe(500);
  });

  it('an orphan child (parent not in the list) contributes its full self time', () => {
    const spans = [
      timed('orphan', 'LLM', 0, 500, 'missing-parent'),
      timed('root', 'TOOL', 0, 500),
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    expect(stats.LLM.selfDuration).toBe(500);
    expect(stats.TOOL.selfDuration).toBe(500);
    expect(stats.LLM.percentage).toBeCloseTo(50);
  });

  it('only subtracts children from the SAME trace', () => {
    const spans = [
      timed('p', 'AGENT', 0, 1000),
      { ...timed('c', 'LLM', 0, 1000, 'p'), traceId: 'other-trace' },
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    // The child belongs to a different trace, so it is not this parent's child.
    expect(stats.AGENT.selfDuration).toBe(1000);
  });

  it('zero-duration spans contribute nothing and do not break shares', () => {
    const spans = [
      timed('p', 'AGENT', 0, 1000),
      timed('z', 'TOOL', 500, 500, 'p'),
      timed('llm', 'LLM', 0, 250, 'p'),
    ];

    const stats = byCategory(calculateCategoryStats(spans));
    expect(stats.TOOL.selfDuration).toBe(0);
    expect(stats.TOOL.percentage).toBe(0);
    expect(stats.AGENT.selfDuration).toBe(750);
    expect(stats.AGENT.percentage).toBeCloseTo(75);
    expect(stats.LLM.percentage).toBeCloseTo(25);
  });

  it('percentages sum to 100 (± rounding) on a deeper mixed tree', () => {
    const spans = [
      timed('root', 'AGENT', 0, 10000),
      timed('cycle1', 'AGENT', 0, 5000, 'root'),
      timed('chat1', 'LLM', 0, 3000, 'cycle1'),
      timed('tool1', 'TOOL', 3000, 4500, 'cycle1'),
      timed('search1', 'OTHER', 3100, 4400, 'tool1'),
      timed('cycle2', 'AGENT', 5000, 10000, 'root'),
      timed('chat2', 'LLM', 5000, 9000, 'cycle2'),
      timed('chat2b', 'LLM', 9000, 9500, 'cycle2'),
    ];

    const stats = calculateCategoryStats(spans);
    const sum = stats.reduce((acc, s) => acc + s.percentage, 0);
    expect(sum).toBeCloseTo(100, 6);
    const totalSelf = stats.reduce((acc, s) => acc + s.selfDuration, 0);
    // Self times partition the root's wall-clock exactly (no gaps in this tree).
    expect(totalSelf).toBe(10000);
    // Sorted by self time descending.
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i - 1].selfDuration).toBeGreaterThanOrEqual(stats[i].selfDuration);
    }
  });

  it('calculateSelfDurations exposes per-span self time', () => {
    const spans = [
      timed('p', 'AGENT', 0, 1000),
      timed('c', 'LLM', 250, 750, 'p'),
    ];
    const self = calculateSelfDurations(spans);
    expect(self.get(spans[0])).toBe(500);
    expect(self.get(spans[1])).toBe(500);
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
