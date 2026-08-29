/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for single evaluation execution
 *
 * Consumes the /api/evaluate SSE endpoint, the same path used by the CLI.
 * This consolidates the browser evaluation path to go through the server,
 * ensuring consistent behavior (hooks, connector selection, storage) regardless
 * of whether the evaluation was triggered from the UI or CLI.
 *
 * Disconnect recovery:
 *   The server pre-persists a placeholder run and emits its `reportId` in the
 *   `started` event. If the SSE stream drops mid-evaluation (network blip, TCP
 *   idle timeout, browser tab throttle, etc.), this client falls back to polling
 *   GET /api/storage/runs/:id until the run reaches a terminal state. This
 *   mirrors the CLI's behavior in `cli/utils/apiClient.ts` so the UX is consistent
 *   between the QuickRunModal and `agent-health run`.
 */

import type { TestCase, TrajectoryStep, EvaluationReport, EvaluationMetrics, ImprovementStrategy, PassFailStatus, MetricsStatus, TraceStatus } from '@/types';
import type { MatcherResult } from '@/lib/matchers/types';
import { debug } from '@/lib/debug';

/**
 * Request options for server-side evaluation
 */
export interface ServerEvaluationRequest {
  agentKey: string;
  modelId: string;
  /**
   * Optional judge model id, distinct from `modelId` (the agent's LLM).
   * Customer input via the run config dialog. Forwarded as `judgeModelId`
   * on the `/api/evaluate` request body. Falls back server-side to the
   * evaluator's `inferenceConfig.modelId`, then `BEDROCK_MODEL_ID` env.
   * Ignored by agentic-provider judges (`pi`, `agent`, `agentic`,
   * `claude-code`) which pick their own model.
   */
  judgeModelId?: string;
  /** Look up test case by ID from storage/samples */
  testCaseId?: string;
  /** Provide test case inline (for ad-hoc runs) */
  testCase?: TestCase;
  /** Optional endpoint override */
  agentEndpoint?: string;
  /** Optional evaluator ID for custom evaluation criteria */
  evaluatorId?: string;
  /**
   * Optional human-readable name for the persisted run. If omitted the server
   * generates `Run <short-id>` so every run has a recognizable label in the
   * runs list. Mirrors `BenchmarkRun.name` for symmetry between single and
   * batch runs.
   */
  runName?: string;
  /** Optional human-readable description of what this run was testing. */
  runDescription?: string;
}

/**
 * Summary report returned from the completed SSE event
 */
export interface ServerEvaluationReport {
  id: string;
  status: string;
  passFailStatus?: PassFailStatus;
  metricsStatus?: MetricsStatus;
  metrics: EvaluationMetrics;
  matcherResults?: MatcherResult[];
  traceStatus?: TraceStatus;
  traceError?: string;
  trajectorySteps: number;
  llmJudgeReasoning?: string;
  improvementStrategies?: ImprovementStrategy[];
}

/**
 * Result from runServerEvaluation
 */
export interface ServerEvaluationResult {
  reportId: string;
  report: ServerEvaluationReport;
}

/**
 * Lifecycle hook callbacks fired by runServerEvaluation.
 *
 * These let the UI surface disconnect/recovery state to the user. The modal
 * can show a "reconnecting…" hint while the server keeps running and the
 * client polls for the final result.
 */
export interface ServerEvaluationHooks {
  /** Fired once for each trajectory step streamed from the server */
  onStep?: (step: TrajectoryStep) => void;
  /** Fired when the SSE stream drops and the client switches to polling */
  onReconnect?: (reportId: string, reason: string) => void;
  /** Fired on every polling cycle while waiting for the run to finish */
  onPoll?: (report: { id: string; status?: string }) => void;
}

/** Default polling timeout (10 minutes) once SSE has dropped */
const POLL_TIMEOUT_MS = 600_000;
/** Polling interval while waiting for a terminal status */
const POLL_INTERVAL_MS = 5_000;

/**
 * Run an evaluation via the server's /api/evaluate SSE endpoint.
 *
 * Falls back to polling GET /api/storage/runs/:reportId if the SSE stream
 * disconnects mid-evaluation. The server keeps processing in the background
 * regardless of whether the client is still connected.
 *
 * @param request - Evaluation parameters (agent, model, test case)
 * @param hooks   - Either a step callback (legacy signature) or a full hooks object
 * @returns The report summary and saved reportId from the completed event
 */
export async function runServerEvaluation(
  request: ServerEvaluationRequest,
  hooks?: ((step: TrajectoryStep) => void) | ServerEvaluationHooks
): Promise<ServerEvaluationResult> {
  // Backwards-compat: callers can pass a single onStep function or a hooks object.
  const normalizedHooks: ServerEvaluationHooks =
    typeof hooks === 'function' ? { onStep: hooks } : hooks ?? {};
  const { onStep, onReconnect, onPoll } = normalizedHooks;

  console.info('[ClientAPI] Running server evaluation:', request.agentKey, request.modelId);
  debug('ClientAPI', 'Request details:', request);
  const response = await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorBody.error || `Evaluation request failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let result: ServerEvaluationResult | null = null;
  let reportId: string | null = null;
  let serverError: Error | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new chunk to buffer
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const events = buffer.split('\n\n');

      // Keep the last potentially incomplete event in the buffer
      buffer = events.pop() || '';

      // Process complete events
      for (const event of events) {
        const parsed = parseSSEEvent(event, onStep, (id) => {
          reportId = id;
        });
        if (parsed === SSE_ERROR) {
          // Server explicitly told us the eval failed — don't try to recover.
          serverError = new Error(getErrorFromEvent(event) || 'Evaluation error');
          break;
        }
        if (parsed) {
          result = parsed;
        }
      }

      if (serverError) break;
    }

    // Process any remaining buffer content
    if (!serverError && buffer.trim()) {
      const parsed = parseSSEEvent(buffer, onStep, (id) => {
        reportId = id;
      });
      if (parsed === SSE_ERROR) {
        serverError = new Error(getErrorFromEvent(buffer) || 'Evaluation error');
      } else if (parsed) {
        result = parsed;
      }
    }
  } catch (streamError: any) {
    // Network error mid-stream. Try to recover via polling if we have a reportId.
    if (result) {
      // We already saw a completed event before the connection dropped — return it.
      debug('ClientAPI', 'Stream errored after completion, returning cached result');
      return result;
    }
    if (reportId) {
      const reason = streamError?.message || String(streamError);
      console.warn(
        `[ClientAPI] SSE stream disconnected: ${reason}. ` +
        `Falling back to polling for report ${reportId} — server is still processing in the background...`
      );
      onReconnect?.(reportId, reason);
      const polled = await pollForReport(reportId, onPoll);
      if (polled) return polled;
    }
    throw streamError;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors
    }
  }

  if (serverError) {
    throw serverError;
  }

  if (!result) {
    // Stream ended without a completed event — try polling.
    if (reportId) {
      console.warn('[ClientAPI] SSE stream ended without completion event, polling for status...');
      onReconnect?.(reportId, 'stream ended without completion');
      const polled = await pollForReport(reportId, onPoll);
      if (polled) return polled;
    }
    throw new Error('Evaluation completed without returning result');
  }

  console.info('[ClientAPI] Evaluation completed, reportId:', result.reportId);
  debug('ClientAPI', 'Full result:', result);
  return result;
}

/**
 * Sentinel returned by parseSSEEvent when the server emits an error event.
 * Lets the caller distinguish "explicit server failure" from "no result yet".
 */
const SSE_ERROR = Symbol('sse-error');

/**
 * Parse a single SSE event string and dispatch to appropriate handler.
 * Returns:
 *   - ServerEvaluationResult on a 'completed' event
 *   - SSE_ERROR on an 'error' event (caller should stop and surface the error)
 *   - null otherwise
 */
function parseSSEEvent(
  event: string,
  onStep: ((step: TrajectoryStep) => void) | undefined,
  onReportId: (id: string) => void
): ServerEvaluationResult | typeof SSE_ERROR | null {
  const lines = event.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));

        // Heartbeat events are pure connection-keepalive — ignore.
        if (data.type === 'heartbeat') {
          return null;
        }

        if (data.type === 'started') {
          if (data.reportId) {
            onReportId(data.reportId);
          }
          console.info('[ClientAPI] Evaluation job started on server, streaming trajectory...');
        } else if (data.type === 'step' && onStep) {
          const step = data.step;
          const detail = step.toolName ? ` — ${step.toolName}${step.status ? ` (${step.status})` : ''}` : '';
          debug('ClientAPI', `Step: ${step.type}${detail}`);
          onStep(data.step as TrajectoryStep);
        } else if (data.type === 'completed') {
          debug('ClientAPI', `Evaluation completed — pass/fail: ${data.report?.passFailStatus ?? 'unknown'}, accuracy: ${data.report?.metrics?.accuracy ?? 'N/A'}`);
          return {
            reportId: data.reportId,
            report: data.report as ServerEvaluationReport,
          };
        } else if (data.type === 'error') {
          console.error('[ClientAPI] Evaluation error:', data.error);
          return SSE_ERROR;
        }
      } catch (e) {
        // Ignore JSON parse errors for incomplete chunks; rethrow real errors.
        if (!(e instanceof SyntaxError)) {
          throw e;
        }
      }
    }
  }
  return null;
}

function getErrorFromEvent(event: string): string | null {
  const lines = event.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'error') return data.error || null;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Poll GET /api/storage/runs/:reportId until the run reaches a terminal state.
 * Returns null if the report is not found or polling times out.
 */
async function pollForReport(
  reportId: string,
  onPoll?: (report: { id: string; status?: string }) => void
): Promise<ServerEvaluationResult | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(`/api/storage/runs/${encodeURIComponent(reportId)}`);
      if (res.status === 404) {
        // Placeholder may not have been created (storage not configured).
        return null;
      }
      if (res.ok) {
        const report = (await res.json()) as EvaluationReport & { id: string };
        onPoll?.({ id: report.id, status: report.status });
        if (report.status && ['completed', 'failed', 'cancelled'].includes(report.status)) {
          return {
            reportId: report.id,
            report: {
              id: report.id,
              status: report.status,
              passFailStatus: report.passFailStatus,
              metricsStatus: report.metricsStatus,
              metrics: report.metrics,
              trajectorySteps: report.trajectory?.length || 0,
              llmJudgeReasoning: report.llmJudgeReasoning,
              improvementStrategies: report.improvementStrategies,
            },
          };
        }
      }
    } catch (e) {
      debug('ClientAPI', 'Poll attempt failed (will retry):', e);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  // Timed out — return whatever the latest snapshot looks like.
  try {
    const res = await fetch(`/api/storage/runs/${encodeURIComponent(reportId)}`);
    if (res.ok) {
      const report = (await res.json()) as EvaluationReport & { id: string };
      return {
        reportId: report.id,
        report: {
          id: report.id,
          status: report.status,
          passFailStatus: report.passFailStatus,
          metricsStatus: report.metricsStatus,
          metrics: report.metrics,
          trajectorySteps: report.trajectory?.length || 0,
          llmJudgeReasoning: report.llmJudgeReasoning,
          improvementStrategies: report.improvementStrategies,
        },
      };
    }
  } catch {
    // ignore
  }
  return null;
}
