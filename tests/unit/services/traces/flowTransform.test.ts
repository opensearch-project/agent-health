/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for flowTransform.ts - flow transformation utilities
 *
 * Note: applyDagreLayout is not tested here as it depends on the dagre library
 * which requires complex mocking. The function is tested through integration tests.
 */

import { CategorizedSpan, SpanCategory, SpanNodeData } from '@/types';
import { Node, Edge } from '@xyflow/react';
import {
  detectParallelExecution,
  countSpansInTree,
  spansToFlow,
  applyDagreLayout,
} from '@/services/traces/flowTransform';

// Helper to create test spans
function createSpan(
  overrides: Partial<CategorizedSpan> & {
    spanId: string;
    category: SpanCategory;
    startTime: string;
    endTime: string;
  }
): CategorizedSpan {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    displayName: overrides.name || 'test-span',
    startTime: overrides.startTime,
    endTime: overrides.endTime,
    duration: new Date(overrides.endTime).getTime() - new Date(overrides.startTime).getTime(),
    status: 'OK',
    category: overrides.category,
    categoryLabel: overrides.category,
    categoryColor: '#888888',
    categoryIcon: 'circle',
    attributes: overrides.attributes || {},
    children: overrides.children,
  };
}

describe('detectParallelExecution', () => {
  it('returns empty array for empty input', () => {
    expect(detectParallelExecution([])).toEqual([]);
  });

  it('returns empty array for single span', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
    ];
    expect(detectParallelExecution(spans)).toEqual([]);
  });

  it('detects overlapping spans as parallel', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:02Z',
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:03Z',
      }),
    ];

    const result = detectParallelExecution(spans);
    expect(result).toHaveLength(1);
    expect(result[0].spans.map(s => s.spanId)).toContain('1');
    expect(result[0].spans.map(s => s.spanId)).toContain('2');
  });

  it('does not detect sequential spans as parallel', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:02Z',
        endTime: '2024-01-01T00:00:03Z',
      }),
    ];

    const result = detectParallelExecution(spans);
    expect(result).toHaveLength(0);
  });

  it('detects multiple parallel groups', () => {
    const spans = [
      // First parallel group
      createSpan({
        spanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:02Z',
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:02Z',
      }),
      // Sequential gap
      createSpan({
        spanId: '3',
        category: 'LLM',
        startTime: '2024-01-01T00:00:05Z',
        endTime: '2024-01-01T00:00:06Z',
      }),
      // Second parallel group
      createSpan({
        spanId: '4',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:10Z',
        endTime: '2024-01-01T00:00:12Z',
      }),
      createSpan({
        spanId: '5',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:11Z',
        endTime: '2024-01-01T00:00:13Z',
      }),
    ];

    const result = detectParallelExecution(spans);
    expect(result).toHaveLength(2);
    expect(result[0].spans.map(s => s.spanId).sort()).toEqual(['1', '2']);
    expect(result[1].spans.map(s => s.spanId).sort()).toEqual(['4', '5']);
  });

  it('sorts spans by start time before detecting', () => {
    const spans = [
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:03Z',
      }),
      createSpan({
        spanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:02Z',
      }),
    ];

    const result = detectParallelExecution(spans);
    expect(result).toHaveLength(1);
    // First span in group should be the one that started first
    expect(result[0].spans[0].spanId).toBe('1');
  });

  it('groups three or more parallel spans together', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:04Z',
      }),
      createSpan({
        spanId: '3',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:02Z',
        endTime: '2024-01-01T00:00:03Z',
      }),
    ];

    const result = detectParallelExecution(spans);
    expect(result).toHaveLength(1);
    expect(result[0].spans).toHaveLength(3);
  });
});

describe('countSpansInTree', () => {
  it('returns 0 for empty array', () => {
    expect(countSpansInTree([])).toBe(0);
  });

  it('counts single span', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
    ];
    expect(countSpansInTree(spans)).toBe(1);
  });

  it('counts multiple root spans', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
      createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:02Z',
      }),
    ];
    expect(countSpansInTree(spans)).toBe(2);
  });

  it('counts nested spans', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
        children: [
          createSpan({
            spanId: '1.1',
            category: 'LLM',
            startTime: '2024-01-01T00:00:01Z',
            endTime: '2024-01-01T00:00:02Z',
          }),
          createSpan({
            spanId: '1.2',
            category: 'TOOL',
            startTime: '2024-01-01T00:00:02Z',
            endTime: '2024-01-01T00:00:03Z',
            children: [
              createSpan({
                spanId: '1.2.1',
                category: 'OTHER',
                startTime: '2024-01-01T00:00:02Z',
                endTime: '2024-01-01T00:00:03Z',
              }),
            ],
          }),
        ],
      }),
    ];
    expect(countSpansInTree(spans)).toBe(4);
  });

  it('handles spans without children', () => {
    const spans = [
      createSpan({
        spanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
        children: undefined,
      }),
    ];
    expect(countSpansInTree(spans)).toBe(1);
  });
});

describe('spansToFlow', () => {
  it('returns empty result for empty spans', () => {
    const result = spansToFlow([], 1000);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('transforms single span to single node in hierarchy mode', () => {
    const spans = [
      createSpan({
        spanId: 'root',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
    ];
    const result = spansToFlow(spans, 1000, { mode: 'hierarchy' });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('root');
    expect(result.edges).toHaveLength(0);
  });

  it('uses execution-order mode by default', () => {
    const spans = [
      createSpan({
        spanId: 'root',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
    ];
    const result = spansToFlow(spans, 1000);

    expect(result.nodes).toBeDefined();
    expect(result.edges).toBeDefined();
  });

  it('creates parent-child edges in hierarchy mode', () => {
    const spans = [
      createSpan({
        spanId: 'parent',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
        children: [
          createSpan({
            spanId: 'child',
            category: 'LLM',
            startTime: '2024-01-01T00:00:01Z',
            endTime: '2024-01-01T00:00:02Z',
          }),
        ],
      }),
    ];
    const result = spansToFlow(spans, 5000, { mode: 'hierarchy' });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source).toBe('parent');
    expect(result.edges[0].target).toBe('child');
  });

  it('marks parallel edges with animation in hierarchy mode', () => {
    const spans = [
      createSpan({
        spanId: 'parent',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
        children: [
          createSpan({
            spanId: 'child1',
            category: 'TOOL',
            startTime: '2024-01-01T00:00:00Z',
            endTime: '2024-01-01T00:00:02Z',
          }),
          createSpan({
            spanId: 'child2',
            category: 'TOOL',
            startTime: '2024-01-01T00:00:00.500Z',
            endTime: '2024-01-01T00:00:02.500Z',
          }),
        ],
      }),
    ];
    const result = spansToFlow(spans, 5000, { mode: 'hierarchy' });

    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    // Both edges should be animated since children are parallel
    expect(result.edges.filter(e => e.animated).length).toBe(2);
  });

  it('handles deeply nested spans in hierarchy mode', () => {
    const spans = [
      createSpan({
        spanId: 'root',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        children: [
          createSpan({
            spanId: 'child',
            category: 'LLM',
            startTime: '2024-01-01T00:00:01Z',
            endTime: '2024-01-01T00:00:05Z',
            children: [
              createSpan({
                spanId: 'grandchild',
                category: 'TOOL',
                startTime: '2024-01-01T00:00:02Z',
                endTime: '2024-01-01T00:00:03Z',
              }),
            ],
          }),
        ],
      }),
    ];
    const result = spansToFlow(spans, 10000, { mode: 'hierarchy' });

    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
  });

  it('applies custom node dimensions', () => {
    const spans = [
      createSpan({
        spanId: 'root',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
    ];
    const result = spansToFlow(spans, 1000, {
      mode: 'hierarchy',
      nodeWidth: 300,
      nodeHeight: 100,
    });

    expect(result.nodes[0].style?.width).toBe(300);
    expect(result.nodes[0].style?.height).toBe(100);
  });

  it('includes span and totalDuration in node data', () => {
    const spans = [
      createSpan({
        spanId: 'root',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
    ];
    const result = spansToFlow(spans, 5000, { mode: 'hierarchy' });

    const nodeData = result.nodes[0].data as SpanNodeData;
    expect(nodeData.span.spanId).toBe('root');
    expect(nodeData.totalDuration).toBe(5000);
  });

  it('handles multiple root spans', () => {
    const spans = [
      createSpan({
        spanId: 'root1',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:01Z',
      }),
      createSpan({
        spanId: 'root2',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:02Z',
        endTime: '2024-01-01T00:00:03Z',
      }),
    ];
    const result = spansToFlow(spans, 3000, { mode: 'hierarchy' });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(0);
  });
});

describe('applyDagreLayout', () => {
  // Helper to create mock nodes
  function createNode(id: string): Node<SpanNodeData> {
    return {
      id,
      type: 'agent',
      data: {
        span: createSpan({
          spanId: id,
          category: 'AGENT',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
        }),
        totalDuration: 1000,
      },
      position: { x: 0, y: 0 },
    };
  }

  it('returns empty result for empty input', () => {
    const result = applyDagreLayout([], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('positions nodes using dagre layout', () => {
    const nodes = [createNode('node1'), createNode('node2')];
    const edges: Edge[] = [{ id: 'e1', source: 'node1', target: 'node2' }];

    const result = applyDagreLayout(nodes, edges);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    // Verify layout was applied (positions are calculated)
    expect(result.nodes[0].position).toBeDefined();
    expect(result.nodes[1].position).toBeDefined();
    expect(typeof result.nodes[0].position.x).toBe('number');
    expect(typeof result.nodes[0].position.y).toBe('number');
  });

  it('applies LR direction', () => {
    const nodes = [createNode('node1'), createNode('node2')];
    const edges: Edge[] = [{ id: 'e1', source: 'node1', target: 'node2' }];

    const result = applyDagreLayout(nodes, edges, { direction: 'LR' });

    // Verify layout was applied
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].position).toBeDefined();
    expect(result.nodes[1].position).toBeDefined();
  });

  it('preserves edge properties', () => {
    const nodes = [createNode('node1'), createNode('node2')];
    const edges: Edge[] = [
      {
        id: 'e1',
        source: 'node1',
        target: 'node2',
        animated: true,
        style: { stroke: '#ff0000' },
      },
    ];

    const result = applyDagreLayout(nodes, edges);

    expect(result.edges[0].animated).toBe(true);
    expect(result.edges[0].style?.stroke).toBe('#ff0000');
  });

  it('applies custom spacing options', () => {
    const nodes = [createNode('node1'), createNode('node2')];
    const edges: Edge[] = [{ id: 'e1', source: 'node1', target: 'node2' }];

    const result = applyDagreLayout(nodes, edges, {
      nodeSpacingX: 100,
      nodeSpacingY: 200,
      nodeWidth: 250,
      nodeHeight: 90,
    });

    expect(result.nodes).toHaveLength(2);
  });

  it('handles disconnected nodes', () => {
    const nodes = [createNode('node1'), createNode('node2'), createNode('node3')];
    const edges: Edge[] = []; // No edges

    const result = applyDagreLayout(nodes, edges);

    expect(result.nodes).toHaveLength(3);
  });

  it('handles complex graph with multiple edges', () => {
    const nodes = [
      createNode('root'),
      createNode('child1'),
      createNode('child2'),
      createNode('grandchild'),
    ];
    const edges: Edge[] = [
      { id: 'e1', source: 'root', target: 'child1' },
      { id: 'e2', source: 'root', target: 'child2' },
      { id: 'e3', source: 'child1', target: 'grandchild' },
    ];

    const result = applyDagreLayout(nodes, edges);

    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
    // Verify all nodes have positions
    result.nodes.forEach(node => {
      expect(node.position).toBeDefined();
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    });
  });
});
