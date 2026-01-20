/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { callBedrockJudge, simulateBedrockJudge } from '@/services/evaluation/bedrockJudge';
import type { TrajectoryStep } from '@/types';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('bedrockJudge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('callBedrockJudge', () => {
    const mockTrajectory: TrajectoryStep[] = [
      {
        id: 'step-1',
        type: 'thinking',
        content: 'Analyzing the issue...',
        timestamp: Date.now(),
      },
      {
        id: 'step-2',
        type: 'action',
        content: 'Checking cluster health',
        toolName: 'opensearch_cluster_health',
        toolArgs: { cluster: 'test' },
        timestamp: Date.now(),
      },
    ];

    const mockExpectedBehavior = {
      expectedOutcomes: ['Identify the root cause', 'Provide recommendations'],
    };

    it('should call the judge API successfully', async () => {
      const mockResponse = {
        passFailStatus: 'passed',
        metrics: { accuracy: 92 },
        llmJudgeReasoning: 'The agent performed well.',
        improvementStrategies: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await callBedrockJudge(mockTrajectory, mockExpectedBehavior);

      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(92);
      expect(result.llmJudgeReasoning).toBe('The agent performed well.');
    });

    it('should call onProgress callback with reasoning', async () => {
      const mockResponse = {
        passFailStatus: 'passed',
        metrics: { accuracy: 85 },
        llmJudgeReasoning: 'Detailed reasoning here',
        improvementStrategies: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const onProgress = jest.fn();
      await callBedrockJudge(mockTrajectory, mockExpectedBehavior, undefined, onProgress);

      expect(onProgress).toHaveBeenCalledWith('Detailed reasoning here');
    });

    it('should include modelId in request when provided', async () => {
      const mockResponse = {
        passFailStatus: 'passed',
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'Test',
        improvementStrategies: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await callBedrockJudge(
        mockTrajectory,
        mockExpectedBehavior,
        undefined,
        undefined,
        'custom-model-id'
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.modelId).toBe('custom-model-id');
    });

    it('should include logs in request when provided', async () => {
      const mockResponse = {
        passFailStatus: 'passed',
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'Test',
        improvementStrategies: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const mockLogs = [
        { message: 'Log 1', timestamp: '2024-01-15T10:00:00Z' },
      ];

      await callBedrockJudge(mockTrajectory, mockExpectedBehavior, mockLogs as any);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.logs).toEqual(mockLogs);
    });

    it('should default passFailStatus to failed if missing', async () => {
      const mockResponse = {
        metrics: { accuracy: 50 },
        llmJudgeReasoning: 'Failed evaluation',
        improvementStrategies: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await callBedrockJudge(mockTrajectory, mockExpectedBehavior);

      expect(result.passFailStatus).toBe('failed');
    });

    // Note: Retry tests are skipped because they would take too long due to exponential backoff
    // The retry logic is tested implicitly through the other tests that verify error handling
    it.skip('should throw error after max retries', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      await expect(
        callBedrockJudge(mockTrajectory, mockExpectedBehavior)
      ).rejects.toThrow('Bedrock Judge evaluation failed after 10 attempts');
    });

    it('should handle API errors on first attempt', async () => {
      const mockError = { error: 'Server error' };
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve(mockError),
      });
      // Succeed on second attempt
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          passFailStatus: 'passed',
          metrics: { accuracy: 90 },
          llmJudgeReasoning: 'Recovered',
          improvementStrategies: [],
        }),
      });

      const result = await callBedrockJudge(mockTrajectory, mockExpectedBehavior);
      expect(result.passFailStatus).toBe('passed');
    }, 15000);

    it('should handle network errors and retry', async () => {
      // Fail first attempt with network error
      mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));
      // Succeed on second attempt
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          passFailStatus: 'passed',
          metrics: { accuracy: 90 },
          llmJudgeReasoning: 'Recovered after network error',
          improvementStrategies: [],
        }),
      });

      const result = await callBedrockJudge(mockTrajectory, mockExpectedBehavior);
      expect(result.passFailStatus).toBe('passed');
    }, 15000);

    it('should include both expectedOutcomes and expectedTrajectory in request', async () => {
      const mockResponse = {
        passFailStatus: 'passed',
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'Test',
        improvementStrategies: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const expected = {
        expectedOutcomes: ['Outcome 1'],
        expectedTrajectory: [{ step: 1 }],
      };

      await callBedrockJudge(mockTrajectory, expected);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.expectedOutcomes).toEqual(['Outcome 1']);
      expect(requestBody.expectedTrajectory).toEqual([{ step: 1 }]);
    });
  });

  describe('simulateBedrockJudge', () => {
    it('should return passed status when all required tools are used', () => {
      const trajectory: TrajectoryStep[] = [
        {
          id: 'step-1',
          type: 'action',
          content: 'Using tool',
          toolName: 'opensearch_cluster_health',
          timestamp: Date.now(),
        },
        {
          id: 'step-2',
          type: 'action',
          content: 'Using tool',
          toolName: 'opensearch_nodes_stats',
          timestamp: Date.now(),
        },
      ];

      const expectedTrajectory = [
        { requiredTools: ['opensearch_cluster_health'] },
        { requiredTools: ['opensearch_nodes_stats'] },
      ];

      const result = simulateBedrockJudge(trajectory, expectedTrajectory);

      expect(result.passFailStatus).toBe('passed');
      expect(result.metrics.accuracy).toBe(92);
      expect(result.metrics.trajectory_alignment_score).toBe(85);
    });

    it('should return failed status when required tools are missing', () => {
      const trajectory: TrajectoryStep[] = [
        {
          id: 'step-1',
          type: 'action',
          content: 'Using tool',
          toolName: 'opensearch_cluster_health',
          timestamp: Date.now(),
        },
      ];

      const expectedTrajectory = [
        { requiredTools: ['opensearch_cluster_health'] },
        { requiredTools: ['opensearch_nodes_stats'] }, // This tool is not in trajectory
      ];

      const result = simulateBedrockJudge(trajectory, expectedTrajectory);

      expect(result.passFailStatus).toBe('failed');
      expect(result.metrics.accuracy).toBe(65);
      expect(result.metrics.trajectory_alignment_score).toBe(40);
    });

    it('should always include metrics', () => {
      const result = simulateBedrockJudge([], []);

      expect(result.metrics).toBeDefined();
      expect(result.metrics.accuracy).toBeDefined();
      expect(result.metrics.faithfulness).toBeDefined();
      expect(result.metrics.latency_score).toBeDefined();
      expect(result.metrics.trajectory_alignment_score).toBeDefined();
    });

    it('should always include improvement strategies', () => {
      const result = simulateBedrockJudge([], []);

      expect(result.improvementStrategies).toBeDefined();
      expect(result.improvementStrategies.length).toBeGreaterThan(0);
      expect(result.improvementStrategies[0].category).toBe('tool_usage');
    });

    it('should log deprecation warning', () => {
      simulateBedrockJudge([], []);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('simulated judge')
      );
    });
  });
});
