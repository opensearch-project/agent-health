/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Last re-judgement failed" — the owner rule is that a retry judgement
 * which produces no judgement PRESERVES the previous one and records the
 * attempt as `report.lastRetryAttempt` (services/evaluation/retryJudgement.ts).
 * This is the surface for that record on the run report's Judge tab: a
 * dismissible amber banner ("Last re-judgement failed 3 minutes ago ·
 * <evaluator> · <reason>") with a Details dialog (full reason, outcome,
 * evaluator / judge model / scope / time, the deterministic diagnostics
 * block) and a "Retry again" shortcut when the host page can open the
 * retry dialog. Dismissal is UI-only, per browser (localStorage, keyed by
 * report id + attempt time — a NEWER failed attempt shows again).
 *
 * `useDismissedAttempt` is shared with the run-level "re-judge failed" pill
 * (RetryJudgementJobs.tsx), which keys on the run id instead.
 */

import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatRelativeTime } from '@/lib/utils';
import type { RetryAttemptRecord } from '@/types';
import { ScoringDiagnosticsView } from './ScoringDiagnosticsView';

const DISMISS_PREFIX = 'ah:retry-attempt-dismissed:';
const listeners = new Set<() => void>();
const notify = () => { for (const l of Array.from(listeners)) l(); };

const readDismissed = (key: string): string | null => {
  try { return window.localStorage.getItem(DISMISS_PREFIX + key); } catch { return null; }
};

/** Mark the attempt identified by `key` (report or run id) + `at` as dismissed in this browser. */
export function dismissRetryAttempt(key: string, at: string): void {
  try { window.localStorage.setItem(DISMISS_PREFIX + key, at); } catch { /* private mode */ }
  notify();
}

/** True when the attempt at `at` for `key` was dismissed in this browser (a newer attempt is not). */
export function useDismissedAttempt(key: string | undefined, at: string | undefined): boolean {
  const subscribe = useCallback((l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const value = useSyncExternalStore(subscribe, () => (key ? readDismissed(key) : null), () => null);
  return !!at && value === at;
}

export const OUTCOME_LABEL: Record<RetryAttemptRecord['outcome'], string> = {
  'not-evaluable': 'not evaluable',
  'judge-error': 'judge error',
  error: 'error',
};

export interface LastRetryAttemptBannerProps {
  reportId: string;
  attempt: RetryAttemptRecord;
  /** Opens the retry-judgement dialog (the inspector passes it; standalone report pages have none). */
  onRetryJudgement?: () => void;
}

export const LastRetryAttemptBanner: React.FC<LastRetryAttemptBannerProps> = ({ reportId, attempt, onRetryJudgement }) => {
  const dismissed = useDismissedAttempt(reportId, attempt.at);
  const [open, setOpen] = useState(false);
  if (dismissed) return null;
  const evaluator = attempt.evaluatorName || attempt.evaluatorId || 'the run\'s evaluator';
  return (
    <>
      <div
        data-testid="last-retry-attempt-banner"
        role="status"
        className="flex items-start gap-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
      >
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <span className="font-medium">Last re-judgement failed</span>
          <span className="text-amber-800/80 dark:text-amber-300/80"> {formatRelativeTime(attempt.at)} · {evaluator} · </span>
          <span data-testid="last-retry-attempt-reason" className="break-words">{attempt.reason}</span>
          <span className="text-amber-800/80 dark:text-amber-300/80"> — the previous judgement below is unchanged.</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" data-testid="last-retry-attempt-details-btn" onClick={() => setOpen(true)}>
            Details
          </Button>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="last-retry-attempt-dismiss"
            onClick={() => dismissRetryAttempt(reportId, attempt.at)}
            className="text-amber-800/70 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-200"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="last-retry-attempt-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle size={16} className="text-amber-500" /> Last re-judgement failed</DialogTitle>
            <DialogDescription>
              The retry produced no judgement, so the report keeps its previous verdict and scores. What was attempted:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">When</dt><dd>{new Date(attempt.at).toLocaleString()} ({formatRelativeTime(attempt.at)})</dd>
              <dt className="text-muted-foreground">Outcome</dt><dd data-testid="last-retry-attempt-outcome">{OUTCOME_LABEL[attempt.outcome] ?? attempt.outcome}</dd>
              <dt className="text-muted-foreground">Evaluator</dt><dd>{evaluator}</dd>
              {attempt.judgeModelId && (<><dt className="text-muted-foreground">Judge model</dt><dd>{attempt.judgeModelId}</dd></>)}
              <dt className="text-muted-foreground">Scope</dt><dd>{attempt.scope === 'all' ? 'all cases' : 'judge-failed cases'}</dd>
            </dl>
            <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2 text-xs text-amber-900 dark:text-amber-200" data-testid="last-retry-attempt-dialog-reason">
              {attempt.reason}
            </div>
            {attempt.diagnostics && (
              <div className="rounded-md border bg-muted/30 p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Where the gold and the candidates were looked for</div>
                <ScoringDiagnosticsView diagnostics={attempt.diagnostics} testId="last-retry-attempt-diagnostics" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { dismissRetryAttempt(reportId, attempt.at); setOpen(false); }} data-testid="last-retry-attempt-dialog-dismiss">
              Dismiss
            </Button>
            {onRetryJudgement && (
              <Button onClick={() => { setOpen(false); onRetryJudgement(); }} data-testid="last-retry-attempt-retry-again">
                <RotateCw size={14} className="mr-1" /> Retry again
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
