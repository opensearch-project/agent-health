/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunActionsMenu — shared kebab menu for the run-lifecycle action matrix:
 * Re-run (opt-in), Cancel, Retry Judgement, Delete. Used identically on
 * every run surface (runs list rows, run detail/report page, inspector
 * header) so the affordance is consistent everywhere.
 *
 * Re-run is opt-in via `onRerun`: the run report page and the inspector
 * header used to carry standalone Re-run / Retry-judgement / Compare
 * buttons NEXT TO this kebab, which the owner asked to collapse — on those
 * surfaces the kebab is now the single home for every lifecycle action. The
 * runs-list rows keep their existing tested Re-run icon and don't pass
 * `onRerun`, so the item simply isn't rendered there (no second path to the
 * same action).
 *
 * Purely presentational + confirm/loading state — the actual API calls are
 * owned by the parent page (different pages have different post-action
 * side effects: list refresh, navigate away, toast, etc.), so this
 * component just orchestrates callbacks.
 */

import React, { useState } from 'react';
import { MoreHorizontal, Trash2, StopCircle, RefreshCw, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

export interface RunActionsMenuProps {
  /** Used only for `data-testid` suffixes and the delete confirm copy. */
  runId: string;
  runName?: string;
  /** Cancel is only rendered while true (spec: "cancel only for ongoing ones"). */
  isRunning: boolean;
  /**
   * Render a Re-run item that calls this (typically opens the prefilled
   * RunConfigDialog). Omitted → no Re-run item (surfaces with their own
   * Re-run affordance, e.g. the runs-list row icon).
   */
  onRerun?: () => void;
  /** Re-run item enablement; defaults to true when `onRerun` is given. */
  canRerun?: boolean;
  /** Tooltip/title shown on the disabled Re-run item when applicable. */
  rerunDisabledReason?: string;
  canRetryJudgement: boolean;
  /** Tooltip/title shown on the disabled Retry Judgement item when applicable. */
  retryJudgementDisabledReason?: string;
  /**
   * When provided, the Retry Judgement label reads "Retry judgement (N)" so
   * the user sees how many judge-failed cases the action will re-judge —
   * the same count the RetryJudgementConfirmDialog is handed.
   */
  judgeFailedCount?: number;
  onDelete: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onRetryJudgement: () => Promise<void> | void;
  /** 'sm' for list rows (default), 'header' for a slightly larger header button. */
  variant?: 'sm' | 'header';
  align?: 'start' | 'end';
}

export const RunActionsMenu: React.FC<RunActionsMenuProps> = ({
  runId,
  runName,
  isRunning,
  onRerun,
  canRerun = true,
  rerunDisabledReason,
  canRetryJudgement,
  retryJudgementDisabledReason,
  judgeFailedCount,
  onDelete,
  onCancel,
  onRetryJudgement,
  variant = 'sm',
  align = 'end',
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<'delete' | 'cancel' | 'retry-judgement' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (kind: 'cancel' | 'retry-judgement', fn: () => Promise<void> | void) => {
    setActionError(null);
    setBusy(kind);
    try {
      await fn();
    } catch (err: any) {
      setActionError(err?.message || `Failed to ${kind === 'cancel' ? 'cancel' : 'retry judgement for'} run`);
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteConfirm = async () => {
    setActionError(null);
    setBusy('delete');
    try {
      await onDelete();
      setDeleteConfirmOpen(false);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to delete run');
    } finally {
      setBusy(null);
    }
  };

  const triggerSizeClass = variant === 'header' ? 'h-7 w-7' : 'h-6 w-6';

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            data-testid={`run-actions-menu-trigger-${runId}`}
            title="Run actions"
            aria-label="Run actions"
            className={`${triggerSizeClass} inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors`}
            onClick={e => e.stopPropagation()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <MoreHorizontal size={13} />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} onClick={e => e.stopPropagation()}>
          {onRerun && (
            <DropdownMenuItem
              data-testid={`run-action-rerun-${runId}`}
              disabled={!canRerun || busy !== null}
              title={!canRerun ? rerunDisabledReason : undefined}
              onSelect={e => { e.preventDefault(); if (canRerun) { setMenuOpen(false); onRerun(); } }}
            >
              <RotateCcw size={14} className="mr-2" /> Re-run
            </DropdownMenuItem>
          )}
          {isRunning && (
            <DropdownMenuItem
              data-testid={`run-action-cancel-${runId}`}
              disabled={busy !== null}
              onSelect={e => { e.preventDefault(); runAction('cancel', onCancel); }}
            >
              <StopCircle size={14} className="mr-2" /> Cancel
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            data-testid={`run-action-retry-judgement-${runId}`}
            disabled={!canRetryJudgement || busy !== null}
            title={!canRetryJudgement ? retryJudgementDisabledReason : undefined}
            onSelect={e => {
              e.preventDefault();
              if (!canRetryJudgement) return;
              // Close first: on the inspector this opens the
              // RetryJudgementConfirmDialog, and a modal dialog stacked on a
              // still-open modal dropdown fights over focus.
              setMenuOpen(false);
              runAction('retry-judgement', onRetryJudgement);
            }}
          >
            <RefreshCw size={14} className="mr-2" />
            {judgeFailedCount === undefined ? 'Retry judgement' : `Retry judgement (${judgeFailedCount})`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`run-action-delete-${runId}`}
            disabled={busy !== null}
            className="text-red-600 focus:text-red-600 dark:text-red-400"
            onSelect={e => { e.preventDefault(); setMenuOpen(false); setDeleteConfirmOpen(true); }}
          >
            <Trash2 size={14} className="mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {actionError && (
        <div
          data-testid={`run-action-error-${runId}`}
          className="absolute z-10 mt-1 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-2 py-1 text-[11px] text-red-700 dark:text-red-300 shadow"
        >
          {actionError}
        </div>
      )}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={open => { if (busy === null) setDeleteConfirmOpen(open); }}>
        <AlertDialogContent data-testid={`run-delete-confirm-${runId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription>
              {runName ? `"${runName}"` : 'This run'} and its results will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'delete'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`run-delete-confirm-btn-${runId}`}
              disabled={busy === 'delete'}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              onClick={e => { e.preventDefault(); handleDeleteConfirm(); }}
            >
              {busy === 'delete' ? <Loader2 size={14} className="mr-1 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
