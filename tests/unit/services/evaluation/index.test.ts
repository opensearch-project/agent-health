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

      // When no runId, log fetch should be skipped (no warning logged)
      expect(openSearchClient.fetchLogsForRun).not.toHaveBeenCalled();
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
        'OpenSearch unavailable'
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

  describe('runEvaluationWithConnector', () => {
    // Import the function dynamically to test it
    let runEvaluationWithConnector: any;

    beforeEach(async () => {
      jest.resetModules();
      const module = await import('@/services/evaluation');
      runEvaluationWithConnector = module.runEvaluationWithConnector;
    });

    it('should execute evaluation using connector pattern', async () => {
      const mockConnector = {
        type: 'mock',
        execute: jest.fn().mockResolvedValue({
          trajectory: [
            { type: 'thinking', content: 'Test', timestamp: new Date().toISOString() },
            { type: 'response', content: 'Done', timestamp: new Date().toISOString() },
          ],
          runId: 'connector-run-123',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      const onStepMock = jest.fn();
      const result = await runEvaluationWithConnector(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      expect(result).toBeDefined();
      expect(result.status).toBe('completed');
      expect(result.trajectory).toHaveLength(2);
      expect(result.connectorProtocol).toBe('mock');
      expect(mockConnector.execute).toHaveBeenCalled();
    });

    it('should return pending status for trace mode agents', async () => {
      const traceAgent = {
        ...mockAgent,
        useTraces: true,
      };

      const mockConnector = {
        type: 'agui-streaming',
        execute: jest.fn().mockResolvedValue({
          trajectory: [{ type: 'response', content: 'Done', timestamp: new Date().toISOString() }],
          runId: 'trace-run-456',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      const onStepMock = jest.fn();
      const result = await runEvaluationWithConnector(
        traceAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      expect(result.status).toBe('completed');
      expect(result.metricsStatus).toBe('pending');
      expect(result.llmJudgeReasoning).toContain('Waiting for traces');
    });

    it('should handle connector execution errors', async () => {
      const mockConnector = {
        type: 'rest',
        execute: jest.fn().mockRejectedValue(new Error('Connection failed')),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      const onStepMock = jest.fn();
      const result = await runEvaluationWithConnector(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      expect(result.status).toBe('failed');
      expect(result.llmJudgeReasoning).toContain('Connection failed');
    });

    it('should call onRawEvent callback when provided', async () => {
      const mockConnector = {
        type: 'mock',
        execute: jest.fn().mockImplementation(async (_endpoint, _request, _auth, _onStep, onRawEvent) => {
          onRawEvent?.({ type: 'raw-event', data: 'test' });
          return {
            trajectory: [],
            runId: 'raw-event-run',
            rawEvents: [{ type: 'raw-event', data: 'test' }],
          };
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      const onStepMock = jest.fn();
      const onRawEventMock = jest.fn();
      await runEvaluationWithConnector(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        { registry: mockRegistry, onRawEvent: onRawEventMock }
      );

      expect(onRawEventMock).toHaveBeenCalledWith({ type: 'raw-event', data: 'test' });
    });

    it('should build bearer auth from Authorization header', async () => {
      const agentWithBearerAuth = {
        ...mockAgent,
        headers: { Authorization: 'Bearer my-token-123' },
      };

      const mockConnector = {
        type: 'rest',
        execute: jest.fn().mockResolvedValue({
          trajectory: [],
          runId: 'auth-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        agentWithBearerAuth,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      expect(mockConnector.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ type: 'bearer', token: 'my-token-123' }),
        expect.any(Function),
        undefined
      );
    });

    it('should build basic auth from Authorization header', async () => {
      const agentWithBasicAuth = {
        ...mockAgent,
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      };

      const mockConnector = {
        type: 'rest',
        execute: jest.fn().mockResolvedValue({
          trajectory: [],
          runId: 'basic-auth-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        agentWithBasicAuth,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      expect(mockConnector.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ type: 'basic', token: 'dXNlcjpwYXNz' }),
        expect.any(Function),
        undefined
      );
    });

    it('should build api-key auth from x-api-key header', async () => {
      const agentWithApiKey = {
        ...mockAgent,
        headers: { 'x-api-key': 'my-api-key-456' },
      };

      const mockConnector = {
        type: 'rest',
        execute: jest.fn().mockResolvedValue({
          trajectory: [],
          runId: 'api-key-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        agentWithApiKey,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      expect(mockConnector.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ type: 'api-key', token: 'my-api-key-456' }),
        expect.any(Function),
        undefined
      );
    });

    it('should pass hook-modified payload through to connector.execute()', async () => {
      // Hook modifies the payload (e.g., adds custom fields, modifies threadId)
      let hookReceivedPayload: any = null;
      const agentWithHook = {
        ...mockAgent,
        hooks: {
          beforeRequest: jest.fn().mockImplementation(async (context: any) => {
            hookReceivedPayload = context.payload;
            // Hook modifies the payload (simulating Pulsar thread creation)
            return {
              ...context,
              payload: {
                ...context.payload,
                customField: 'hook-added-value',
              },
            };
          }),
        },
      };

      const mockConnector = {
        type: 'mock',
        buildPayload: jest.fn().mockReturnValue({
          threadId: 'thread-generated-123',
          runId: 'run-generated-456',
          prompt: 'test',
        }),
        execute: jest.fn().mockResolvedValue({
          trajectory: [{ type: 'response', content: 'Done', timestamp: Date.now() }],
          runId: 'connector-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        agentWithHook,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      // Hook should have received the preview payload from buildPayload
      expect(hookReceivedPayload).toBeDefined();
      expect(hookReceivedPayload.threadId).toBe('thread-generated-123');

      // connector.execute() should receive the hook-modified payload in request.payload
      const executeCall = mockConnector.execute.mock.calls[0];
      const requestArg = executeCall[1];
      expect(requestArg.payload).toBeDefined();
      expect(requestArg.payload.threadId).toBe('thread-generated-123');
      expect(requestArg.payload.runId).toBe('run-generated-456');
      expect(requestArg.payload.customField).toBe('hook-added-value');
    });

    it('should pass unmodified payload when hook returns context unchanged', async () => {
      const agentWithHook = {
        ...mockAgent,
        hooks: {
          beforeRequest: jest.fn().mockImplementation(async (context: any) => context),
        },
      };

      const originalPayload = {
        threadId: 'thread-from-build',
        runId: 'run-from-build',
        prompt: 'test',
      };

      const mockConnector = {
        type: 'mock',
        buildPayload: jest.fn().mockReturnValue(originalPayload),
        execute: jest.fn().mockResolvedValue({
          trajectory: [],
          runId: 'connector-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        agentWithHook,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      // Even when hook doesn't modify, the payload should pass through
      const executeCall = mockConnector.execute.mock.calls[0];
      const requestArg = executeCall[1];
      expect(requestArg.payload).toBe(originalPayload);
    });

    it('should not call buildPayload when no hooks configured', async () => {
      const mockConnector = {
        type: 'mock',
        buildPayload: jest.fn(),
        execute: jest.fn().mockResolvedValue({
          trajectory: [],
          runId: 'no-hook-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        mockAgent,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      // buildPayload should NOT have been called directly (only execute calls it internally)
      expect(mockConnector.buildPayload).not.toHaveBeenCalled();
    });

    it('should pass through headers when no standard auth pattern', async () => {
      const agentWithCustomHeaders = {
        ...mockAgent,
        headers: { 'X-Custom-Header': 'custom-value' },
      };

      const mockConnector = {
        type: 'rest',
        execute: jest.fn().mockResolvedValue({
          trajectory: [],
          runId: 'custom-header-run',
          rawEvents: [],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      await runEvaluationWithConnector(
        agentWithCustomHeaders,
        'claude-3-sonnet',
        mockTestCase,
        jest.fn(),
        { registry: mockRegistry }
      );

      expect(mockConnector.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ type: 'none', headers: { 'X-Custom-Header': 'custom-value' } }),
        expect.any(Function),
        undefined
      );
    });

    it('should continue with pre-hook result when afterResponse hook throws', async () => {
      const agentWithAfterHook = {
        ...mockAgent,
        hooks: {
          afterResponse: jest.fn().mockRejectedValue(new Error('Hook exploded')),
        },
      };

      const originalTrajectory = [
        { type: 'response', content: 'Original from connector', timestamp: new Date().toISOString() },
      ];

      const mockConnector = {
        type: 'mock',
        execute: jest.fn().mockResolvedValue({
          trajectory: originalTrajectory,
          runId: 'hook-err-run',
          rawEvents: [{ type: 'test' }],
        }),
      };

      const mockRegistry = {
        getForAgent: jest.fn().mockReturnValue(mockConnector),
      };

      const onStepMock = jest.fn();
      const result = await runEvaluationWithConnector(
        agentWithAfterHook,
        'claude-3-sonnet',
        mockTestCase,
        onStepMock,
        { registry: mockRegistry }
      );

      // Should succeed with original trajectory, not fail
      expect(result.status).toBe('completed');
      expect(result.trajectory).toEqual(originalTrajectory);
      // Should have logged the hook error
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('afterResponse hook failed'),
        expect.stringContaining('Hook exploded')
      );
    });
  });
});
