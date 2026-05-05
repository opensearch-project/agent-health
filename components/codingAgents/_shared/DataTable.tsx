/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DataTable — shared thin shell around shadcn Table for the AI Dev Tools page.
 *
 * This primitive is deliberately minimal. It does NOT replace the existing
 * <Table> / <TableHeader> / <TableBody> / <TableRow> / <TableHead> /
 * <TableCell> building blocks — migrating away from those would be a
 * 500-line diff. Instead it:
 *
 *   1. Wraps the table in a consistent <Card>-like surface.
 *   2. Renders a built-in empty state when `isEmpty` is true.
 *   3. Exports `DATA_TABLE_CELL_CLASSES` / `DATA_TABLE_HEAD_CLASSES` so
 *      call sites can opt in to locked padding + text-size rules without
 *      rewriting their schema.
 *
 * Task 3B of the ai-dev-tool-ux branch.
 */

import React from 'react';
import { Card } from '@/components/ui/card';

/**
 * Locked padding / typography for table headers. Apply via `className` on
 * individual <TableHead> elements when migrating.
 *
 * Rationale: shadcn's default TableHead pads loosely; tabs on this page
 * range from 10–14px vertical — this pins it to 8px/12px for visual density.
 */
export const DATA_TABLE_HEAD_CLASSES =
  'px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground';

/**
 * Locked padding / typography for table cells. Apply via `className` on
 * individual <TableCell> elements when migrating.
 */
export const DATA_TABLE_CELL_CLASSES = 'px-3 py-2.5 text-sm align-middle';

export interface DataTableProps {
  /** Table element(s) — typically <Table><TableHeader/><TableBody/></Table>. */
  children: React.ReactNode;
  /** Optional wrapper class. */
  className?: string;
  /** When true, renders the empty state instead of the table body. */
  isEmpty?: boolean;
  /** Optional custom empty state. If omitted, a generic message is rendered. */
  emptyState?: React.ReactNode;
}

const DEFAULT_EMPTY_STATE = (
  <div className="text-center py-8">
    <div className="text-2xl mb-2 opacity-20">—</div>
    <p className="text-sm text-muted-foreground">No results</p>
    <p className="text-xs text-muted-foreground/70 mt-1">
      Try adjusting your filters or date range.
    </p>
  </div>
);

export const DataTable: React.FC<DataTableProps> = ({
  children,
  className,
  isEmpty,
  emptyState,
}) => {
  return (
    <Card className={className}>
      {children}
      {isEmpty && (emptyState ?? DEFAULT_EMPTY_STATE)}
    </Card>
  );
};
