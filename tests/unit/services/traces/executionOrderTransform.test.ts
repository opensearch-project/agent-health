/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CategorizedSpan, SpanCategory } from '@/types';
import {
  spansToExecutionFlow,
  isContainerSpan,
  findMainFlowSpans,
  sortByStartTime,
} from '@/services/traces/executionOrderTransform';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
} from '@opentelemetry/semantic-conventions/incubating';

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
    traceId: overrides.traceId || 'test-trace',
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
    parentSpanId: overrides.parentSpanId,
  };
}

describe('executionOrderTransform', () => {
  describe('isContainerSpan', () => {
    it('returns true for spans with invoke_agent operation name', () => {
      const span = createSpan({
        spanId: '1',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
        },
      });

      expect(isContainerSpan(span)).toBe(true);
    });

    it('returns true for spans with create_agent operation name', () => {
      const span = createSpan({
        spanId: '1',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
        },
      });

      expect(isContainerSpan(span)).toBe(true);
    });

    it('returns true for spans with agent.run in name', () => {
      const span = createSpan({
        spanId: '1',
        name: 'agent.run.step',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
      });

      expect(isContainerSpan(span)).toBe(true);
    });

    it('returns true for spans with invoke_agent in name', () => {
      const span = createSpan({
        spanId: '1',
        name: 'invoke_agent_operation',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
      });

      expect(isContainerSpan(span)).toBe(true);
    });

    it('returns true for root span covering 90%+ of children duration', () => {
      const span = createSpan({
        spanId: '1',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        children: [
          createSpan({
            spanId: '1.1',
            parentSpanId: '1',
            category: 'LLM',
            startTime: '2024-01-01T00:00:01Z',
            endTime: '2024-01-01T00:00:05Z',
          }),
          createSpan({
            spanId: '1.2',
            parentSpanId: '1',
            category: 'TOOL',
            startTime: '2024-01-01T00:00:06Z',
            endTime: '2024-01-01T00:00:09Z',
          }),
        ],
      });

      expect(isContainerSpan(span)).toBe(true);
    });

    it('returns false for regular span without container indicators', () => {
      const span = createSpan({
        spanId: '1',
        name: 'llm.call',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
      });

      expect(isContainerSpan(span)).toBe(false);
    });

    it('returns false for span with parent (not root)', () => {
      const span = createSpan({
        spanId: '1',
        parentSpanId: 'parent-1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
        children: [
          createSpan({
            spanId: '1.1',
            parentSpanId: '1',
            category: 'TOOL',
            startTime: '2024-01-01T00:00:01Z',
            endTime: '2024-01-01T00:00:04Z',
          }),
          createSpan({
            spanId: '1.2',
            parentSpanId: '1',
            category: 'TOOL',
            startTime: '2024-01-01T00:00:02Z',
            endTime: '2024-01-01T00:00:03Z',
          }),
        ],
      });

      expect(isContainerSpan(span)).toBe(false);
    });
  });

  describe('findMainFlowSpans', () => {
    it('returns children of container root span', () => {
      const child1 = createSpan({
        spanId: '1.1',
        parentSpanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:05Z',
      });
      const child2 = createSpan({
        spanId: '1.2',
        parentSpanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:06Z',
        endTime: '2024-01-01T00:00:09Z',
      });
      const root = createSpan({
        spanId: '1',
        name: 'agent.run',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        children: [child1, child2],
      });

      const result = findMainFlowSpans([root]);
      expect(result).toHaveLength(2);
      expect(result.map(s => s.spanId)).toEqual(['1.1', '1.2']);
    });

    it('returns roots when single root is not a container', () => {
      const root = createSpan({
        spanId: '1',
        name: 'llm.call',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
      });

      const result = findMainFlowSpans([root]);
      expect(result).toHaveLength(1);
      expect(result[0].spanId).toBe('1');
    });

    it('returns all roots when multiple roots exist', () => {
      const root1 = createSpan({
        spanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
      });
      const root2 = createSpan({
        spanId: '2',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:05Z',
        endTime: '2024-01-01T00:00:10Z',
      });

      const result = findMainFlowSpans([root1, root2]);
      expect(result).toHaveLength(2);
      expect(result.map(s => s.spanId).sort()).toEqual(['1', '2']);
    });

    it('returns empty array when container has no children', () => {
      const root = createSpan({
        spanId: '1',
        name: 'agent.run',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        children: undefined,
      });

      const result = findMainFlowSpans([root]);
      expect(result).toEqual([]);
    });
  });

  describe('sortByStartTime', () => {
    it('sorts spans by start time ascending', () => {
      const spans = [
        createSpan({
          spanId: '3',
          category: 'LLM',
          startTime: '2024-01-01T00:00:10Z',
          endTime: '2024-01-01T00:00:15Z',
        }),
        createSpan({
          spanId: '1',
          category: 'LLM',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:05Z',
        }),
        createSpan({
          spanId: '2',
          category: 'TOOL',
          startTime: '2024-01-01T00:00:05Z',
          endTime: '2024-01-01T00:00:10Z',
        }),
      ];

      const sorted = sortByStartTime(spans);
      expect(sorted.map(s => s.spanId)).toEqual(['1', '2', '3']);
    });

    it('does not mutate original array', () => {
      const spans = [
        createSpan({
          spanId: '2',
          category: 'LLM',
          startTime: '2024-01-01T00:00:05Z',
          endTime: '2024-01-01T00:00:10Z',
        }),
        createSpan({
          spanId: '1',
          category: 'LLM',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:05Z',
        }),
      ];

      const original = [...spans];
      sortByStartTime(spans);
      expect(spans.map(s => s.spanId)).toEqual(original.map(s => s.spanId));
    });

    it('handles empty array', () => {
      expect(sortByStartTime([])).toEqual([]);
    });
  });

  describe('spansToExecutionFlow', () => {
    it('returns empty result for empty input', () => {
      const result = spansToExecutionFlow([], 10000);
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it('creates nodes for single span', () => {
      const spans = [
        createSpan({
          spanId: '1',
          category: 'LLM',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:05Z',
        }),
      ];

      const result = spansToExecutionFlow(spans, 5000);
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].id).toBe('1');
      expect(result.nodes[0].type).toBe('llm');
    });

    it('creates sequential edges between siblings', () => {
      const spans = [
        createSpan({
          spanId: '1',
          category: 'LLM',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:05Z',
        }),
        createSpan({
          spanId: '2',
          category: 'TOOL',
          startTime: '2024-01-01T00:00:06Z',
          endTime: '2024-01-01T00:00:10Z',
        }),
      ];

      const result = spansToExecutionFlow(spans, 10000);
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].source).toBe('1');
      expect(result.edges[0].target).toBe('2');
    });

    it('creates parallel edges for overlapping spans', () => {
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
          startTime: '2024-01-01T00:00:02Z',
          endTime: '2024-01-01T00:00:07Z',
        }),
      ];

      const result = spansToExecutionFlow(spans, 7000);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].animated).toBe(true); // Parallel edges are animated
    });

    it('processes children recursively', () => {
      const spans = [
        createSpan({
          spanId: '1',
          category: 'LLM',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:10Z',
          children: [
            createSpan({
              spanId: '1.1',
              parentSpanId: '1',
              category: 'TOOL',
              startTime: '2024-01-01T00:00:02Z',
              endTime: '2024-01-01T00:00:05Z',
            }),
          ],
        }),
      ];

      const result = spansToExecutionFlow(spans, 10000);
      expect(result.nodes).toHaveLength(2); // Parent + child
      expect(result.nodes.map(n => n.id).sort()).toEqual(['1', '1.1']);
    });

    it('skips container root and processes its children as main flow', () => {
      const child1 = createSpan({
        spanId: '1.1',
        parentSpanId: '1',
        category: 'LLM',
        startTime: '2024-01-01T00:00:01Z',
        endTime: '2024-01-01T00:00:05Z',
      });
      const child2 = createSpan({
        spanId: '1.2',
        parentSpanId: '1',
        category: 'TOOL',
        startTime: '2024-01-01T00:00:06Z',
        endTime: '2024-01-01T00:00:09Z',
      });
      const containerRoot = createSpan({
        spanId: '1',
        name: 'agent.run',
        category: 'AGENT',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:10Z',
        children: [child1, child2],
      });

      const result = spansToExecutionFlow([containerRoot], 10000);

      // Container is skipped, children become the main flow
      expect(result.nodes.map(n => n.id).sort()).toEqual(['1.1', '1.2']);
    });

    it('applies custom options', () => {
      const spans = [
        createSpan({
          spanId: '1',
          category: 'LLM',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:05Z',
        }),
      ];

      const result = spansToExecutionFlow(spans, 5000, {
        nodeWidth: 300,
        nodeHeight: 100,
        direction: 'LR',
      });

      expect(result.nodes[0].style?.width).toBe(300);
      expect(result.nodes[0].style?.height).toBe(100);
    });
  });
});
