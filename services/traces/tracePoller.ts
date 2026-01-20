/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trace Polling Service
 *
 * Manages polling for trace availability after a trace-mode run completes.
 * Traces take ~5 minutes to propagate to OpenSearch after agent execution.
 */

import { Span, EvaluationReport } from '@/types';
import { fetchTracesByRunIds } from './index';
import { asyncRunStorage } from '../storage/asyncRunStorage';

// Polling configuration
const DEFAULT_POLL_INTERVAL_MS = 10000; // 10 seconds
const DEFAULT_MAX_ATTEMPTS = 30; // 5 minutes total

export interface PollState {
  reportId: string;
  runId: string;
  attempts: number;
  maxAttempts: number;
  intervalMs: number;
  lastAttempt: string | null;
  running: boolean;
  timerId?: ReturnType<typeof setTimeout>;
}

export interface PollCallbacks {
  onTracesFound: (spans: Span[], report: EvaluationReport) => Promise<void>;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
  onError: (error: Error) => void;
}

/**
 * Trace Polling Manager
 *
 * Singleton that manages active polling for trace availability.
 * State is in-memory only - polling is short-lived (~10 min max).
 *
 * Polling runs in two places for redundancy:
 * - Server (experimentRunner.ts): Primary - starts immediately after agent execution
 * - Browser (RunDetailsContent.tsx): Recovery - starts when viewing a pending report
 */
class TracePollingManager {
  private polls: Map<string, PollState> = new Map();
  private callbacks: Map<string, PollCallbacks> = new Map();

  /**
   * Start polling for traces for a specific report
   */
  startPolling(
    reportId: string,
    runId: string,
    callbacks: PollCallbacks,
    options?: { intervalMs?: number; maxAttempts?: number }
  ): void {
    // Don't start if already polling for this report
    if (this.polls.has(reportId) && this.polls.get(reportId)!.running) {
      console.log(`[TracePoller] Already polling for report ${reportId}`);
      return;
    }

    const state: PollState = {
      reportId,
      runId,
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      intervalMs: options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      lastAttempt: null,
      running: true,
    };

    this.polls.set(reportId, state);
    this.callbacks.set(reportId, callbacks);

    console.log(`[TracePoller] Starting polling for report ${reportId}, runId ${runId}`);
    this.poll(reportId);
  }

  /**
   * Stop polling for a specific report
   */
  stopPolling(reportId: string): void {
    const state = this.polls.get(reportId);
    if (state) {
      if (state.timerId) {
        clearTimeout(state.timerId);
      }
      state.running = false;
      console.log(`[TracePoller] Stopped polling for report ${reportId}`);
    }
    this.callbacks.delete(reportId);
  }

  /**
   * Get the state for a specific poll
   */
  getState(reportId: string): PollState | undefined {
    return this.polls.get(reportId);
  }

  /**
   * Get all active polls
   */
  getAllActivePolls(): Map<string, PollState> {
    const active = new Map<string, PollState>();
    this.polls.forEach((state, reportId) => {
      if (state.running) {
        active.set(reportId, state);
      }
    });
    return active;
  }

  /**
   * Execute a single poll attempt
   */
  private async poll(reportId: string): Promise<void> {
    const state = this.polls.get(reportId);
    const callbacks = this.callbacks.get(reportId);

    if (!state || !state.running) {
      return;
    }

    state.attempts++;
    state.lastAttempt = new Date().toISOString();

    console.log(`[TracePoller] Poll attempt ${state.attempts}/${state.maxAttempts} for report ${reportId}`);

    // Notify about attempt
    callbacks?.onAttempt?.(state.attempts, state.maxAttempts);

    // Update report with attempt count
    try {
      await asyncRunStorage.updateReport(reportId, {
        traceFetchAttempts: state.attempts,
        lastTraceFetchAt: state.lastAttempt,
      });
    } catch (err) {
      console.warn(`[TracePoller] Failed to update attempt count:`, err);
    }

    try {
      // Try to fetch traces
      const result = await fetchTracesByRunIds([state.runId]);

      if (result.spans && result.spans.length > 0) {
        // Traces found!
        console.log(`[TracePoller] Found ${result.spans.length} spans for report ${reportId}`);

        // Get the current report
        const report = await asyncRunStorage.getReportById(reportId);
        if (!report) {
          throw new Error(`Report ${reportId} not found`);
        }

        // Stop polling and notify success
        state.running = false;

        await callbacks?.onTracesFound(result.spans, report);
        this.callbacks.delete(reportId);
      } else {
        // No traces yet
        if (state.attempts >= state.maxAttempts) {
          // Max attempts reached
          console.log(`[TracePoller] Max attempts reached for report ${reportId}`);
          state.running = false;

          callbacks?.onError(new Error(`Traces not available after ${state.maxAttempts} attempts`));

          // Update report with error status - critical as report will remain stuck otherwise
          try {
            await asyncRunStorage.updateReport(reportId, {
              metricsStatus: 'error',
              traceError: `Traces not available after ${state.maxAttempts} attempts (${state.maxAttempts * state.intervalMs / 60000} minutes)`,
            });
          } catch (updateErr) {
            console.error(`[TracePoller] CRITICAL: Failed to update report ${reportId} error status. Report may be stuck in pending state.`, updateErr);
          }

          this.callbacks.delete(reportId);
        } else {
          // Schedule next poll
          state.timerId = setTimeout(() => this.poll(reportId), state.intervalMs);
        }
      }
    } catch (error) {
      console.error(`[TracePoller] Error polling for report ${reportId}:`, error);

      if (state.attempts >= state.maxAttempts) {
        state.running = false;
        callbacks?.onError(error as Error);

        // Update report with error status - critical as report will remain stuck otherwise
        try {
          await asyncRunStorage.updateReport(reportId, {
            metricsStatus: 'error',
            traceError: (error as Error).message,
          });
        } catch (updateErr) {
          console.error(`[TracePoller] CRITICAL: Failed to update report ${reportId} error status. Report may be stuck in pending state.`, updateErr);
        }

        this.callbacks.delete(reportId);
      } else {
        // Schedule retry
        state.timerId = setTimeout(() => this.poll(reportId), state.intervalMs);
      }
    }
  }
}

// Singleton instance
export const tracePollingManager = new TracePollingManager();
