/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JudgeSelectionConflictChip — small amber notice on a report's judge
 * section when the eval body pinned a different evaluator / judge model than
 * the run selected. The run selection was applied (run-level wins); this
 * makes the disagreement visible instead of leaving a clean-looking report
 * whose author expected a different judge.
 *
 * Renders nothing when the report carries no conflicts.
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { JudgeSelectionConflict } from '@/types';

interface JudgeSelectionConflictChipProps {
  conflicts?: JudgeSelectionConflict[];
  className?: string;
}

const FIELD_LABEL: Record<JudgeSelectionConflict['field'], string> = {
  evaluatorId: 'evaluator',
  modelId: 'judge model',
};

export const JudgeSelectionConflictChip: React.FC<JudgeSelectionConflictChipProps> = ({ conflicts, className }) => {
  if (!conflicts || conflicts.length === 0) return null;
  return (
    <div
      data-testid="judge-selection-conflict-chip"
      role="note"
      className={
        'inline-flex flex-wrap items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ' +
        'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30 ' +
        (className ?? '')
      }
    >
      <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden />
      <div className="space-y-0.5">
        <div className="font-medium">Body pinned a different judge — run selection applied</div>
        <ul className="list-none space-y-0.5">
          {conflicts.map((c, i) => (
            <li key={`${c.field}-${c.bodyValue}-${i}`} data-testid="judge-selection-conflict-row">
              <span className="capitalize">{FIELD_LABEL[c.field] ?? c.field}</span>
              {': run selected '}
              <code className="font-mono">{c.runValue}</code>
              {' · body asked for '}
              <code className="font-mono line-through decoration-amber-600/70">{c.bodyValue}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default JudgeSelectionConflictChip;
