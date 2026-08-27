/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side API for evaluation runs.
 *
 * Handles CRUD, SSE streaming for execution, cancellation, and promotion.
 */

import { EvaluationRun, TestCaseSource, TestCaseSnapshot } from '@/types';
import { debug } from '@/lib/debug';

export interface CreateEvaluationRunRequest {
  name?: string;
  sources: TestCaseSource[];
  agentKey: string;
  modelId: string;
  /**
   * Optional judge model id, distinct from `modelId` (the agent's LLM).
   * Customer input via the run config UI / CLI `--judge-model`. Forwarded
   * to the server which falls back to the evaluator's `inferenceConfig.modelId`,
   * then `BEDROCK_MODEL_ID` env. Agentic-provider judges (`pi`, `agent`,
   * `agentic`, `claude-code`) ignore this and pick their own model.
   */
  judgeModelId?: string;
  evaluatorId?: string;
  concurrency?: number;
  benchmarkId?: string;
  trigger?: 'ui' | 'cli' | 'api' | 'schedule';
}

export interface EvaluationRunProgress {
  runId: string;
  testCaseId: string;
  startedCount: number;
  completedCount: number;
  totalTestCases: number;
  status: string;
}

export interface EvaluationRunStartedEvent {
  runId: string;
  testCases: TestCaseSnapshot[];
}

/**
 * Create and execute an evaluation run via SSE streaming.
 */
export async function executeEvaluationRun(
  request: CreateEvaluationRunRequest,
  onProgress: (progress: EvaluationRunProgress) => void,
  onStarted?: (event: EvaluationRunStartedEvent) => void,
  onTestCaseComplete?: (testCaseId: string, result: any) => void
): Promise<EvaluationRun> {
  debug('ClientAPI', 'Creating evaluation run:', request.name);

  const response = await fetch('/api/storage/evaluation-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create evaluation run');
  }

  return consumeRunSSEStream(response, onProgress, onStarted, onTestCaseComplete);
}

/**
 * Resume an interrupted evaluation run via SSE streaming.
 *
 * Re-executes only the test cases without a persisted report; completed
 * test cases keep their existing reports (checkpoint-resume semantics).
 */
export async function resumeEvaluationRun(
  runId: string,
  onProgress: (progress: EvaluationRunProgress) => void,
  onStarted?: (event: EvaluationRunStartedEvent) => void,
  onTestCaseComplete?: (testCaseId: string, result: any) => void
): Promise<EvaluationRun> {
  debug('ClientAPI', 'Resuming evaluation run:', runId);

  const response = await fetch(`/api/storage/evaluation-runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to resume evaluation run');
  }

  return consumeRunSSEStream(response, onProgress, onStarted, onTestCaseComplete);
}

/**
 * Consume the SSE stream shared by the create and resume endpoints.
 */
async function consumeRunSSEStream(
  response: Response,
  onProgress: (progress: EvaluationRunProgress) => void,
  onStarted?: (event: EvaluationRunStartedEvent) => void,
  onTestCaseComplete?: (testCaseId: string, result: any) => void
): Promise<EvaluationRun> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let completedRun: EvaluationRun | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const lines = event.split('\n');
      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ')) {
          eventData = line.slice(6);
        }
      }

      if (!eventData) continue;

      try {
        const data = JSON.parse(eventData);

        switch (eventType) {
          case 'started':
            debug('ClientAPI', `Evaluation run ${data.runId} started — ${data.testCases?.length ?? 0} test cases`);
            onStarted?.({ runId: data.runId, testCases: data.testCases || [] });
            break;
          case 'progress':
            onProgress(data);
            break;
          case 'testCaseComplete':
            onTestCaseComplete?.(data.testCaseId, data.result);
            break;
          case 'completed':
            completedRun = data;
            break;
          case 'error':
            throw new Error(data.error || 'Evaluation run failed');
        }
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) {
          throw e;
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    let eventType = '';
    let eventData = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      else if (line.startsWith('data: ')) eventData = line.slice(6);
    }
    if (eventData) {
      try {
        const data = JSON.parse(eventData);
        if (eventType === 'completed') completedRun = data;
        else if (eventType === 'error') throw new Error(data.error);
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
  }

  if (!completedRun) {
    throw new Error('Evaluation run completed without returning result');
  }

  return completedRun;
}

/**
 * List evaluation runs with optional filters.
 */
export async function listEvaluationRuns(options?: {
  benchmarkId?: string;
  agentKey?: string;
  status?: string;
  testCaseId?: string;
  trigger?: string;
  from?: number;
  size?: number;
  sort?: string;
  order?: string;
}): Promise<{ evaluationRuns: EvaluationRun[]; total: number }> {
  const params = new URLSearchParams();
  if (options) {
    Object.entries(options).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
  }

  const url = `/api/storage/evaluation-runs${params.toString() ? '?' + params.toString() : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to list evaluation runs: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get a single evaluation run by ID.
 */
export async function getEvaluationRun(id: string): Promise<EvaluationRun> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}`);

  if (!response.ok) {
    throw new Error(`Failed to get evaluation run: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Cancel a running evaluation.
 */
export async function cancelEvaluationRun(id: string): Promise<boolean> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}/cancel`, {
    method: 'POST',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to cancel evaluation run');
  }

  const result = await response.json();
  return result.success === true;
}

/**
 * Delete an evaluation run.
 */
export async function deleteEvaluationRun(id: string): Promise<boolean> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(`Failed to delete evaluation run: ${response.statusText}`);
  }

  const result = await response.json();
  return result.success === true;
}

/**
 * Promote an ad-hoc run to a benchmark.
 */
export async function promoteEvaluationRun(
  id: string,
  benchmarkName: string
): Promise<{ benchmark: any; run: EvaluationRun }> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ benchmarkName }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to promote evaluation run');
  }

  return response.json();
}

/**
 * Update an evaluation run (partial).
 */
export async function updateEvaluationRun(
  id: string,
  updates: Partial<EvaluationRun>
): Promise<EvaluationRun> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error(`Failed to update evaluation run: ${response.statusText}`);
  }

  return response.json();
}
