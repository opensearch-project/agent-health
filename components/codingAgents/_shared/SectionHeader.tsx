/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SectionHeader — shared primitive for the AI Dev Tools page.
 *
 * Replaces the inline pattern:
 *   <h3 className="text-xs font-medium text-muted-foreground uppercase
 *                 tracking-wider mb-2">{label}</h3>
 *
 * with a single component that supports:
 *   - required `label` (the tiny uppercase title)
 *   - optional `description` (a muted-foreground subtext under the label)
 *   - optional `actions` right-slot (buttons, range pickers, clear-all links)
 *
 * This is Task 3A of the ai-dev-tool-ux branch. Later tasks (3B, 3C) will
 * migrate FilterBar and DataTable call sites to their own shared primitives
 * under this folder.
 */

import React from 'react';

export interface SectionHeaderProps {
  /** Short uppercase label — e.g., "Usage", "Cost", "Since Last Visit". */
  label: React.ReactNode;
  /** Optional sentence of context shown under the label. */
  description?: React.ReactNode;
  /** Optional right-aligned slot for buttons, selects, filter chips. */
  actions?: React.ReactNode;
  /** Optional extra classes on the outer wrapper. */
  className?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  label,
  description,
  actions,
  className,
}) => {
  const hasActions = Boolean(actions);
  return (
    <div
      className={`flex items-end justify-between gap-3 mb-2 ${className ?? ''}`}
    >
      <div className="min-w-0">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider leading-none">
          {label}
        </h3>
        {description && (
          <p className="mt-1 text-[11px] text-muted-foreground/80 leading-snug">
            {description}
          </p>
        )}
      </div>
      {hasActions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
};
