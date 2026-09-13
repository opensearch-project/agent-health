/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RetryJudgementConfirmDialog — the "Retry judgement" picker for a TERMINAL
 * run. Re-runs ONLY the judge against each case's already-recorded agent
 * output (the agent is never re-invoked) via
 * POST /api/storage/evaluation-runs/:id/retry-judgement, polls the job to
 * completion and shows the retried/succeeded/failed summary in place before
 * the caller refreshes.
 *
 * Owner requirement (follow-up to #468): "Retry judgement should be a
 * retryable step all the time. We only preserve the last one, but the
 * judgement should allow for evaluator type and prompt evaluator when
 * retrying; defaults will be the last selected ones." Hence the three
 * pickers — Evaluator, Judge model, Scope — and `seedRetryJudgementDefaults`:
 * the run's `lastJudgementRetry` (what the previous retry was launched with)
 * wins over the run's original `evaluatorId` / `judgeModelId`. Scope
 * defaults to "only judge-failed cases" whenever there are any, otherwise
 * "all cases". Only the LATEST judgement is kept on each report (no
 * history) — the dialog says so.
 */

import React, { useEffect, useState } from 'react';
import { Loader2, RotateCw, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { JudgeModelSelect } from '@/components/JudgeModelSelect';
import { EvaluationRun, Evaluator } from '@/types';
import { ENV_CONFIG } from '@/lib/config';
import { retryJudgement, RetryJudgementSummary } from '@/services/client';

/** The built-in default evaluator (server/prompts/evaluatorTemplates.ts) — what an unset `evaluatorId` resolves to. */
export const DEFAULT_EVALUATOR_ID = 'system-rca-default';

export interface RetryJudgementSelection {
  evaluatorId: string;
  /** '' = "use evaluator default" (sent as `null`). */
  judgeModelId: string;
  scope: 'errored' | 'all';
}

/**
 * Defaults for the pickers: the run's most recent retry (`lastJudgementRetry`)
 * if there was one, else the run's own evaluator / judge model. Exported for
 * unit tests.
 */
export function seedRetryJudgementDefaults(
  run: Pick<EvaluationRun, 'evaluatorId' | 'judgeModelId' | 'lastJudgementRetry'>,
  judgeFailedCount: number,
): RetryJudgementSelection {
  const last = run.lastJudgementRetry;
  return {
    evaluatorId: (last ? last.evaluatorId : run.evaluatorId) || DEFAULT_EVALUATOR_ID,
    judgeModelId: (last ? last.judgeModelId : run.judgeModelId) || '',
    scope: judgeFailedCount > 0 ? 'errored' : 'all',
  };
}

export interface RetryJudgementConfirmDialogProps {
  /** The run to retry judgement on. Dialog renders nothing while this is null. */
  run: EvaluationRun | null;
  /** Number of judge-failed (no-verdict) cases — the "Only judge-failed cases (N)" scope. */
  judgeFailedCount: number;
  /** Number of completed cases with agent output to re-judge — the "All cases (M)" scope. */
  rejudgeableCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the user dismisses a completed summary, so the caller can refresh. */
  onComplete: (summary: RetryJudgementSummary) => void;
}

export const RetryJudgementConfirmDialog: React.FC<RetryJudgementConfirmDialogProps> = ({
  run, judgeFailedCount, rejudgeableCount, open, onOpenChange, onComplete,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RetryJudgementSummary | null>(null);
  // Populated once the POST returns 202 and while polling for completion —
  // see retryJudgement()'s onProgress in services/client/evaluationRunsApi.ts.
  // A 62-case run's judge pipeline can take 20-30+ minutes; this is the only
  // feedback the user gets that the dialog is still doing something.
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [selection, setSelection] = useState<RetryJudgementSelection>({ evaluatorId: DEFAULT_EVALUATOR_ID, judgeModelId: '', scope: 'errored' });
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);

  // Re-seed on every open (keyed on the run's identity, not the object —
  // parents refetch the run while the dialog is open, and a fresh object
  // must NOT wipe the user's in-progress selection).
  const runId = run?.id ?? null;
  useEffect(() => {
    if (!open || !run) return;
    setSelection(seedRetryJudgementDefaults(run, judgeFailedCount));
    setError(null);
  }, [open, runId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`)
      .then(res => (res.ok ? res.json() : { evaluators: [] }))
      .then(data => { if (!cancelled) setEvaluators(data.evaluators || []); })
      .catch(() => { /* select falls back to the seeded id */ });
    return () => { cancelled = true; };
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // Don't let a stray click close mid-request
    if (!next) {
      setError(null);
      // Reset the summary view so the NEXT open starts fresh; the caller
      // already got a chance to react to it via onComplete when the user
      // clicked "Done" below.
      setSummary(null);
      setProgress(null);
    }
    onOpenChange(next);
  };

  if (!run) return null;

  const count = selection.scope === 'errored' ? judgeFailedCount : rejudgeableCount;
  const evaluatorMissing = evaluators.length > 0 && !evaluators.some(e => e.id === selection.evaluatorId);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    setProgress(null);
    try {
      const result = await retryJudgement(
        run.id,
        {
          scope: selection.scope,
          evaluatorId: selection.evaluatorId,
          judgeModelId: selection.judgeModelId || null,
        },
        (completed, total) => setProgress({ completed, total }),
      );
      setSubmitting(false);
      setSummary(result);
    } catch (err: any) {
      setSubmitting(false);
      setError(err.message || 'Failed to retry judgement');
    }
  };

  const handleDone = () => {
    if (summary) onComplete(summary);
    setSummary(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="retry-judgement-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCw size={16} /> Retry judgement
          </DialogTitle>
          {!summary && (
            <DialogDescription>
              Re-runs ONLY the judge against each case's already-recorded agent
              output — the agent is not re-invoked. Only the latest judgement
              is kept on each report.
            </DialogDescription>
          )}
        </DialogHeader>

        {!summary ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Evaluator</Label>
                <Select
                  value={selection.evaluatorId}
                  onValueChange={val => setSelection(prev => ({ ...prev, evaluatorId: val }))}
                  disabled={submitting}
                >
                  <SelectTrigger className="h-8" data-testid="retry-judgement-evaluator-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {evaluatorMissing && (
                      <SelectItem value={selection.evaluatorId} disabled>
                        {selection.evaluatorId} (not found)
                      </SelectItem>
                    )}
                    {evaluators.length === 0 && (
                      <SelectItem value={selection.evaluatorId}>{selection.evaluatorId}</SelectItem>
                    )}
                    {evaluators.map(evaluator => (
                      <SelectItem key={evaluator.id} value={evaluator.id} data-testid={`retry-judgement-evaluator-${evaluator.id}`}>
                        {evaluator.name}{evaluator.isSystem ? ' (System)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Judge model</Label>
                <JudgeModelSelect
                  value={selection.judgeModelId}
                  onValueChange={val => setSelection(prev => ({ ...prev, judgeModelId: val }))}
                  allowDefault
                  triggerClassName="h-8"
                />
              </div>
            </div>

            <fieldset className="space-y-1.5" data-testid="retry-judgement-scope">
              <legend className="text-xs font-medium leading-none mb-1.5">Cases</legend>
              <label className={`flex items-center gap-2 text-sm ${judgeFailedCount === 0 ? 'text-muted-foreground' : ''}`}>
                <input
                  type="radio"
                  name="retry-judgement-scope"
                  value="errored"
                  data-testid="retry-judgement-scope-errored"
                  checked={selection.scope === 'errored'}
                  disabled={submitting || judgeFailedCount === 0}
                  onChange={() => setSelection(prev => ({ ...prev, scope: 'errored' }))}
                />
                Only judge-failed cases ({judgeFailedCount})
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="retry-judgement-scope"
                  value="all"
                  data-testid="retry-judgement-scope-all"
                  checked={selection.scope === 'all'}
                  disabled={submitting}
                  onChange={() => setSelection(prev => ({ ...prev, scope: 'all' }))}
                />
                All cases ({rejudgeableCount})
              </label>
            </fieldset>

            <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-xs text-muted-foreground">
              <div>
                Cases to re-judge:{' '}
                <span className="font-medium text-foreground" data-testid="retry-judgement-count">{count}</span>
              </div>
              <div>
                Cases whose agent execution never actually completed are skipped automatically -- the retried count below may be lower than this.
              </div>
            </div>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span data-testid="retry-judgement-error">{error}</span>
              </div>
            )}
            {submitting && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="retry-judgement-progress">
                <Loader2 size={12} className="animate-spin" />
                <span>
                  {progress && progress.total > 0
                    ? `Retrying judgement... ${progress.completed}/${progress.total}`
                    : 'Starting retry judgement...'}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2 text-sm" data-testid="retry-judgement-summary">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Retried:</span>
                <span className="font-medium">{summary.retried}</span>
              </div>
              <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                <CheckCircle2 size={13} />
                <span>{summary.succeeded} succeeded</span>
              </div>
              {summary.failed > 0 && (
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <XCircle size={13} />
                  <span>{summary.failed} still failed</span>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {!summary ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={submitting || count === 0} data-testid="retry-judgement-confirm-btn">
                {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RotateCw size={14} className="mr-1" />}
                {submitting
                  ? (progress && progress.total > 0 ? `Retrying ${progress.completed}/${progress.total}...` : 'Retrying...')
                  : 'Retry judgement'}
              </Button>
            </>
          ) : (
            <Button onClick={handleDone} data-testid="retry-judgement-done-btn">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
