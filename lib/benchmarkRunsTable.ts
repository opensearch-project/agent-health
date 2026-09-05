/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the benchmark Runs tab (table + pass-rate-over-time chart).
 *
 * Kept free of React/DOM so the click-to-filter semantics and the chart
 * series derivation can be unit-tested directly. The component
 * (components/evals3/BenchmarkRunsPage.tsx) is a thin renderer over these.
 */

import type { BenchmarkRun } from '@/types';
import { computeRunStats, getEffectiveRunStatus } from '@/lib/runStats';

// ─── Row model ───────────────────────────────────────────────────────────────

/** The dimensions a user can click on in the table to filter by. */
export type RunFilterField = 'agent' | 'model' | 'judge' | 'evaluator' | 'status';

export interface RunFilter {
  field: RunFilterField;
  /** Raw value (id/key), NOT the display label — labels can collide. */
  value: string;
  /** Human label for the pill. */
  label: string;
}

export interface RunTableRow {
  run: BenchmarkRun;
  agentKey: string;
  agentName: string;
  modelId: string;
  modelName: string;
  judgeModelId: string;
  judgeLabel: string;
  evaluatorId: string;
  evaluatorLabel: string;
  status: ReturnType<typeof getEffectiveRunStatus>;
  passed: number;
  failed: number;
  errored: number;
  pending: number;
  running: number;
  total: number;
  /**
   * Pass rate over the *evaluable* set (total − errored − pending − running),
   * or null when nothing has been evaluated yet. Percent 0–100.
   */
  passRate: number | null;
  /** Number of test cases in the run (snapshotted size, falling back to results). */
  size: number;
}

export interface RowLabelResolvers {
  agentName: (agentKey: string) => string;
  modelName: (modelId: string) => string;
  judgeLabel: (judgeModelId?: string | null) => string;
  evaluatorLabel: (evaluatorId?: string | null) => string;
}

export function computePassRate(
  passed: number, failed: number,
): number | null {
  const evaluable = passed + failed;
  if (evaluable <= 0) return null;
  return Math.round((passed / evaluable) * 1000) / 10;
}

export function buildRunTableRow(run: BenchmarkRun, resolve: RowLabelResolvers): RunTableRow {
  let running = 0;
  Object.values(run.results || {}).forEach(r => { if (r.status === 'running') running++; });
  const { passed, failed, errored, total } = computeRunStats(run);
  const pending = Math.max(0, total - passed - failed - errored - running);
  const size = run.testCaseSnapshots?.length || total;
  const agentKey = run.agentKey || '';
  const modelId = run.modelId || '';
  const judgeModelId = run.judgeModelId || '';
  const evaluatorId = run.evaluatorId || '';
  return {
    run,
    agentKey,
    agentName: resolve.agentName(agentKey),
    modelId,
    modelName: resolve.modelName(modelId),
    judgeModelId,
    judgeLabel: resolve.judgeLabel(judgeModelId || undefined),
    evaluatorId,
    evaluatorLabel: resolve.evaluatorLabel(evaluatorId || undefined),
    status: getEffectiveRunStatus(run),
    passed, failed, errored, pending, running, total,
    passRate: computePassRate(passed, failed),
    size,
  };
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export function rowFieldValue(row: RunTableRow, field: RunFilterField): string {
  switch (field) {
    case 'agent': return row.agentKey;
    case 'model': return row.modelId;
    case 'judge': return row.judgeModelId;
    case 'evaluator': return row.evaluatorId;
    case 'status': return row.status;
  }
}

export function rowFieldLabel(row: RunTableRow, field: RunFilterField): string {
  switch (field) {
    case 'agent': return row.agentName;
    case 'model': return row.modelName;
    case 'judge': return row.judgeLabel;
    case 'evaluator': return row.evaluatorLabel;
    case 'status': return row.status;
  }
}

export function isSameFilter(a: RunFilter, b: RunFilter): boolean {
  return a.field === b.field && a.value === b.value;
}

/**
 * Click semantics: clicking a value that is already an active filter removes
 * it (toggle); otherwise it is added. Multiple values on the same field are
 * OR-ed; different fields are AND-ed (see {@link applyRunFilters}).
 */
export function toggleRunFilter(filters: RunFilter[], next: RunFilter): RunFilter[] {
  const exists = filters.some(f => isSameFilter(f, next));
  return exists ? filters.filter(f => !isSameFilter(f, next)) : [...filters, next];
}

export function removeRunFilter(filters: RunFilter[], target: RunFilter): RunFilter[] {
  return filters.filter(f => !isSameFilter(f, target));
}

export function applyRunFilters(rows: RunTableRow[], filters: RunFilter[]): RunTableRow[] {
  if (filters.length === 0) return rows;
  const byField = new Map<RunFilterField, Set<string>>();
  for (const f of filters) {
    if (!byField.has(f.field)) byField.set(f.field, new Set());
    byField.get(f.field)!.add(f.value);
  }
  return rows.filter(row => {
    for (const [field, values] of byField) {
      if (!values.has(rowFieldValue(row, field))) return false;
    }
    return true;
  });
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

export type RunSortField = 'name' | 'agent' | 'model' | 'size' | 'passRate' | 'judge' | 'evaluator' | 'date';
export interface RunSort { field: RunSortField; dir: 'asc' | 'desc'; }

export const DEFAULT_RUN_SORT: RunSort = { field: 'date', dir: 'desc' };

export function toggleRunSort(current: RunSort, field: RunSortField): RunSort {
  if (current.field === field) return { field, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  // Numeric/date columns default to descending (biggest/newest first);
  // text columns to ascending.
  const numeric: RunSortField[] = ['size', 'passRate', 'date'];
  return { field, dir: numeric.includes(field) ? 'desc' : 'asc' };
}

export function sortRunRows(rows: RunTableRow[], sort: RunSort): RunTableRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const cmpNum = (a: number | null, b: number | null) => {
    // nulls always sink to the bottom regardless of direction
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return dir * (a - b);
  };
  return [...rows].sort((a, b) => {
    switch (sort.field) {
      case 'name': return dir * a.run.name.localeCompare(b.run.name);
      case 'agent': return dir * a.agentName.localeCompare(b.agentName);
      case 'model': return dir * a.modelName.localeCompare(b.modelName);
      case 'judge': return dir * a.judgeLabel.localeCompare(b.judgeLabel);
      case 'evaluator': return dir * a.evaluatorLabel.localeCompare(b.evaluatorLabel);
      case 'size': return cmpNum(a.size, b.size);
      case 'passRate': return cmpNum(a.passRate, b.passRate);
      case 'date':
      default:
        return dir * (new Date(a.run.createdAt).getTime() - new Date(b.run.createdAt).getTime());
    }
  });
}

// ─── Chart ───────────────────────────────────────────────────────────────────

export interface PassRatePoint {
  /** Epoch ms of run.createdAt — numeric so the X axis is a real time axis. */
  t: number;
  runId: string;
  runName: string;
  passRate: number;
  passed: number;
  failed: number;
  total: number;
}

export interface PassRateSeries {
  /** Series key = agentKey (the sketch groups lines by agent, e.g. CC vs AIS). */
  key: string;
  label: string;
  points: PassRatePoint[];
}

/**
 * One line per agent, points ordered by time. Runs without an evaluable
 * result (pass rate null — e.g. still running with nothing judged, or fully
 * errored) are excluded: plotting them as 0% would read as a regression.
 */
export function buildPassRateSeries(rows: RunTableRow[]): PassRateSeries[] {
  const byAgent = new Map<string, PassRateSeries>();
  for (const row of rows) {
    if (row.passRate === null) continue;
    const t = new Date(row.run.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    let series = byAgent.get(row.agentKey);
    if (!series) {
      series = { key: row.agentKey, label: row.agentName, points: [] };
      byAgent.set(row.agentKey, series);
    }
    series.points.push({
      t, runId: row.run.id, runName: row.run.name,
      passRate: row.passRate, passed: row.passed, failed: row.failed, total: row.total,
    });
  }
  const out = [...byAgent.values()];
  for (const s of out) s.points.sort((a, b) => a.t - b.t);
  // Order by label (then key) — NOT by point count. Series index drives the
  // line colour, so the order must be stable while the page polls every few
  // seconds and new runs land; "busiest first" would recolour agents mid-run.
  out.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return out;
}

/** Latest run = max createdAt over the given runs (not "first in the array" —
 *  the merged list appends standalone eval-run docs after embedded runs, so
 *  array order is not chronological). */
export function latestRunId(runs: Array<Pick<BenchmarkRun, 'id' | 'createdAt'>>): string | null {
  let best: { id: string; t: number } | null = null;
  for (const r of runs) {
    const t = new Date(r.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { id: r.id, t };
  }
  return best?.id ?? null;
}

/** Deterministic, distinguishable palette for agent lines (index-based). */
export const SERIES_COLORS = [
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#10b981', // emerald-500
  '#8b5cf6', // violet-500
  '#ef4444', // red-500
  '#06b6d4', // cyan-500
  '#ec4899', // pink-500
  '#84cc16', // lime-500
];

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}
