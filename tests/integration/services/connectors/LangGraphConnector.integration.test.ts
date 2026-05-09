/* Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for LangGraphConnector
 *
 * Tests the LangGraph REST connector logic end-to-end by mocking fetch.
 * Verifies:
 * 1. Correct payload construction (messages format)
 * 2. URL construction (with/without threadId, graphId)
 * 3. Response parsing (messages, tool calls, intermediate_steps)
 * 4. Error handling for failed requests
 * 5. Health check behavior
 */

import type { ConnectorAuth, ConnectorRequest } from '@/services/connectors/types';
import type { TestCase } from '@/types';
import { LangGraphConnector } from '@/services/connectors/langgraph/LangGraphConnector';

describe('LangGraphConnector Integration Tests', () => {
  let connector: LangGraphConnector;
  let mockFetch: jest.Mock;

  const makeTestCase = (prompt: string): TestCase => ({
    id: 'tc-1',
    name: 'Test Case',
    initialPrompt: prompt,
    expectedOutcomes: ['Identify issue'],
    context: [],
    labels: [],
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const defaultAuth: ConnectorAuth = { type: 'bearer', token: 'test-token-123' };

  beforeEach(() => {
    connector = new LangGraphConnector();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildPayload', () => {
    it('should construct messages-based payload from test case', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Analyze the error logs'),
        modelId: 'gpt-4',
      };

      const payload = connector.buildPayload(request);

      expect(payload.input.messages).toEqual([
        { role: 'user', content: 'Analyze the error logs' },
      ]);
      expect(payload.config.configurable.model).toBe('gpt-4');
    });

    it('should merge configurable options from connectorConfig', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'claude-3',
        connectorConfig: {
          configurable: { temperature: 0.5, custom_param: 'abc' },
        },
      };

      const payload = connector.buildPayload(request);

      expect(payload.config.configurable).toEqual({
        model: 'claude-3',
        temperature: 0.5,
        custom_param: 'abc',
      });
    });

    it('should omit model from configurable when not provided', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: '',
      };

      const payload = connector.buildPayload(request);

      // modelId is falsy so it should not appear
      expect(payload.config.configurable.model).toBeFalsy();
    });
  });

  describe('execute', () => {
    it('should call correct invoke URL without threadId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          output: { messages: [{ type: 'ai', content: 'Done' }] },
        }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test prompt'),
        modelId: 'model-1',
        connectorConfig: { graphId: 'my-graph' },
      };

      await connector.execute('http://localhost:8123', request, defaultAuth);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8123/assistants/my-graph/invoke',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should call thread-based URL when threadId is provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          values: { messages: [{ type: 'ai', content: 'Response' }] },
        }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
        connectorConfig: { threadId: 'thread-abc' },
      };

      await connector.execute('http://localhost:8123/', request, defaultAuth);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8123/threads/thread-abc/runs/wait',
        expect.any(Object)
      );
    });

    it('should default graphId to "agent"', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ output: { messages: [] } }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('http://localhost:8123', request, defaultAuth);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8123/assistants/agent/invoke',
        expect.any(Object)
      );
    });

    it('should include auth headers in request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ output: { messages: [] } }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('http://localhost:8123', request, defaultAuth);

      const fetchCall = mockFetch.mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['Authorization']).toBe('Bearer test-token-123');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should throw error on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error: graph execution failed',
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await expect(
        connector.execute('http://localhost:8123', request, defaultAuth)
      ).rejects.toThrow('LangGraph request failed: 500 - Internal Server Error: graph execution failed');
    });

    it('should parse AI messages with tool calls into action steps', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          output: {
            messages: [
              {
                type: 'ai',
                content: '',
                tool_calls: [
                  { name: 'search_logs', args: { query: 'error', limit: 10 } },
                ],
              },
              {
                type: 'tool',
                name: 'search_logs',
                content: 'Found 3 errors',
              },
              {
                type: 'ai',
                content: 'Based on the logs, the issue is a timeout.',
              },
            ],
          },
        }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('What is wrong?'),
        modelId: 'model-1',
      };

      const result = await connector.execute('http://localhost:8123', request, defaultAuth);

      expect(result.trajectory).toHaveLength(3);
      expect(result.trajectory[0].type).toBe('action');
      expect(result.trajectory[0].toolName).toBe('search_logs');
      expect(result.trajectory[0].toolArgs).toEqual({ query: 'error', limit: 10 });
      expect(result.trajectory[1].type).toBe('tool_result');
      expect(result.trajectory[1].content).toBe('Found 3 errors');
      expect(result.trajectory[2].type).toBe('response');
      expect(result.trajectory[2].content).toBe('Based on the logs, the issue is a timeout.');
    });

    it('should parse intermediate_steps format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          intermediate_steps: [
            [{ tool: 'get_metrics', tool_input: { metric: 'cpu' } }, 'CPU: 95%'],
            [{ tool: 'get_metrics', tool_input: { metric: 'memory' } }, 'Memory: 80%'],
          ],
          output: 'High CPU usage detected.',
        }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Check system'),
        modelId: 'model-1',
      };

      const result = await connector.execute('http://localhost:8123', request, defaultAuth);

      // intermediate_steps produces action + tool_result pairs, plus the output string
      expect(result.trajectory.length).toBeGreaterThanOrEqual(4);
      const actions = result.trajectory.filter(s => s.type === 'action');
      const toolResults = result.trajectory.filter(s => s.type === 'tool_result');
      expect(actions).toHaveLength(2);
      expect(toolResults).toHaveLength(2);
      expect(actions[0].toolName).toBe('get_metrics');
      expect(toolResults[0].content).toBe('CPU: 95%');
    });

    it('should handle array content in messages', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          output: {
            messages: [
              {
                type: 'ai',
                content: [
                  { text: 'Part 1' },
                  { text: 'Part 2' },
                ],
              },
            ],
          },
        }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const result = await connector.execute('http://localhost:8123', request, defaultAuth);

      expect(result.trajectory[0].content).toBe('Part 1\nPart 2');
    });

    it('should call onProgress and onRawEvent callbacks', async () => {
      const responseData = {
        output: { messages: [{ type: 'ai', content: 'Hello' }] },
        run_id: 'run-123',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => responseData,
      });

      const onProgress = jest.fn();
      const onRawEvent = jest.fn();
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('http://localhost:8123', request, defaultAuth, onProgress, onRawEvent);

      expect(onRawEvent).toHaveBeenCalledWith(responseData);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', content: 'Hello' })
      );
    });

    it('should return runId and metadata', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          output: { messages: [{ type: 'ai', content: 'Done' }] },
          run_id: 'run-xyz',
          thread_id: 'thread-456',
        }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const result = await connector.execute('http://localhost:8123', request, defaultAuth);

      expect(result.runId).toBe('run-xyz');
      expect(result.metadata?.graphId).toBe('agent');
      expect(result.metadata?.threadId).toBe('thread-456');
    });

    it('should use pre-built payload when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ output: { messages: [{ type: 'ai', content: 'OK' }] } }),
      });

      const customPayload = { input: { messages: [{ role: 'user', content: 'Custom' }] }, config: {} };
      const request: ConnectorRequest = {
        testCase: makeTestCase('Ignored'),
        modelId: 'model-1',
        payload: customPayload,
      };

      await connector.execute('http://localhost:8123', request, defaultAuth);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(customPayload);
    });

    it('should strip trailing slash from endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ output: { messages: [] } }),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      await connector.execute('http://localhost:8123///', request, defaultAuth);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8123/assistants/agent/invoke',
        expect.any(Object)
      );
    });

    it('should fallback to JSON.stringify for unrecognized response', async () => {
      const weirdData = { custom_field: 'weird value', no_messages: true };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => weirdData,
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'model-1',
      };

      const result = await connector.execute('http://localhost:8123', request, defaultAuth);

      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0].type).toBe('response');
      expect(result.trajectory[0].content).toContain('custom_field');
    });
  });

  describe('parseResponse', () => {
    it('should handle values.messages format (thread-based)', () => {
      const steps = connector.parseResponse({
        values: {
          messages: [
            { type: 'ai', content: 'Analysis complete.' },
          ],
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Analysis complete.');
    });

    it('should handle direct messages array', () => {
      const steps = connector.parseResponse({
        messages: [
          { role: 'assistant', content: 'Hello' },
        ],
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
    });

    it('should handle direct string output', () => {
      const steps = connector.parseResponse({ output: 'Simple string output' });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Simple string output');
    });
  });

  describe('healthCheck', () => {
    it('should return true when /ok endpoint responds 200', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const result = await connector.healthCheck('http://localhost:8123', defaultAuth);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8123/ok',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should fall back to root endpoint when /ok fails', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ ok: true });

      const result = await connector.healthCheck('http://localhost:8123', defaultAuth);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return false when both endpoints fail', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await connector.healthCheck('http://localhost:8123', defaultAuth);

      expect(result).toBe(false);
    });
  });

  describe('connector properties', () => {
    it('should have correct type and name', () => {
      expect(connector.type).toBe('langgraph');
      expect(connector.name).toBe('LangGraph (REST)');
      expect(connector.supportsStreaming).toBe(false);
    });
  });
});
