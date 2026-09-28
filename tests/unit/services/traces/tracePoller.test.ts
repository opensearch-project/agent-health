/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { EvaluationReport, Span } from '@/types';
import { tracePollingManager, PollCallbacks } from '@/services/traces/tracePoller';
import { fetchTracesForRun } from '@/services/traces';
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { executeBuildTrajectoryHook } from '@/lib/hooks';

// Mock dependencies
jest.mock('@/services/traces/index', () => ({
  fetchTracesForRun: jest.fn(),
}));

jest.mock('@/services/storage/asyncRunStorage', () => ({
  asyncRunStorage: {
    updateReport: jest.fn(),
    getReportById: jest.fn(),
  },
}));

jest.mock('@/lib/hooks', () => ({
  executeBuildTrajectoryHook: jest.fn(),
}));

const mockFetchTracesForRun = fetchTracesForRun as jest.MockedFunction<typeof fetchTracesForRun>;
const mockUpdateReport = asyncRunStorage.updateReport as jest.MockedFunction<typeof asyncRunStorage.updateReport>;
const mockGetReportById = asyncRunStorage.getReportById as jest.MockedFunction<typeof asyncRunStorage.getReportById>;
const mockExecuteBuildTrajectoryHook = executeBuildTrajectoryHook as jest.MockedFunction<typeof executeBuildTrajectoryHook>;

describe('TracePollingManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset any active polls
    const activePolls = tracePollingManager.getAllActivePolls();
    activePolls.forEach((_, reportId) => {
      tracePollingManager.stopPolling(reportId);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    // Clean up any remaining polls
    const activePolls = tracePollingManager.getAllActivePolls();
    activePolls.forEach((_, reportId) => {
      tracePollingManager.stopPolling(reportId);
    });
  });

  describe('startPolling', () => {
    it('creates a poll state for new report', async () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-1', 'run-1', callbacks);

      const state = tracePollingManager.getState('report-1');
      expect(state).toBeDefined();
      expect(state?.reportId).toBe('report-1');
      expect(state?.runId).toBe('run-1');
      expect(state?.running).toBe(true);
      // First poll starts immediately after startPolling, so attempts is 1
      expect(state?.attempts).toBeGreaterThanOrEqual(1);
    });

    it('does not start duplicate polling for same report', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-1', 'run-1', callbacks);
      tracePollingManager.startPolling('report-1', 'run-1', callbacks);

      // Should only have one poll
      const activePolls = tracePollingManager.getAllActivePolls();
      expect(activePolls.size).toBe(1);
    });

    it('uses custom options when provided', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-2', 'run-2', callbacks, {
        intervalMs: 5000,
        maxAttempts: 10,
      });

      const state = tracePollingManager.getState('report-2');
      expect(state?.intervalMs).toBe(5000);
      expect(state?.maxAttempts).toBe(10);
    });
  });

  describe('stopPolling', () => {
    it('stops an active poll', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-3', 'run-3', callbacks);
      expect(tracePollingManager.getState('report-3')?.running).toBe(true);

      tracePollingManager.stopPolling('report-3');
      // After stopPolling, state should be completely removed (memory cleanup)
      expect(tracePollingManager.getState('report-3')).toBeUndefined();
    });

    it('handles stopping non-existent poll gracefully', () => {
      expect(() => {
        tracePollingManager.stopPolling('non-existent');
      }).not.toThrow();
    });

    it('cleans up memory after manual stop', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-mem-1', 'run-mem-1', callbacks);
      expect(tracePollingManager.getState('report-mem-1')).toBeDefined();

      tracePollingManager.stopPolling('report-mem-1');

      // Verify complete cleanup - getState should return undefined
      expect(tracePollingManager.getState('report-mem-1')).toBeUndefined();
    });

    it('rejects completion promise when stopPolling is called on async poll', async () => {
      mockFetchTracesForRun.mockResolvedValue({ spans: [] });
      mockUpdateReport.mockResolvedValue(undefined);

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      const promise = tracePollingManager.startPollingAsync(
        'report-stop-async', 'run-stop', callbacks,
        { intervalMs: 10000, maxAttempts: 30 }
      );

      // Catch rejection before stopping
      let rejectedError: Error | undefined;
      const handled = promise.catch((err) => { rejectedError = err; });

      // Stop polling - should reject the promise
      tracePollingManager.stopPolling('report-stop-async');
      await handled;

      expect(rejectedError).toBeDefined();
      expect(rejectedError!.message).toContain('Polling stopped');
    });
  });

  describe('getState', () => {
    it('returns undefined for non-existent poll', () => {
      expect(tracePollingManager.getState('non-existent')).toBeUndefined();
    });

    it('returns state for existing poll', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-4', 'run-4', callbacks);

      const state = tracePollingManager.getState('report-4');
      expect(state).toBeDefined();
      expect(state?.reportId).toBe('report-4');
    });
  });

  describe('getAllActivePolls', () => {
    it('returns only active polls', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-5', 'run-5', callbacks);
      tracePollingManager.startPolling('report-6', 'run-6', callbacks);
      tracePollingManager.stopPolling('report-6');

      const activePolls = tracePollingManager.getAllActivePolls();
      expect(activePolls.size).toBe(1);
      expect(activePolls.has('report-5')).toBe(true);
      expect(activePolls.has('report-6')).toBe(false);
    });
  });

  describe('polling behavior', () => {
    it('calls onTracesFound when traces are available', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-7',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [],
        metrics: {
          accuracy: 0.95,
          faithfulness: 0.9,
          latency_score: 0.85,
          trajectory_alignment_score: 0.88,
        },
        llmJudgeReasoning: 'Test reasoning',
      };

      const onTracesFound = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValueOnce({ spans: mockSpans, total: mockSpans.length });
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValueOnce(mockReport);

      tracePollingManager.startPolling('report-7', 'run-7', callbacks);

      // Wait for the async poll to complete
      await jest.runAllTimersAsync();

      expect(onTracesFound).toHaveBeenCalledWith(mockSpans, mockReport);
    });

    it('increments attempts and schedules retry when no traces found', async () => {
      const onAttempt = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
        onAttempt,
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-8', 'run-8', callbacks, {
        intervalMs: 1000,
        maxAttempts: 3,
      });

      // First attempt
      await jest.advanceTimersByTimeAsync(0);
      expect(onAttempt).toHaveBeenCalledWith(1, 3);

      // Second attempt after interval
      await jest.advanceTimersByTimeAsync(1000);
      expect(onAttempt).toHaveBeenCalledWith(2, 3);

      const state = tracePollingManager.getState('report-8');
      expect(state?.attempts).toBe(2);
    });

    it('calls onError when max attempts reached', async () => {
      const onError = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError,
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-9', 'run-9', callbacks, {
        intervalMs: 1000,
        maxAttempts: 2,
      });

      // Run through all attempts
      await jest.advanceTimersByTimeAsync(0); // First attempt
      await jest.advanceTimersByTimeAsync(1000); // Second attempt (max)

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toContain('not available after 2 attempts');
    });

    it('handles fetch errors and retries', async () => {
      const onError = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError,
      };

      mockFetchTracesForRun.mockRejectedValue(new Error('Network error'));
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-10', 'run-10', callbacks, {
        intervalMs: 1000,
        maxAttempts: 2,
      });

      // First attempt - should fail but retry
      await jest.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled();

      // Second attempt - max reached, should call onError
      await jest.advanceTimersByTimeAsync(1000);
      expect(onError).toHaveBeenCalled();
    });

    it('updates report with error status when max attempts reached', async () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-11', 'run-11', callbacks, {
        intervalMs: 1000,
        maxAttempts: 1,
      });

      await jest.advanceTimersByTimeAsync(0);

      // Check that updateReport was called with error status
      expect(mockUpdateReport).toHaveBeenCalledWith(
        'report-11',
        expect.objectContaining({
          metricsStatus: 'error',
          traceError: expect.stringContaining('not available'),
        })
      );
    });

    it('cleans up memory when traces are found', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-mem',
          spanId: 'span-mem',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-mem-traces',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [],
        metrics: { accuracy: 0.95 },
        llmJudgeReasoning: 'Test reasoning',
      };

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValueOnce({ spans: mockSpans, total: mockSpans.length });
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValueOnce(mockReport);

      tracePollingManager.startPolling('report-mem-traces', 'run-mem-traces', callbacks);
      expect(tracePollingManager.getState('report-mem-traces')).toBeDefined();

      // Wait for the async poll to complete
      await jest.runAllTimersAsync();

      // Verify complete cleanup after traces found
      expect(tracePollingManager.getState('report-mem-traces')).toBeUndefined();
    });

    it('cleans up memory when max attempts reached', async () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-mem-max', 'run-mem-max', callbacks, {
        intervalMs: 1000,
        maxAttempts: 1,
      });

      expect(tracePollingManager.getState('report-mem-max')).toBeDefined();

      // Run through max attempts
      await jest.advanceTimersByTimeAsync(0);

      // Verify complete cleanup after max attempts
      expect(tracePollingManager.getState('report-mem-max')).toBeUndefined();
    });

    it('writes error status when onTracesFound callback throws', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-cb-err',
          spanId: 'span-cb-err',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-cb-err',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [],
        metrics: { accuracy: 0.95 },
        llmJudgeReasoning: 'Test reasoning',
      };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const onTracesFound = jest.fn().mockRejectedValue(new Error('Judge failed'));
      const onError = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError,
      };

      mockFetchTracesForRun.mockResolvedValueOnce({ spans: mockSpans, total: mockSpans.length });
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValueOnce(mockReport);

      tracePollingManager.startPolling('report-cb-err', 'run-cb-err', callbacks);

      await jest.runAllTimersAsync();

      // onTracesFound was called and threw
      expect(onTracesFound).toHaveBeenCalledWith(mockSpans, mockReport);

      // Should write error status to prevent stuck pending
      expect(mockUpdateReport).toHaveBeenCalledWith(
        'report-cb-err',
        expect.objectContaining({
          metricsStatus: 'error',
          traceError: expect.stringContaining('Judge failed'),
        })
      );

      // Should clean up polling state
      expect(tracePollingManager.getState('report-cb-err')).toBeUndefined();

      consoleErrorSpy.mockRestore();
    });

    it('handles both onTracesFound and error status update failing', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-double-err',
          spanId: 'span-double-err',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-double-err',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [],
        metrics: { accuracy: 0.95 },
        llmJudgeReasoning: 'Test reasoning',
      };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const onTracesFound = jest.fn().mockRejectedValue(new Error('Judge failed'));
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValueOnce({ spans: mockSpans, total: mockSpans.length });
      mockGetReportById.mockResolvedValueOnce(mockReport);
      // updateReport calls: attempt count OK, claim (calculating) OK, then
      // the error-status write fails
      mockUpdateReport
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Storage down'));

      tracePollingManager.startPolling('report-double-err', 'run-double-err', callbacks);

      await jest.runAllTimersAsync();

      // Should still clean up polling state even when both fail
      expect(tracePollingManager.getState('report-double-err')).toBeUndefined();

      // Should log critical error
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('cleans up memory when error occurs at max attempts', async () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockRejectedValue(new Error('Network error'));
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-mem-error', 'run-mem-error', callbacks, {
        intervalMs: 1000,
        maxAttempts: 1,
      });

      expect(tracePollingManager.getState('report-mem-error')).toBeDefined();

      // First attempt - error at max attempts
      await jest.advanceTimersByTimeAsync(0);

      // Verify complete cleanup after error at max attempts
      expect(tracePollingManager.getState('report-mem-error')).toBeUndefined();
    });

    it('continues polling when buildTrajectory hook returns null', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const agentConfig = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com',
        hooks: {
          buildTrajectory: {
            enabled: true,
            script: 'test-script.js'
          }
        }
      };

      const onAttempt = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
        onAttempt,
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans, total: 1 });
      mockExecuteBuildTrajectoryHook.mockResolvedValue(null);
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-continue', 'run-continue', callbacks, {
        intervalMs: 100,
        maxAttempts: 3,
        agentConfig,
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(onAttempt).toHaveBeenCalledWith(1, 3);

      await jest.advanceTimersByTimeAsync(100);
      expect(onAttempt).toHaveBeenCalledWith(2, 3);

      expect(callbacks.onTracesFound).not.toHaveBeenCalled();
    });

    it('stops polling when buildTrajectory hook returns trajectory', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockTrajectory = [
        { type: 'response', content: 'Built from traces', timestamp: '2024-01-01T00:00:00Z' }
      ];

      const mockReport: EvaluationReport = {
        id: 'report-built',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [],
        metrics: { accuracy: 0.95, faithfulness: 0.9, latency_score: 0.85, trajectory_alignment_score: 0.88 },
        llmJudgeReasoning: 'Test reasoning',
      };

      const agentConfig = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com',
        hooks: {
          buildTrajectory: {
            enabled: true,
            script: 'test-script.js'
          }
        }
      };

      const onTracesFound = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans, total: 1 });
      mockExecuteBuildTrajectoryHook.mockResolvedValue(mockTrajectory);
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValue(mockReport);

      tracePollingManager.startPolling('report-built', 'run-built', callbacks, {
        intervalMs: 100,
        maxAttempts: 3,
        agentConfig,
      });

      await jest.runAllTimersAsync();

      expect(mockExecuteBuildTrajectoryHook).toHaveBeenCalledWith(
        agentConfig.hooks,
        { spans: mockSpans, runId: 'run-built' },
        'test-agent'
      );

      expect(onTracesFound).toHaveBeenCalledWith(
        mockSpans,
        expect.objectContaining({ trajectory: mockTrajectory })
      );
    });

    it('uses empty trajectory when no buildTrajectory hook configured', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-no-hook',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [{ type: 'original', content: 'From SSE' }],
        metrics: { accuracy: 0.95, faithfulness: 0.9, latency_score: 0.85, trajectory_alignment_score: 0.88 },
        llmJudgeReasoning: 'Test reasoning',
      };

      const agentConfig = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com',
      };

      const onTracesFound = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans, total: 1 });
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValue(mockReport);

      tracePollingManager.startPolling('report-no-hook', 'run-no-hook', callbacks, {
        agentConfig,
      });

      await jest.runAllTimersAsync();

      expect(mockExecuteBuildTrajectoryHook).not.toHaveBeenCalled();
      expect(onTracesFound).toHaveBeenCalledWith(
        mockSpans,
        expect.objectContaining({ trajectory: [{ type: 'original', content: 'From SSE' }] })
      );
    });

    // Issue #320 (root cause 2): without a buildTrajectory hook the poller
    // used to return [] and the judge graded the tool-call-less AG-UI
    // trajectory — failing trace-only agents for "not invoking any tool".
    // The default span→trajectory conversion must surface the tool calls.
    it('builds a default trajectory from tool spans when no hook is configured', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-default',
          spanId: 'span-tool-1',
          name: 'execute_tool add_to_cart',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'add_to_cart',
          },
          events: [
            {
              name: 'gen_ai.tool.message',
              time: '2024-01-01T00:00:00.5Z',
              attributes: { role: 'tool', content: '{"product_id":"PROD-001"}' },
            },
            {
              name: 'gen_ai.choice',
              time: '2024-01-01T00:00:00.9Z',
              attributes: { message: '{"cart_total":79.99}' },
            },
          ],
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-default-traj',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        agentName: 'Trace Agent',
        agentKey: 'trace-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [{ type: 'response', content: 'Final answer only (AG-UI)' }],
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
        llmJudgeReasoning: '',
      } as any;

      const onTracesFound = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans, total: 1 });
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValue(mockReport);

      tracePollingManager.startPolling('report-default-traj', 'run-default-traj', callbacks, {
        agentConfig: { key: 'trace-agent', name: 'Trace Agent', endpoint: 'http://test.com' },
      });

      await jest.runAllTimersAsync();

      expect(mockExecuteBuildTrajectoryHook).not.toHaveBeenCalled();
      expect(onTracesFound).toHaveBeenCalledTimes(1);
      const reportArg = onTracesFound.mock.calls[0][1];
      // The judged trajectory must contain the tool call from the spans,
      // not the tool-call-less AG-UI response.
      const actionSteps = reportArg.trajectory.filter((s: any) => s.type === 'action');
      expect(actionSteps.length).toBeGreaterThanOrEqual(1);
      expect(actionSteps[0].toolName).toBe('add_to_cart');
    });

    // Regression (P0, judge evidence loss): the default span→trajectory
    // conversion used to REPLACE the connector trajectory wholesale, keeping
    // only its response steps. When the agent's spans carry no tool payloads
    // the connector/afterResponse-hook `tool_result` steps (with `toolOutput`)
    // were discarded — measured live: ~50% of a REST agent's reports ended
    // with NO tool steps and the judge wrote "no intermediate retrieval
    // steps". Replacement must never lose evidence (services/traces/
    // trajectoryMerge.ts).
    describe('evidence-preserving merge (no buildTrajectory hook)', () => {
      const connectorTrajectory = [
        { id: 'c-1', timestamp: 1, type: 'action', content: '{"index":"kb"}', toolName: 'dsl_executor', toolArgs: { index: 'kb' } },
        { id: 'c-2', timestamp: 2, type: 'tool_result', content: '[{"id":597374}]', toolName: 'dsl_executor', toolOutput: '[{"id":597374}]', status: 'SUCCESS' },
        { id: 'c-3', timestamp: 3, type: 'response', content: 'The product is 597374.' },
      ];
      const baseReport = {
        id: 'report-merge',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        agentName: 'REST Agent',
        agentKey: 'rest-agent',
        connectorProtocol: 'rest',
        modelName: 'Test Model',
        modelId: 'test-model',
        metricsStatus: 'pending',
        traceId: 'trace-merge',
        metrics: {},
        llmJudgeReasoning: '',
      };

      it('keeps hook-built tool_result steps (with toolOutput) when the spans carry NO tool payloads', async () => {
        // Generic (non-Claude) spans with only prompt/completion attributes —
        // spansToTrajectory yields thinking + response, zero tool steps.
        const spans: Span[] = [{
          traceId: 'trace-merge',
          spanId: 'span-root',
          name: 'invoke_agent retrieval-agent',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:03Z',
          duration: 3000,
          status: 'OK',
          attributes: { 'gen_ai.prompt': 'find the away kit', 'gen_ai.completion': 'The product is 597374.' },
        }];
        const report = { ...baseReport, id: 'report-merge-notools', trajectory: connectorTrajectory } as any;
        const onTracesFound = jest.fn();
        mockFetchTracesForRun.mockResolvedValue({ spans, total: 1 });
        mockUpdateReport.mockResolvedValue(undefined);
        mockGetReportById.mockResolvedValue(report);

        tracePollingManager.startPolling('report-merge-notools', 'run-merge', { onTracesFound, onError: jest.fn() }, {
          agentConfig: { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://test.com' },
        });
        await jest.runAllTimersAsync();

        expect(onTracesFound).toHaveBeenCalledTimes(1);
        const judged = onTracesFound.mock.calls[0][1].trajectory;
        const toolResults = judged.filter((s: any) => s.type === 'tool_result');
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].toolOutput).toBe('[{"id":597374}]');
        expect(judged.filter((s: any) => s.type === 'action')).toHaveLength(1);
        expect(judged.some((s: any) => s.type === 'response' && s.content === 'The product is 597374.')).toBe(true);
      });

      it('keeps connector outputs over span-derived "tool succeeded" stubs and folds span timing onto them', async () => {
        // Claude-native shape: `tool` + `tool.execution` spans without payload
        // attributes → action + "tool succeeded" tool_result stubs.
        const spans: Span[] = [
          {
            traceId: 'trace-merge', spanId: 'sp-tool', name: 'claude_code.tool',
            startTime: '2024-01-01T00:00:01Z', endTime: '2024-01-01T00:00:01.5Z', duration: 500, status: 'OK',
            attributes: { 'span.type': 'tool', tool_name: 'dsl_executor', tool_use_id: 'toolu_1', duration_ms: 500 },
          },
          {
            traceId: 'trace-merge', spanId: 'sp-exec', name: 'claude_code.tool.execution',
            startTime: '2024-01-01T00:00:01.1Z', endTime: '2024-01-01T00:00:01.4Z', duration: 300, status: 'OK',
            attributes: { 'span.type': 'tool.execution', tool_use_id: 'toolu_1', success: true, duration_ms: 300 },
          },
        ];
        const report = { ...baseReport, id: 'report-merge-stubs', trajectory: connectorTrajectory } as any;
        const onTracesFound = jest.fn();
        mockFetchTracesForRun.mockResolvedValue({ spans, total: 2 });
        mockUpdateReport.mockResolvedValue(undefined);
        mockGetReportById.mockResolvedValue(report);

        tracePollingManager.startPolling('report-merge-stubs', 'run-merge-2', { onTracesFound, onError: jest.fn() }, {
          agentConfig: { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://test.com' },
        });
        await jest.runAllTimersAsync();

        const judged = onTracesFound.mock.calls[0][1].trajectory;
        const toolResults = judged.filter((s: any) => s.type === 'tool_result');
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].content).not.toBe('tool succeeded');
        expect(toolResults[0].toolOutput).toBe('[{"id":597374}]');
        expect(toolResults[0].latencyMs).toBe(300); // folded from the tool.execution span
        expect(judged.find((s: any) => s.type === 'action').latencyMs).toBe(500);
        expect(judged.filter((s: any) => s.type === 'response')).toHaveLength(1);
      });

      it('still lets an explicit buildTrajectory hook replace the trajectory wholesale (#320)', async () => {
        const spans: Span[] = [{
          traceId: 'trace-merge', spanId: 'span-h', name: 'x',
          startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:00:01Z', duration: 1000, status: 'OK', attributes: {},
        }];
        const hookTrajectory = [{ type: 'response', content: 'hook says so' }];
        mockExecuteBuildTrajectoryHook.mockResolvedValue(hookTrajectory as any);
        const report = { ...baseReport, id: 'report-merge-hook', trajectory: connectorTrajectory } as any;
        const onTracesFound = jest.fn();
        mockFetchTracesForRun.mockResolvedValue({ spans, total: 1 });
        mockUpdateReport.mockResolvedValue(undefined);
        mockGetReportById.mockResolvedValue(report);

        tracePollingManager.startPolling('report-merge-hook', 'run-merge-3', { onTracesFound, onError: jest.fn() }, {
          agentConfig: { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://test.com', hooks: { buildTrajectory: { enabled: true, script: 'x.js' } } } as any,
        });
        await jest.runAllTimersAsync();

        expect(onTracesFound.mock.calls[0][1].trajectory).toEqual(hookTrajectory);
      });
    });

    it('preserves existing trajectory when buildTrajectory hook throws', async () => {
      const mockSpans: Span[] = [
        {
          traceId: 'trace-hook-err',
          spanId: 'span-hook-err',
          name: 'test-span',
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-01T00:00:01Z',
          duration: 1000,
          status: 'OK',
          attributes: {},
        },
      ];

      const mockReport: EvaluationReport = {
        id: 'report-hook-err',
        timestamp: '2024-01-01T00:00:00Z',
        testCaseId: 'test-1',
        status: 'completed',
        passFailStatus: 'passed',
        agentName: 'Test Agent',
        agentKey: 'test-agent',
        modelName: 'Test Model',
        modelId: 'test-model',
        trajectory: [{ type: 'original', content: 'SSE trajectory' }],
        metrics: { accuracy: 0.95, faithfulness: 0.9, latency_score: 0.85, trajectory_alignment_score: 0.88 },
        llmJudgeReasoning: 'Test reasoning',
      };

      const agentConfig = {
        key: 'test-agent',
        name: 'Test Agent',
        endpoint: 'http://test.com',
        hooks: {
          buildTrajectory: {
            enabled: true,
            script: 'test-script.js'
          }
        }
      };

      const onTracesFound = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans, total: 1 });
      mockExecuteBuildTrajectoryHook.mockRejectedValue(new Error('Hook script failed'));
      mockUpdateReport.mockResolvedValue(undefined);
      mockGetReportById.mockResolvedValue(mockReport);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      tracePollingManager.startPolling('report-hook-err', 'run-hook-err', callbacks, {
        agentConfig,
      });

      await jest.runAllTimersAsync();

      // Hook failed, but the empty trajectory from error path should NOT overwrite existing
      expect(onTracesFound).toHaveBeenCalledWith(
        mockSpans,
        expect.objectContaining({ trajectory: [{ type: 'original', content: 'SSE trajectory' }] })
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('startPollingAsync', () => {
    it('resolves when traces are found and callback succeeds', async () => {
      const mockSpans = [{ traceId: 'trace-1', spanId: 'span-1', name: 'test' }] as unknown as Span[];
      const mockReport = { id: 'report-1', trajectory: [] } as unknown as EvaluationReport;

      (fetchTracesForRun as jest.Mock).mockResolvedValue({ spans: mockSpans });
      (asyncRunStorage.getReportById as jest.Mock).mockResolvedValue(mockReport);
      (asyncRunStorage.updateReport as jest.Mock).mockResolvedValue(undefined);

      const onTracesFound = jest.fn().mockResolvedValue(undefined);
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      await tracePollingManager.startPollingAsync('report-async-1', 'run-1', callbacks, {
        intervalMs: 10,
        maxAttempts: 3,
      });

      expect(onTracesFound).toHaveBeenCalledWith(mockSpans, mockReport);
    });

    it('rejects when max attempts reached without traces', async () => {
      (fetchTracesForRun as jest.Mock).mockResolvedValue({ spans: [] });
      (asyncRunStorage.updateReport as jest.Mock).mockResolvedValue(undefined);

      const onError = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError,
      };

      const promise = tracePollingManager.startPollingAsync('report-async-2', 'run-2', callbacks, {
        intervalMs: 1000,
        maxAttempts: 2,
      });

      // Attach rejection handler before advancing timers to avoid unhandled rejection
      let rejectedError: Error | undefined;
      const settled = promise.catch((err) => { rejectedError = err; });

      // Run all timers to completion
      await jest.runAllTimersAsync();
      await settled;

      expect(rejectedError).toBeDefined();
      expect(rejectedError!.message).toContain('Traces not available after 2 attempts');
      expect(onError).toHaveBeenCalled();
    });

    it('rejects when onTracesFound callback throws', async () => {
      const mockSpans = [{ traceId: 'trace-1', spanId: 'span-1', name: 'test' }] as unknown as Span[];
      const mockReport = { id: 'report-1', trajectory: [] } as unknown as EvaluationReport;

      (fetchTracesForRun as jest.Mock).mockResolvedValue({ spans: mockSpans });
      (asyncRunStorage.getReportById as jest.Mock).mockResolvedValue(mockReport);
      (asyncRunStorage.updateReport as jest.Mock).mockResolvedValue(undefined);

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn().mockRejectedValue(new Error('Judge failed')),
        onError: jest.fn(),
      };

      await expect(
        tracePollingManager.startPollingAsync('report-async-3', 'run-3', callbacks, {
          intervalMs: 10,
          maxAttempts: 3,
        })
      ).rejects.toThrow('Judge failed');
    });
  });

  describe('clobber guards + exact-match correlation (2026-08-25 fixes)', () => {
    const pendingReport = (over: Partial<EvaluationReport> = {}): EvaluationReport => ({
      id: 'r-guard',
      timestamp: '2024-01-01T00:00:00Z',
      testCaseId: 'tc-1',
      status: 'completed',
      agentName: 'A',
      agentKey: 'a',
      modelName: 'M',
      modelId: 'm',
      trajectory: [],
      metrics: { accuracy: 0 },
      llmJudgeReasoning: '',
      metricsStatus: 'pending',
      ...over,
    } as EvaluationReport);

    const span = (over: Partial<Span> = {}): Span => ({
      traceId: 't1', spanId: 's1', name: 'sp', startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:01Z', duration: 1000, status: 'OK', attributes: {},
      ...over,
    } as Span);

    it('stops without judging (and fires onStopped) when the report is already terminal', async () => {
      mockGetReportById.mockResolvedValue(pendingReport({ metricsStatus: 'ready' }));
      mockUpdateReport.mockResolvedValue(undefined);
      const onTracesFound = jest.fn();
      const onStopped = jest.fn();

      tracePollingManager.startPolling('r-guard', 'run-x', { onTracesFound, onError: jest.fn(), onStopped });
      await jest.runAllTimersAsync();

      expect(onTracesFound).not.toHaveBeenCalled();
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(mockFetchTracesForRun).not.toHaveBeenCalled();
      expect(tracePollingManager.getState('r-guard')).toBeUndefined();
    });

    it('filters fetched spans to the report sessionId (concurrent same-service runs)', async () => {
      const mine = span({ spanId: 'mine', attributes: { 'session.id': 'sess-A' } });
      const other = span({ spanId: 'other', attributes: { 'session.id': 'sess-B' } });
      mockGetReportById.mockResolvedValue(pendingReport({ sessionId: 'sess-A' }));
      mockUpdateReport.mockResolvedValue(undefined);
      mockFetchTracesForRun.mockResolvedValue({ spans: [mine, other], total: 2 } as any);
      const onTracesFound = jest.fn().mockResolvedValue(undefined);

      tracePollingManager.startPolling('r-guard', 'run-x', { onTracesFound, onError: jest.fn() });
      await jest.runAllTimersAsync();

      expect(onTracesFound).toHaveBeenCalledTimes(1);
      const judgedSpans = onTracesFound.mock.calls[0][0] as Span[];
      expect(judgedSpans.map(sp => sp.spanId)).toEqual(['mine']);
    });

    it('filters fetched spans to the eval traceId when no sessionId is present', async () => {
      const EVAL_TRACE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const mine = span({ spanId: 'mine', traceId: EVAL_TRACE });
      const other = span({ spanId: 'other', traceId: '0f0e0d0c0b0a09080706050403020100' });
      mockGetReportById.mockResolvedValue(pendingReport({ traceId: EVAL_TRACE }));
      mockUpdateReport.mockResolvedValue(undefined);
      mockFetchTracesForRun.mockResolvedValue({ spans: [mine, other], total: 2 } as any);
      const onTracesFound = jest.fn().mockResolvedValue(undefined);

      tracePollingManager.startPolling('r-guard', 'run-x', { onTracesFound, onError: jest.fn() });
      await jest.runAllTimersAsync();

      const judgedSpans = onTracesFound.mock.calls[0][0] as Span[];
      expect(judgedSpans.map(sp => sp.spanId)).toEqual(['mine']);
    });

    it('keeps spans that carry the report runId even when they are in another trace (Strategy B is positive evidence)', async () => {
      const EVAL_TRACE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const viaRunId = span({ spanId: 'via-run-id', traceId: '0f0e0d0c0b0a09080706050403020100', attributes: { 'gen_ai.conversation.id': 'run-x' } });
      const foreign = span({ spanId: 'foreign', traceId: '0f0e0d0c0b0a09080706050403020100', attributes: { 'gen_ai.conversation.id': 'run-other' } });
      mockGetReportById.mockResolvedValue(pendingReport({ traceId: EVAL_TRACE }));
      mockUpdateReport.mockResolvedValue(undefined);
      mockFetchTracesForRun.mockResolvedValue({ spans: [viaRunId, foreign], total: 2 } as any);
      const onTracesFound = jest.fn().mockResolvedValue(undefined);

      tracePollingManager.startPolling('r-guard', 'run-x', { onTracesFound, onError: jest.fn() });
      await jest.runAllTimersAsync();

      const judgedSpans = onTracesFound.mock.calls[0][0] as Span[];
      expect(judgedSpans.map(sp => sp.spanId)).toEqual(['via-run-id']);
    });

    it('does NOT treat a non-W3C report.traceId (connector run id mis-stamped as traceId) as a filter — the pre-fix black hole', async () => {
      // Legacy /execute reports persisted `traceId === runId === 'conv-…'`.
      // Pre-fix the poller queried by it (miss), Strategy B found the spans,
      // and the exact-match filter `span.traceId === 'conv-…'` then rejected
      // every one of them → "Traces never arrived" after 30 attempts.
      const found = span({ spanId: 'found', traceId: '0f0e0d0c0b0a09080706050403020100', attributes: { 'gen_ai.conversation.id': 'conv-33c29f9d5b8a' } });
      mockGetReportById.mockResolvedValue(pendingReport({ traceId: 'conv-33c29f9d5b8a', runId: 'conv-33c29f9d5b8a' } as any));
      mockUpdateReport.mockResolvedValue(undefined);
      mockFetchTracesForRun.mockResolvedValue({ spans: [found], total: 1 } as any);
      const onTracesFound = jest.fn().mockResolvedValue(undefined);

      tracePollingManager.startPolling('r-guard', 'conv-33c29f9d5b8a', { onTracesFound, onError: jest.fn() });
      await jest.runAllTimersAsync();

      // The bogus traceId is not sent as a Strategy-A key…
      expect(mockFetchTracesForRun.mock.calls[0][0].evalTraceId).toBeUndefined();
      // …and the spans Strategy B found are judged, not discarded.
      const judgedSpans = onTracesFound.mock.calls[0][0] as Span[];
      expect(judgedSpans.map(sp => sp.spanId)).toEqual(['found']);
    });

    it('claims the report (calculating) before invoking the judge callback', async () => {
      mockGetReportById.mockResolvedValue(pendingReport());
      mockUpdateReport.mockResolvedValue(undefined);
      mockFetchTracesForRun.mockResolvedValue({ spans: [span()], total: 1 } as any);
      const calls: string[] = [];
      const onTracesFound = jest.fn().mockImplementation(async () => { calls.push('judge'); });
      mockUpdateReport.mockImplementation(async (_id: string, patch: any) => {
        if (patch?.metricsStatus === 'calculating') calls.push('claim');
        return undefined as any;
      });

      tracePollingManager.startPolling('r-guard', 'run-x', { onTracesFound, onError: jest.fn() });
      await jest.runAllTimersAsync();

      expect(calls).toEqual(['claim', 'judge']);
    });

    it('does not overwrite an existing error verdict with a generic timeout', async () => {
      // First poll: report pending, no spans; maxAttempts=1 so timeout fires.
      // By the time the timeout patch runs, another path wrote 'error'.
      mockGetReportById
        .mockResolvedValueOnce(pendingReport())                       // top-of-poll
        .mockResolvedValueOnce(pendingReport({ metricsStatus: 'error' })); // patch guard
      mockUpdateReport.mockResolvedValue(undefined);
      mockFetchTracesForRun.mockResolvedValue({ spans: [], total: 0 } as any);

      tracePollingManager.startPolling('r-guard', 'run-x', { onTracesFound: jest.fn(), onError: jest.fn() }, { maxAttempts: 1 });
      await jest.runAllTimersAsync();

      const errorPatches = mockUpdateReport.mock.calls.filter(c => (c[1] as any)?.metricsStatus === 'error');
      expect(errorPatches).toHaveLength(0);
    });
  });
});
