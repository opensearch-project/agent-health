/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry-judgement surfaces shared by the inspector header, the runs-list
 * row, the confirm dialog and the page-level toaster:
 *   - `formatRetryJudgementSummary` — the ONE wording for a finished retry:
 *     "Retried 3 · 2 scored · 1 not evaluable" (never "still failed" for a
 *     case the evaluator simply could not apply to).
 *   - `RetryJudgementJobPill` — amber "Re-judging n/N…" pill shown on a run
 *     while its job runs (subscribes to the job store by run id); once no job
 *     runs it shows a dismissible "re-judge failed" pill while the run doc
 *     carries a `lastRetryAttempt` (≥1 case produced no judgement — owner:
 *     the previous judgement was preserved, the failure must stay visible
 *     until the next successful retry or a UI-only dismissal).
 *   - `RetryJudgementToaster` — mounted once in Layout; announces each
 *     finished job (summary or error) with an "Open run" link, dismissible,
 *     auto-dismissed after a while. The repo has no general toast system;
 *     this is deliberately scoped to retry-judgement jobs.
 */

import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useRetryJudgementJob, useRetryJudgementJobs } from '@/hooks/useRetryJudgementJob';
import { dismissRetryJudgementJob, type RetryJudgementJob } from '@/services/client/retryJudgementJobs';
import { notEvaluableCount, type RetryJudgementSummary } from '@/services/client/evaluationRunsApi';
import { runReportPath } from '@/lib/runReportPath';
import { formatRelativeTime } from '@/lib/utils';
import type { RunRetryAttemptSummary } from '@/types';
import { dismissRetryAttempt, useDismissedAttempt } from './LastRetryAttemptBanner';

/** "Retried 3 · 2 scored (1 abstain) · 1 not evaluable[ · 1 failed]". */
export function formatRetryJudgementSummary(summary: RetryJudgementSummary): string {
  const notEvaluable = notEvaluableCount(summary);
  const abstain = summary.abstain ?? summary.results.filter(r => r.outcome === 'succeeded' && r.abstain).length;
  const parts = [`Retried ${summary.retried}`, `${summary.succeeded} scored${abstain > 0 ? ` (${abstain} abstain)` : ''}`];
  if (notEvaluable > 0) parts.push(`${notEvaluable} not evaluable`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  return parts.join(' · ');
}

/** Hint shown next to a summary / pre-flight in which the evaluator could not score every case. */
export const NOT_EVALUABLE_HINT =
  "This evaluator's gold/extraction rules don't match these cases — pick another evaluator or add gold ids.";

/** Toasts linger this long before auto-dismissing (ms). */
export const RETRY_JUDGEMENT_TOAST_MS = 15000;

/** "3 not evaluable · 1 failed — <reason> (×2), <reason>" for the failed pill's hover. */
export function describeRunRetryAttempt(a: RunRetryAttemptSummary): string {
  const counts = [
    a.notEvaluable > 0 ? `${a.notEvaluable} not evaluable` : '',
    a.failed > 0 ? `${a.failed} failed` : '',
  ].filter(Boolean).join(' · ');
  const reasons = Object.entries(a.reasons).map(([r, n]) => (n > 1 ? `${r} (×${n})` : r)).join('; ');
  const who = a.evaluatorName || a.evaluatorId || 'the run\'s evaluator';
  return `Last re-judgement ${formatRelativeTime(a.at)} with ${who}: ${a.succeeded} of ${a.retried} judged, ${counts}${reasons ? ` — ${reasons}` : ''}. The previous judgements were preserved.`;
}

export const RetryJudgementJobPill: React.FC<{
  runId: string;
  runName?: string;
  className?: string;
  /** The run doc's last failed attempt (RunRetryAttemptSummary); shows the "re-judge failed" state when no job is running. */
  lastRetryAttempt?: RunRetryAttemptSummary | null;
}> = ({ runId, runName, className, lastRetryAttempt }) => {
  const job = useRetryJudgementJob(runId, runName);
  const dismissed = useDismissedAttempt(runId, lastRetryAttempt?.at);
  if (job?.status === 'running') {
    const progress = job.total > 0 ? `${job.completed}/${job.total}` : '';
    return (
      <span
        data-testid={`retry-judgement-pill-${runId}`}
        className={`inline-flex items-center gap-1 px-1.5 py-0 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 whitespace-nowrap ${className ?? ''}`}
        title="Retry judgement is running in the background — you can keep navigating; the run refreshes when it finishes"
      >
        <Loader2 size={9} className="animate-spin" /> Re-judging{progress ? ` ${progress}` : ''}…
      </span>
    );
  }
  if (lastRetryAttempt && !dismissed) {
    return (
      <span
        data-testid={`retry-judgement-failed-pill-${runId}`}
        className={`inline-flex items-center gap-1 px-1.5 py-0 rounded-full text-[9px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40 whitespace-nowrap ${className ?? ''}`}
        title={describeRunRetryAttempt(lastRetryAttempt)}
      >
        <AlertTriangle size={9} /> re-judge failed
        <button
          type="button"
          aria-label="Dismiss"
          data-testid={`retry-judgement-failed-pill-dismiss-${runId}`}
          onClick={e => { e.stopPropagation(); dismissRetryAttempt(runId, lastRetryAttempt.at); }}
          className="ml-0.5 text-amber-700/70 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-200"
        >
          <X size={9} />
        </button>
      </span>
    );
  }
  return null;
};

const Toast: React.FC<{ job: RetryJudgementJob }> = ({ job }) => {
  useEffect(() => {
    const t = setTimeout(() => dismissRetryJudgementJob(job.runId), RETRY_JUDGEMENT_TOAST_MS);
    return () => clearTimeout(t);
  }, [job.runId, job.finishedAt]);

  const ok = job.status === 'completed' && job.summary;
  const notEvaluable = ok ? notEvaluableCount(job.summary!) : 0;
  const label = job.label || job.runId.slice(0, 8);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`retry-judgement-toast-${job.runId}`}
      className="pointer-events-auto w-[340px] rounded-md border bg-card shadow-lg p-3 text-xs flex items-start gap-2"
    >
      {ok
        ? <CheckCircle2 size={14} className={`shrink-0 mt-0.5 ${notEvaluable > 0 ? 'text-amber-500' : 'text-green-500'}`} />
        : <AlertTriangle size={14} className="shrink-0 mt-0.5 text-red-500" />}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium truncate" title={label}>Retry judgement {ok ? 'finished' : 'failed'} — {label}</div>
        <div className="text-muted-foreground" data-testid={`retry-judgement-toast-summary-${job.runId}`}>
          {ok ? formatRetryJudgementSummary(job.summary!) : job.error}
        </div>
        {notEvaluable > 0 && <div className="text-amber-700 dark:text-amber-300">{NOT_EVALUABLE_HINT}</div>}
        <Link
          to={runReportPath(job.runId, undefined)}
          onClick={() => dismissRetryJudgementJob(job.runId)}
          className="inline-block text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open run
        </Link>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid={`retry-judgement-toast-dismiss-${job.runId}`}
        onClick={() => dismissRetryJudgementJob(job.runId)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
};

export const RetryJudgementToaster: React.FC = () => {
  const jobs = useRetryJudgementJobs();
  const finished = jobs.filter(j => j.status !== 'running');
  if (finished.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2" data-testid="retry-judgement-toaster">
      {finished.map(job => <Toast key={`${job.runId}:${job.startedAt}`} job={job} />)}
    </div>
  );
};
