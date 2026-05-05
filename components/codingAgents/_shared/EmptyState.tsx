/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EmptyState — shared empty-state primitive for the AI Dev Tools page.
 *
 * Consolidates the three inline empty-state variants that existed before
 * Task 3C:
 *   - The `EmptyState` helper at CodingAgentsPage.tsx line 2810
 *   - The "No coding agents detected" card at line 3157
 *   - Various one-off "No results" blocks inside tabs
 *
 * Ships with an optional `action` slot for the CTA row, and a `fullCard`
 * prop that wraps the state in a Card for use as a tab-level placeholder.
 *
 * Task 3C of the ai-dev-tool-ux branch.
 */

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  /** Optional icon text or element (emoji / unicode / lucide). */
  icon?: React.ReactNode;
  /** Large title — typically one short phrase. */
  title: React.ReactNode;
  /** Optional one-line description below the title. */
  description?: React.ReactNode;
  /** Optional secondary row (call-to-action buttons, hints). */
  action?: React.ReactNode;
  /** When true, wraps the state in a <Card>. Defaults to false. */
  fullCard?: boolean;
  /** Optional extra classes on the outer wrapper. */
  className?: string;
  /** Vertical padding preset. Default is `relaxed`. */
  density?: 'tight' | 'relaxed';
}

const DENSITY_CLASSES: Record<NonNullable<EmptyStateProps['density']>, string> = {
  tight: 'py-8',
  relaxed: 'py-10',
};

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  fullCard,
  className,
  density = 'relaxed',
}) => {
  const body = (
    <div className={cn('text-center', DENSITY_CLASSES[density], className)}>
      {icon && (
        <div
          className="text-3xl mb-3 opacity-30"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );

  if (fullCard) {
    return (
      <Card>
        <CardContent className="px-6">{body}</CardContent>
      </Card>
    );
  }
  return body;
};
