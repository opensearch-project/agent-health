/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side registry of in-flight / just-finished retry-judgement jobs,
 * keyed by run id.
 *
 * Why: the server already runs retry judgement as a background job (POST
 * → 202, GET .../retry-judgement/status to poll), but the confirm dialog
 * used to own the polling loop — so the modal had to stay open for the
 * whole 20-30 minute judge pipeline of a large run (owner: "the retry button
 * is not async in nature"). Moving the poll here makes the retry
 * fire-and-forget from the user's point of view: the dialog starts the job
 * and may be closed at once; every surface that shows the run (inspector
 * header, runs-list row, the dialog itself when re-opened) subscribes with
 * `useRetryJudgementJob(runId)` and renders the live "Re-judging n/N…"
 * pill; the page-level toaster announces the summary when the job ends.
 *
 * Plain module state + subscribe/notify (no store library): one Map, a
 * listener Set, and a setTimeout poll chain per job. `useSyncExternalStore`
 * consumes it (hooks/useRetryJudgementJob.ts). Closing the dialog never
 * cancels the job — there is no cancel; the server contract is unchanged.
 */

import {
  getRetryJudgementStatus,
  startRetryJudgement,
  type RetryJudgementRequest,
  type RetryJudgementSummary,
} from './evaluationRunsApi';

export interface RetryJudgementJob {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  completed: number;
  request: RetryJudgementRequest;
  /** Human label for toasts (the run name); falls back to the run id. */
  label?: string;
  startedAt: number;
  finishedAt?: number;
  summary?: RetryJudgementSummary;
  error?: string;
}

/** Poll cadence — the same 2s the old in-dialog loop used. */
export const RETRY_JUDGEMENT_JOB_POLL_MS = 2000;
/** Finished jobs are kept until dismissed (toast) or until this many ms pass, so a forgotten toast cannot leak forever. */
export const RETRY_JUDGEMENT_JOB_RETENTION_MS = 30 * 60 * 1000;

const jobs = new Map<string, RetryJudgementJob>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Immutable snapshot for useSyncExternalStore (must be referentially stable between changes). */
let snapshot: ReadonlyArray<RetryJudgementJob> = [];

function notify(): void {
  snapshot = Array.from(jobs.values());
  for (const listener of Array.from(listeners)) listener();
}

function setJob(job: RetryJudgementJob): void {
  jobs.set(job.runId, job);
  notify();
}

export function getRetryJudgementJob(runId: string): RetryJudgementJob | undefined {
  return jobs.get(runId);
}

/** All tracked jobs (running + finished-but-not-dismissed), stable between changes. */
export function listRetryJudgementJobs(): ReadonlyArray<RetryJudgementJob> {
  return snapshot;
}

export function subscribeRetryJudgementJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forget a finished job (the toast was dismissed / acted on). No-op for a running job — it cannot be cancelled from here. */
export function dismissRetryJudgementJob(runId: string): void {
  const job = jobs.get(runId);
  if (!job || job.status === 'running') return;
  jobs.delete(runId);
  notify();
}

function finish(runId: string, patch: Partial<RetryJudgementJob>): void {
  const job = jobs.get(runId);
  if (!job) return;
  const finished = { ...job, ...patch, finishedAt: Date.now() } as RetryJudgementJob;
  setJob(finished);
  const t = setTimeout(() => dismissRetryJudgementJob(runId), RETRY_JUDGEMENT_JOB_RETENTION_MS);
  (t as { unref?: () => void }).unref?.();
  timers.set(runId, t);
}

function schedulePoll(runId: string): void {
  const t = setTimeout(() => { void poll(runId); }, RETRY_JUDGEMENT_JOB_POLL_MS);
  (t as { unref?: () => void }).unref?.();
  timers.set(runId, t);
}

async function poll(runId: string): Promise<void> {
  const job = jobs.get(runId);
  if (!job || job.status !== 'running') return;
  try {
    const status = await getRetryJudgementStatus(runId);
    if (status.status === 'completed') {
      if (!status.summary) throw new Error('Retry judgement reported completed with no summary');
      finish(runId, { status: 'completed', completed: status.summary.retried, total: status.total, summary: status.summary });
      return;
    }
    if (status.status === 'failed') {
      finish(runId, { status: 'failed', completed: status.completed, total: status.total, error: status.error || 'Retry judgement failed' });
      return;
    }
    if (status.completed !== job.completed || status.total !== job.total) {
      setJob({ ...job, completed: status.completed, total: status.total });
    }
  } catch (error: any) {
    // A 404 means the server no longer knows the job (restart, or the
    // tracking entry aged out) — stop polling with an explicit error rather
    // than spinning forever; any other error is transient, keep polling.
    if (error?.status === 404) {
      finish(runId, { status: 'failed', error: 'The server lost track of this retry (restarted?) — check the run for updated verdicts' });
      return;
    }
  }
  schedulePoll(runId);
}

/**
 * POST the retry and, once the server accepts it (202), register a running
 * job and start polling. Resolves with the job as soon as it is accepted —
 * NOT when it finishes. Rejects (and registers nothing) when the server
 * refuses (409 already running / still executing, 400, 404), so callers can
 * show the error inline. A finished-but-undismissed job for the same run is
 * replaced.
 */
export async function startRetryJudgementJob(runId: string, request: RetryJudgementRequest = {}, label?: string): Promise<RetryJudgementJob> {
  const existing = jobs.get(runId);
  if (existing?.status === 'running') return existing;
  const { total } = await startRetryJudgement(runId, request);
  const prior = timers.get(runId);
  if (prior) clearTimeout(prior);
  const job: RetryJudgementJob = { runId, status: 'running', total, completed: 0, request, ...(label ? { label } : {}), startedAt: Date.now() };
  setJob(job);
  schedulePoll(runId);
  return job;
}

/**
 * Pick up a job this browser does not know about — e.g. after a page reload
 * while the server is still judging. Asks the status endpoint once; when a
 * job is running there, registers + polls it so the pill reappears. Silent
 * (resolves `undefined`) on 404 / errors: no job is the common case.
 */
export async function adoptRetryJudgementJob(runId: string, label?: string): Promise<RetryJudgementJob | undefined> {
  const known = jobs.get(runId);
  if (known) return known;
  try {
    const status = await getRetryJudgementStatus(runId);
    if (status.status !== 'running') return undefined;
    const job: RetryJudgementJob = { runId, status: 'running', total: status.total, completed: status.completed, request: {}, ...(label ? { label } : {}), startedAt: Date.now() };
    setJob(job);
    schedulePoll(runId);
    return job;
  } catch {
    return undefined;
  }
}

/** Test-only: drop every job and timer. */
export function __resetRetryJudgementJobsForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  jobs.clear();
  snapshot = [];
  listeners.clear();
}
