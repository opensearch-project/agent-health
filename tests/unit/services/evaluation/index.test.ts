/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { runEvaluation, callBedrockJudge } from '@/services/evaluation';
import type { AgentConfig, TestCase, TrajectoryStep } from '@/types';

// Mock dependencies
jest.mock('@/services/agent', () => ({
  AGUIToTrajectoryConverter: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockReturnValue([]),
    getRunId: jest.fn().mockReturnValue('mock-run-id'),
  })),
  consumeSSEStream: jest.fn().mockResolvedValue(undefined),
  buildAgentPayload: jest.fn().mockReturnValue({ prompt: 'test' }),
}));

jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn().mockResolvedValue({
    passFailStatus: 'passed',
    metrics: {
      accuracy: 0.9,
      faithfulness: 0.85,
      latency_score: 0.8,
      trajectory_alignment_score: 0.75,
    },
    llmJudgeReasoning: 'Test reasoning',
    improvementStrategies: [],
  }),
}));

jest.mock('@/services/opensearch', () => ({
  openSearchClient: {
    fetchLogsForRun: jest.fn().mockResolvedValue([
      { timestamp: '2024-01-01T00:00:00Z', message: 'test log' },
    ]),
  },
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-123'),
}));

describe('Evaluation Service Index', () => {
  const mockAgent: AgentConfig = {
    key: 'test-agent',
    name: 'Test Agent',
    endpoint: 'http://localhost:3000/agent',
    protocol: 'agui' as const,
    models: ['claude-3-sonnet'],
    type: 'langgraph',
    useTraces: false,
  };

  const mockTestCase: TestCase = {
    id: 'test-case-1',
    name: 'Test Case',
    prompt: 'Test prompt',
    context: 'Test context',
    expectedOutcomes: ['Outcome 1', 'Outcome 2'],
    currentVersion: 1,
    labels: [],
    versions: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  let consoleInfoSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('runEvaluation', () => {
    it('should run real agent evaluation and return report', async () => {
      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');
      const { callBedrockJudge } = require('@/services/evaluation/bedrockJudge');

      // Setup mock to emit trajectory steps
      const mockConverter = {
        processEvent: jest.fn().mockReturnValue([
          { type: 'thinking', content: 'Test thinking', timestamp: new Date().toISOString() },
        ]),
        getRunId: jest.fn().mockReturnValue('run-123'),
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);

      consumeSSEStream.mockImplementation(async (_url: string, _payload: unknown, onEvent: (event: unknown) => void) => {
        // Simulate events
        onEvent({ type: 'RUN_STARTED', runId: 'run-123' });
        onEvent({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Test' });
      });

      const onStepMock = jest.fn();
      const onRawEventMock = jest.fn();

      const result = await runEvaluation(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        onRawEventMock
      );

      expect(result).toBeDefined();
      expect(result.id).toBe('test-uuid-123');
      expect(result.agentName).toBe('Test Agent');
      expect(result.testCaseId).toBe('test-case-1');
      expect(result.status).toBe('completed');
      expect(callBedrockJudge).toHaveBeenCalled();
    });

    it('should handle trace mode (useTraces=true)', async () => {
      const traceAgent: AgentConfig = {
        ...mockAgent,
        useTraces: true,
      };

      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');

      const mockConverter = {
        processEvent: jest.fn().mockReturnValue([]),
        getRunId: jest.fn().mockReturnValue('run-456'),
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);
      consumeSSEStream.mockResolvedValue(undefined);

      const onStepMock = jest.fn();
      const result = await runEvaluation(
        traceAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock
      );

      expect(result.status).toBe('completed');
      expect(result.metricsStatus).toBe('pending');
      expect(result.llmJudgeReasoning).toContain('traces');
      expect(result.runId).toBe('run-456');

      // Judge should NOT be called in trace mode
      const { callBedrockJudge } = require('@/services/evaluation/bedrockJudge');
      expect(callBedrockJudge).not.toHaveBeenCalled();
    });

    it('should handle evaluation errors gracefully', async () => {
      const { consumeSSEStream } = require('@/services/agent');

      consumeSSEStream.mockRejectedValue(new Error('Agent connection failed'));

      const onStepMock = jest.fn();
      const result = await runEvaluation(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock
      );

      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('Evaluation failed');
      expect(result.llmJudgeReasoning).toContain('Agent connection failed');
      expect(result.metrics.accuracy).toBe(0);
    });

    it('should skip log fetch when no runId is captured', async () => {
      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');
      const { openSearchClient } = require('@/services/opensearch');

      const mockConverter = {
        processEvent: jest.fn().mockReturnValue([]),
        getRunId: jest.fn().mockReturnValue(null), // No runId
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);
      consumeSSEStream.mockResolvedValue(undefined);

      const onStepMock = jest.fn();
      await runEvaluation(mockAgent, 'claude-3-sonnet', mockTestCase, onStepMock);

      expect(openSearchClient.fetchLogsForRun).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No runId captured')
      );
    });

    it('should handle log fetch errors gracefully', async () => {
      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');
      const { openSearchClient } = require('@/services/opensearch');

      const mockConverter = {
        processEvent: jest.fn().mockReturnValue([]),
        getRunId: jest.fn().mockReturnValue('run-789'),
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);
      consumeSSEStream.mockResolvedValue(undefined);
      openSearchClient.fetchLogsForRun.mockRejectedValue(new Error('OpenSearch unavailable'));

      const onStepMock = jest.fn();
      const result = await runEvaluation(mockAgent, 'claude-3-sonnet', mockTestCase, onStepMock);

      // Should still complete despite log fetch failure
      expect(result.status).toBe('completed');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch logs'),
        expect.any(Error)
      );
    });

    it('should capture raw events when callback provided', async () => {
      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');

      const mockConverter = {
        processEvent: jest.fn().mockReturnValue([]),
        getRunId: jest.fn().mockReturnValue('run-abc'),
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);

      const capturedEvents: unknown[] = [];
      consumeSSEStream.mockImplementation(async (_url: string, _payload: unknown, onEvent: (event: unknown) => void) => {
        const testEvent = { type: 'TEST_EVENT', data: 'test' };
        onEvent(testEvent);
      });

      const onStepMock = jest.fn();
      const onRawEventMock = jest.fn((event) => capturedEvents.push(event));

      const result = await runEvaluation(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        onRawEventMock
      );

      expect(onRawEventMock).toHaveBeenCalled();
      expect(result.rawEvents).toBeDefined();
      expect(result.rawEvents).toHaveLength(1);
    });

    it('should include LLM judge response in report', async () => {
      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');

      const mockConverter = {
        processEvent: jest.fn().mockReturnValue([]),
        getRunId: jest.fn().mockReturnValue('run-def'),
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);
      consumeSSEStream.mockResolvedValue(undefined);

      const onStepMock = jest.fn();
      const result = await runEvaluation(mockAgent, 'claude-3-sonnet', mockTestCase, onStepMock);

      expect(result.llmJudgeResponse).toBeDefined();
      expect(result.llmJudgeResponse?.modelId).toBeDefined();
      expect(result.llmJudgeResponse?.parsedMetrics).toBeDefined();
      expect(result.passFailStatus).toBe('passed');
    });

    it('should count trajectory step types correctly', async () => {
      const { consumeSSEStream, AGUIToTrajectoryConverter } = require('@/services/agent');

      const mockSteps: TrajectoryStep[] = [
        { type: 'thinking', content: 'Thinking...', timestamp: new Date().toISOString() },
        { type: 'action', toolName: 'search', toolArgs: {}, timestamp: new Date().toISOString() },
        { type: 'tool_result', toolName: 'search', result: 'result', status: 'SUCCESS', timestamp: new Date().toISOString() },
        { type: 'response', content: 'Final answer', timestamp: new Date().toISOString() },
      ];

      let stepIndex = 0;
      const mockConverter = {
        processEvent: jest.fn().mockImplementation(() => {
          if (stepIndex < mockSteps.length) {
            return [mockSteps[stepIndex++]];
          }
          return [];
        }),
        getRunId: jest.fn().mockReturnValue('run-ghi'),
      };
      AGUIToTrajectoryConverter.mockImplementation(() => mockConverter);

      consumeSSEStream.mockImplementation(async (_url: string, _payload: unknown, onEvent: (event: unknown) => void) => {
        // Emit 4 events to trigger 4 steps
        onEvent({ type: 'EVENT1' });
        onEvent({ type: 'EVENT2' });
        onEvent({ type: 'EVENT3' });
        onEvent({ type: 'EVENT4' });
      });

      const onStepMock = jest.fn();
      const result = await runEvaluation(mockAgent, 'claude-3-sonnet', mockTestCase, onStepMock);

      expect(onStepMock).toHaveBeenCalledTimes(4);
      expect(result.trajectory).toHaveLength(4);
    });
  });

  describe('callBedrockJudge re-export', () => {
    it('should re-export callBedrockJudge from bedrockJudge module', () => {
      expect(callBedrockJudge).toBeDefined();
      expect(typeof callBedrockJudge).toBe('function');
    });
  });
});
