/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RetryJudgementConfirmDialog — the "Retry judgement" picker for a TERMINAL
 * run. Re-runs ONLY the judge against each case's already-recorded agent
 * output (the agent is never re-invoked) via
 * POST /api/storage/evaluation-runs/:id/retry-judgement.
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
 *
 * ASYNC (owner: "the retry button is not async in nature"): Confirm POSTs
 * and hands the 202 job to the client-side job store
 * (services/client/retryJudgementJobs.ts). From then on the dialog is just
 * another subscriber: it may be closed at once (Esc / X / "Close — keep
 * running") without cancelling anything; the run's header + list row show a
 * "Re-judging n/N…" pill, the page toaster announces the summary, and
 * re-opening the dialog while the job runs shows the live progress instead
 * of the pickers.
 *
 * PRE-FLIGHT ("not evaluable" is not "failed"): whenever the picked
 * evaluator / scope changes the dialog asks POST .../retry-judgement/preflight
 * what the retry would do. For a deterministic evaluator that is exact —
 * "n of N cases evaluable by this evaluator", the not-evaluable reasons
 * grouped, per-case diagnostics — Confirm is disabled when n = 0, and the
 * scope is forced to "All cases" (a deterministic evaluator re-scores the
 * whole run; the server 400s otherwise). The summary reads
 * "Retried 3 · 2 scored (1 abstain) · 1 not evaluable" — amber, never
 * "still failed"; a failed attempt preserved the previous judgement
 * (services/evaluation/retryJudgement.ts).
 */

import React, { useEffect, useState } from 'react';
import { Loader2, RotateCw, AlertTriangle, CheckCircle2, XCircle, CircleSlash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { JudgeModelSelect } from '@/components/JudgeModelSelect';
import { EvaluationRun, Evaluator } from '@/types';
import type { ScoringDiagnostics } from '@/types';
import { ENV_CONFIG } from '@/lib/config';
import {
  groupNotEvaluableReasons,
  notEvaluableCount,
  preflightRetryJudgement,
  type RetryJudgementPreflight,
  type RetryJudgementRequest,
  type RetryJudgementSummary,
} from '@/services/client/evaluationRunsApi';
import { startRetryJudgementJob } from '@/services/client/retryJudgementJobs';
import { useRetryJudgementJob } from '@/hooks/useRetryJudgementJob';
import { NOT_EVALUABLE_HINT, formatRetryJudgementSummary } from './RetryJudgementJobs';
import { ScoringDiagnosticsView } from './ScoringDiagnosticsView';

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

/** The request body a selection turns into (exported for tests). */
export function selectionToRequest(selection: RetryJudgementSelection, deterministic: boolean): RetryJudgementRequest {
  return {
    // A deterministic evaluator always re-scores the whole run (DETERMINISTIC_SCOPE_ERROR).
    scope: deterministic ? 'all' : selection.scope,
    evaluatorId: selection.evaluatorId,
    judgeModelId: selection.judgeModelId || null,
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
  /**
   * Called when the user dismisses a completed summary with "Done". The pages
   * ALSO refresh via useOnRetryJudgementFinished (the job may finish long
   * after the dialog was closed), so this is optional bookkeeping.
   */
  onComplete?: (summary: RetryJudgementSummary) => void;
}

/** Per-case rows ("<test case> — <reason>" + diagnostics) for not-evaluable / failed cases. */
export const CaseDiagnosticsList: React.FC<{
  cases: Array<{ testCaseId: string; reason?: string; error?: string; diagnostics?: ScoringDiagnostics }>;
  testId: string;
}> = ({ cases, testId }) => (
  <details className="text-[11px]" data-testid={testId}>
    <summary className="cursor-pointer text-muted-foreground">Per-case details ({cases.length})</summary>
    <ul className="mt-1 space-y-1.5 max-h-56 overflow-y-auto pr-1">
      {cases.map(c => (
        <li key={c.testCaseId} className="rounded border bg-background/60 p-1.5" data-testid={`${testId}-${c.testCaseId}`}>
          <div className="font-mono text-[10px] text-muted-foreground truncate" title={c.testCaseId}>{c.testCaseId}</div>
          <div>{c.reason ?? c.error ?? 'no reason recorded'}</div>
          {c.diagnostics && <ScoringDiagnosticsView diagnostics={c.diagnostics} className="mt-1 text-muted-foreground" />}
        </li>
      ))}
    </ul>
  </details>
);

/** "3 × no gold ids on the test case (…)" rows for a grouped reason map. */
export const NotEvaluableReasons: React.FC<{ reasons: Array<{ reason: string; count: number }>; testId: string }> = ({ reasons, testId }) => (
  <ul className="space-y-0.5 text-[11px] text-amber-800 dark:text-amber-300" data-testid={testId}>
    {reasons.map(r => (
      <li key={r.reason} className="flex gap-1.5">
        <span className="shrink-0 tabular-nums font-medium">{r.count} ×</span>
        <span>{r.reason}</span>
      </li>
    ))}
  </ul>
);

export const RetryJudgementConfirmDialog: React.FC<RetryJudgementConfirmDialogProps> = ({
  run, judgeFailedCount, rejudgeableCount, open, onOpenChange, onComplete,
}) => {
  const runId = run?.id ?? null;
  const job = useRetryJudgementJob(runId ?? undefined, run?.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<RetryJudgementSelection>({ evaluatorId: DEFAULT_EVALUATOR_ID, judgeModelId: '', scope: 'errored' });
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
  const [preflight, setPreflight] = useState<RetryJudgementPreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // The job this dialog instance started or watched — the summary view shows
  // only for a job that finished while the dialog was open; a stale finished
  // job from an earlier open (already toasted) starts a fresh form.
  const [watchedStartedAt, setWatchedStartedAt] = useState<number | null>(null);

  // Re-seed on every open (keyed on the run's identity, not the object —
  // parents refetch the run while the dialog is open, and a fresh object
  // must NOT wipe the user's in-progress selection).
  useEffect(() => {
    if (!open || !run) return;
    setSelection(seedRetryJudgementDefaults(run, judgeFailedCount));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Pre-flight whenever the picked evaluator / scope changes while open.
  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    setPreflight(null);
    setPreflightError(null);
    preflightRetryJudgement(runId, { scope: selection.scope, evaluatorId: selection.evaluatorId })
      .then(p => { if (!cancelled) setPreflight(p); })
      .catch(err => { if (!cancelled) setPreflightError(err?.message || 'Pre-flight failed'); });
    return () => { cancelled = true; };
  }, [open, runId, selection.evaluatorId, selection.scope]);

  // Re-opened while the job runs → watch it (live progress instead of the pickers).
  useEffect(() => {
    if (open && job?.status === 'running') setWatchedStartedAt(job.startedAt);
  }, [open, job?.status, job?.startedAt]);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // the POST is in flight for a moment — don't lose its error
    if (!next) {
      setError(null);
      setWatchedStartedAt(null);
    }
    onOpenChange(next);
  };

  if (!run) return null;

  const watching = job && watchedStartedAt !== null && job.startedAt === watchedStartedAt ? job : undefined;
  const running = watching?.status === 'running';
  const summary = watching?.status === 'completed' ? watching.summary : undefined;
  const jobError = watching?.status === 'failed' ? watching.error : undefined;
  const showForm = !running && !summary && !jobError;

  const evaluatorMissing = evaluators.length > 0 && !evaluators.some(e => e.id === selection.evaluatorId);
  const deterministic = !!preflight?.deterministic;
  const nothingEvaluable = deterministic && (preflight?.evaluable ?? 0) === 0;
  const preflightReasons = preflight
    ? Object.entries(preflight.reasons).map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count)
    : [];
  // Cases the retry will select: the pre-flight's exact count once it landed
  // (it knows a deterministic evaluator re-scores everything), else the
  // picked scope's count from the run doc.
  const count = preflight ? preflight.total : selection.scope === 'errored' ? judgeFailedCount : rejudgeableCount;
  const confirmDisabled = submitting || running || count === 0 || nothingEvaluable || (!preflight && !preflightError);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const started = await startRetryJudgementJob(run.id, selectionToRequest(selection, deterministic), run.name);
      setWatchedStartedAt(started.startedAt);
    } catch (err: any) {
      setError(err.message || 'Failed to retry judgement');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDone = () => {
    if (summary) onComplete?.(summary);
    setWatchedStartedAt(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="retry-judgement-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCw size={16} /> Retry judgement
          </DialogTitle>
          <DialogDescription>
            {showForm
              ? 'Re-runs ONLY the judge against each case\'s already-recorded agent output — the agent is not re-invoked. Only the latest judgement is kept on each report; a retry that produces no judgement leaves the previous one in place.'
              : running
                ? 'Retry judgement is running in the background.'
                : 'Retry judgement finished.'}
          </DialogDescription>
        </DialogHeader>

        {showForm && (
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
                {deterministic && (
                  <div className="text-[10px] text-muted-foreground" data-testid="retry-judgement-no-judge-model">
                    Not used — a deterministic evaluator scores in code, no judge model is called.
                  </div>
                )}
              </div>
            </div>

            <fieldset className="space-y-1.5" data-testid="retry-judgement-scope">
              <legend className="text-xs font-medium leading-none mb-1.5">Cases</legend>
              <label className={`flex items-center gap-2 text-sm ${judgeFailedCount === 0 || deterministic ? 'text-muted-foreground' : ''}`}>
                <input
                  type="radio"
                  name="retry-judgement-scope"
                  value="errored"
                  data-testid="retry-judgement-scope-errored"
                  checked={!deterministic && selection.scope === 'errored'}
                  disabled={submitting || judgeFailedCount === 0 || deterministic}
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
                  checked={deterministic || selection.scope === 'all'}
                  disabled={submitting}
                  onChange={() => setSelection(prev => ({ ...prev, scope: 'all' }))}
                />
                All cases ({rejudgeableCount})
              </label>
              {deterministic && (
                <div className="text-[10px] text-muted-foreground" data-testid="retry-judgement-scope-forced">
                  A deterministic evaluator re-scores the whole run (re-scoring only the judge-failed cases would mix two scoring snapshots in one run).
                </div>
              )}
            </fieldset>

            <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-xs text-muted-foreground">
              <div>
                Cases to re-judge:{' '}
                <span className="font-medium text-foreground" data-testid="retry-judgement-count">{count}</span>
              </div>
              {!deterministic && (
                <div>
                  Cases whose agent execution never actually completed are skipped automatically -- the retried count below may be lower than this.
                </div>
              )}
            </div>

            {/* Pre-flight */}
            {!preflight && !preflightError && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="retry-judgement-preflight-loading">
                <Loader2 size={12} className="animate-spin" /> Checking which cases this evaluator can score…
              </div>
            )}
            {preflightError && (
              <div className="text-xs text-muted-foreground" data-testid="retry-judgement-preflight-error">
                Could not pre-flight this retry ({preflightError}); you can still start it.
              </div>
            )}
            {preflight?.deterministic && (
              <div
                data-testid="retry-judgement-preflight"
                data-evaluable={preflight.evaluable}
                className={`rounded-md border p-2 text-xs space-y-1 ${nothingEvaluable
                  ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200'
                  : 'bg-muted/30'}`}
              >
                <div className="flex items-center gap-1.5">
                  {nothingEvaluable ? <CircleSlash size={13} className="shrink-0" /> : <CheckCircle2 size={13} className="shrink-0 text-green-600 dark:text-green-400" />}
                  <span data-testid="retry-judgement-preflight-summary">
                    <span className="font-medium">{preflight.evaluable} of {preflight.total}</span> case{preflight.total === 1 ? '' : 's'} evaluable by this evaluator
                  </span>
                </div>
                {preflight.abstain > 0 && (
                  <div className="text-[11px] text-muted-foreground" data-testid="retry-judgement-preflight-abstain">
                    {preflight.abstain} abstain case{preflight.abstain === 1 ? '' : 's'} (gold explicitly empty — judged by whether the agent returned nothing)
                  </div>
                )}
                {preflightReasons.length > 0 && <NotEvaluableReasons reasons={preflightReasons} testId="retry-judgement-preflight-reasons" />}
                {preflight.cases.some(c => !c.evaluable) && (
                  <CaseDiagnosticsList cases={preflight.cases.filter(c => !c.evaluable)} testId="retry-judgement-preflight-cases" />
                )}
                {nothingEvaluable && <div className="text-[11px]">{NOT_EVALUABLE_HINT}</div>}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span data-testid="retry-judgement-error">{error}</span>
              </div>
            )}
          </div>
        )}

        {running && watching && (
          <div className="space-y-2 text-sm" data-testid="retry-judgement-progress">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              <span data-testid="retry-judgement-progress-text">
                {watching.total > 0
                  ? `Re-judging ${watching.completed}/${watching.total}…`
                  : 'Starting retry judgement…'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              This runs in the background — you can close this dialog and keep working. The run refreshes when it finishes.
            </div>
          </div>
        )}

        {summary && (
          <div className="space-y-2 text-sm" data-testid="retry-judgement-summary">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <div className="font-medium" data-testid="retry-judgement-summary-line">{formatRetryJudgementSummary(summary)}</div>
              <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                <CheckCircle2 size={13} />
                <span>{summary.succeeded} scored</span>
              </div>
              {notEvaluableCount(summary) > 0 && (
                <div className="space-y-1 text-amber-600 dark:text-amber-400" data-testid="retry-judgement-summary-not-evaluable">
                  <div className="flex items-center gap-1.5">
                    <CircleSlash size={13} />
                    <span>{notEvaluableCount(summary)} not evaluable — previous judgement kept</span>
                  </div>
                  <NotEvaluableReasons reasons={groupNotEvaluableReasons(summary.results)} testId="retry-judgement-summary-reasons" />
                  <CaseDiagnosticsList cases={summary.results.filter(r => r.outcome === 'not-evaluable')} testId="retry-judgement-summary-cases" />
                  <div className="text-[11px]">{NOT_EVALUABLE_HINT}</div>
                </div>
              )}
              {summary.failed > 0 && (
                <div className="space-y-1 text-red-600 dark:text-red-400">
                  <div className="flex items-center gap-1.5">
                    <XCircle size={13} />
                    <span>{summary.failed} failed (judgement could not be made — previous judgement kept)</span>
                  </div>
                  <CaseDiagnosticsList cases={summary.results.filter(r => r.outcome === 'failed')} testId="retry-judgement-summary-failed-cases" />
                </div>
              )}
            </div>
          </div>
        )}

        {jobError && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span data-testid="retry-judgement-error">{jobError}</span>
          </div>
        )}

        <DialogFooter>
          {showForm ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={confirmDisabled}
                data-testid="retry-judgement-confirm-btn"
                title={nothingEvaluable ? 'This evaluator cannot score any case of this run' : undefined}
              >
                {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RotateCw size={14} className="mr-1" />}
                {submitting ? 'Starting…' : 'Retry judgement'}
              </Button>
            </>
          ) : running ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)} data-testid="retry-judgement-close-btn">
              Close — keep running
            </Button>
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
