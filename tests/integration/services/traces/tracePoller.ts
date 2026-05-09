/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for Trace Polling Service
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=tracePoller
 *
 * The trace poller:
 * - Polls every 30 seconds by default (configurable)
 * - Max 20 attempts (~10 minutes)
 * - Updates report.traceFetchAttempts on each attempt
 * - Calls Bedrock judge when traces are found
 */

import { tracePollingManager, PollCallbacks } from '@/services/traces/tracePoller';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const BASE_URL = getTestBackendUrl();

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    return response.ok;
  } catch {
    return false;
  }
};

// Helper to create a test report via API
const createTestReport = async (): Promise<string | null> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCaseId: 'test-case-trace-poll',
        testCaseName: 'Trace Poller Test',
        timestamp: new Date().toISOString(),
        trajectory: [],
        metricsStatus: 'pending',
        runId: `test-run-${Date.now()}`, // Fake runId for polling
      }),
    });

    if (response.ok) {
      const report = await response.json();
      return report.id;
    }
    return null;
  } catch {
    return null;
  }
};

// Helper to get report by ID
const getReport = async (reportId: string): Promise<any | null> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/runs/${reportId}`);
    if (response.ok) {
      return response.json();
    }
    return null;
  } catch {
    return null;
  }
};

// Helper to delete test report
const deleteReport = async (reportId: string): Promise<void> => {
  try {
    await fetch(`${BASE_URL}/api/storage/runs/${reportId}`, {
      method: 'DELETE',
    });
  } catch {
    // Ignore cleanup errors
  }
};

describe('Trace Polling Manager Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
    }
  });

  describe('In-memory polling state', () => {
    it('should start polling and track state', () => {
      const reportId = 'test-report-1';
      const runId = 'test-run-1';

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt: jest.fn(),
        onError: jest.fn(),
      };

      // Start polling with very short interval for testing
      tracePollingManager.startPolling(reportId, runId, callbacks, {
        intervalMs: 100,
        maxAttempts: 2,
      });

      // Check state is tracked
      const state = tracePollingManager.getState(reportId);
      expect(state).toBeDefined();
      expect(state?.reportId).toBe(reportId);
      expect(state?.runId).toBe(runId);
      expect(state?.running).toBe(true);

      // Stop polling
      tracePollingManager.stopPolling(reportId);

      // State should show not running
      const stoppedState = tracePollingManager.getState(reportId);
      expect(stoppedState?.running).toBe(false);
    });

    it('should prevent duplicate polling for same report', () => {
      const reportId = 'test-report-2';
      const runId = 'test-run-2';

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt: jest.fn(),
        onError: jest.fn(),
      };

      // Start polling
      tracePollingManager.startPolling(reportId, runId, callbacks, {
        intervalMs: 10000, // Long interval so it stays running
        maxAttempts: 10,
      });

      // Try to start again - should be ignored
      const callbacks2: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt: jest.fn(),
        onError: jest.fn(),
      };

      tracePollingManager.startPolling(reportId, runId, callbacks2, {
        intervalMs: 100,
        maxAttempts: 2,
      });

      // Should still have original state
      const state = tracePollingManager.getState(reportId);
      expect(state?.intervalMs).toBe(10000); // Original interval

      // Cleanup
      tracePollingManager.stopPolling(reportId);
    });

    it('should track all active polls', () => {
      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt: jest.fn(),
        onError: jest.fn(),
      };

      // Start multiple polls
      tracePollingManager.startPolling('report-a', 'run-a', callbacks, {
        intervalMs: 10000,
        maxAttempts: 10,
      });
      tracePollingManager.startPolling('report-b', 'run-b', callbacks, {
        intervalMs: 10000,
        maxAttempts: 10,
      });

      const activePolls = tracePollingManager.getAllActivePolls();
      expect(activePolls.size).toBeGreaterThanOrEqual(2);
      expect(activePolls.has('report-a')).toBe(true);
      expect(activePolls.has('report-b')).toBe(true);

      // Cleanup
      tracePollingManager.stopPolling('report-a');
      tracePollingManager.stopPolling('report-b');
    });
  });

  describe('Polling with callbacks', () => {
    it('should call onAttempt callback during polling', async () => {
      const reportId = `test-report-${Date.now()}`;
      const runId = `test-run-${Date.now()}`;

      const onAttempt = jest.fn();
      const onError = jest.fn();

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt,
        onError,
      };

      // Start polling with very short interval and low max attempts
      tracePollingManager.startPolling(reportId, runId, callbacks, {
        intervalMs: 100, // 100ms for fast test
        maxAttempts: 2,
      });

      // Wait for polling to complete by checking state (more reliable than fixed timeout)
      const waitForCompletion = async (maxWaitMs: number) => {
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
          const state = tracePollingManager.getState(reportId);
          if (state && !state.running) {
            return true;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      };

      const completed = await waitForCompletion(5000);
      expect(completed).toBe(true);

      // onAttempt should have been called
      expect(onAttempt).toHaveBeenCalled();

      // onError should be called when max attempts reached (no traces found)
      expect(onError).toHaveBeenCalled();

      // Cleanup
      tracePollingManager.stopPolling(reportId);
    }, 10000);
  });

  describe('Integration with storage API', () => {
    let testReportId: string | null = null;

    afterEach(async () => {
      if (testReportId) {
        tracePollingManager.stopPolling(testReportId);
        await deleteReport(testReportId);
        testReportId = null;
      }
    });

    it('should update report.traceFetchAttempts during polling', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      // Create a test report
      testReportId = await createTestReport();
      if (!testReportId) {
        console.warn('Skipping: could not create test report');
        return;
      }

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt: jest.fn(),
        onError: jest.fn(),
      };

      // Start polling with short interval
      tracePollingManager.startPolling(
        testReportId,
        `run-${Date.now()}`,
        callbacks,
        {
          intervalMs: 200,
          maxAttempts: 3,
        }
      );

      // Wait for at least one poll attempt
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check that report was updated with attempt count
      const report = await getReport(testReportId);
      expect(report).toBeDefined();
      expect(report?.traceFetchAttempts).toBeGreaterThan(0);
      expect(report?.lastTraceFetchAt).toBeDefined();
    }, 15000);

    it('should mark report as error when max attempts reached', async () => {
      if (!backendAvailable) {
        console.warn('Skipping: backend not available');
        return;
      }

      // Create a test report
      testReportId = await createTestReport();
      if (!testReportId) {
        console.warn('Skipping: could not create test report');
        return;
      }

      const onError = jest.fn();

      const callbacks: PollCallbacks = {
        onTracesFound: jest.fn(),
        onAttempt: jest.fn(),
        onError,
      };

      // Start polling with very short interval and low max attempts
      tracePollingManager.startPolling(
        testReportId,
        `run-${Date.now()}`,
        callbacks,
        {
          intervalMs: 100,
          maxAttempts: 2,
        }
      );

      // Wait for polling to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // onError should have been called
      expect(onError).toHaveBeenCalled();

      // Report should be marked as error
      const report = await getReport(testReportId);
      expect(report?.metricsStatus).toBe('error');
      expect(report?.traceError).toContain('not available after');
    }, 15000);
  });
});
