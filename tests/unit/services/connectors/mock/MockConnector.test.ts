/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MockConnector, mockConnector } from '@/services/connectors/mock/MockConnector';
import type { ConnectorRequest, ConnectorAuth } from '@/services/connectors/types';
import type { TestCase, TrajectoryStep } from '@/types';

describe('MockConnector', () => {
  let connector: MockConnector;
  let mockTestCase: TestCase;
  let mockAuth: ConnectorAuth;

  beforeEach(() => {
    connector = new MockConnector();
    mockTestCase = {
      id: 'tc-123',
      name: 'Test Case',
      initialPrompt: 'What is the cluster health?',
      context: [],
      expectedOutcomes: ['Check cluster health'],
      labels: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockAuth = { type: 'none' };
  });

  describe('properties', () => {
    it('should have correct type', () => {
      expect(connector.type).toBe('mock');
    });

    it('should have correct name', () => {
      expect(connector.name).toBe('Demo Agent (Mock)');
    });

    it('should support streaming', () => {
      expect(connector.supportsStreaming).toBe(true);
    });
  });

  describe('buildPayload', () => {
    it('should build payload with question and context', () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const payload = connector.buildPayload(request);

      expect(payload.question).toBe(mockTestCase.initialPrompt);
      expect(payload.context).toEqual(mockTestCase.context);
    });
  });

  describe('execute', () => {
    it('should return trajectory with multiple steps', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute('mock://demo', request, mockAuth);

      expect(response.trajectory.length).toBeGreaterThan(0);
      expect(response.runId).toMatch(/^mock-run-\d+$/);
      expect(response.rawEvents).toBeDefined();
    });

    it('should include various step types', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute('mock://demo', request, mockAuth);

      const stepTypes = new Set(response.trajectory.map(s => s.type));
      expect(stepTypes.has('assistant')).toBe(true);
      expect(stepTypes.has('action')).toBe(true);
      expect(stepTypes.has('tool_result')).toBe(true);
      expect(stepTypes.has('response')).toBe(true);
    });

    it('should call onProgress for each step', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const progressSteps: TrajectoryStep[] = [];

      await connector.execute(
        'mock://demo',
        request,
        mockAuth,
        (step) => progressSteps.push(step)
      );

      expect(progressSteps.length).toBeGreaterThan(0);
    });

    it('should call onRawEvent for each step', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };
      const rawEvents: any[] = [];

      await connector.execute(
        'mock://demo',
        request,
        mockAuth,
        undefined,
        (event) => rawEvents.push(event)
      );

      expect(rawEvents.length).toBeGreaterThan(0);
      expect(rawEvents[0].type).toBe('MOCK_STEP');
    });

    it('should include metadata with test case info', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute('mock://demo', request, mockAuth);

      expect(response.metadata?.mock).toBe(true);
      expect(response.metadata?.testCaseId).toBe(mockTestCase.id);
      expect(response.metadata?.testCaseName).toBe(mockTestCase.name);
    });

    it('should include tool calls with proper structure', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute('mock://demo', request, mockAuth);

      const actionSteps = response.trajectory.filter(s => s.type === 'action');
      expect(actionSteps.length).toBeGreaterThan(0);
      expect(actionSteps[0].toolName).toBeDefined();
      expect(actionSteps[0].toolArgs).toBeDefined();
    });

    it('should include tool results with status', async () => {
      const request: ConnectorRequest = {
        testCase: mockTestCase,
        modelId: 'test-model',
      };

      const response = await connector.execute('mock://demo', request, mockAuth);

      const resultSteps = response.trajectory.filter(s => s.type === 'tool_result');
      expect(resultSteps.length).toBeGreaterThan(0);
      expect(resultSteps[0].status).toBe('SUCCESS');
    });
  });

  describe('parseResponse', () => {
    it('should extract steps from raw events', () => {
      const rawEvents = [
        { type: 'MOCK_STEP', step: { id: '1', type: 'thinking', content: 'test', timestamp: 123 } },
        { type: 'MOCK_STEP', step: { id: '2', type: 'response', content: 'done', timestamp: 456 } },
      ];

      const steps = connector.parseResponse(rawEvents);

      expect(steps).toHaveLength(2);
      expect(steps[0].id).toBe('1');
      expect(steps[1].id).toBe('2');
    });

    it('should filter out non-MOCK_STEP events', () => {
      const rawEvents = [
        { type: 'OTHER', data: 'ignored' },
        { type: 'MOCK_STEP', step: { id: '1', type: 'response', content: 'test', timestamp: 123 } },
      ];

      const steps = connector.parseResponse(rawEvents);

      expect(steps).toHaveLength(1);
    });

    it('should handle empty events', () => {
      const steps = connector.parseResponse([]);
      expect(steps).toEqual([]);
    });
  });

  describe('healthCheck', () => {
    it('should always return true for mock connector', async () => {
      const result = await connector.healthCheck('mock://demo', mockAuth);
      expect(result).toBe(true);
    });
  });

  describe('default instance', () => {
    it('should export a default instance', () => {
      expect(mockConnector).toBeInstanceOf(MockConnector);
    });
  });
});
