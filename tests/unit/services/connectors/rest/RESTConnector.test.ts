/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { RESTConnector, restConnector } from '@/services/connectors/rest/RESTConnector';
import type { ConnectorRequest, ConnectorAuth } from '@/services/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';

describe('RESTConnector', () => {
  let connector: RESTConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;

  beforeEach(() => {
    connector = new RESTConnector();
    mockTestCase = {
      id: 'tc-123',
      name: 'Test Case',
      initialPrompt: 'What is the cluster health?',
      context: [{ description: 'Cluster Name', value: 'test-cluster' }],
      expectedOutcomes: ['Check cluster health'],
      labels: [],
      tools: ['tool1', 'tool2'],
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
      expect(connector.type).toBe('rest');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('REST API');
    });

    it('should not support streaming', () => {
      expect(connector.supportsStreaming).toBe(false);
    });
  });

  describe('buildPayload', () => {
    it('should build payload with required fields', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload.prompt).toBe(mockTestCase.initialPrompt);
      expect(payload.context).toEqual(mockTestCase.context);
      expect(payload.model).toBe('test-model');
      expect(payload.tools).toEqual(mockTestCase.tools);
    });
  });

  describe('execute', () => {
    it('should make POST request to endpoint', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Test response' }),
        headers: new Map([['content-type', 'application/json']]),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      await connector.execute('http://localhost:8080/api', request, mockAuth);

      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expect.any(String),
      });
    });

    it('should include auth headers', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Test' }),
        headers: new Map(),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      await connector.execute(
        'http://localhost:8080/api',
        request,
        { type: 'bearer', token: 'my-token' }
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/api',
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

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      await expect(
        connector.execute('http://localhost:8080/api', request, mockAuth)
      ).rejects.toThrow('REST request failed: 500');
    });

    it('should return trajectory from response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          thinking: 'Analyzing...',
          response: 'The answer is 42',
        }),
        headers: new Map(),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute(
        'http://localhost:8080/api',
        request,
        mockAuth
      );

      expect(response.trajectory.length).toBeGreaterThan(0);
      expect(response.rawEvents).toHaveLength(1);
    });

    it('should call onProgress for each step', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Test' }),
        headers: new Map(),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      await connector.execute(
        'http://localhost:8080/api',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(progressSteps.length).toBeGreaterThan(0);
    });

    it('should call onRawEvent with response data', async () => {
      const responseData = { response: 'Test response' };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(responseData),
        headers: new Map(),
      });

      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const rawEvents: any[] = [];

      await connector.execute(
        'http://localhost:8080/api',
        request,
        mockAuth,
        undefined,
        (event) => rawEvents.push(event)
      );

      expect(rawEvents).toContainEqual(responseData);
    });
  });

  describe('parseResponse', () => {
    it('should parse thinking field', () => {
      const steps = connector.parseResponse({ thinking: 'Let me think...' });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].content).toBe('Let me think...');
    });

    it('should parse tool calls', () => {
      const steps = connector.parseResponse({
        toolCalls: [
          { name: 'get_data', args: { id: 123 }, result: 'data found' },
        ],
      });

      expect(steps).toHaveLength(2); // action + tool_result
      expect(steps[0].type).toBe('action');
      expect(steps[0].toolName).toBe('get_data');
      expect(steps[1].type).toBe('tool_result');
      expect(steps[1].content).toBe('data found');
    });

    it('should parse response field', () => {
      const steps = connector.parseResponse({ response: 'Final answer' });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Final answer');
    });

    it('should parse content field', () => {
      const steps = connector.parseResponse({ content: 'Content response' });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('Content response');
    });

    it('should parse answer field', () => {
      const steps = connector.parseResponse({ answer: 'The answer' });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
    });

    it('should parse ML-Commons inference_results format', () => {
      const steps = connector.parseResponse({
        inference_results: [{
          output: [
            { name: 'response', dataAsMap: { response: 'ML Commons result' } },
          ],
        }],
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
      expect(steps[0].content).toBe('ML Commons result');
    });

    it('should stringify object response content', () => {
      const steps = connector.parseResponse({ response: { key: 'value' } });

      expect(steps[0].content).toBe('{"key":"value"}');
    });

    it('should create generic response for unknown format', () => {
      const steps = connector.parseResponse({ unknown: 'data' });

      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('response');
    });

    it('should handle complex response with multiple fields', () => {
      const steps = connector.parseResponse({
        thinking: 'Analyzing...',
        toolCalls: [{ name: 'search', args: {}, result: 'found' }],
        response: 'Done',
      });

      expect(steps.length).toBeGreaterThanOrEqual(3); // thinking + action + result + response
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(restConnector).toBeInstanceOf(RESTConnector);
    });
  });
});
