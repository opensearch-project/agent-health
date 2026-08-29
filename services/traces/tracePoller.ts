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
import { fetchTracesForRun } from './index';
import { buildJudgeAgentsHints } from './judgeAgentsHints';
import { asyncRunStorage } from '../storage/asyncRunStorage';
import { executeBuildTrajectoryHook } from '@/lib/hooks';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { spansToTrajectory } from './spansToTrajectory';
import { getJudgeVerdict } from '@/lib/reportVerdict';

// Polling configuration. Defaults are overridable via env vars so that
// CI / E2E runs without a real OpenSearch trace backend can fail fast
// instead of waiting the full ~10 min before the poller gives up.
//
// NOTE: this module is imported by browser code (RunDetailsContent.tsx) for
// recovery polling, where `process` is not defined. Guard the access so we
// silently fall back to defaults in the browser instead of throwing
// `ReferenceError: process is not defined` at module load time.
const envInt = (name: string, fallback: number): number => {
  const raw =
    typeof process !== 'undefined' && process?.env ? process.env[name] : undefined;
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const DEFAULT_POLL_INTERVAL_MS = envInt('TRACE_POLL_INTERVAL_MS', 10000); // 10 seconds
const DEFAULT_MAX_ATTEMPTS = envInt('TRACE_POLL_MAX_ATTEMPTS', 60); // 10 minutes total at default interval
// Hard ceiling: never exceed this many attempts regardless of agent config or
// env override. Raised 60 → 240 (40 min at the default interval): the old
// ceiling silently clamped explicit agent `tracePolling.maxAttempts` overrides
// (e.g. 180 for slow OTLP→API-Gateway→cluster ingestion) back down to 10 min.
const MAX_POLL_CEILING = 240;

export interface PollState {
  reportId: string;
  /**
   * Connector runId (Strategy B). OPTIONAL — REST-connector reports never
   * get one; correlation then relies on the sessionId/service-window hints
   * derived from the report (Strategies C/D).
   */
  runId?: string;
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
  /**
   * Fired when polling stops WITHOUT a verdict from this poller — e.g. the
   * report reached a terminal metricsStatus through another path (eager
   * judge, sibling server). Callers that wrap `startPolling` in a promise
   * (evaluationRunner.waitForTracesAndJudge) MUST resolve here or they hang.
   */
  onStopped?: () => void;
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
  private completionPromises: Map<string, { resolve: () => void; reject: (err: Error) => void }> = new Map();

  /**
   * Start polling for traces for a specific report
   */
  startPolling(
    reportId: string,
    runId: string | undefined,
    callbacks: PollCallbacks,
    options?: { intervalMs?: number; maxAttempts?: number; agentConfig?: AgentConfig }
  ): void {
    // Don't start if already polling for this report
    if (this.polls.has(reportId) && this.polls.get(reportId)!.running) {
      debug('TracePoller', `Already polling for report ${reportId}`);
      return;
    }

    // Explicit options win; otherwise fall back to the agent's configured
    // tracePolling budget (callers like evaluationRunner pass agentConfig but
    // not the numbers — per-agent overrides were silently ignored there).
    const cfgPolling = options?.agentConfig?.tracePolling;
    const requestedMax = Number.isFinite(options?.maxAttempts)
      ? options!.maxAttempts!
      : Number.isFinite(cfgPolling?.maxAttempts) ? cfgPolling!.maxAttempts! : DEFAULT_MAX_ATTEMPTS;
    const state: PollState = {
      reportId,
      runId,
      attempts: 0,
      maxAttempts: Math.min(requestedMax, MAX_POLL_CEILING),
      intervalMs: options?.intervalMs ?? cfgPolling?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
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
   * Stop polling for a specific report.
   * If a completion promise exists (from startPollingAsync), it is rejected
   * so callers awaiting it are unblocked.
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
    // Reject any pending completion promise so awaiting callers don't hang
    const pending = this.completionPromises.get(reportId);
    if (pending) {
      pending.reject(new Error(`Polling stopped for report ${reportId}`));
      this.completionPromises.delete(reportId);
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
   * Start polling and return a Promise that resolves when polling completes.
   * This allows callers (e.g., benchmark runner) to await trace availability
   * instead of firing and forgetting.
   *
   * If polling is already active for this reportId, returns the existing
   * completion promise (no duplicate poll started).
   */
  startPollingAsync(
    reportId: string,
    runId: string | undefined,
    callbacks: PollCallbacks,
    options?: { intervalMs?: number; maxAttempts?: number; agentConfig?: AgentConfig }
  ): Promise<void> {
    // If already polling, return the existing completion promise
    const existing = this.completionPromises.get(reportId);
    if (existing && this.polls.has(reportId) && this.polls.get(reportId)!.running) {
      debug('TracePoller', `Already polling for report ${reportId}, returning existing promise`);
      return new Promise<void>((resolve, reject) => {
        const current = this.completionPromises.get(reportId)!;
        this.completionPromises.set(reportId, {
          resolve: () => { current.resolve(); resolve(); },
          reject: (err) => { current.reject(err); reject(err); },
        });
      });
    }

    return new Promise<void>((resolve, reject) => {
      this.completionPromises.set(reportId, { resolve, reject });

      // Wrap callbacks to resolve/reject the promise on completion
      const wrappedCallbacks: PollCallbacks = {
        onTracesFound: async (spans, report) => {
          try {
            await callbacks.onTracesFound(spans, report);
            this.completionPromises.get(reportId)?.resolve();
          } catch (err) {
            this.completionPromises.get(reportId)?.reject(err as Error);
          } finally {
            this.completionPromises.delete(reportId);
          }
        },
        onAttempt: callbacks.onAttempt,
        onError: (error) => {
          callbacks.onError(error);
          this.completionPromises.get(reportId)?.reject(error);
          this.completionPromises.delete(reportId);
        },
      };

      this.startPolling(reportId, runId, wrappedCallbacks, options);
    });
  }

  /**
   * Fetch a report defensively: storage failures and missing docs both
   * resolve to null (callers treat null as "unknown — proceed").
   */
  private async safeGetReport(reportId: string): Promise<EvaluationReport | null> {
    try {
      return (await asyncRunStorage.getReportById(reportId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Write an evaluator-error patch ONLY if the report is still pending /
   * calculating. A report judged through another path (eager judge, another
   * server's poller) must never have its verdict clobbered by this poller's
   * timeout/error bookkeeping.
   */
  private async patchErrorIfStillPending(reportId: string, patch: any): Promise<void> {
    try {
      const fresh = await this.safeGetReport(reportId);
      if (fresh && (fresh.metricsStatus === 'ready' || fresh.metricsStatus === 'error')) {
        // 'ready': a real verdict landed — never overwrite it.
        // 'error': another path already wrote a (likely more specific) error
        //          cause — don't stomp it with a generic timeout.
        debug('TracePoller', `Skipping error patch for ${reportId} — already '${fresh.metricsStatus}'`);
        return;
      }
      await asyncRunStorage.updateReport(reportId, patch);
    } catch (updateErr) {
      console.error(`[TracePoller] CRITICAL: Failed to update report ${reportId} error status. Report may be stuck in pending state.`, updateErr);
    }
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
      // Fetch the current report FIRST. Two reasons:
      //  1. Clobber guard: if the report was already judged (eager path — a
      //     browser fan-out can start polls for transiently-pending eager
      //     reports), STOP instead of racing the verdict. A trace_timeout
      //     patch 10 minutes later must never overwrite a real judgment
      //     (2026-08-25: run-inspector fan-out clobbered a full run's early
      //     verdicts this way).
      //  2. Correlation hints: the report carries sessionId / timestamp /
      //     connectorProtocol, from which we derive the service-window +
      //     sessionId hints (Strategies C/D). Claude Code spans carry only
      //     `session.id` (no runId tag), pi/REST spans carry neither —
      //     runId-only polling (Strategy B) can never find them.
      const currentReport = await this.safeGetReport(reportId);
      if (currentReport && (currentReport.metricsStatus === 'ready' || currentReport.metricsStatus === 'error')) {
        debug('TracePoller', `Report ${reportId} is already '${currentReport.metricsStatus}' — stopping poll (no clobber)`);
        state.running = false;
        this.callbacks.delete(reportId);
        this.polls.delete(reportId);
        // Resolve (not reject) any completion promise — the report reached a
        // terminal state through another path; nothing is owed here. Plain
        // startPolling callers are notified via onStopped (promise wrappers
        // like waitForTracesAndJudge resolve there — otherwise they'd hang).
        this.completionPromises.get(reportId)?.resolve();
        this.completionPromises.delete(reportId);
        try { callbacks?.onStopped?.(); } catch { /* notification only */ }
        return;
      }

      const windowAgents = currentReport
        ? buildJudgeAgentsHints(currentReport as any, state.agentConfig?.traceServiceName)
        : [];
      const sessionId = currentReport?.sessionId;
      // The run's own OTel traceId (test_case eval span) — stamped by the
      // runners at case start. Agents that adopt the propagated traceparent
      // (REST via header, pi via TRACEPARENT env — both verified) emit their
      // spans under this exact traceId (Strategy A).
      const evalTraceId = currentReport?.traceId;

      if (!state.runId && !sessionId && !evalTraceId && windowAgents.length === 0) {
        // No correlator at all this attempt (report fetch may have failed
        // transiently, or the report carries no correlation fields yet).
        // An unfiltered query would be rejected by the traces API anyway —
        // skip the fetch and let the attempt budget advance.
        debug('TracePoller', `No correlator available for report ${reportId} (attempt ${state.attempts}) — skipping fetch`);
        if (state.attempts >= state.maxAttempts) {
          state.running = false;
          callbacks?.onError(new Error(`Traces not available after ${state.maxAttempts} attempts (no correlation keys on report)`));
          await this.patchErrorIfStillPending(reportId, buildEvaluatorErrorPatch(
            'trace_timeout',
            `no correlation keys (runId/sessionId/traceId/service-window) available after ${state.maxAttempts} attempts`,
          ) as any);
          this.callbacks.delete(reportId);
          this.polls.delete(reportId);
        } else {
          state.timerId = setTimeout(() => this.poll(reportId), state.intervalMs);
        }
        return;
      }

      // Try to fetch traces — union of Strategy A (eval traceId), B (runId),
      // C (service.name + time window) and D (session.id inside the window hint).
      const result = await fetchTracesForRun({
        runId: state.runId,
        evalTraceId,
        windowAgents,
        includeWindowFallback: windowAgents.length > 0,
      });

      // EXACT-MATCH FILTER (fail-closed): the window clause (Strategy C) is a
      // discovery fallback and can return spans from CONCURRENT runs of the
      // same agent — or from unrelated emitters sharing the service name
      // (observed live: a pi-web session's spans were fetched for a pi eval
      // run). When the report carries a precise correlator, judge ONLY spans
      // matching it — and if none match yet, treat the attempt as "traces
      // not available" and keep polling rather than judging foreign spans:
      //   session.id (Claude Code)  >  eval traceId (traceparent adopters).
      let spans = result.spans || [];
      if (spans.length > 0) {
        if (sessionId) {
          spans = spans.filter(sp => (sp.attributes as any)?.['session.id'] === sessionId);
          if (spans.length === 0) debug('TracePoller', `Fetched ${result.spans!.length} spans but none match session ${sessionId} — waiting`);
        } else if (evalTraceId) {
          spans = spans.filter(sp => sp.traceId === evalTraceId);
          if (spans.length === 0) debug('TracePoller', `Fetched ${result.spans!.length} spans but none match eval traceId ${evalTraceId} — waiting`);
        }
      }
      const filteredResult = { ...result, spans };

      if (filteredResult.spans && filteredResult.spans.length > 0) {
        // Traces found!
        debug('TracePoller', `Found ${filteredResult.spans.length} spans for report ${reportId} (fetched ${result.spans?.length ?? 0})`);

        // Get the current report (reuse the top-of-poll fetch when it
        // succeeded — one storage read per attempt).
        const report = currentReport ?? await asyncRunStorage.getReportById(reportId);
        if (!report) {
          throw new Error(`Report ${reportId} not found`);
        }

        // Build trajectory from trace spans
        const { trajectory, shouldContinuePolling, fromHook } = await this.buildTrajectory(filteredResult.spans, state);
        // Check if we should continue polling
        if (shouldContinuePolling) {
          if (state.attempts >= state.maxAttempts) {
            console.log(`[TracePoller] Max attempts reached with incomplete trace`);
            state.running = false;
            callbacks?.onError(new Error(`Trace incomplete after ${state.maxAttempts} attempts`));
            
            await this.persistTraceFailure(
              reportId,
              'trace_incomplete',
              `found ${filteredResult.spans.length} spans but no root span after ${state.maxAttempts} attempts`,
            ).catch(err => console.error(`[TracePoller] Failed to update report error status:`, err));
            
            this.callbacks.delete(reportId);
            this.polls.delete(reportId);
          } else {
            // Schedule next poll
            state.timerId = setTimeout(() => this.poll(reportId), state.intervalMs);
          }
          return;
        }

        // Trajectory replacement policy:
        //  - an agent's explicit buildTrajectory HOOK is intentional — its
        //    output always wins (issue #320);
        //  - the DEFAULT span→trajectory conversion replaces the connector
        //    trajectory so tool calls are visible to the judge (#320) — BUT
        //    if the span-built steps carry no response content (e.g. Claude
        //    Code tool spans: prompts/responses live in OTel LOGS, not span
        //    attributes), the connector trajectory's response steps are
        //    appended so the judge still sees the agent's actual answer.
        //    Replacing wholesale with content-less span stubs made the judge
        //    fail every case of a live benchmark.
        if (trajectory.length > 0) {
          if (fromHook) {
            report.trajectory = trajectory;
          } else {
            const hasResponseContent = trajectory.some(
              (st: any) => st?.type === 'response' && typeof st.content === 'string' && st.content.trim().length > 0
            );
            const originalResponses = (report.trajectory || []).filter(
              (st: any) => (st?.type === 'response' || st?.type === 'assistant') &&
                typeof st.content === 'string' && st.content.trim().length > 0
            );
            report.trajectory = !hasResponseContent && originalResponses.length > 0
              ? [...trajectory, ...originalResponses]
              : trajectory;
          }
        }

        // Stop polling and notify success
        state.running = false;

        // Claim the report before judging (pending -> calculating). Not an
        // atomic lease — the storage layer has no CAS — but it makes the
        // browser recovery's "someone else is judging" guard effective and
        // narrows the double-judge window between sibling pollers to the
        // fetch-to-claim gap.
        try {
          await asyncRunStorage.updateReport(reportId, { metricsStatus: 'calculating' } as any);
        } catch { /* best-effort claim — proceed to judge regardless */ }

        try {
          await callbacks?.onTracesFound(filteredResult.spans, report);
        } catch (callbackErr) {
          // onTracesFound failed (e.g., judge + error recovery both failed).
          // Write error status so the report doesn't stay stuck in 'pending'.
          console.error(`[TracePoller] onTracesFound callback failed for report ${reportId}:`, callbackErr);
          try {
            await this.persistTraceFailure(reportId, 'trace_callback_failed', callbackErr, report);
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
            await this.persistTraceFailure(
              reportId,
              'trace_timeout',
              `traces not available after ${state.maxAttempts} attempts (${state.maxAttempts * state.intervalMs / 60000} minutes)`,
            );
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
          await this.persistTraceFailure(reportId, 'trace_fetch_failed', error);
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
   * Persist a terminal trace diagnostic without destroying a verdict that has
   * already landed. Trace polling can race a no-trace/inline judge path; in
   * that case the timeout is a warning, not a new evaluation result (#407).
   */
  private async persistTraceFailure(
    reportId: string,
    kind: 'trace_timeout' | 'trace_incomplete' | 'trace_callback_failed' | 'trace_fetch_failed',
    error: unknown,
    knownReport?: EvaluationReport,
  ): Promise<void> {
    const errorPatch = buildEvaluatorErrorPatch(kind, error);
    let current: EvaluationReport | null = knownReport ?? null;
    // Re-read whenever the caller does not already hold an authoritative
    // verdict. Timeout/fetch failures can race another poller or judge that
    // settles the report between the top-of-poll read and this write.
    if (!getJudgeVerdict(current)) {
      try {
        current = (await asyncRunStorage.getReportById(reportId)) ?? current;
      } catch {
        // Failure persistence must still work when the storage read is
        // unavailable; in that case there is no known verdict to protect.
      }
    }
    const verdict = getJudgeVerdict(current);

    if (verdict) {
      await asyncRunStorage.updateReport(reportId, {
        metricsStatus: 'ready',
        traceStatus: 'unavailable',
        traceError: errorPatch.traceError,
      });
      return;
    }

    // Another path already recorded a terminal evaluator error (or a ready
    // state without a parseable legacy verdict). Do not replace that more
    // specific result with a generic trace diagnostic.
    if (current?.metricsStatus === 'ready' || current?.metricsStatus === 'error') return;

    await asyncRunStorage.updateReport(reportId, {
      ...errorPatch,
      traceStatus: 'unavailable',
    } as any);
  }

  /**
   * Build trajectory from spans with proper error handling
   */
  private async buildTrajectory(spans: Span[], state: PollState): Promise<{ trajectory: any[], shouldContinuePolling: boolean, fromHook: boolean }> {
    const traceId = spans[0]?.traceId;
    if (!traceId) {
      console.warn(`[TracePoller] No traceId found in spans`);
      return { trajectory: [], shouldContinuePolling: false, fromHook: false };
    }

    // No buildTrajectory hook: fall back to the generic span→trajectory
    // conversion so the judge grades what the traces actually show (tool
    // calls included) instead of the tool-call-less AG-UI trajectory.
    // Previously this returned [] and trace-only agents could not be judged
    // from their traces without a custom hook (issue #320, root cause 2).
    if (!state.agentConfig?.hooks?.buildTrajectory) {
      try {
        const converted = spansToTrajectory(spans, state.agentConfig?.traceServiceName);
        if (converted.length > 0) {
          debug('TracePoller', `Default span→trajectory conversion produced ${converted.length} steps for trace ${traceId}`);
        }
        return { trajectory: converted, shouldContinuePolling: false, fromHook: false };
      } catch (err) {
        console.error(`[TracePoller] Default span→trajectory conversion failed for ${traceId}:`, err);
        return { trajectory: [], shouldContinuePolling: false, fromHook: false };
      }
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
        return { trajectory: hookResult, shouldContinuePolling: false, fromHook: true };
      } else {
        console.log(`[TracePoller] Hook returned null - trace not ready yet`);
        return { trajectory: [], shouldContinuePolling: true, fromHook: true };
      }
    } catch (err) {
      console.error(`[TracePoller] Failed to build trajectory for ${traceId}:`, err);
      return { trajectory: [], shouldContinuePolling: false, fromHook: true };
    }
  }
}

// Singleton instance
export const tracePollingManager = new TracePollingManager();
