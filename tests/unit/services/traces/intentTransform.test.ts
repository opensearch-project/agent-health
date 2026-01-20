/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for Intent Transform Service
 */

import { spansToIntentNodes, getRootContainerSpan } from '@/services/traces/intentTransform';
import { CategorizedSpan, SpanCategory } from '@/types';

/**
 * Helper to create test spans with sensible defaults
 */
function createSpan(overrides: Partial<CategorizedSpan> = {}): CategorizedSpan {
  const category = (overrides.category || 'AGENT') as SpanCategory;
  return {
    spanId: `span-${Math.random().toString(36).substr(2, 9)}`,
    traceId: 'trace-1',
    name: 'test.span',
    displayName: 'Test Span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    duration: 1000,
    status: 'OK',
    attributes: {},
    category,
    categoryLabel: category,
    categoryColor: 'slate',
    categoryIcon: 'Circle',
    children: [],
    ...overrides,
  };
}

describe('spansToIntentNodes', () => {
  it('returns empty array for empty input', () => {
    expect(spansToIntentNodes([])).toEqual([]);
  });

  it('creates single node for single span', () => {
    const spans = [
      createSpan({ category: 'LLM', name: 'llm.call' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].category).toBe('LLM');
    expect(nodes[0].count).toBe(1);
    expect(nodes[0].executionOrder).toBe(0);
    expect(nodes[0].startIndex).toBe(0);
  });

  it('groups consecutive same-category spans', () => {
    const spans = [
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:01Z' }),
      createSpan({ category: 'TOOL', startTime: '2024-01-01T00:00:02Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes).toHaveLength(2);
    expect(nodes[0].category).toBe('LLM');
    expect(nodes[0].count).toBe(2);
    expect(nodes[1].category).toBe('TOOL');
    expect(nodes[1].count).toBe(1);
  });

  it('does NOT group non-consecutive same-category spans', () => {
    const spans = [
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'TOOL', startTime: '2024-01-01T00:00:01Z' }),
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:02Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].category).toBe('LLM');
    expect(nodes[1].category).toBe('TOOL');
    expect(nodes[2].category).toBe('LLM');
  });

  it('preserves execution order', () => {
    const spans = [
      createSpan({ category: 'AGENT', startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:01Z' }),
      createSpan({ category: 'TOOL', startTime: '2024-01-01T00:00:02Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes[0].executionOrder).toBe(0);
    expect(nodes[1].executionOrder).toBe(1);
    expect(nodes[2].executionOrder).toBe(2);
  });

  it('tracks startIndex correctly across groups', () => {
    const spans = [
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:01Z' }),
      createSpan({ category: 'TOOL', startTime: '2024-01-01T00:00:02Z' }),
      createSpan({ category: 'TOOL', startTime: '2024-01-01T00:00:03Z' }),
      createSpan({ category: 'TOOL', startTime: '2024-01-01T00:00:04Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes[0].startIndex).toBe(0); // LLM x2: indices 0-1
    expect(nodes[1].startIndex).toBe(2); // TOOL x3: indices 2-4
  });

  it('skips container spans (agent.run) but includes children', () => {
    const containerSpan = createSpan({
      name: 'agent.run',
      category: 'AGENT',
      startTime: '2024-01-01T00:00:00Z',
      children: [
        createSpan({
          category: 'LLM',
          name: 'bedrock.invoke',
          startTime: '2024-01-01T00:00:01Z'
        }),
      ],
    });

    const nodes = spansToIntentNodes([containerSpan]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].category).toBe('LLM');
  });

  it('handles nested children within container span', () => {
    const containerSpan = createSpan({
      name: 'agent.run',
      category: 'AGENT',
      startTime: '2024-01-01T00:00:00Z',
      children: [
        createSpan({
          category: 'LLM',
          startTime: '2024-01-01T00:00:01Z',
          duration: 5000,
        }),
        createSpan({
          category: 'TOOL',
          startTime: '2024-01-01T00:00:06Z',
          duration: 3000,
        }),
      ],
    });

    const nodes = spansToIntentNodes([containerSpan]);

    expect(nodes).toHaveLength(2);
    expect(nodes[0].category).toBe('LLM');
    expect(nodes[1].category).toBe('TOOL');
  });

  it('calculates totalDuration from all spans in group', () => {
    const spans = [
      createSpan({ category: 'LLM', duration: 1000, startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'LLM', duration: 2000, startTime: '2024-01-01T00:00:01Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes[0].totalDuration).toBe(3000);
  });

  it('handles null/undefined duration gracefully', () => {
    const spans = [
      createSpan({ category: 'LLM', duration: 1000, startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'LLM', duration: undefined as unknown as number, startTime: '2024-01-01T00:00:01Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    // Should not throw, duration should be partial
    expect(nodes[0].totalDuration).toBe(1000);
  });

  it('generates correct displayName for single span', () => {
    const spans = [
      createSpan({ category: 'LLM' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes[0].displayName).toBe('LLM'); // Uses meta.label
  });

  it('generates correct displayName for multiple spans', () => {
    const spans = [
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:00Z' }),
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:01Z' }),
      createSpan({ category: 'LLM', startTime: '2024-01-01T00:00:02Z' }),
    ];

    const nodes = spansToIntentNodes(spans);

    expect(nodes[0].displayName).toBe('LLM ×3');
  });
});

describe('getRootContainerSpan', () => {
  it('returns null for empty tree', () => {
    expect(getRootContainerSpan([])).toBeNull();
  });

  it('returns agent.run span if present', () => {
    const spans = [
      createSpan({ name: 'agent.run', category: 'AGENT' }),
      createSpan({ name: 'other.span', category: 'LLM' }),
    ];

    const root = getRootContainerSpan(spans);

    expect(root?.name).toBe('agent.run');
  });

  it('returns invoke_agent span if present', () => {
    const spans = [
      createSpan({ name: 'invoke_agent', category: 'AGENT' }),
    ];

    const root = getRootContainerSpan(spans);

    expect(root?.name).toBe('invoke_agent');
  });

  it('returns first span if no container found', () => {
    const spans = [
      createSpan({ name: 'llm.call', category: 'LLM' }),
      createSpan({ name: 'tool.execute', category: 'TOOL' }),
    ];

    const root = getRootContainerSpan(spans);

    expect(root?.name).toBe('llm.call');
  });
});
