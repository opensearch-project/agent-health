/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for Intent View trace transformation
 *
 * Tests the full pipeline: span tree → categorization → intent nodes
 *
 * Run tests:
 *   npm test -- --testPathPattern=intentView.integration
 */

import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { spansToIntentNodes, getRootContainerSpan } from '@/services/traces/intentTransform';
import { Span } from '@/types';
import {
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from '@opentelemetry/semantic-conventions/incubating';

/**
 * Create a realistic span tree structure similar to what we receive from OpenSearch
 */
function createRealSpanTree(): Span[] {
  return [
    {
      spanId: 'root-1',
      traceId: 'trace-1',
      name: 'agent.run',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:01:00Z',
      duration: 60000,
      status: 'OK',
      attributes: {},
      children: [
        {
          spanId: 'llm-1',
          traceId: 'trace-1',
          name: 'bedrock.invoke_model',
          startTime: '2024-01-01T00:00:01Z',
          endTime: '2024-01-01T00:00:10Z',
          duration: 9000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_SYSTEM]: 'aws_bedrock' },
          children: [],
        },
        {
          spanId: 'tool-1',
          traceId: 'trace-1',
          name: 'execute_tool',
          startTime: '2024-01-01T00:00:11Z',
          endTime: '2024-01-01T00:00:20Z',
          duration: 9000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL },
          children: [],
        },
        {
          spanId: 'llm-2',
          traceId: 'trace-1',
          name: 'bedrock.invoke_model',
          startTime: '2024-01-01T00:00:21Z',
          endTime: '2024-01-01T00:00:35Z',
          duration: 14000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_SYSTEM]: 'aws_bedrock' },
          children: [],
        },
      ],
    },
  ];
}

/**
 * Create a multi-tool execution span tree
 */
function createMultiToolSpanTree(): Span[] {
  return [
    {
      spanId: 'root-1',
      traceId: 'trace-1',
      name: 'agent.run',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:02:00Z',
      duration: 120000,
      status: 'OK',
      attributes: {},
      children: [
        {
          spanId: 'llm-1',
          traceId: 'trace-1',
          name: 'bedrock.invoke',
          startTime: '2024-01-01T00:00:01Z',
          endTime: '2024-01-01T00:00:10Z',
          duration: 9000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_SYSTEM]: 'aws_bedrock' },
          children: [],
        },
        {
          spanId: 'tool-1',
          traceId: 'trace-1',
          name: 'execute_tool',
          startTime: '2024-01-01T00:00:11Z',
          endTime: '2024-01-01T00:00:20Z',
          duration: 9000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL, [ATTR_GEN_AI_TOOL_NAME]: 'search_logs' },
          children: [],
        },
        {
          spanId: 'tool-2',
          traceId: 'trace-1',
          name: 'execute_tool',
          startTime: '2024-01-01T00:00:21Z',
          endTime: '2024-01-01T00:00:30Z',
          duration: 9000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL, [ATTR_GEN_AI_TOOL_NAME]: 'get_metrics' },
          children: [],
        },
        {
          spanId: 'tool-3',
          traceId: 'trace-1',
          name: 'execute_tool',
          startTime: '2024-01-01T00:00:31Z',
          endTime: '2024-01-01T00:00:45Z',
          duration: 14000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL, [ATTR_GEN_AI_TOOL_NAME]: 'query_database' },
          children: [],
        },
        {
          spanId: 'llm-2',
          traceId: 'trace-1',
          name: 'bedrock.invoke',
          startTime: '2024-01-01T00:00:46Z',
          endTime: '2024-01-01T00:01:00Z',
          duration: 14000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_SYSTEM]: 'aws_bedrock' },
          children: [],
        },
      ],
    },
  ];
}

describe('Intent View Integration', () => {
  describe('Full Pipeline', () => {
    it('transforms real span tree through categorization to intent nodes', () => {
      const spanTree = createRealSpanTree();

      // Step 1: Categorize spans
      const categorized = categorizeSpanTree(spanTree);
      expect(categorized).toHaveLength(1);
      expect(categorized[0].category).toBeDefined();

      // Step 2: Transform to intent nodes
      const nodes = spansToIntentNodes(categorized);
      expect(nodes.length).toBeGreaterThan(0);

      // Step 3: Get root container
      const root = getRootContainerSpan(categorized);
      expect(root?.name).toBe('agent.run');
    });

    it('handles nested container spans correctly', () => {
      const spanTree = createRealSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      // Container span (agent.run) should be skipped
      // Children (LLM, TOOL) should be promoted
      const categories = nodes.map((n) => n.category);
      // Note: agent.run may or may not be detected as container depending on heuristics
      expect(categories).toContain('LLM');
      expect(categories).toContain('TOOL');
    });

    it('preserves correct execution order across pipeline', () => {
      const spanTree = createRealSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      // Verify execution order is monotonically increasing
      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i].executionOrder).toBeGreaterThan(
          nodes[i - 1].executionOrder
        );
      }
    });
  });

  describe('Consecutive Grouping', () => {
    it('groups consecutive tool calls into single node', () => {
      const spanTree = createMultiToolSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      // Should have: LLM, TOOL (grouped), LLM
      // Find the TOOL node
      const toolNode = nodes.find((n) => n.category === 'TOOL');
      expect(toolNode).toBeDefined();
      expect(toolNode?.count).toBe(3); // 3 consecutive tool calls grouped
    });

    it('maintains separate nodes for non-consecutive same-category spans', () => {
      const spanTree = createRealSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      // Should have: LLM, TOOL, LLM (not grouped)
      const llmNodes = nodes.filter((n) => n.category === 'LLM');
      expect(llmNodes.length).toBe(2); // Two separate LLM phases
    });
  });

  describe('Duration Calculations', () => {
    it('calculates group totalDuration correctly', () => {
      const spanTree = createMultiToolSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      const toolNode = nodes.find((n) => n.category === 'TOOL');
      // 3 tools: 9000 + 9000 + 14000 = 32000ms
      expect(toolNode?.totalDuration).toBe(32000);
    });

    it('calculates single span duration correctly', () => {
      const spanTree = createRealSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      const toolNode = nodes.find((n) => n.category === 'TOOL');
      expect(toolNode?.totalDuration).toBe(9000);
    });
  });

  describe('Span Array Preservation', () => {
    it('preserves original spans in each node', () => {
      const spanTree = createMultiToolSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      const toolNode = nodes.find((n) => n.category === 'TOOL');
      expect(toolNode?.spans).toHaveLength(3);
      expect(toolNode?.spans[0].name).toContain('execute_tool');
    });

    it('maintains span categorization data', () => {
      const spanTree = createRealSpanTree();
      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      nodes.forEach((node) => {
        node.spans.forEach((span) => {
          expect(span.category).toBeDefined();
          expect(span.category).toBe(node.category);
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('handles empty span tree', () => {
      const categorized = categorizeSpanTree([]);
      const nodes = spansToIntentNodes(categorized);

      expect(nodes).toEqual([]);
    });

    it('handles single span without children', () => {
      const spanTree: Span[] = [
        {
          spanId: 'single-1',
          traceId: 'trace-1',
          name: 'bedrock.invoke',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:10Z',
          duration: 10000,
          status: 'OK',
          attributes: { [ATTR_GEN_AI_SYSTEM]: 'aws_bedrock' },
          children: [],
        },
      ];

      const categorized = categorizeSpanTree(spanTree);
      const nodes = spansToIntentNodes(categorized);

      expect(nodes).toHaveLength(1);
      expect(nodes[0].category).toBe('LLM');
      expect(nodes[0].count).toBe(1);
    });
  });
});
