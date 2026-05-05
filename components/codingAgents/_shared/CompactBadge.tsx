/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CompactBadge — page-local badge variant for table and inline-row use.
 *
 * The shared <Badge> primitive defaults to `px-2.5 py-0.5 text-xs` which is
 * too large for table cells where density matters. CompactBadge composes the
 * shared Badge but overrides typography and padding to a single rule:
 *
 *   text-[10px] px-1.5 py-0
 *
 * This matches the Evaluator Agents page so the two surfaces look related.
 * Title-bar / hero badges that are intentionally prominent should keep using
 * <Badge> directly.
 *
 * Task 3C of the ai-dev-tool-ux branch.
 */

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export interface CompactBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
  className?: string;
  /** Optional inline style (used for agent-colored outlines). */
  style?: React.CSSProperties;
}

export const CompactBadge: React.FC<CompactBadgeProps> = ({
  className,
  variant,
  ...props
}) => {
  return (
    <Badge
      variant={variant}
      className={cn('text-[10px] px-1.5 py-0 font-medium', className)}
      {...props}
    />
  );
};
