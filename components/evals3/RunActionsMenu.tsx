/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunActionsMenu — shared kebab menu for the run-lifecycle action matrix:
 * Delete, Cancel, Retry Judgement. Used identically on every run surface
 * (runs list rows, benchmark runs list rows, run detail/report page,
 * inspector header) so the affordance is consistent everywhere.
 *
 * Re-run is deliberately NOT in this menu — every surface already has its
 * own dedicated, tested Re-run button/icon (RerunConfirmDialog); folding it
 * in here would just be a second path to the same action. This menu owns
 * the three actions that previously had NO consistent home (some surfaces
 * had inline buttons, most had nothing).
 *
 * Purely presentational + confirm/loading state — the actual API calls are
 * owned by the parent page (different pages have different post-action
 * side effects: list refresh, navigate away, toast, etc.), so this
 * component just orchestrates callbacks.
 */

import React, { useState } from 'react';
import { MoreHorizontal, Trash2, StopCircle, RefreshCw, Loader2 } from 'lucide-react';
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
   * Suppress the Cancel item even while running — for pages that already
   * render their own dedicated Cancel button (e.g. EvalRunDetailPage) and
   * would otherwise show the action twice. Defaults to false (Cancel shown
   * whenever `isRunning`).
   */
  hideCancel?: boolean;
  canRetryJudgement: boolean;
  /** Tooltip/title shown on the disabled Retry Judgement item when applicable. */
  retryJudgementDisabledReason?: string;
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
  hideCancel = false,
  canRetryJudgement,
  retryJudgementDisabledReason,
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
            className={`${triggerSizeClass} inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors`}
            onClick={e => e.stopPropagation()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <MoreHorizontal size={13} />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} onClick={e => e.stopPropagation()}>
          {isRunning && !hideCancel && (
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
            onSelect={e => { e.preventDefault(); if (canRetryJudgement) runAction('retry-judgement', onRetryJudgement); }}
          >
            <RefreshCw size={14} className="mr-2" /> Retry judgement
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
