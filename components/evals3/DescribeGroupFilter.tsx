/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { FolderTree, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { DescribeGrouping } from '@/lib/describeGroups';

/** Sentinel for "cases with no describe chain" in the group filter. */
export const UNGROUPED: unique symbol = Symbol('ungrouped');
export type DescribeGroupSelection = string | null | typeof UNGROUPED;

/**
 * Compact "group by describe()" affordance for the benchmark Cases tab.
 *
 * Renders nothing when no case in the benchmark carries a `describePath`
 * (JSON/UI-authored suites, or code cases imported before the field
 * existed). Otherwise a collapsed-by-default disclosure lists each outermost
 * describe title with its case count; picking one narrows the case list to
 * that group, and the always-present "Ungrouped" row (only when non-empty)
 * shows cases with no describe chain. Selecting is a filter, not a
 * re-layout, so keyboard navigation / infinite scroll of the list are
 * untouched.
 */
export const DescribeGroupFilter: React.FC<{
  grouping: DescribeGrouping;
  selected: DescribeGroupSelection;
  onSelect: (title: DescribeGroupSelection) => void;
}> = ({ grouping, selected, onSelect }) => {
  if (grouping.groups.length === 0) return null;
  const selectedLabel = selected === UNGROUPED ? 'Ungrouped' : selected;
  return (
    <details className="rounded-md border bg-card/60 text-xs" data-testid="describe-groups">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 hover:bg-muted/50">
        <FolderTree size={13} className="text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="font-medium">
          {selectedLabel ? <>Suite: <span className="text-primary">{selectedLabel}</span></> : 'Group by describe'}
        </span>
        <Badge variant="secondary" className="ml-auto text-[9px]" data-testid="describe-groups-count">
          {grouping.groups.length} {grouping.groups.length === 1 ? 'suite' : 'suites'}
        </Badge>
        {selectedLabel && (
          <button
            type="button"
            className="rounded p-0.5 hover:bg-muted"
            aria-label="Clear suite filter"
            data-testid="describe-groups-clear"
            onClick={event => { event.preventDefault(); event.stopPropagation(); onSelect(null); }}
          >
            <X size={12} />
          </button>
        )}
      </summary>
      <div className="flex flex-col border-t" role="group" aria-label="Filter cases by describe suite">
        {grouping.groups.map(group => (
          <button
            type="button"
            key={group.title}
            className={`flex items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-muted/60 ${selected === group.title ? 'bg-primary/10 font-medium' : ''}`}
            aria-pressed={selected === group.title}
            data-testid="describe-group"
            data-describe-title={group.title}
            onClick={() => onSelect(selected === group.title ? null : group.title)}
          >
            <span className="truncate">{group.title}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="describe-group-count">{group.ids.length}</span>
          </button>
        ))}
        {grouping.ungroupedIds.length > 0 && (
          <button
            type="button"
            className={`flex items-center justify-between gap-2 px-2.5 py-1.5 text-left italic text-muted-foreground hover:bg-muted/60 ${selected === UNGROUPED ? 'bg-primary/10 font-medium' : ''}`}
            aria-pressed={selected === UNGROUPED}
            data-testid="describe-group-ungrouped"
            onClick={() => onSelect(selected === UNGROUPED ? null : UNGROUPED)}
          >
            <span>Ungrouped</span>
            <span className="shrink-0 tabular-nums" data-testid="describe-group-count">{grouping.ungroupedIds.length}</span>
          </button>
        )}
      </div>
    </details>
  );
};
