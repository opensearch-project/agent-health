/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FilterBar — shared primitive for the AI Dev Tools page.
 *
 * Normalises the filter-row pattern that every tab reinvents:
 *
 *   [ 🔍 search input ] [ facet Selects… ]     chips…     [ right-slot ]
 *
 * The primitive is intentionally uncoupled from the actual filter state —
 * callers keep their own useState hooks and render the input, selects, and
 * chips as children of the slots. The primitive just locks:
 *
 *   - padding / alignment / wrap behaviour
 *   - the search input styling + icon affordance
 *   - the chip slot position (below/right of facets)
 *   - the right-slot (counts, clear-all, export buttons) always sticking right
 *
 * Task 3B of the ai-dev-tool-ux branch.
 */

import React from 'react';
import { Search, X } from 'lucide-react';

export interface FilterBarSearchProps {
  /** Current input value. */
  value: string;
  /** Called on every keystroke. */
  onChange: (next: string) => void;
  /** Called when the user hits Enter. Optional — if omitted, input auto-applies via `onChange`. */
  onSubmit?: () => void;
  /** Placeholder text inside the input. */
  placeholder?: string;
  /** Width in Tailwind (default `w-64`). */
  widthClass?: string;
}

export interface FilterBarChipProps {
  /** Chip text. */
  label: React.ReactNode;
  /** Called when the user clicks the × to remove the filter. */
  onRemove: () => void;
}

export interface FilterBarProps {
  /** Optional search input spec. When omitted, no search input is rendered. */
  search?: FilterBarSearchProps;
  /** Facet selects / dropdowns — rendered inline next to the search input. */
  facets?: React.ReactNode;
  /** Applied-filter chips — rendered after facets. */
  chips?: React.ReactNode;
  /** Right-aligned slot (count text, Clear-all link, Export button, etc.). */
  right?: React.ReactNode;
  /** Optional extra classes on the outer wrapper. */
  className?: string;
}

/**
 * Search input with icon + Enter-to-submit semantics. Used standalone inside
 * a FilterBar's `search` slot (the FilterBar auto-wraps it) or as a bare
 * building block.
 */
export const FilterBarSearch: React.FC<FilterBarSearchProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = 'Search…',
  widthClass = 'w-64',
}) => {
  return (
    <div className={`relative ${widthClass}`}>
      <Search
        size={14}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        aria-hidden
      />
      <input
        type="search"
        className="w-full border rounded pl-8 pr-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && onSubmit) onSubmit();
        }}
      />
    </div>
  );
};

/** Single applied-filter chip with a × button. */
export const FilterBarChip: React.FC<FilterBarChipProps> = ({ label, onRemove }) => {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-secondary/60 px-2 py-0.5 text-[11px] text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Remove filter"
      >
        <X size={10} />
      </button>
    </span>
  );
};

export const FilterBar: React.FC<FilterBarProps> = ({
  search,
  facets,
  chips,
  right,
  className,
}) => {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}
      role="toolbar"
      aria-label="Filters"
    >
      {search && <FilterBarSearch {...search} />}
      {facets && <div className="flex flex-wrap items-center gap-2">{facets}</div>}
      {chips && <div className="flex flex-wrap items-center gap-1.5">{chips}</div>}
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
};
