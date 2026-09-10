/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for evaluation service debugging enhancements
 */

import { jest } from '@jest/globals';

// Mock debug function
const mockDebug = jest.fn();
jest.mock('@/lib/debug', () => ({
  debug: mockDebug,
  isDebugEnabled: jest.fn().mockReturnValue(false),
}));

// Mock connector registry
const mockExecute = jest.fn();
const mockBuildPayload = jest.fn().mockReturnValue({ test: 'payload' });
const mockConnectorRegistry = {
  getForAgent: jest.fn().mockReturnValue({
    type: 'agui-streaming',
    execute: mockExecute,
    buildPayload: mockBuildPayload,
  }),
};

jest.mock('@/connectors/registry', () => ({
  connectorRegistry: mockConnectorRegistry,
}));

// Mock other dependencies
jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn(),
}));

describe('Evaluation Service Debug Enhancements', () => {
  let runEvaluationWithConnector: any;
  let callBedrockJudge: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await import('@/services/evaluation/index');
    runEvaluationWithConnector = module.runEvaluationWithConnector;
    const judgeModule = await import('@/services/evaluation/bedrockJudge');
    callBedrockJudge = judgeModule.callBedrockJudge;
  });

  describe('Error logging', () => {
    it('should log detailed error information on connector failure', async () => {
      const error = new Error('Connection refused');
      error.name = 'NetworkError';
      (error as any).cause = 'ECONNREFUSED';

      mockExecute.mockRejectedValueOnce(error);

      const testCase = {
        id: 'tc-1',
        name: 'Test Case',
        initialPrompt: 'Test prompt',
        expectedOutcomes: [],
      };

      const agent = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com/agent',
        connectorType: 'agui-streaming',
      };

      const result = await runEvaluationWithConnector(
        agent as any,
        'test-model',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      // Should return a failed report instead of throwing
      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('Connection refused');

      // Verify detailed error logging
      expect(mockDebug).toHaveBeenCalledWith('Eval', 'Error details:', expect.objectContaining({
        name: 'NetworkError',
        message: 'Connection refused',
        cause: 'ECONNREFUSED',
        agent: 'Test Agent',
        endpoint: 'http://test.com/agent',
        modelId: 'test-model',
        testCaseId: 'tc-1',
      }));
    });

    it('should handle non-Error thrown values', async () => {
      mockExecute.mockRejectedValueOnce('string error message');

      const testCase = {
        id: 'tc-2',
        name: 'Test Case 2',
        initialPrompt: 'Test prompt',
        expectedOutcomes: [],
      };

      const agent = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com/agent',
        connectorType: 'agui-streaming',
      };

      const result = await runEvaluationWithConnector(
        agent as any,
        'test-model',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      expect(result.status).toBe('failed');
      expect(mockDebug).toHaveBeenCalledWith('Eval', 'Unknown error:', 'string error message');
    });

    it('should log connector type on error', async () => {
      const error = new Error('Agent timeout');
      mockExecute.mockRejectedValueOnce(error);

      const testCase = {
        id: 'tc-3',
        name: 'Test Case 3',
        initialPrompt: 'Test prompt',
        expectedOutcomes: [],
      };

      const agent = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com/agent',
        connectorType: 'agui-streaming',
      };

      const result = await runEvaluationWithConnector(
        agent as any,
        'test-model',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      expect(result.status).toBe('failed');
      expect(mockDebug).toHaveBeenCalledWith('Eval', 'Connector type:', 'agui-streaming');
    });

    it('should handle connector registry lookup failure', async () => {
      mockConnectorRegistry.getForAgent.mockImplementation(() => {
        throw new Error('Connector not found');
      });

      const testCase = {
        id: 'tc-4',
        name: 'Test Case 4',
        initialPrompt: 'Test prompt',
        expectedOutcomes: [],
      };

      const agent = {
        key: 'unknown-agent',
        name: 'Unknown Agent',
        endpoint: 'http://test.com/agent',
        connectorType: 'unknown',
      };

      const result = await runEvaluationWithConnector(
        agent as any,
        'test-model',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      expect(result.status).toBe('failed');
      expect(mockDebug).toHaveBeenCalledWith('Eval', 'Failed to get connector type:', expect.any(Error));

      // Restore mock for other tests
      mockConnectorRegistry.getForAgent.mockReturnValue({
        type: 'agui-streaming',
        execute: mockExecute,
        buildPayload: mockBuildPayload,
      });
    });
  });

  describe('Stack trace logging', () => {
    it('should include stack trace in error details', async () => {
      const error = new Error('Test error with stack');
      error.stack = 'Error: Test error\n    at test.ts:123:45';

      mockExecute.mockRejectedValueOnce(error);

      const testCase = {
        id: 'tc-5',
        name: 'Test Case 5',
        initialPrompt: 'Test prompt',
        expectedOutcomes: [],
      };

      const agent = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com/agent',
        connectorType: 'agui-streaming',
      };

      const result = await runEvaluationWithConnector(
        agent as any,
        'test-model',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      expect(result.status).toBe('failed');
      expect(mockDebug).toHaveBeenCalledWith('Eval', 'Error details:', expect.objectContaining({
        stack: expect.stringContaining('test.ts:123:45'),
      }));
    });
  });

  describe('Context logging', () => {
    it('should log agent and test case context on error', async () => {
      const error = new Error('Evaluation failed');
      mockExecute.mockRejectedValueOnce(error);

      const testCase = {
        id: 'tc-context',
        name: 'Context Test Case',
        initialPrompt: 'Test prompt',
        expectedOutcomes: ['outcome1', 'outcome2'],
      };

      const agent = {
        key: 'context-agent',
        name: 'Context Agent',
        endpoint: 'http://context.com/agent',
        connectorType: 'rest',
      };

      const result = await runEvaluationWithConnector(
        agent as any,
        'claude-4',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      expect(result.status).toBe('failed');

      const errorDetailsCall = mockDebug.mock.calls.find(
        (call) => call[0] === 'Eval' && call[1] === 'Error details:'
      );

      expect(errorDetailsCall).toBeDefined();
      expect(errorDetailsCall![2]).toEqual(expect.objectContaining({
        agent: 'Context Agent',
        endpoint: 'http://context.com/agent',
        modelId: 'claude-4',
        testCaseId: 'tc-context',
      }));
    });
  });

  describe('Success path', () => {
    it('should not log errors on successful evaluation', async () => {
      const mockResponse = {
        trajectory: [
          { type: 'thinking', content: 'Analyzing...' },
          { type: 'response', content: 'Done' },
        ],
        metadata: {},
        rawEvents: [],
      };

      const mockJudgment = {
        passFailStatus: 'passed',
        metrics: {
          accuracy: 0.9,
          faithfulness: 0.85,
          latency_score: 0.95,
          trajectory_alignment_score: 0.88,
        },
        reasoning: 'Test passed successfully',
        improvementStrategies: [],
      };

      mockExecute.mockResolvedValueOnce(mockResponse);
      (callBedrockJudge as jest.Mock).mockResolvedValueOnce(mockJudgment);

      const testCase = {
        id: 'tc-success',
        name: 'Success Test',
        initialPrompt: 'Test prompt',
        expectedOutcomes: [],
      };

      const agent = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com/agent',
        connectorType: 'agui-streaming',
      };

      await runEvaluationWithConnector(
        agent as any,
        'test-model',
        testCase as any,
        jest.fn(),
        { registry: mockConnectorRegistry }
      );

      // Should not log error details on success
      const errorDetailsCall = mockDebug.mock.calls.find(
        (call) => call[0] === 'Eval' && call[1] === 'Error details:'
      );

      expect(errorDetailsCall).toBeUndefined();
    });
  });
});
