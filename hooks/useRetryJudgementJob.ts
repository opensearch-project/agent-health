/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React bindings for the retry-judgement job store
 * (services/client/retryJudgementJobs.ts). Every surface that shows a run
 * subscribes here so the "Re-judging n/N…" pill and the completion toast
 * are consistent whether the job was started from the inspector, the runs
 * list, or a dialog that has since been closed.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  adoptRetryJudgementJob,
  getRetryJudgementJob,
  listRetryJudgementJobs,
  subscribeRetryJudgementJobs,
  type RetryJudgementJob,
} from '@/services/client/retryJudgementJobs';

const EMPTY: ReadonlyArray<RetryJudgementJob> = [];

/**
 * The job for one run (running or finished-but-undismissed), or `undefined`.
 * On mount it also asks the server once whether a job is already running for
 * this run (page reload mid-retry) and adopts it.
 */
export function useRetryJudgementJob(runId: string | undefined, label?: string): RetryJudgementJob | undefined {
  const job = useSyncExternalStore(
    subscribeRetryJudgementJobs,
    () => (runId ? getRetryJudgementJob(runId) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (!runId) return;
    void adoptRetryJudgementJob(runId, label);
    // `label` is display-only; re-adopting on rename is pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  return job;
}

/** Every tracked job — for the page-level toaster. */
export function useRetryJudgementJobs(): ReadonlyArray<RetryJudgementJob> {
  return useSyncExternalStore(subscribeRetryJudgementJobs, listRetryJudgementJobs, () => EMPTY);
}

/**
 * Fire `onFinished(job)` exactly once per job that transitions
 * running → completed/failed while mounted (the pages use it to reload the
 * run so the fresh verdicts show without a manual refresh).
 */
export function useOnRetryJudgementFinished(onFinished: (job: RetryJudgementJob) => void): void {
  const jobs = useRetryJudgementJobs();
  const seenRunning = useRef(new Set<string>());
  const announced = useRef(new Set<string>());
  const callback = useRef(onFinished);
  callback.current = onFinished;
  useEffect(() => {
    for (const job of jobs) {
      const key = `${job.runId}:${job.startedAt}`;
      if (job.status === 'running') { seenRunning.current.add(key); continue; }
      if (seenRunning.current.has(key) && !announced.current.has(key)) {
        announced.current.add(key);
        callback.current(job);
      }
    }
  }, [jobs]);
}
