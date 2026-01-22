/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { EvaluationReport, Span } from '@/types';
import { tracePollingManager, PollCallbacks } from '@/services/traces/tracePoller';
import { fetchTracesByRunIds } from '@/services/traces';
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';

// Mock dependencies
jest.mock('@/services/traces/index', () => ({
  fetchTracesByRunIds: jest.fn(),
}));

jest.mock('@/services/storage/asyncRunStorage', () => ({
  asyncRunStorage: {
    updateReport: jest.fn(),
    getReportById: jest.fn(),
  },
}));

const mockFetchTracesByRunIds = fetchTracesByRunIds as jest.MockedFunction<typeof fetchTracesByRunIds>;
const mockUpdateReport = asyncRunStorage.updateReport as jest.MockedFunction<typeof asyncRunStorage.updateReport>;
const mockGetReportById = asyncRunStorage.getReportById as jest.MockedFunction<typeof asyncRunStorage.getReportById>;

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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
      mockUpdateReport.mockResolvedValue(undefined);

      tracePollingManager.startPolling('report-mem-1', 'run-mem-1', callbacks);
      expect(tracePollingManager.getState('report-mem-1')).toBeDefined();

      tracePollingManager.stopPolling('report-mem-1');

      // Verify complete cleanup - getState should return undefined
      expect(tracePollingManager.getState('report-mem-1')).toBeUndefined();
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValueOnce({ spans: mockSpans, total: mockSpans.length });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockRejectedValue(new Error('Network error'));
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

      mockFetchTracesByRunIds.mockResolvedValueOnce({ spans: mockSpans, total: mockSpans.length });
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

      mockFetchTracesByRunIds.mockResolvedValue({ spans: [], total: 0 });
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

    it('cleans up memory when error occurs at max attempts', async () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError: jest.fn(),
      };

      mockFetchTracesByRunIds.mockRejectedValue(new Error('Network error'));
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
  });
});
