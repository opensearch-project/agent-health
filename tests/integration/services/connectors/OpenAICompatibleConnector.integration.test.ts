/* Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for OpenAICompatibleConnector
 *
 * Tests the OpenAI-compatible connector logic end-to-end by mocking fetch.
 * Verifies:
 * 1. Correct Chat Completion payload construction
 * 2. System message from context, user message from prompt
 * 3. Tool definitions formatting
 * 4. Response parsing (content, tool_calls, empty response)
 * 5. Error handling for failed requests
 */

import type { ConnectorAuth, ConnectorRequest } from '@/services/connectors/types';
import type { TestCase } from '@/types';
import { OpenAICompatibleConnector } from '@/services/connectors/openai-compatible/OpenAICompatibleConnector';

describe('OpenAICompatibleConnector Integration Tests', () => {
  let connector: OpenAICompatibleConnector;
  let mockFetch: jest.Mock;

  const makeTestCase = (prompt: string, options?: Partial<TestCase>): TestCase => ({
    id: 'tc-oai-1',
    name: 'OpenAI Test Case',
    initialPrompt: prompt,
    expectedOutcomes: ['Provide analysis'],
    context: [],
    labels: [],
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...options,
  });

  const defaultAuth: ConnectorAuth = { type: 'bearer', token: 'sk-test-key-123' };

  beforeEach(() => {
    connector = new OpenAICompatibleConnector();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildPayload', () => {
    it('should construct standard Chat Completion payload', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('What is the root cause?'),
        modelId: 'gpt-4-turbo',
      };

      const payload = connector.buildPayload(request);

      expect(payload.model).toBe('gpt-4-turbo');
      expect(payload.messages).toEqual([
        { role: 'user', content: 'What is the root cause?' },
      ]);
      expect(payload.tools).toBeUndefined();
    });

    it('should add context as system message', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Analyze this', {
          context: ['You are an RCA agent.', 'Focus on OpenSearch clusters.'],
        }),
        modelId: 'gpt-4',
      };

      const payload = connector.buildPayload(request);

      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0]).toEqual({
        role: 'system',
        content: 'You are an RCA agent.\nFocus on OpenSearch clusters.',
      });
      expect(payload.messages[1]).toEqual({
        role: 'user',
        content: 'Analyze this',
      });
    });

    it('should handle object context items by JSON stringifying them', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test', {
          context: [{ key: 'value', nested: { a: 1 } }] as any,
        }),
        modelId: 'gpt-4',
      };

      const payload = connector.buildPayload(request);

      expect(payload.messages[0].role).toBe('system');
      expect(payload.messages[0].content).toContain('"key":"value"');
    });

    it('should not add system message when context is empty', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test', { context: [] }),
        modelId: 'gpt-4',
      };

      const payload = connector.buildPayload(request);

      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].role).toBe('user');
    });

    it('should include tools in OpenAI function format', () => {
      const request: ConnectorRequest = {
        testCase: makeTestCase('Find errors', {
          tools: [
            {
              name: 'search_logs',
              description: 'Search application logs',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
            {
              name: 'get_metrics',
              description: 'Get system metrics',
              parameters: {},
            },
          ],
        } as any),
        modelId: 'gpt-4',
      };

      const payload = connector.buildPayload(request);

      expect(payload.tools).toHaveLength(2);
      expect(payload.tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'search_logs',
          description: 'Search application logs',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      });
      expect(payload.tools[1].function.name).toBe('get_metrics');
    });
  });

  describe('execute', () => {
    const makeChatResponse = (content: string, extras?: any) => ({
      id: 'chatcmpl-abc123',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4-turbo',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, ...extras },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
    });

    it('should send request to the correct endpoint with auth', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeChatResponse('Hello!'),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Hi'),
        modelId: 'gpt-4',
      };

      await connector.execute(
        'https://api.openai.com/v1/chat/completions',
        request,
        defaultAuth
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-test-key-123',
          }),
        })
      );
    });

    it('should parse content response into trajectory', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeChatResponse('The root cause is a memory leak in the indexing service.'),
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Diagnose the issue'),
        modelId: 'gpt-4',
      };

      const result = await connector.execute(
        'http://localhost:11434/v1/chat/completions',
        request,
        defaultAuth
      );

      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0].type).toBe('response');
      expect(result.trajectory[0].content).toBe('The root cause is a memory leak in the indexing service.');
    });

    it('should parse tool_calls in response', async () => {
      const responseData = {
        id: 'chatcmpl-xyz',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'search_logs',
                    arguments: '{"query": "OutOfMemoryError", "limit": 5}',
                  },
                },
                {
                  id: 'call_2',
                  type: 'function',
                  function: {
                    name: 'get_cluster_health',
                    arguments: '{}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => responseData,
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Investigate OOM'),
        modelId: 'gpt-4',
      };

      const result = await connector.execute('http://localhost/v1/chat/completions', request, defaultAuth);

      expect(result.trajectory).toHaveLength(2);
      expect(result.trajectory[0].type).toBe('action');
      expect(result.trajectory[0].toolName).toBe('search_logs');
      expect(result.trajectory[0].toolArgs).toEqual({ query: 'OutOfMemoryError', limit: 5 });
      expect(result.trajectory[1].type).toBe('action');
      expect(result.trajectory[1].toolName).toBe('get_cluster_health');
      expect(result.trajectory[1].toolArgs).toEqual({});
    });

    it('should handle tool_calls with invalid JSON arguments gracefully', async () => {
      const responseData = {
        id: 'chatcmpl-bad',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad',
                  type: 'function',
                  function: {
                    name: 'broken_tool',
                    arguments: 'not valid json {{{',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => responseData,
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'gpt-4',
      };

      const result = await connector.execute('http://localhost/v1/chat/completions', request, defaultAuth);

      // Should not throw — falls back to raw string
      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0].type).toBe('action');
      expect(result.trajectory[0].toolName).toBe('broken_tool');
      expect(result.trajectory[0].toolArgs).toBe('not valid json {{{');
    });

    it('should throw on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded. Please retry after 60s.',
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'gpt-4',
      };

      await expect(
        connector.execute('http://localhost/v1/chat/completions', request, defaultAuth)
      ).rejects.toThrow('OpenAI-compatible request failed: 429 - Rate limit exceeded');
    });

    it('should throw on 401 unauthorized', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid API key',
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'gpt-4',
      };

      await expect(
        connector.execute('http://localhost/v1/chat/completions', request, defaultAuth)
      ).rejects.toThrow('OpenAI-compatible request failed: 401 - Invalid API key');
    });

    it('should return correct runId and metadata', async () => {
      const responseData = makeChatResponse('Answer');

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => responseData,
      });

      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'gpt-4',
      };

      const result = await connector.execute('http://localhost/v1/chat/completions', request, defaultAuth);

      expect(result.runId).toBe('chatcmpl-abc123');
      expect(result.metadata?.model).toBe('gpt-4-turbo');
      expect(result.metadata?.usage).toEqual({
        prompt_tokens: 50,
        completion_tokens: 100,
        total_tokens: 150,
      });
      expect(result.metadata?.finishReason).toBe('stop');
      expect(result.rawEvents).toEqual([responseData]);
    });

    it('should call onProgress and onRawEvent callbacks', async () => {
      const responseData = makeChatResponse('Result');

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => responseData,
      });

      const onProgress = jest.fn();
      const onRawEvent = jest.fn();
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'gpt-4',
      };

      await connector.execute(
        'http://localhost/v1/chat/completions',
        request,
        defaultAuth,
        onProgress,
        onRawEvent
      );

      expect(onRawEvent).toHaveBeenCalledWith(responseData);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', content: 'Result' })
      );
    });

    it('should use pre-built payload when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeChatResponse('OK'),
      });

      const customPayload = {
        model: 'custom-model',
        messages: [{ role: 'user', content: 'Custom message' }],
        temperature: 0.9,
      };

      const request: ConnectorRequest = {
        testCase: makeTestCase('Ignored'),
        modelId: 'ignored-model',
        payload: customPayload,
      };

      await connector.execute('http://localhost/v1/chat/completions', request, defaultAuth);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(customPayload);
    });

    it('should work with api-key auth type', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeChatResponse('OK'),
      });

      const apiKeyAuth: ConnectorAuth = { type: 'api-key', token: 'my-api-key' };
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'gpt-4',
      };

      await connector.execute('http://localhost/v1/chat/completions', request, apiKeyAuth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-API-Key']).toBe('my-api-key');
    });

    it('should work with no auth', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeChatResponse('OK'),
      });

      const noAuth: ConnectorAuth = { type: 'none' };
      const request: ConnectorRequest = {
        testCase: makeTestCase('Test'),
        modelId: 'local-model',
      };

      await connector.execute('http://localhost:11434/v1/chat/completions', request, noAuth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('parseResponse', () => {
    it('should handle response with no choices', () => {
      const steps = connector.parseResponse({ id: 'x', choices: [] });

      // Falls through to no-choice branch
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
    });

    it('should handle response with null content and no tool_calls', () => {
      const steps = connector.parseResponse({
        choices: [{ message: { role: 'assistant', content: null } }],
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('(empty response)');
    });

    it('should handle both content and tool_calls together', () => {
      const steps = connector.parseResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Let me search for that.',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
              ],
            },
          },
        ],
      });

      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('search');
      expect(steps[1].type).toBe('response');
      expect(steps[1].content).toBe('Let me search for that.');
    });
  });

  describe('connector properties', () => {
    it('should have correct type and name', () => {
      expect(connector.type).toBe('openai-compatible');
      expect(connector.name).toBe('OpenAI-compatible');
      expect(connector.supportsStreaming).toBe(false);
    });
  });
});
