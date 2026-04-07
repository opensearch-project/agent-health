/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for LiteLLM / OpenAI-compatible Connector
 *
 * Run tests:
 *   npm test -- --testPathPattern=LiteLLMConnector
 */

import type { ConnectorRequest, ConnectorAuth } from '@/services/connectors/types';
import type { TestCase } from '@/types';

// Mock the debug module before importing the connector
jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
  isDebugEnabled: jest.fn().mockReturnValue(false),
  setDebugEnabled: jest.fn(),
}));

import { LiteLLMConnector, litellmConnector } from '@/services/connectors/litellm/LiteLLMConnector';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Suppress console output
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ============ Test Helpers ============

/**
 * Build a minimal TestCase for testing
 */
function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-test-1',
    name: 'Test Case',
    description: 'A test case for unit testing',
    labels: ['category:RCA'],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [
      {
        version: 1,
        createdAt: '2025-01-01T00:00:00Z',
        initialPrompt: 'What is the root cause?',
        context: [],
      },
    ],
    // Current version fields (flattened)
    initialPrompt: 'What is the root cause?',
    context: [],
    ...overrides,
  } as TestCase;
}

/**
 * Build a ConnectorRequest from a test case and optional overrides
 */
function makeRequest(overrides: Partial<ConnectorRequest> = {}): ConnectorRequest {
  return {
    testCase: makeTestCase(),
    modelId: 'gpt-4',
    ...overrides,
  };
}

/**
 * Build a mock ChatCompletionResponse
 */
function makeChatCompletionResponse(overrides: Record<string, any> = {}) {
  return {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'The root cause is a memory leak in the application.',
          tool_calls: undefined,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
    ...overrides,
  };
}

const noAuth: ConnectorAuth = { type: 'none' };

// ============ Tests ============

describe('LiteLLMConnector', () => {
  let connector: LiteLLMConnector;

  beforeEach(() => {
    connector = new LiteLLMConnector();
    mockFetch.mockClear();
  });

  // ============ Static Properties ============

  describe('properties', () => {
    it('should have type "litellm"', () => {
      expect(connector.type).toBe('litellm');
    });

    it('should have the correct display name', () => {
      expect(connector.name).toBe('LiteLLM / OpenAI-compatible');
    });

    it('should not support streaming', () => {
      expect(connector.supportsStreaming).toBe(false);
    });
  });

  describe('default instance', () => {
    it('should export a default litellmConnector instance', () => {
      expect(litellmConnector).toBeInstanceOf(LiteLLMConnector);
      expect(litellmConnector.type).toBe('litellm');
    });
  });

  // ============ buildPayload ============

  describe('buildPayload', () => {
    it('should build a basic payload with prompt as user message', () => {
      const request = makeRequest();
      const payload = connector.buildPayload(request);

      expect(payload.model).toBe('gpt-4');
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0]).toEqual({
        role: 'user',
        content: 'What is the root cause?',
      });
      expect(payload.tools).toBeUndefined();
    });

    it('should include context as system message when present', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          context: ['You are analyzing a production incident.', 'The service is running on AWS.'],
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0]).toEqual({
        role: 'system',
        content: 'You are analyzing a production incident.\nThe service is running on AWS.',
      });
      expect(payload.messages[1]).toEqual({
        role: 'user',
        content: 'What is the root cause?',
      });
    });

    it('should handle context items that are objects by stringifying them', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          context: [{ key: 'value', nested: { a: 1 } }] as any,
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0].role).toBe('system');
      expect(payload.messages[0].content).toBe(JSON.stringify({ key: 'value', nested: { a: 1 } }));
    });

    it('should not include system message when context is empty', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          context: [],
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].role).toBe('user');
    });

    it('should not include system message when context is undefined', () => {
      const testCase = makeTestCase();
      (testCase as any).context = undefined;
      const request = makeRequest({ testCase });

      const payload = connector.buildPayload(request);

      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].role).toBe('user');
    });

    it('should include tools in OpenAI function format', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          tools: [
            {
              name: 'search_logs',
              description: 'Search application logs',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  timeRange: { type: 'string' },
                },
              },
            },
            {
              name: 'get_metrics',
              description: 'Get system metrics',
              parameters: {},
            },
          ] as any,
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.tools).toHaveLength(2);
      expect(payload.tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'search_logs',
          description: 'Search application logs',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              timeRange: { type: 'string' },
            },
          },
        },
      });
      expect(payload.tools[1]).toEqual({
        type: 'function',
        function: {
          name: 'get_metrics',
          description: 'Get system metrics',
          parameters: {},
        },
      });
    });

    it('should default description to empty string when tool has no description', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          tools: [
            {
              name: 'my_tool',
              // no description
              parameters: { type: 'object' },
            },
          ] as any,
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.tools[0].function.description).toBe('');
    });

    it('should default parameters to empty object when tool has no parameters', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          tools: [
            {
              name: 'simple_tool',
              description: 'A simple tool',
              // no parameters
            },
          ] as any,
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.tools[0].function.parameters).toEqual({});
    });

    it('should not include tools when test case has no tools', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          tools: undefined,
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.tools).toBeUndefined();
    });

    it('should not include tools when test case has empty tools array', () => {
      const request = makeRequest({
        testCase: makeTestCase({
          tools: [],
        }),
      });

      const payload = connector.buildPayload(request);

      expect(payload.tools).toBeUndefined();
    });

    it('should use the modelId from request', () => {
      const request = makeRequest({ modelId: 'claude-sonnet-4-20250514' });
      const payload = connector.buildPayload(request);

      expect(payload.model).toBe('claude-sonnet-4-20250514');
    });
  });

  // ============ execute ============

  describe('execute', () => {
    const endpoint = 'http://localhost:4000/v1/chat/completions';

    it('should make a POST request to the endpoint with correct payload', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const request = makeRequest();
      await connector.execute(endpoint, request, noAuth);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(endpoint);
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('gpt-4');
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('What is the root cause?');
    });

    it('should return trajectory with response step on success', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const result = await connector.execute(endpoint, makeRequest(), noAuth);

      expect(result.trajectory).toHaveLength(1);
      expect(result.trajectory[0].type).toBe('response');
      expect(result.trajectory[0].content).toBe('The root cause is a memory leak in the application.');
      expect(result.trajectory[0].id).toBeDefined();
      expect(result.trajectory[0].timestamp).toBeDefined();
    });

    it('should return runId from response', async () => {
      const responseData = makeChatCompletionResponse({ id: 'chatcmpl-xyz789' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const result = await connector.execute(endpoint, makeRequest(), noAuth);

      expect(result.runId).toBe('chatcmpl-xyz789');
    });

    it('should return null runId when response has no id', async () => {
      const responseData = makeChatCompletionResponse({ id: undefined });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const result = await connector.execute(endpoint, makeRequest(), noAuth);

      expect(result.runId).toBeNull();
    });

    it('should include raw events in response', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const result = await connector.execute(endpoint, makeRequest(), noAuth);

      expect(result.rawEvents).toHaveLength(1);
      expect(result.rawEvents![0]).toEqual(responseData);
    });

    it('should include metadata with model, usage, and finishReason', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const result = await connector.execute(endpoint, makeRequest(), noAuth);

      expect(result.metadata).toEqual({
        model: 'gpt-4',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
        finishReason: 'stop',
      });
    });

    it('should call onProgress for each trajectory step', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const onProgress = jest.fn();
      await connector.execute(endpoint, makeRequest(), noAuth, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          content: 'The root cause is a memory leak in the application.',
        })
      );
    });

    it('should call onRawEvent with the full response data', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const onRawEvent = jest.fn();
      await connector.execute(endpoint, makeRequest(), noAuth, undefined, onRawEvent);

      expect(onRawEvent).toHaveBeenCalledTimes(1);
      expect(onRawEvent).toHaveBeenCalledWith(responseData);
    });

    it('should call both onProgress and onRawEvent when both provided', async () => {
      const responseData = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Result text',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"test"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const onProgress = jest.fn();
      const onRawEvent = jest.fn();
      await connector.execute(endpoint, makeRequest(), noAuth, onProgress, onRawEvent);

      // onRawEvent called once with full data
      expect(onRawEvent).toHaveBeenCalledTimes(1);
      // onProgress called for each step (1 action + 1 response = 2)
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      await expect(
        connector.execute(endpoint, makeRequest(), noAuth)
      ).rejects.toThrow('LiteLLM request failed: 429 - Rate limit exceeded');
    });

    it('should throw on 500 server error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(
        connector.execute(endpoint, makeRequest(), noAuth)
      ).rejects.toThrow('LiteLLM request failed: 500 - Internal Server Error');
    });

    it('should use request.payload if present instead of building payload', async () => {
      const customPayload = {
        model: 'custom-model',
        messages: [{ role: 'user', content: 'Custom prompt' }],
        temperature: 0.5,
      };

      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const request = makeRequest({ payload: customPayload });
      await connector.execute(endpoint, request, noAuth);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual(customPayload);
      expect(body.model).toBe('custom-model');
      expect(body.temperature).toBe(0.5);
    });

    it('should pass bearer auth headers to fetch', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const auth: ConnectorAuth = {
        type: 'bearer',
        token: 'sk-test-token-123',
      };

      await connector.execute(endpoint, makeRequest(), auth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer sk-test-token-123');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should pass api-key auth headers to fetch', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const auth: ConnectorAuth = {
        type: 'api-key',
        token: 'my-api-key-456',
      };

      await connector.execute(endpoint, makeRequest(), auth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-API-Key']).toBe('my-api-key-456');
    });

    it('should pass custom headers from auth configuration', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      const auth: ConnectorAuth = {
        type: 'none',
        headers: {
          'X-Custom-Header': 'custom-value',
          'X-Org-Id': 'org-123',
        },
      };

      await connector.execute(endpoint, makeRequest(), auth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['X-Custom-Header']).toBe('custom-value');
      expect(headers['X-Org-Id']).toBe('org-123');
    });

    it('should not add auth headers when auth type is none', async () => {
      const responseData = makeChatCompletionResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseData,
      });

      await connector.execute(endpoint, makeRequest(), noAuth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['X-API-Key']).toBeUndefined();
      // Content-Type should still be present
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  // ============ parseResponse ============

  describe('parseResponse', () => {
    it('should parse content into a response step', () => {
      const data = makeChatCompletionResponse();
      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('The root cause is a memory leak in the application.');
      expect(steps[0].id).toBeDefined();
      expect(steps[0].timestamp).toBeDefined();
    });

    it('should parse tool_calls into action steps with parsed JSON args', () => {
      const data = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: {
                    name: 'search_logs',
                    arguments: '{"query":"ERROR","timeRange":"1h"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('action');
      expect(steps[0].content).toBe('Calling search_logs...');
      expect(steps[0].toolName).toBe('search_logs');
      expect(steps[0].toolArgs).toEqual({ query: 'ERROR', timeRange: '1h' });
    });

    it('should parse multiple tool_calls into multiple action steps', () => {
      const data = makeChatCompletionResponse({
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
                    arguments: '{"query":"ERROR"}',
                  },
                },
                {
                  id: 'call_2',
                  type: 'function',
                  function: {
                    name: 'get_metrics',
                    arguments: '{"metric":"cpu"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('search_logs');
      expect(steps[0].toolArgs).toEqual({ query: 'ERROR' });
      expect(steps[1].type).toBe('action');
      expect(steps[1].toolName).toBe('get_metrics');
      expect(steps[1].toolArgs).toEqual({ metric: 'cpu' });
    });

    it('should fall back to raw string args when tool_call arguments are invalid JSON', () => {
      const data = makeChatCompletionResponse({
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
                    arguments: 'this is not valid json{{{',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('broken_tool');
      expect(steps[0].toolArgs).toBe('this is not valid json{{{');
    });

    it('should handle empty choices with a generic response', () => {
      const data = makeChatCompletionResponse({
        choices: [],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      // When no choices, the entire data object is stringified
      expect(steps[0].content).toContain('chat.completion');
    });

    it('should handle undefined choices with a generic response', () => {
      const data = {
        id: 'chatcmpl-noop',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4',
      };

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toContain('chatcmpl-noop');
    });

    it('should return "(empty response)" when no content and no tool_calls', () => {
      const data = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: undefined,
            },
            finish_reason: 'stop',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('(empty response)');
    });

    it('should return "(empty response)" when content is empty string and no tool_calls', () => {
      const data = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: undefined,
            },
            finish_reason: 'stop',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      // Empty string is falsy, so no content step is added; falls through to empty response
      expect(steps[0].content).toBe('(empty response)');
    });

    it('should handle content and tool_calls together', () => {
      const data = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Let me search the logs for you.',
              tool_calls: [
                {
                  id: 'call_both',
                  type: 'function',
                  function: {
                    name: 'search_logs',
                    arguments: '{"query":"ERROR"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      // Should have action step first, then response step
      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('search_logs');
      expect(steps[0].content).toBe('Calling search_logs...');
      expect(steps[1].type).toBe('response');
      expect(steps[1].content).toBe('Let me search the logs for you.');
    });

    it('should handle tool_calls with empty arguments string', () => {
      const data = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_empty',
                  type: 'function',
                  function: {
                    name: 'list_items',
                    arguments: '',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('list_items');
      // Empty string fails JSON.parse, so raw string is used
      expect(steps[0].toolArgs).toBe('');
    });

    it('should generate unique IDs for each step', () => {
      const data = makeChatCompletionResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Response text',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'tool_a', arguments: '{}' },
                },
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'tool_b', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const steps = connector.parseResponse(data);

      const ids = steps.map(s => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should include timestamps on all steps', () => {
      const data = makeChatCompletionResponse();
      const beforeTime = Date.now();
      const steps = connector.parseResponse(data);
      const afterTime = Date.now();

      for (const step of steps) {
        expect(step.timestamp).toBeGreaterThanOrEqual(beforeTime);
        expect(step.timestamp).toBeLessThanOrEqual(afterTime);
      }
    });
  });
});
