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
 */

import type { TestCase, TrajectoryStep, EvaluationReport, EvaluationMetrics, ImprovementStrategy, PassFailStatus, MetricsStatus } from '@/types';
import { debug } from '@/lib/debug';

/**
 * Request options for server-side evaluation
 */
export interface ServerEvaluationRequest {
  agentKey: string;
  modelId: string;
  /** Look up test case by ID from storage/samples */
  testCaseId?: string;
  /** Provide test case inline (for ad-hoc runs) */
  testCase?: TestCase;
  /** Optional endpoint override */
  agentEndpoint?: string;
  /** Optional evaluator ID for custom evaluation criteria */
  evaluatorId?: string;
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
 * Run an evaluation via the server's /api/evaluate SSE endpoint.
 *
 * @param request - Evaluation parameters (agent, model, test case)
 * @param onStep - Callback for each trajectory step as it streams in
 * @returns The report summary and saved reportId from the completed event
 */
export async function runServerEvaluation(
  request: ServerEvaluationRequest,
  onStep?: (step: TrajectoryStep) => void
): Promise<ServerEvaluationResult> {
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
      const parsed = parseSSEEvent(event, onStep);
      if (parsed) {
        result = parsed;
      }
    }
  }

  // Process any remaining buffer content
  if (buffer.trim()) {
    const parsed = parseSSEEvent(buffer, onStep);
    if (parsed) {
      result = parsed;
    }
  }

  if (!result) {
    throw new Error('Evaluation completed without returning result');
  }

  console.info('[ClientAPI] Evaluation completed, reportId:', result.reportId);
  debug('ClientAPI', 'Full result:', result);
  return result;
}

/**
 * Parse a single SSE event string and dispatch to appropriate handler
 */
function parseSSEEvent(
  event: string,
  onStep?: (step: TrajectoryStep) => void
): ServerEvaluationResult | null {
  const lines = event.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));

        if (data.type === 'step' && onStep) {
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
          throw new Error(data.error);
        } else if (data.type === 'started') {
          console.info('[ClientAPI] Evaluation job started on server, streaming trajectory...');
        }
        // Other events are informational — no action needed
      } catch (e) {
        // Rethrow application errors, ignore JSON parse errors for incomplete chunks
        if (e instanceof Error && !(e instanceof SyntaxError)) {
          throw e;
        }
      }
    }
  }
  return null;
}
