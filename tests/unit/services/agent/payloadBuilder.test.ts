/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import {
  buildAgentPayload,
  buildMultiTurnPayload,
  DEFAULT_PPL_TOOL,
  AgentMessage,
} from '@/services/agent/payloadBuilder';
import { TestCase, AgentToolDefinition } from '@/types';

describe('payloadBuilder', () => {
  describe('DEFAULT_PPL_TOOL', () => {
    it('should have correct name and description', () => {
      expect(DEFAULT_PPL_TOOL.name).toBe('execute_ppl_query');
      expect(DEFAULT_PPL_TOOL.description).toContain('PPL query');
    });

    it('should have required parameters defined', () => {
      expect(DEFAULT_PPL_TOOL.parameters.type).toBe('object');
      expect(DEFAULT_PPL_TOOL.parameters.properties).toHaveProperty('query');
      expect(DEFAULT_PPL_TOOL.parameters.properties).toHaveProperty('autoExecute');
      expect(DEFAULT_PPL_TOOL.parameters.properties).toHaveProperty('description');
      expect(DEFAULT_PPL_TOOL.parameters.required).toContain('query');
    });
  });

  describe('buildAgentPayload', () => {
    const baseTestCase: TestCase = {
      id: 'test-1',
      name: 'Test Case',
      initialPrompt: 'Find errors in logs',
      expectedOutcomes: ['Should identify error patterns'],
      category: 'RCA',
      context: [
        {
          name: 'error_log',
          type: 'text',
          value: 'Sample error log content',
        },
      ],
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      labels: ['test'],
    };

    it('should create a valid payload with required fields', () => {
      const payload = buildAgentPayload(baseTestCase, 'model-123');

      expect(payload.threadId).toMatch(/^thread-\d+-[a-z0-9]+$/);
      expect(payload.runId).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].role).toBe('user');
      expect(payload.messages[0].content).toBe(baseTestCase.initialPrompt);
      expect(payload.tools).toEqual([DEFAULT_PPL_TOOL]);
      expect(payload.context).toEqual(baseTestCase.context);
      expect(payload.state).toEqual({});
      expect(payload.forwardedProps).toEqual({});
    });

    it('should use provided threadId and runId', () => {
      const threadId = 'custom-thread-123';
      const runId = 'custom-run-456';
      const payload = buildAgentPayload(baseTestCase, 'model-123', threadId, runId);

      expect(payload.threadId).toBe(threadId);
      expect(payload.runId).toBe(runId);
    });

    it('should use tools from test case when provided', () => {
      const customTools: AgentToolDefinition[] = [
        {
          name: 'custom_tool',
          description: 'A custom tool',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ];
      const testCaseWithTools: TestCase = {
        ...baseTestCase,
        tools: customTools,
      };

      const payload = buildAgentPayload(testCaseWithTools, 'model-123');
      expect(payload.tools).toEqual(customTools);
    });

    it('should handle test case without context', () => {
      const testCaseNoContext: TestCase = {
        ...baseTestCase,
        context: undefined,
      };

      const payload = buildAgentPayload(testCaseNoContext, 'model-123');
      expect(payload.context).toEqual([]);
    });

    it('should generate unique IDs for each call', () => {
      const payload1 = buildAgentPayload(baseTestCase, 'model-123');
      const payload2 = buildAgentPayload(baseTestCase, 'model-123');

      expect(payload1.threadId).not.toBe(payload2.threadId);
      expect(payload1.runId).not.toBe(payload2.runId);
      expect(payload1.messages[0].id).not.toBe(payload2.messages[0].id);
    });

    it('should create message with correct structure', () => {
      const payload = buildAgentPayload(baseTestCase, 'model-123');
      const message = payload.messages[0];

      expect(message.id).toMatch(/^msg-\d+-[a-z0-9]+$/);
      expect(message.role).toBe('user');
      expect(message.content).toBe('Find errors in logs');
    });
  });

  describe('buildMultiTurnPayload', () => {
    const messages: AgentMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'Hi there!' },
      { id: 'msg-3', role: 'user', content: 'Find errors' },
    ];

    it('should create a valid multi-turn payload', () => {
      const payload = buildMultiTurnPayload(messages);

      expect(payload.threadId).toMatch(/^thread-\d+-[a-z0-9]+$/);
      expect(payload.runId).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(payload.messages).toEqual(messages);
      expect(payload.tools).toEqual([DEFAULT_PPL_TOOL]);
      expect(payload.context).toEqual([]);
      expect(payload.state).toEqual({});
      expect(payload.forwardedProps).toEqual({});
    });

    it('should use provided threadId and runId', () => {
      const threadId = 'thread-abc';
      const runId = 'run-xyz';
      const payload = buildMultiTurnPayload(messages, threadId, runId);

      expect(payload.threadId).toBe(threadId);
      expect(payload.runId).toBe(runId);
    });

    it('should use provided context', () => {
      const context = [
        { name: 'data', type: 'text' as const, value: 'some data' },
      ];
      const payload = buildMultiTurnPayload(messages, undefined, undefined, context);

      expect(payload.context).toEqual(context);
    });

    it('should use provided tools', () => {
      const customTools: AgentToolDefinition[] = [
        {
          name: 'search',
          description: 'Search tool',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ];
      const payload = buildMultiTurnPayload(
        messages,
        undefined,
        undefined,
        undefined,
        customTools
      );

      expect(payload.tools).toEqual(customTools);
    });

    it('should preserve message order', () => {
      const payload = buildMultiTurnPayload(messages);

      expect(payload.messages[0].content).toBe('Hello');
      expect(payload.messages[1].content).toBe('Hi there!');
      expect(payload.messages[2].content).toBe('Find errors');
    });
  });
});
