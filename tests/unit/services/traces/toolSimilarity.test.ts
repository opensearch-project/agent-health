/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for toolSimilarity.ts - tool grouping and similarity utilities
 */

import { CategorizedSpan, SpanCategory, ToolSimilarityConfig } from '@/types';
import {
  extractCommonArgKeys,
  groupToolSpans,
  calculateToolSimilarity,
  getToolGroupStats,
} from '@/services/traces/toolSimilarity';

// Helper to create test spans
function createSpan(
  overrides: Partial<CategorizedSpan> & {
    spanId: string;
    category: SpanCategory;
  }
): CategorizedSpan {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    displayName: overrides.name || 'test-span',
    startTime: overrides.startTime || '2024-01-01T00:00:00Z',
    endTime: overrides.endTime || '2024-01-01T00:00:01Z',
    duration: overrides.duration ?? 1000,
    status: 'OK',
    category: overrides.category,
    categoryLabel: overrides.category,
    categoryColor: '#888888',
    categoryIcon: 'circle',
    attributes: overrides.attributes || {},
    children: overrides.children,
  };
}

describe('extractCommonArgKeys', () => {
  it('returns empty array for empty input', () => {
    expect(extractCommonArgKeys([])).toEqual([]);
  });

  it('returns empty array when no tool spans', () => {
    const spans = [
      createSpan({ spanId: '1', category: 'LLM' }),
      createSpan({ spanId: '2', category: 'AGENT' }),
    ];
    expect(extractCommonArgKeys(spans)).toEqual([]);
  });

  it('extracts keys from gen_ai.tool.args attribute', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.args': JSON.stringify({ query: 'test', limit: 10 }),
        },
      }),
    ];

    const result = extractCommonArgKeys(spans);
    expect(result).toContain('query');
    expect(result).toContain('limit');
  });

  it('extracts keys from gen_ai.tool.input attribute', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.input': JSON.stringify({ index: 'logs', size: 100 }),
        },
      }),
    ];

    const result = extractCommonArgKeys(spans);
    expect(result).toContain('index');
    expect(result).toContain('size');
  });

  it('handles object attributes (not string)', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.args': { key1: 'val1', key2: 'val2' },
        },
      }),
    ];

    const result = extractCommonArgKeys(spans);
    expect(result).toContain('key1');
    expect(result).toContain('key2');
  });

  it('extracts keys from nested tool spans', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'AGENT',
        children: [
          createSpan({
            spanId: '1.1',
            category: 'TOOL',
            attributes: {
              'gen_ai.tool.args': JSON.stringify({ nestedKey: 'value' }),
            },
          }),
        ],
      }),
    ];

    const result = extractCommonArgKeys(spans);
    expect(result).toContain('nestedKey');
  });

  it('deduplicates and sorts keys', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.args': JSON.stringify({ zebra: 1, apple: 2 }),
        },
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.args': JSON.stringify({ apple: 3, banana: 4 }),
        },
      }),
    ];

    const result = extractCommonArgKeys(spans);
    expect(result).toEqual(['apple', 'banana', 'zebra']);
  });

  it('ignores invalid JSON in attributes', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.args': 'not valid json',
        },
      }),
    ];

    expect(extractCommonArgKeys(spans)).toEqual([]);
  });
});

describe('groupToolSpans', () => {
  const defaultConfig: ToolSimilarityConfig = {
    enabled: true,
    keyArguments: ['query'],
  };

  it('returns original spans when config disabled', () => {
    const spans = [createSpan({ spanId: '1', category: 'TOOL' })];
    const config = { enabled: false, keyArguments: ['query'] };

    const result = groupToolSpans(spans, config);
    expect(result.groupedSpans).toEqual(spans);
    expect(result.toolGroups).toEqual([]);
  });

  it('returns original spans when no key arguments', () => {
    const spans = [createSpan({ spanId: '1', category: 'TOOL' })];
    const config = { enabled: true, keyArguments: [] };

    const result = groupToolSpans(spans, config);
    expect(result.groupedSpans).toEqual(spans);
    expect(result.toolGroups).toEqual([]);
  });

  it('groups tool spans by name and key arguments', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        name: 'SearchDocs',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
        attributes: {
          'gen_ai.tool.name': 'SearchDocs',
          'gen_ai.tool.args': JSON.stringify({ query: 'logs' }),
        },
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        name: 'SearchDocs',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:02Z',
        attributes: {
          'gen_ai.tool.name': 'SearchDocs',
          'gen_ai.tool.args': JSON.stringify({ query: 'logs' }),
        },
      }),
      createSpan({
        spanId: '3',
        category: 'TOOL',
        name: 'SearchDocs',
        startTime: '2024-01-01T00:00:02Z',
        endTime: '2024-01-01T00:00:03Z',
        attributes: {
          'gen_ai.tool.name': 'SearchDocs',
          'gen_ai.tool.args': JSON.stringify({ query: 'metrics' }),
        },
      }),
    ];

    const result = groupToolSpans(spans, defaultConfig);

    expect(result.toolGroups).toHaveLength(2);

    const logsGroup = result.toolGroups.find(g => g.keyArgsValues.query === 'logs');
    expect(logsGroup).toBeDefined();
    expect(logsGroup!.count).toBe(2);
    expect(logsGroup!.spans).toHaveLength(2);

    const metricsGroup = result.toolGroups.find(g => g.keyArgsValues.query === 'metrics');
    expect(metricsGroup).toBeDefined();
    expect(metricsGroup!.count).toBe(1);
  });

  it('calculates average duration for groups', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z', // 1000ms
        attributes: {
          'gen_ai.tool.name': 'SearchDocs',
          'gen_ai.tool.args': JSON.stringify({ query: 'test' }),
        },
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:04Z', // 3000ms
        attributes: {
          'gen_ai.tool.name': 'SearchDocs',
          'gen_ai.tool.args': JSON.stringify({ query: 'test' }),
        },
      }),
    ];

    const result = groupToolSpans(spans, defaultConfig);

    expect(result.toolGroups).toHaveLength(1);
    expect(result.toolGroups[0].totalDuration).toBe(4000);
    expect(result.toolGroups[0].avgDuration).toBe(2000);
  });

  it('sorts groups by count descending', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.name': 'ToolA',
          'gen_ai.tool.args': JSON.stringify({ query: 'a' }),
        },
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.name': 'ToolB',
          'gen_ai.tool.args': JSON.stringify({ query: 'b' }),
        },
      }),
      createSpan({
        spanId: '3',
        category: 'TOOL',
        attributes: {
          'gen_ai.tool.name': 'ToolB',
          'gen_ai.tool.args': JSON.stringify({ query: 'b' }),
        },
      }),
    ];

    const result = groupToolSpans(spans, defaultConfig);

    expect(result.toolGroups[0].toolName).toBe('ToolB');
    expect(result.toolGroups[0].count).toBe(2);
    expect(result.toolGroups[1].toolName).toBe('ToolA');
    expect(result.toolGroups[1].count).toBe(1);
  });

  it('processes non-tool spans with children', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'AGENT',
        children: [
          createSpan({
            spanId: '1.1',
            category: 'TOOL',
            attributes: {
              'gen_ai.tool.name': 'SearchDocs',
              'gen_ai.tool.args': JSON.stringify({ query: 'test' }),
            },
          }),
        ],
      }),
    ];

    const result = groupToolSpans(spans, defaultConfig);

    expect(result.toolGroups).toHaveLength(1);
    expect(result.groupedSpans).toHaveLength(1);
    expect(result.groupedSpans[0].children).toHaveLength(1);
  });
});

describe('calculateToolSimilarity', () => {
  const defaultConfig: ToolSimilarityConfig = {
    enabled: true,
    keyArguments: ['query', 'index'],
  };

  it('returns 0 for non-tool spans', () => {
    const left = createSpan({ spanId: '1', category: 'LLM' });
    const right = createSpan({ spanId: '2', category: 'TOOL' });

    expect(calculateToolSimilarity(left, right, defaultConfig)).toBe(0);
  });

  it('returns 0 for different tool names', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'ToolA' },
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'ToolB' },
    });

    expect(calculateToolSimilarity(left, right, defaultConfig)).toBe(0);
  });

  it('returns 1 for same tool name when config disabled', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'ToolA' },
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'ToolA' },
    });

    const config = { enabled: false, keyArguments: ['query'] };
    expect(calculateToolSimilarity(left, right, config)).toBe(1.0);
  });

  it('returns 1 for same tool name with no key arguments', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'ToolA' },
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      attributes: { 'gen_ai.tool.name': 'ToolA' },
    });

    const config = { enabled: true, keyArguments: [] };
    expect(calculateToolSimilarity(left, right, config)).toBe(1.0);
  });

  it('returns 1 for identical key arguments', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.args': JSON.stringify({ query: 'logs', index: 'main' }),
      },
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      attributes: {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.args': JSON.stringify({ query: 'logs', index: 'main' }),
      },
    });

    expect(calculateToolSimilarity(left, right, defaultConfig)).toBe(1.0);
  });

  it('returns 0.5 for half matching key arguments', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.args': JSON.stringify({ query: 'logs', index: 'main' }),
      },
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      attributes: {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.args': JSON.stringify({ query: 'logs', index: 'other' }),
      },
    });

    expect(calculateToolSimilarity(left, right, defaultConfig)).toBe(0.5);
  });

  it('returns 0 for no matching key arguments', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.args': JSON.stringify({ query: 'logs', index: 'main' }),
      },
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      attributes: {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.args': JSON.stringify({ query: 'metrics', index: 'other' }),
      },
    });

    expect(calculateToolSimilarity(left, right, defaultConfig)).toBe(0);
  });

  it('uses span name when no gen_ai.tool.name attribute', () => {
    const left = createSpan({
      spanId: '1',
      category: 'TOOL',
      name: 'SearchDocs',
    });
    const right = createSpan({
      spanId: '2',
      category: 'TOOL',
      name: 'SearchDocs',
    });

    const config = { enabled: true, keyArguments: [] };
    expect(calculateToolSimilarity(left, right, config)).toBe(1.0);
  });
});

describe('getToolGroupStats', () => {
  it('returns zeros for empty array', () => {
    const result = getToolGroupStats([]);

    expect(result.totalTools).toBe(0);
    expect(result.uniqueTools).toBe(0);
    expect(result.mostFrequent).toBeNull();
    expect(result.longestDuration).toBeNull();
  });

  it('calculates stats for single group', () => {
    const groups = [
      {
        toolName: 'SearchDocs',
        keyArgsValues: { query: 'test' },
        spans: [],
        count: 5,
        totalDuration: 1000,
        avgDuration: 200,
      },
    ];

    const result = getToolGroupStats(groups);

    expect(result.totalTools).toBe(5);
    expect(result.uniqueTools).toBe(1);
    expect(result.mostFrequent?.toolName).toBe('SearchDocs');
    expect(result.longestDuration?.toolName).toBe('SearchDocs');
  });

  it('identifies most frequent group (already sorted)', () => {
    const groups = [
      {
        toolName: 'ToolA',
        keyArgsValues: {},
        spans: [],
        count: 10,
        totalDuration: 500,
        avgDuration: 50,
      },
      {
        toolName: 'ToolB',
        keyArgsValues: {},
        spans: [],
        count: 3,
        totalDuration: 1000,
        avgDuration: 333,
      },
    ];

    const result = getToolGroupStats(groups);

    expect(result.mostFrequent?.toolName).toBe('ToolA');
    expect(result.mostFrequent?.count).toBe(10);
  });

  it('identifies longest duration group', () => {
    const groups = [
      {
        toolName: 'ToolA',
        keyArgsValues: {},
        spans: [],
        count: 10,
        totalDuration: 500,
        avgDuration: 50,
      },
      {
        toolName: 'ToolB',
        keyArgsValues: {},
        spans: [],
        count: 3,
        totalDuration: 1000,
        avgDuration: 333,
      },
    ];

    const result = getToolGroupStats(groups);

    expect(result.longestDuration?.toolName).toBe('ToolB');
    expect(result.longestDuration?.totalDuration).toBe(1000);
  });

  it('sums total tools across groups', () => {
    const groups = [
      { toolName: 'A', keyArgsValues: {}, spans: [], count: 5, totalDuration: 100, avgDuration: 20 },
      { toolName: 'B', keyArgsValues: {}, spans: [], count: 3, totalDuration: 200, avgDuration: 66 },
      { toolName: 'C', keyArgsValues: {}, spans: [], count: 2, totalDuration: 150, avgDuration: 75 },
    ];

    const result = getToolGroupStats(groups);

    expect(result.totalTools).toBe(10);
    expect(result.uniqueTools).toBe(3);
  });
});
