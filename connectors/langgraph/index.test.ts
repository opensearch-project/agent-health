/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { LangGraphConnector, langgraphConnector } from '@/connectors/langgraph';
import type { ConnectorRequest, ConnectorAuth } from '@/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';

describe('LangGraphConnector', () => {
  let connector: LangGraphConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;

  beforeEach(() => {
    connector = new LangGraphConnector();
    mockTestCase = {
      id: 'tc-123',
      name: 'Test Case',
      initialPrompt: 'What is the cluster health?',
      context: [{ description: 'Cluster Name', value: 'test-cluster' }],
      expectedOutcomes: ['Check cluster health'],
      labels: [],
      tools: ['tool1'],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockAuth = { type: 'none' };
    jest.spyOn(global, 'fetch').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('properties', () => {
    it('should have correct type', () => {
      expect(connector.type).toBe('langgraph');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('LangGraph (REST)');
    });

    it('should not support streaming', () => {
      expect(connector.supportsStreaming).toBe(false);
    });
  });

  describe('buildPayload', () => {
    it('should build payload with messages format', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload.input.messages).toEqual([
        { role: 'user', content: 'What is the cluster health?' },
      ]);
      expect(payload.config.configurable.model).toBe('test-model');
    });

    it('should include custom configurable from connectorConfig', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: {
          configurable: { thread_id: 'abc' },
        },
      };

      const payload = connector.buildPayload(request);

      expect(payload.config.configurable.thread_id).toBe('abc');
    });

    it('should omit model when modelId is not provided', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
      };

      const payload = connector.buildPayload(request);

      expect(payload.config.configurable.model).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('should POST to invoke URL with default graphId', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          output: { messages: [{ type: 'ai', content: 'Hello' }] },
        }),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };

      await connector.execute('http://localhost:8123', request, mockAuth);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8123/assistants/agent/invoke',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
    });

    it('should use custom graphId from connectorConfig', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ output: { messages: [] } }),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: { graphId: 'my-graph' },
      };

      await connector.execute('http://localhost:8123', request, mockAuth);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8123/assistants/my-graph/invoke',
        expect.any(Object)
      );
    });

    it('should use thread-based URL when threadId is provided', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ values: { messages: [] } }),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        connectorConfig: { threadId: 'thread-123' },
      };

      await connector.execute('http://localhost:8123', request, mockAuth);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8123/threads/thread-123/runs/wait',
        expect.any(Object)
      );
    });

    it('should include auth headers', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ output: { messages: [] } }),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };

      await connector.execute(
        'http://localhost:8123',
        request,
        { type: 'bearer', token: 'my-token' }
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-token',
          }),
        })
      );
    });

    it('should throw on non-ok response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };

      await expect(
        connector.execute('http://localhost:8123', request, mockAuth)
      ).rejects.toThrow('LangGraph request failed: 500');
    });

    it('should return trajectory from response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          output: {
            messages: [
              { type: 'ai', content: 'The cluster is healthy' },
            ],
          },
          run_id: 'run-abc',
        }),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };
      const result = await connector.execute('http://localhost:8123', request, mockAuth);

      expect(result.trajectory.length).toBeGreaterThan(0);
      expect(result.runId).toBe('run-abc');
      expect(result.rawEvents).toHaveLength(1);
    });

    it('should call onProgress for each step', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          output: {
            messages: [{ type: 'ai', content: 'Response' }],
          },
        }),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };
      const progressSteps: TrajectoryStep[] = [];

      await connector.execute(
        'http://localhost:8123',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(progressSteps.length).toBeGreaterThan(0);
    });

    it('should call onRawEvent with response data', async () => {
      const responseData = {
        output: { messages: [{ type: 'ai', content: 'Hello' }] },
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(responseData),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };
      const rawEvents: any[] = [];

      await connector.execute(
        'http://localhost:8123',
        request,
        mockAuth,
        undefined,
        (event) => rawEvents.push(event)
      );

      expect(rawEvents).toContainEqual(responseData);
    });

    it('should strip trailing slashes from endpoint', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ output: { messages: [] } }),
      });

      const request: ConnectorRequest = { testCase: mockTestCase };

      await connector.execute('http://localhost:8123///', request, mockAuth);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8123/assistants/agent/invoke',
        expect.any(Object)
      );
    });

    it('should use custom payload when provided', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ output: { messages: [] } }),
      });

      const customPayload = { custom: 'payload' };
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        payload: customPayload,
      };

      await connector.execute('http://localhost:8123', request, mockAuth);

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(JSON.parse(fetchCall[1].body)).toEqual(customPayload);
    });
  });

  describe('parseResponse', () => {
    it('should parse AI messages as response', () => {
      const steps = connector.parseResponse({
        output: {
          messages: [
            { type: 'ai', content: 'The answer is 42' },
          ],
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('The answer is 42');
    });

    it('should parse tool calls in AI messages', () => {
      const steps = connector.parseResponse({
        output: {
          messages: [
            {
              type: 'ai',
              content: '',
              tool_calls: [
                { name: 'search', args: { query: 'test' } },
              ],
            },
            { type: 'tool', name: 'search', content: 'found results' },
            { type: 'ai', content: 'Based on search results...' },
          ],
        },
      });

      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('search');
      expect(steps[1].type).toBe('tool_result');
      expect(steps[1].content).toBe('found results');
      // Last AI message becomes 'response'
      const responseStep = steps.find(s => s.type === 'response');
      expect(responseStep).toBeDefined();
      expect(responseStep!.content).toBe('Based on search results...');
    });

    it('should parse values.messages format (thread-based)', () => {
      const steps = connector.parseResponse({
        values: {
          messages: [
            { type: 'ai', content: 'Thread response' },
          ],
        },
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Thread response');
    });

    it('should parse intermediate_steps format (older LangGraph)', () => {
      const steps = connector.parseResponse({
        intermediate_steps: [
          [{ tool: 'search', tool_input: { q: 'test' } }, 'result data'],
        ],
      });

      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('search');
      expect(steps[1].type).toBe('tool_result');
      expect(steps[1].content).toBe('result data');
    });

    it('should parse direct string output', () => {
      const steps = connector.parseResponse({
        output: 'Simple string output',
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Simple string output');
    });

    it('should handle array content in messages', () => {
      const steps = connector.parseResponse({
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
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].content).toBe('Part 1\nPart 2');
    });

    it('should fallback to JSON stringified data when no recognized format', () => {
      const data = { unknown_field: 'value' };
      const steps = connector.parseResponse(data);

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe(JSON.stringify(data, null, 2));
    });

    it('should handle empty messages array', () => {
      const steps = connector.parseResponse({
        output: { messages: [] },
      });

      // Should fallback since no steps were generated from empty messages
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
    });
  });

  describe('healthCheck', () => {
    it('should check /ok endpoint', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

      const result = await connector.healthCheck('http://localhost:8123', mockAuth);

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8123/ok',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should fallback to root endpoint', async () => {
      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ ok: true });

      const result = await connector.healthCheck('http://localhost:8123', mockAuth);

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should return false when both endpoints fail', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('connection refused'));

      const result = await connector.healthCheck('http://localhost:8123', mockAuth);

      expect(result).toBe(false);
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(langgraphConnector).toBeInstanceOf(LangGraphConnector);
    });
  });
});
