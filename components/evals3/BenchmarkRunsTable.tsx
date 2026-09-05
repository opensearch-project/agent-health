/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compact runs table for the benchmark detail page's Runs tab.
 *
 * Columns: [select] Run · Agent · Model · Size · Pass % · Judge · J. Model · Date · [actions]
 * Every categorical cell (Agent / Model / Judge / J. Model / status) is a
 * click-to-filter target; active filters render as removable pills above the
 * table (owned by the parent, which also feeds the chart the same filters).
 */

import React from 'react';
import { ChevronDown, Loader2, StopCircle, Trash2, AlertTriangle, X, ArrowUpRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { formatDate } from '@/lib/utils';
import {
  RunTableRow, RunFilter, RunFilterField, RunSort, RunSortField,
  rowFieldValue, rowFieldLabel,
} from '@/lib/benchmarkRunsTable';
import { CaseHeatStrip } from '@/components/evals3/BenchmarkCasesTab';
import type { EvaluationReport, TestCase } from '@/types';

// Pill/tooltip labels mirror the column headers: the evaluator IS the judge
// (its prompt + scoring config) and judgeModelId is the model that judge ran on.
export const FILTER_FIELD_LABEL: Record<RunFilterField, string> = {
  agent: 'Agent', model: 'Model', judge: 'J. Model', evaluator: 'Judge', status: 'Status',
};

// ─── Filter pills ────────────────────────────────────────────────────────────

export const RunFilterPills: React.FC<{
  filters: RunFilter[];
  onRemove: (f: RunFilter) => void;
  onClear: () => void;
  shown: number;
  total: number;
}> = ({ filters, onRemove, onClear, shown, total }) => {
  if (filters.length === 0) return null;
  return (
    <div data-testid="run-filter-pills" className="flex flex-wrap items-center gap-1.5 mb-2">
      {filters.map(f => (
        <button
          key={`${f.field}:${f.value}`}
          type="button"
          data-testid="run-filter-pill"
          data-filter-field={f.field}
          data-filter-value={f.value}
          onClick={() => onRemove(f)}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/60 pl-2 pr-1 py-0.5 text-[11px] hover:bg-muted transition-colors"
          title="Remove filter"
        >
          <span className="text-muted-foreground">{FILTER_FIELD_LABEL[f.field]}:</span>
          <span className="font-medium max-w-[220px] truncate">{f.label}</span>
          <X size={11} className="text-muted-foreground" />
        </button>
      ))}
      <button
        type="button"
        data-testid="run-filter-clear"
        onClick={onClear}
        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline ml-1"
      >
        Clear
      </button>
      <span className="text-[11px] text-muted-foreground ml-auto" data-testid="run-filter-count">
        {shown} of {total} runs
      </span>
    </div>
  );
};

// ─── Table ───────────────────────────────────────────────────────────────────

function SortHeader({ label, field, sort, onSort, className }: {
  label: string; field: RunSortField; sort: RunSort; onSort: (f: RunSortField) => void; className?: string;
}) {
  const active = sort.field === field;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`h-7 px-2 text-left align-middle font-medium text-[11px] text-muted-foreground bg-background border-b cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${className || ''}`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <ChevronDown size={10} className={sort.dir === 'asc' ? 'rotate-180' : ''} />}
      </span>
    </th>
  );
}

/** A cell whose value doubles as a click-to-filter target. */
const CELL_MAX_W: Record<RunFilterField, string> = {
  agent: 'max-w-[150px]', model: 'max-w-[140px]', judge: 'max-w-[120px]', evaluator: 'max-w-[140px]', status: 'max-w-[100px]',
};

function FilterCell({ row, field, filters, onToggle, className, mono }: {
  row: RunTableRow; field: RunFilterField; filters: RunFilter[];
  onToggle: (f: RunFilter) => void; className?: string; mono?: boolean;
}) {
  const value = rowFieldValue(row, field);
  const label = rowFieldLabel(row, field);
  const active = filters.some(f => f.field === field && f.value === value);
  if (!value) {
    return <td className={`px-2 py-1 align-middle text-[11px] text-muted-foreground ${className || ''}`}>—</td>;
  }
  return (
    <td className={`px-2 py-1 align-middle ${className || ''}`}>
      <button
        type="button"
        data-testid={`run-cell-${field}`}
        data-filter-value={value}
        aria-pressed={active}
        onClick={e => { e.stopPropagation(); onToggle({ field, value, label }); }}
        title={active ? `Remove ${FILTER_FIELD_LABEL[field]} filter` : `Filter by ${FILTER_FIELD_LABEL[field]}: ${label}`}
        className={`text-left text-[11px] ${CELL_MAX_W[field]} truncate block rounded px-1 -mx-1 hover:bg-muted transition-colors ${mono ? 'font-mono text-[10px]' : ''} ${active ? 'bg-muted font-medium' : ''}`}
      >
        {label}
      </button>
    </td>
  );
}

/** "Sep 3, 07:52 PM" — the year is noise for anything created this year. */
export function formatRunDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit', minute: '2-digit',
  });
}

function passRateColor(rate: number | null): string {
  if (rate === null) return 'text-muted-foreground';
  if (rate >= 80) return 'text-green-700 dark:text-green-400';
  if (rate >= 50) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-400';
}

export interface BenchmarkRunsTableProps {
  rows: RunTableRow[];
  filters: RunFilter[];
  onToggleFilter: (f: RunFilter) => void;
  sort: RunSort;
  onSort: (f: RunSortField) => void;
  benchmarkId: string;
  currentVersion?: number;
  latestRunId?: string | null;
  selectable: boolean;
  selectedRunIds: string[];
  onToggleSelect: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenEvaluator?: (evaluatorId: string) => void;
  /** Rows for which row-level Delete/Cancel are NOT applicable (standalone eval-run docs). */
  actionsDisabledIds: Set<string>;
  onDelete: (row: RunTableRow) => void;
  deletingId: string | null;
  onCancel: (row: RunTableRow) => void;
  isCancelling: (runId: string) => boolean;
  /** Heat strip support (expanded row) */
  testCases: TestCase[];
  reportsById: Record<string, EvaluationReport>;
  onSelectCase: (testCaseId: string) => void;
  expandedRunIds: Set<string>;
  onToggleExpand: (runId: string) => void;
}

export const BenchmarkRunsTable: React.FC<BenchmarkRunsTableProps> = (props) => {
  const {
    rows, filters, onToggleFilter, sort, onSort, currentVersion, latestRunId,
    selectable, selectedRunIds, onToggleSelect, onOpenRun, onOpenEvaluator,
    actionsDisabledIds, onDelete, deletingId, onCancel, isCancelling,
    testCases, reportsById, onSelectCase, expandedRunIds, onToggleExpand, benchmarkId,
  } = props;

  const colCount = 10 + (selectable ? 1 : 0);

  return (
    <div className="rounded-md border overflow-x-auto" data-testid="benchmark-runs-table">
      <table className="w-full caption-bottom text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            {selectable && <th className="h-7 w-7 px-2 align-middle bg-background border-b" />}
            <SortHeader label="Run" field="name" sort={sort} onSort={onSort} />
            <SortHeader label="Agent" field="agent" sort={sort} onSort={onSort} />
            <SortHeader label="Model" field="model" sort={sort} onSort={onSort} />
            <SortHeader label="Size" field="size" sort={sort} onSort={onSort} className="text-right" />
            <SortHeader label="Pass %" field="passRate" sort={sort} onSort={onSort} className="text-right" />
            <SortHeader label="Judge" field="evaluator" sort={sort} onSort={onSort} />
            <SortHeader label="J. Model" field="judge" sort={sort} onSort={onSort} />
            <SortHeader label="Date" field="date" sort={sort} onSort={onSort} />
            <th className="h-7 w-8 px-1 align-middle bg-background border-b" aria-label="Cases" />
            <th className="h-7 w-14 px-1 align-middle bg-background border-b" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="py-10 text-center text-xs text-muted-foreground" data-testid="benchmark-runs-table-empty">
                No runs match the current filters
              </td>
            </tr>
          ) : rows.map(row => {
            const { run } = row;
            const isSelected = selectedRunIds.includes(run.id);
            const isLatest = run.id === latestRunId;
            const outdated = run.benchmarkVersion !== undefined && currentVersion !== undefined && run.benchmarkVersion < currentVersion;
            const expanded = expandedRunIds.has(run.id);
            const actionable = !actionsDisabledIds.has(run.id);
            return (
              <React.Fragment key={run.id}>
                <tr
                  data-testid="run-row"
                  data-run-id={run.id}
                  className={`border-b last:border-0 cursor-pointer transition-colors hover:bg-muted/40 ${isSelected ? 'bg-primary/5' : ''}`}
                  onClick={() => onOpenRun(run.id)}
                >
                  {selectable && (
                    <td className="px-2 py-1 align-middle" onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleSelect(run.id)}
                        aria-label={`Select ${run.name} for comparison`}
                        className="h-3.5 w-3.5"
                      />
                    </td>
                  )}
                  <td className="px-2 py-1 align-middle max-w-[250px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <a
                        href={`/evaluations/benchmarks/${benchmarkId}/runs/${run.id}/inspect`}
                        data-testid="run-name-link"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); onOpenRun(run.id); }}
                        className="text-xs font-medium text-foreground hover:text-primary hover:underline truncate inline-flex items-center gap-0.5"
                        title={run.description ? `${run.name} — ${run.description}` : run.name}
                      >
                        <span className="truncate">{run.name}</span>
                        <ArrowUpRight size={10} className="shrink-0 text-muted-foreground" />
                      </a>
                      {row.status === 'running' && (
                        <button
                          type="button"
                          data-testid="run-status-running"
                          onClick={e => { e.stopPropagation(); onToggleFilter({ field: 'status', value: 'running', label: 'Running' }); }}
                          className="inline-flex items-center gap-1 px-1.5 rounded-full text-[9px] font-medium bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/30 animate-pulse shrink-0"
                          title="Filter to running runs"
                        >
                          <Loader2 size={9} className="animate-spin" /> Running
                        </button>
                      )}
                      {row.status === 'cancelled' && (
                        <button
                          type="button"
                          data-testid="run-status-cancelled"
                          onClick={e => { e.stopPropagation(); onToggleFilter({ field: 'status', value: 'cancelled', label: 'Cancelled' }); }}
                          className="inline-flex items-center px-1.5 rounded-full text-[9px] font-medium bg-gray-500/15 text-gray-600 dark:text-gray-400 border border-gray-500/30 shrink-0"
                          title="Filter to cancelled runs"
                        >
                          Cancelled
                        </button>
                      )}
                      {isLatest && (
                        <span className="px-1.5 rounded-full text-[9px] font-medium bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/30 shrink-0" data-testid="run-latest-badge">
                          Latest
                        </span>
                      )}
                      {outdated && (
                        <span
                          className="px-1.5 rounded-full text-[9px] font-medium bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30 shrink-0"
                          title={`Run used v${run.benchmarkVersion}, current is v${currentVersion}`}
                        >
                          v{run.benchmarkVersion}
                        </span>
                      )}
                    </div>
                  </td>
                  <FilterCell row={row} field="agent" filters={filters} onToggle={onToggleFilter} />
                  <FilterCell row={row} field="model" filters={filters} onToggle={onToggleFilter} mono />
                  <td className="px-2 py-1 align-middle text-right text-[11px] tabular-nums" data-testid="run-size-cell">{row.size}</td>
                  <td className="px-2 py-1 align-middle text-right whitespace-nowrap" data-testid="run-passrate-cell">
                    <span
                      className={`text-xs font-semibold tabular-nums ${passRateColor(row.passRate)}`}
                      title={row.passRate === null
                        ? 'No judged cases yet'
                        : `${row.passed} passed of ${row.passed + row.failed} judged (errored/pending cases excluded, issue #242)`}
                    >
                      {row.passRate === null ? '—' : `${row.passRate}%`}
                    </span>
                    <span className="ml-1.5 text-[10px] text-muted-foreground tabular-nums" data-testid="run-stats">
                      <span className="text-green-700 dark:text-green-400">{row.passed}</span>
                      /<span className="text-red-700 dark:text-red-400">{row.failed}</span>
                      {row.errored > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-500 ml-0.5" title="Evaluator could not run on these (e.g. judge validation error). Excluded from pass-rate aggregation.">
                          /<AlertTriangle size={9} />{row.errored}
                        </span>
                      )}
                      {(row.pending > 0 || row.running > 0) && (
                        <span className="text-blue-700 dark:text-blue-400 ml-0.5" title="Pending / running">
                          /{row.pending + row.running}
                          <Loader2 size={9} className="inline ml-0.5 animate-spin" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-1 align-middle">
                    {row.evaluatorId ? (
                      <span className="inline-flex items-center gap-1 max-w-[140px]">
                        <button
                          type="button"
                          data-testid="run-cell-evaluator"
                          data-filter-value={row.evaluatorId}
                          aria-pressed={filters.some(f => f.field === 'evaluator' && f.value === row.evaluatorId)}
                          onClick={e => { e.stopPropagation(); onToggleFilter({ field: 'evaluator', value: row.evaluatorId, label: row.evaluatorLabel }); }}
                          title={`Filter by Judge: ${row.evaluatorLabel}`}
                          className={`text-left text-[11px] truncate max-w-[125px] rounded px-1 -mx-1 hover:bg-muted transition-colors ${filters.some(f => f.field === 'evaluator' && f.value === row.evaluatorId) ? 'bg-muted font-medium' : ''}`}
                        >
                          {row.evaluatorLabel}
                        </button>
                        {onOpenEvaluator && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); onOpenEvaluator(row.evaluatorId); }}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                            title="Open evaluator"
                            aria-label={`Open evaluator ${row.evaluatorLabel}`}
                          >
                            <ArrowUpRight size={10} />
                          </button>
                        )}
                      </span>
                    ) : <span className="text-[11px] text-muted-foreground">—</span>}
                  </td>
                  <FilterCell row={row} field="judge" filters={filters} onToggle={onToggleFilter} mono />
                  <td className="px-2 py-1 align-middle text-[10px] text-muted-foreground whitespace-nowrap tabular-nums" title={formatDate(run.createdAt, 'detailed')} data-testid="run-date-cell">
                    {formatRunDate(run.createdAt)}
                  </td>
                  <td className="px-1 py-1 align-middle text-center" onClick={e => e.stopPropagation()}>
                    <button
                      type="button"
                      data-testid="run-expand-cases"
                      aria-expanded={expanded}
                      aria-label={expanded ? 'Hide case verdicts' : 'Show case verdicts'}
                      onClick={() => onToggleExpand(run.id)}
                      className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                      title={expanded ? 'Hide case verdicts' : 'Show case verdicts'}
                    >
                      <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </button>
                  </td>
                  <td className="px-1 py-1 align-middle text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                    {actionable && row.status === 'running' && (
                      <button
                        type="button"
                        disabled={isCancelling(run.id)}
                        onClick={() => onCancel(row)}
                        className="h-5 w-5 inline-flex items-center justify-center rounded text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        title={isCancelling(run.id) ? 'Cancelling…' : 'Cancel run'}
                        aria-label="Cancel run"
                      >
                        {isCancelling(run.id) ? <Loader2 size={12} className="animate-spin" /> : <StopCircle size={12} />}
                      </button>
                    )}
                    {actionable && (
                      <button
                        type="button"
                        onClick={() => onDelete(row)}
                        disabled={deletingId === run.id}
                        className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-red-700 dark:hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        title="Delete run"
                        aria-label="Delete run"
                      >
                        {deletingId === run.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b last:border-0 bg-muted/20" data-testid="run-row-cases">
                    <td colSpan={colCount} className="px-3 py-1.5">
                      <div className="text-[10px] text-muted-foreground mb-1">Case verdicts · click a cell to review</div>
                      <CaseHeatStrip
                        benchmarkId={benchmarkId}
                        run={run}
                        testCases={testCases}
                        reportsById={reportsById}
                        onSelectCase={onSelectCase}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
