/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * InlineRenameField — click-a-pencil, edit-in-place rename control.
 *
 * Shared by RunInspectorPage (header title) and EvalRunsPage (run row) so
 * evaluation-run rename has ONE interaction pattern instead of two. There was
 * no pre-existing inline-rename component in the repo to reuse (checked
 * BenchmarksPage/TestCasesPage — both use a full modal editor for renames),
 * so this is a new, deliberately small component: text + hover-revealed
 * pencil -> input -> Enter/blur to save, Escape to cancel.
 *
 * The repo has no toast/notification system (checked components/ui — none
 * exists), so failures surface as inline text next to the field, matching
 * the app's existing inline-error idiom (e.g. RunInspectorPage's own
 * load-error state) rather than introducing a new UI dependency.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';

export interface InlineRenameFieldProps {
  /** Current (persisted) name. */
  value: string;
  /**
   * Persist the new name. Reject (throw) to signal failure — the field
   * shows the thrown error's message and stays in edit mode so the user's
   * edit isn't lost. Callers are responsible for any optimistic update and
   * for reverting it on failure (this component only owns the input UI).
   */
  onSave: (newValue: string) => Promise<void>;
  className?: string;
  textClassName?: string;
  maxLength?: number;
  /** Stable prefix for data-testid on the text/button/input/error nodes. */
  testId?: string;
}

export const InlineRenameField: React.FC<InlineRenameFieldProps> = ({
  value,
  onSave,
  className,
  textClassName,
  maxLength = 200,
  testId,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Synchronous re-entrancy guard: Enter (keydown) and blur can both target
  // the same commit within one JS tick, before the `saving` STATE update
  // (async, batched) is visible to a second call's closure. A ref updates
  // immediately, so the second call sees it and no-ops.
  const committingRef = useRef(false);

  // Keep the draft in sync with upstream changes (e.g. a poll refresh)
  // while not editing; never clobber an in-progress edit.
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setError(null);
    setDraft(value);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(value);
    setError(null);
    setEditing(false);
  };

  const commit = async () => {
    if (committingRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('Name cannot be empty');
      return;
    }
    if (trimmed === value) {
      setEditing(false);
      setError(null);
      return;
    }
    committingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to rename');
    } finally {
      setSaving(false);
      committingRef.current = false;
    }
  };

  if (editing) {
    return (
      <div className={`flex flex-col gap-0.5 min-w-0 ${className || ''}`} onClick={e => e.stopPropagation()}>
        <Input
          ref={inputRef}
          value={draft}
          // A small buffer above the trimmed-value cap: validation caps the
          // TRIMMED value, so a user padding with leading/trailing spaces
          // around an otherwise-valid name must not be blocked by the raw
          // HTML maxLength before they even get to trim it down.
          maxLength={maxLength + 20}
          disabled={saving}
          data-testid={testId ? `${testId}-input` : undefined}
          className={textClassName}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
        {error && (
          <span className="text-[10px] text-destructive" data-testid={testId ? `${testId}-error` : undefined}>
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`group/rename inline-flex items-center gap-1 min-w-0 ${className || ''}`}>
      <span className={`truncate ${textClassName || ''}`} data-testid={testId ? `${testId}-text` : undefined}>
        {value}
      </span>
      <button
        type="button"
        title="Rename"
        aria-label="Rename"
        data-testid={testId ? `${testId}-edit-btn` : undefined}
        className="opacity-0 group-hover/rename:opacity-100 focus:opacity-100 text-muted-foreground hover:text-foreground transition-opacity shrink-0"
        onClick={startEditing}
      >
        <Pencil size={12} />
      </button>
    </div>
  );
};
