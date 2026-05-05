/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared primitives for the AI Dev Tools page (`/coding-agents`).
 *
 * Task 3 of the ai-dev-tool-ux branch introduced this folder so the page can
 * stop reinventing section headers, filter bars, table shells, and empty
 * states in every tab.
 *
 * Currently exports:
 *   - SectionHeader               (Task 3A)
 *   - FilterBar + FilterBarSearch + FilterBarChip   (Task 3B)
 *   - DataTable + padding class constants           (Task 3B)
 *   - CompactBadge                (Task 3C)
 *   - EmptyState                  (Task 3C)
 */

export { SectionHeader } from './SectionHeader';
export type { SectionHeaderProps } from './SectionHeader';

export { FilterBar, FilterBarSearch, FilterBarChip } from './FilterBar';
export type { FilterBarProps, FilterBarSearchProps, FilterBarChipProps } from './FilterBar';

export { DataTable, DATA_TABLE_HEAD_CLASSES, DATA_TABLE_CELL_CLASSES } from './DataTable';
export type { DataTableProps } from './DataTable';

export { CompactBadge } from './CompactBadge';
export type { CompactBadgeProps } from './CompactBadge';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
