/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behavioral tests for issue #184 fix.
 *
 * These tests verify the BEHAVIORAL CONTRACT:
 * "When useTraces is true, the benchmark runner MUST wait for trace polling
 *  to complete (success or failure) before reporting benchmark results."
 *
 * The bug was: startPolling() returned void (fire-and-forget), so the benchmark
 * runner reported 0% pass rate immediately without waiting for the judge.
 *
 * The fix: startPollingAsync() returns a Promise that the benchmark runner awaits.
 */

import { tracePollingManager, PollCallbacks } from '@/services/traces/tracePoller';
import { fetchTracesForRun } from '@/services/traces';
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';

jest.mock('@/services/traces/index', () => ({
  fetchTracesForRun: jest.fn(),
}));

jest.mock('@/services/storage/asyncRunStorage', () => ({
  asyncRunStorage: {
    updateReport: jest.fn().mockResolvedValue(undefined),
    getReportById: jest.fn().mockResolvedValue({ id: 'report-1', trajectory: [] }),
  },
}));

jest.mock('@/lib/hooks', () => ({
  executeBuildTrajectoryHook: jest.fn(),
}));

describe('Issue #184 Fix - Behavioral Contract', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('startPollingAsync blocks until completion', () => {
    it('does NOT resolve until traces are found', async () => {
      // Simulate: no traces on first two attempts, found on third
      let attempt = 0;
      (fetchTracesForRun as jest.Mock).mockImplementation(() => {
        attempt++;
        if (attempt < 3) return Promise.resolve({ spans: [] });
        return Promise.resolve({
          spans: [{ traceId: 'trace-1', spanId: 'span-1', name: 'root' }],
        });
      });

      const onTracesFound = jest.fn().mockResolvedValue(undefined);
      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      const promise = tracePollingManager.startPollingAsync(
        'behavior-test-1',
        'run-1',
        callbacks,
        { intervalMs: 1000, maxAttempts: 5 }
      );

      // Track whether promise has settled
      let settled = false;
      promise.then(() => { settled = true; }).catch(() => { settled = true; });

      // After first attempt (no traces) — still blocking
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(attempt).toBe(1);

      // After second attempt (no traces) — still blocking
      await jest.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      expect(attempt).toBe(2);

      // After third attempt (traces found) — should resolve
      await jest.advanceTimersByTimeAsync(1000);
      await jest.runAllTimersAsync();
      await promise;

      // Verify settled via the .then handler (not the await above)
      expect(settled).toBe(true);
      expect(onTracesFound).toHaveBeenCalled();
      expect(attempt).toBe(3);
    });

    it('does NOT resolve until onTracesFound callback completes', async () => {
      (fetchTracesForRun as jest.Mock).mockResolvedValue({
        spans: [{ traceId: 'trace-1', spanId: 'span-1', name: 'root' }],
      });

      // Simulate a slow judge evaluation (takes 500ms)
      let judgeCompleted = false;
      const onTracesFound = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 500));
        judgeCompleted = true;
      });

      const callbacks: PollCallbacks = {
        onTracesFound,
        onError: jest.fn(),
      };

      const promise = tracePollingManager.startPollingAsync(
        'behavior-test-2',
        'run-2',
        callbacks,
        { intervalMs: 1000, maxAttempts: 5 }
      );

      // First poll finds traces, calls onTracesFound
      await jest.advanceTimersByTimeAsync(0);

      // Judge hasn't completed yet
      expect(judgeCompleted).toBe(false);

      // Advance through the judge delay
      await jest.advanceTimersByTimeAsync(500);
      await jest.runAllTimersAsync();
      await promise;

      // Now the promise resolved AND the judge completed
      expect(judgeCompleted).toBe(true);
    });

    it('rejects (does not hang forever) when traces never arrive', async () => {
      (fetchTracesForRun as jest.Mock).mockResolvedValue({ spans: [] });

      const onError = jest.fn();
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onError,
      };

      const promise = tracePollingManager.startPollingAsync(
        'behavior-test-3',
        'run-3',
        callbacks,
        { intervalMs: 1000, maxAttempts: 3 }
      );

      // Catch the rejection so it doesn't become unhandled
      let rejectionError: Error | undefined;
      const handled = promise.catch((err) => { rejectionError = err; });

      // Run all timers (3 attempts × 1s)
      await jest.runAllTimersAsync();
      await handled;

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toContain('Traces not available after 3 attempts');
      expect(onError).toHaveBeenCalled();
    });

    it('rejects when onTracesFound throws (judge failure)', async () => {
      (fetchTracesForRun as jest.Mock).mockResolvedValue({
        spans: [{ traceId: 'trace-1', spanId: 'span-1', name: 'root' }],
      });

      const judgeError = new Error('Bedrock judge rate limited');
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn().mockRejectedValue(judgeError),
        onError: jest.fn(),
      };

      const promise = tracePollingManager.startPollingAsync(
        'behavior-test-4',
        'run-4',
        callbacks,
        { intervalMs: 1000, maxAttempts: 5 }
      );

      let rejectionError: Error | undefined;
      const handled = promise.catch((err) => { rejectionError = err; });

      await jest.runAllTimersAsync();
      await handled;

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toBe('Bedrock judge rate limited');
    });
  });

  describe('contrast with old fire-and-forget behavior', () => {
    it('startPolling returns void — caller CANNOT await it', () => {
      const result = tracePollingManager.startPolling(
        'contrast-test-1',
        'run-old',
        { onTracesFound: jest.fn(), onError: jest.fn() },
        { intervalMs: 10000, maxAttempts: 1 }
      );

      // This is the root cause of #184: void return means no way to block
      expect(result).toBeUndefined();
      // The benchmark runner would continue immediately and report 0% pass rate

      tracePollingManager.stopPolling('contrast-test-1');
    });

    it('startPollingAsync returns Promise — caller CAN await it', () => {
      (fetchTracesForRun as jest.Mock).mockResolvedValue({ spans: [] });

      const result = tracePollingManager.startPollingAsync(
        'contrast-test-2',
        'run-new',
        { onTracesFound: jest.fn(), onError: jest.fn() },
        { intervalMs: 10000, maxAttempts: 1 }
      );

      // This is the fix: Promise return means benchmark runner can block
      expect(result).toBeInstanceOf(Promise);

      // Clean up
      result.catch(() => {}); // suppress unhandled rejection
      tracePollingManager.stopPolling('contrast-test-2');
    });
  });
});
