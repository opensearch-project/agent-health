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

import { Span, EvaluationReport, AgentConfig, BuildTrajectoryContext } from '@/types';
import { debug } from '@/lib/debug';
import { fetchTracesByRunIds } from './index';
import { asyncRunStorage } from '../storage/asyncRunStorage';
import { executeBuildTrajectoryHook } from '@/lib/hooks';

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
  agentConfig?: AgentConfig;
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
    options?: { intervalMs?: number; maxAttempts?: number; agentConfig?: AgentConfig }
  ): void {
    // Don't start if already polling for this report
    if (this.polls.has(reportId) && this.polls.get(reportId)!.running) {
      debug('TracePoller', `Already polling for report ${reportId}`);
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
      agentConfig: options?.agentConfig,
    };

    this.polls.set(reportId, state);
    this.callbacks.set(reportId, callbacks);

    debug('TracePoller', `Starting polling for report ${reportId}, runId ${runId}`);
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
      debug('TracePoller', `Stopped polling for report ${reportId}`);
    }
    this.callbacks.delete(reportId);
    this.polls.delete(reportId);
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

    debug('TracePoller', `Poll attempt ${state.attempts}/${state.maxAttempts} for report ${reportId}`);

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
        debug('TracePoller', `Found ${result.spans.length} spans for report ${reportId}`);

        // Get the current report
        const report = await asyncRunStorage.getReportById(reportId);
        if (!report) {
          throw new Error(`Report ${reportId} not found`);
        }

        // Build trajectory from trace spans
        const { trajectory, shouldContinuePolling } = await this.buildTrajectory(result.spans, state);
        // Check if we should continue polling
        if (shouldContinuePolling) {
          if (state.attempts >= state.maxAttempts) {
            console.log(`[TracePoller] Max attempts reached with incomplete trace`);
            state.running = false;
            callbacks?.onError(new Error(`Trace incomplete after ${state.maxAttempts} attempts`));
            
            await asyncRunStorage.updateReport(reportId, {
              metricsStatus: 'error',
              traceError: `Incomplete trace: found ${result.spans.length} spans but no root span after ${state.maxAttempts} attempts`,
            }).catch(err => console.error(`[TracePoller] Failed to update report error status:`, err));
            
            this.callbacks.delete(reportId);
            this.polls.delete(reportId);
          } else {
            // Schedule next poll
            state.timerId = setTimeout(() => this.poll(reportId), state.intervalMs);
          }
          return;
        }

        // Trajectory is ready - proceed
        report.trajectory = trajectory;

        // Stop polling and notify success
        state.running = false;

        try {
          await callbacks?.onTracesFound(result.spans, report);
        } catch (callbackErr) {
          // onTracesFound failed (e.g., judge + error recovery both failed).
          // Write error status so the report doesn't stay stuck in 'pending'.
          console.error(`[TracePoller] onTracesFound callback failed for report ${reportId}:`, callbackErr);
          try {
            await asyncRunStorage.updateReport(reportId, {
              metricsStatus: 'error',
              traceError: `Callback failed after traces found: ${callbackErr instanceof Error ? callbackErr.message : 'Unknown error'}`,
            });
          } catch (updateErr) {
            console.error(`[TracePoller] CRITICAL: Failed to update report ${reportId} error status after callback failure.`, updateErr);
          }
        }
        this.callbacks.delete(reportId);
        this.polls.delete(reportId);
      } else {
        // No traces yet
        if (state.attempts >= state.maxAttempts) {
          // Max attempts reached
          debug('TracePoller', `Max attempts reached for report ${reportId}`);
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
          this.polls.delete(reportId);
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
        this.polls.delete(reportId);
      } else {
        // Schedule retry
        state.timerId = setTimeout(() => this.poll(reportId), state.intervalMs);
      }
    }
  }

  /**
   * Build trajectory from spans with proper error handling
   */
  private async buildTrajectory(spans: Span[], state: PollState): Promise<{ trajectory: any[], shouldContinuePolling: boolean }> {
    const traceId = spans[0]?.traceId;
    if (!traceId) {
      console.warn(`[TracePoller] No traceId found in spans`);
      return { trajectory: [], shouldContinuePolling: false };
    }

    // If no buildTrajectory hook, return empty trajectory (will use SSE trajectory)
    if (!state.agentConfig?.hooks?.buildTrajectory) {
      return { trajectory: [], shouldContinuePolling: false };
    }

    try {
      console.log(`[TracePoller] Building trajectory from hook for trace ${traceId}`);
      const hookResult = await executeBuildTrajectoryHook(
        state.agentConfig.hooks,
        { spans, runId: state.runId },
        state.agentConfig.key
      );
      
      if (hookResult !== null) {
        console.log(`[TracePoller] Hook returned ${hookResult.length} trajectory steps`);
        return { trajectory: hookResult, shouldContinuePolling: false };
      } else {
        console.log(`[TracePoller] Hook returned null - trace not ready yet`);
        return { trajectory: [], shouldContinuePolling: true };
      }
    } catch (err) {
      console.error(`[TracePoller] Failed to build trajectory for ${traceId}:`, err);
      return { trajectory: [], shouldContinuePolling: false };
    }
  }
}

// Singleton instance
export const tracePollingManager = new TracePollingManager();
