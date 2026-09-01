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
  description?: string;
  agentEndpoint?: string;
  headers?: Record<string, string>;
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
    const err = new Error(`Failed to get evaluation run: ${response.statusText}`) as Error & { status?: number };
    // Attached (not part of the message) so callers can distinguish "not
    // found" from a transient/server failure without string-matching
    // statusText -- see RunInspectorPage.tsx's canonical-run resolution,
    // which must NOT silently treat a 500/network error the same as a 404.
    err.status = response.status;
    throw err;
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
 * Re-run an evaluation run: duplicate its config into a brand-new,
 * independent run (fresh id, "<name> (re-run)"), linked back via
 * `rerunOf`. The new run starts executing immediately server-side; poll
 * `getEvaluationRun(runId)` for progress (same as any 'running' run).
 */
export async function rerunEvaluationRun(id: string): Promise<{
  runId: string;
  run: EvaluationRun;
  defaultsApplied: string[];
}> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}/rerun`, {
    method: 'POST',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to re-run evaluation run');
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
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to update evaluation run');
  }

  return response.json();
}

export interface RetryJudgementCaseResult {
  testCaseId: string;
  reportId: string;
  outcome: 'succeeded' | 'failed';
  passFailStatus?: 'passed' | 'failed' | null;
  error?: string;
}

export interface RetryJudgementSummary {
  retried: number;
  succeeded: number;
  failed: number;
  results: RetryJudgementCaseResult[];
}

export interface RetryJudgementJobStatus {
  status: 'running' | 'completed' | 'failed';
  total: number;
  completed: number;
  summary?: RetryJudgementSummary;
  error?: string;
}

/**
 * Poll the background job started by {@link retryJudgement}'s POST. 404s
 * once the run never had a job (never started, or the server-side tracking
 * entry aged out) — surfaced to the caller as a thrown Error, same as any
 * other non-2xx response here.
 */
export async function getRetryJudgementStatus(id: string): Promise<RetryJudgementJobStatus> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}/retry-judgement/status`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to fetch retry-judgement status');
  }
  return response.json();
}

/** Polling cadence + ceiling for {@link retryJudgement} below. */
const RETRY_JUDGEMENT_POLL_INTERVAL_MS = 2000;
/** 30 minutes at the interval above — generous over the real incident's ~20-30min run, still bounded. */
const RETRY_JUDGEMENT_POLL_MAX_ATTEMPTS = 900;

/**
 * Retry judgement for a TERMINAL run's judge-failed cases (or, with
 * `scope: 'all'`, every rejudgeable case) at judge cost only — the agent is
 * never re-invoked. 409s if the run is still executing.
 *
 * The route responds 202 immediately (job started in the background) and
 * this function polls GET .../retry-judgement/status until the job reaches
 * a terminal state, resolving with the final summary. This is what fixes
 * the real incident this shipped for: a 62-case run's judge pipeline ran
 * 20-30+ minutes, well past any fetch/proxy timeout — awaiting a single
 * long-open POST surfaced a false "failed to retry judgement" toast while
 * the server kept working. `onProgress(completed, total)` fires after the
 * initial POST and after every poll, so callers can render live progress.
 */
export async function retryJudgement(
  id: string,
  scope: 'errored' | 'all' = 'errored',
  onProgress?: (completed: number, total: number) => void
): Promise<RetryJudgementSummary> {
  const response = await fetch(`/api/storage/evaluation-runs/${id}/retry-judgement?scope=${scope}`, {
    method: 'POST',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to retry judgement');
  }

  const started: { total?: number } = await response.json().catch(() => ({}));
  onProgress?.(0, started.total ?? 0);

  for (let attempt = 0; attempt < RETRY_JUDGEMENT_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise(resolve => setTimeout(resolve, RETRY_JUDGEMENT_POLL_INTERVAL_MS));
    const job = await getRetryJudgementStatus(id);
    onProgress?.(job.completed, job.total);
    if (job.status === 'completed') {
      if (!job.summary) throw new Error('Retry judgement reported completed with no summary');
      return job.summary;
    }
    if (job.status === 'failed') {
      throw new Error(job.error || 'Retry judgement failed');
    }
  }
  throw new Error('Retry judgement is taking longer than expected — check back on the run later');
}
