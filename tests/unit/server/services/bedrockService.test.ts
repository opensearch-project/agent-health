/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock the Bedrock client BEFORE imports
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input) => input),
}));

// Mock the config
jest.mock('@/server/config', () => ({
  default: {
    AWS_REGION: 'us-east-1',
    BEDROCK_MODEL_ID: 'anthropic.claude-3-5-sonnet-v1',
  },
}));

import {
  truncateString,
  compactTrajectory,
  buildEvaluationPrompt,
  evaluateTrajectory,
  parseBedrockError,
  JudgeRequest,
} from '@/server/services/bedrockService';
import { TrajectoryStep } from '@/types';

// Helper to create a valid TrajectoryStep with optional overrides
const createStep = (overrides: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'type'>): TrajectoryStep => ({
  id: `step-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  content: '',
  ...overrides,
});

describe('BedrockService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('truncateString', () => {
    it('should return empty string for null or undefined', () => {
      expect(truncateString(null)).toBe('');
      expect(truncateString(undefined)).toBe('');
    });

    it('should return original string if shorter than max length', () => {
      const short = 'short string';
      expect(truncateString(short, 100)).toBe(short);
    });

    it('should truncate string longer than max length', () => {
      const long = 'a'.repeat(200);
      const result = truncateString(long, 100);

      expect(result).toHaveLength(100 + '... [truncated 100 chars]'.length);
      expect(result).toContain('... [truncated 100 chars]');
    });

    it('should use default max length of 1000', () => {
      const long = 'a'.repeat(1500);
      const result = truncateString(long);

      expect(result).toContain('... [truncated 500 chars]');
    });

    it('should return exactly max length content plus truncation message', () => {
      const long = 'a'.repeat(50);
      const result = truncateString(long, 30);

      expect(result.startsWith('a'.repeat(30))).toBe(true);
      expect(result).toContain('[truncated 20 chars]');
    });
  });

  describe('compactTrajectory', () => {
    it('should truncate long content fields', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'action', content: 'a'.repeat(1000) }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].content).toContain('[truncated');
      expect((result[0].content as string).length).toBeLessThan(1000);
    });

    it('should truncate long string toolOutput', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'tool_result', content: '', toolOutput: 'b'.repeat(2000) }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].toolOutput).toContain('[truncated');
    });

    it('should truncate object toolOutput as JSON', () => {
      const largeObject = { data: 'x'.repeat(2000) };
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'tool_result', content: '', toolOutput: largeObject as any }),
      ];

      const result = compactTrajectory(trajectory);

      expect(typeof result[0].toolOutput).toBe('string');
      expect(result[0].toolOutput).toContain('[truncated');
    });

    it('should preserve short content', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'thinking', content: 'short content' }),
      ];

      const result = compactTrajectory(trajectory);

      expect(result[0].content).toBe('short content');
    });

    it('should not modify original trajectory', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'action', content: 'a'.repeat(1000) }),
      ];
      const originalLength = (trajectory[0].content as string).length;

      compactTrajectory(trajectory);

      expect(trajectory[0].content).toHaveLength(originalLength);
    });
  });

  describe('buildEvaluationPrompt', () => {
    it('should include trajectory in JSON format', () => {
      const trajectory: TrajectoryStep[] = [
        createStep({ type: 'action', toolName: 'cluster_health', content: 'test' }),
      ];

      const result = buildEvaluationPrompt(trajectory);

      expect(result).toContain('Actual Agent Trajectory');
      expect(result).toContain('cluster_health');
    });

    it('should include expected outcomes when provided', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const expectedOutcomes = ['Check cluster health', 'Identify root cause'];

      const result = buildEvaluationPrompt(trajectory, expectedOutcomes);

      expect(result).toContain('Expected Outcomes');
      expect(result).toContain('1. Check cluster health');
      expect(result).toContain('2. Identify root cause');
    });

    it('should include legacy expected trajectory when no outcomes', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const expectedTrajectory = [{ description: 'Step 1', requiredTools: ['tool1'] }];

      const result = buildEvaluationPrompt(trajectory, undefined, expectedTrajectory);

      expect(result).toContain('Expected Trajectory (Legacy)');
      expect(result).toContain('Step 1');
    });

    it('should show "No expected outcomes" when neither provided', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];

      const result = buildEvaluationPrompt(trajectory);

      expect(result).toContain('No expected outcomes defined');
    });

    it('should include logs when provided', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const logs = [{ timestamp: '2024-01-01', message: 'Test log' }];

      const result = buildEvaluationPrompt(trajectory, undefined, undefined, logs);

      expect(result).toContain('Test log');
    });

    it('should limit logs to 20', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];
      const logs = Array(30).fill(null).map((_, i) => ({ id: i, message: `Log ${i}` }));

      const result = buildEvaluationPrompt(trajectory, undefined, undefined, logs);

      expect(result).toContain('Log 19');
      expect(result).not.toContain('Log 20');
    });

    it('should show "No logs available" when empty', () => {
      const trajectory: TrajectoryStep[] = [createStep({ type: 'action' })];

      const result = buildEvaluationPrompt(trajectory, undefined, undefined, []);

      expect(result).toContain('No logs available');
    });
  });

  describe('evaluateTrajectory', () => {
    it('should call Bedrock API with correct parameters', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 0.9, "reasoning": "Good"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action', toolName: 'test' })],
        expectedOutcomes: ['Test outcome'],
      };

      await evaluateTrajectory(request);

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should use provided model ID', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 0.9, "reasoning": "Good"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      await evaluateTrajectory(request, 'custom-model-id');

      const calledWith = mockSend.mock.calls[0][0];
      expect(calledWith.modelId).toBe('custom-model-id');
    });

    it('should return structured response', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "accuracy": 0.95, "reasoning": "Excellent work", "improvement_strategies": ["Try X"]}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
        expectedOutcomes: ['Test'],
      };

      const result = await evaluateTrajectory(request);

      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(0.95);
      expect(result.llmJudgeReasoning).toBe('Excellent work');
      expect(result.improvementStrategies).toContain('Try X');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle JSON in markdown code block', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '```json\n{"pass_fail_status": "failed", "accuracy": 0.5, "reasoning": "Needs work"}\n```' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.passFailStatus).toBe('failed');
      expect(result.metrics.accuracy).toBe(0.5);
    });

    it('should handle metrics in nested object (legacy format)', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "passed", "metrics": {"accuracy": 0.8, "faithfulness": 0.9}, "reasoning": "OK"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.metrics.accuracy).toBe(0.8);
      expect(result.metrics.faithfulness).toBe(0.9);
    });

    it('should default accuracy to 0 when missing', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"pass_fail_status": "failed", "reasoning": "No data"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.metrics.accuracy).toBe(0);
    });

    it('should default passFailStatus to failed when missing', async () => {
      mockSend.mockResolvedValue({
        output: {
          message: {
            content: [{ text: '{"accuracy": 0.5, "reasoning": "OK"}' }],
          },
        },
      });

      const request: JudgeRequest = {
        trajectory: [createStep({ type: 'action' })],
      };

      const result = await evaluateTrajectory(request);

      expect(result.passFailStatus).toBe('failed');
    });
  });

  describe('parseBedrockError', () => {
    it('should identify expired token error', () => {
      const error = new Error('ExpiredToken: The security token included in the request is expired');

      const result = parseBedrockError(error);

      expect(result).toContain('credentials expired');
    });

    it('should identify credentials provider error', () => {
      const error = new Error('CredentialsProviderError: Could not load credentials');

      const result = parseBedrockError(error);

      expect(result).toContain('credentials expired');
    });

    it('should identify throttling error', () => {
      const error = new Error('ThrottlingException: Rate exceeded');

      const result = parseBedrockError(error);

      expect(result).toContain('rate limit');
    });

    it('should identify validation error', () => {
      const error = new Error('ValidationException: Invalid model');

      const result = parseBedrockError(error);

      expect(result).toContain('Invalid request');
    });

    it('should identify JSON parse error', () => {
      const error = new Error('Unexpected token at position 0 in JSON');

      const result = parseBedrockError(error);

      expect(result).toContain('parse LLM judge response');
    });

    it('should return original message for unknown errors', () => {
      const error = new Error('Some unknown error');

      const result = parseBedrockError(error);

      expect(result).toBe('Some unknown error');
    });

    it('should return "Unknown error" for empty message', () => {
      const error = new Error('');

      const result = parseBedrockError(error);

      expect(result).toBe('Unknown error occurred');
    });
  });
});
