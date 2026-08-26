/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ComparisonInsightsBand — the "who agrees where, and what's weak for
 * everyone" band between the scoreboard and Table Compare.
 *
 * Three deterministic elements (no LLM calls — see lib/comparisonInsights):
 *   1. Agreement chips: All pass / All fail / Split counts across the
 *      selected runs; each chip filters the table below.
 *   2. A collapsible (open by default) category × run pass-rate matrix,
 *      parsed from the test-case name tags ("qst_0011 [basic] …"); cells
 *      click-to-filter the table by category.
 *   3. A shared-weakness callout when one category is the weakest for EVERY
 *      run — the "corpus problem, not agent problem" signal.
 *
 * Renders nothing for single-run views. The category section hides itself
 * when the benchmark has no meaningful categories (everything uncategorized).
 */

import React, { useMemo, useState } from 'react';
import { ChevronRight, TriangleAlert, Grid3x3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TestCaseComparisonRow } from '@/types';
import {
  partitionByAgreement,
  buildCategoryBreakdown,
  detectSharedWeakness,
  MIN_CATEGORY_CASES,
  OTHER_CATEGORY,
  UNCATEGORIZED,
  type AgreementBucket,
} from '@/lib/comparisonInsights';

// Same palette as AggregateMetricsChart so run identity is consistent.
const RUN_COLORS = ['#3b82f6', '#015aa3', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

/**
 * Category selection: `label` is the displayed column; `categories` is the
 * exact raw-category set that column counted (union for the `(other)`
 * rollup), so the table filter matches the cell math one-to-one.
 */
export interface CategorySelection {
  label: string;
  categories: string[];
}

export interface ComparisonInsightsBandProps {
  rows: TestCaseComparisonRow[];
  /** Selected run ids, in scoreboard order (#1, #2, …). */
  runIds: string[];
  /** Short display name per run id (agent name or run name). */
  getRunName: (runId: string) => string;
  agreementFilter: AgreementBucket | null;
  onAgreementFilter: (bucket: AgreementBucket | null) => void;
  categoryFilter: CategorySelection | null;
  onCategoryFilter: (selection: CategorySelection | null) => void;
}

/** Heatmap cell background from a pass-rate percent (works on light + dark). */
function rateBackground(pct: number): string {
  if (pct < 70) return `rgba(239, 68, 68, ${0.18 + ((70 - pct) / 70) * 0.25})`; // red, deeper when worse
  if (pct < 80) return 'rgba(234, 179, 8, 0.22)'; // amber
  return `rgba(34, 197, 94, ${0.15 + ((pct - 80) / 20) * 0.3})`; // green, deeper when better
}

export const ComparisonInsightsBand: React.FC<ComparisonInsightsBandProps> = ({
  rows,
  runIds,
  getRunName,
  agreementFilter,
  onAgreementFilter,
  categoryFilter,
  onCategoryFilter,
}) => {
  const [categoriesOpen, setCategoriesOpen] = useState(true);

  const partition = useMemo(() => partitionByAgreement(rows, runIds), [rows, runIds]);
  // Small comparisons (smoke runs, e2e fixtures) still deserve a breakdown —
  // relax the per-column minimum when the dataset itself is small.
  const minCases = rows.length >= 30 ? MIN_CATEGORY_CASES : 2;
  const breakdown = useMemo(() => buildCategoryBreakdown(rows, runIds, minCases), [rows, runIds, minCases]);
  const weakness = useMemo(
    () => detectSharedWeakness(breakdown, partition, runIds),
    [breakdown, partition, runIds]
  );

  if (runIds.length < 2) return null;

  const covered = rows.length - partition.uncovered.length;
  const pairLabel = runIds.length === 2 ? 'Both' : 'All';
  const meaningfulCategories = breakdown.categories.filter(c => c !== UNCATEGORIZED);
  const showCategories =
    meaningfulCategories.length > 1 || (meaningfulCategories.length === 1 && meaningfulCategories[0] !== OTHER_CATEGORY);

  const chip = (bucket: AgreementBucket, label: string, count: number, tone: string, activeTone: string) => (
    <button
      key={bucket}
      data-testid={`agreement-chip-${bucket}`}
      onClick={() => onAgreementFilter(agreementFilter === bucket ? null : bucket)}
      title={
        agreementFilter === bucket
          ? 'Clear this filter'
          : `Show only the ${count} test case${count === 1 ? '' : 's'} in this bucket`
      }
      className={cn(
        'px-2.5 py-0.5 rounded-full border text-[11px] transition-colors cursor-pointer',
        tone,
        agreementFilter === bucket && activeTone
      )}
    >
      {label} <span className="font-semibold">{count}</span>
    </button>
  );

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3" data-testid="comparison-insights-band">
      {/* ── Agreement chips ─────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agreement</span>
        {chip(
          'allPass',
          `✓ ${pairLabel} pass`,
          partition.allPass.length,
          'border-green-500/40 text-green-600 dark:text-green-400 bg-green-500/5 hover:bg-green-500/15',
          'bg-green-500/25 border-green-500'
        )}
        {chip(
          'allFail',
          `✗ ${pairLabel} fail`,
          partition.allFail.length,
          'border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/5 hover:bg-red-500/15',
          'bg-red-500/25 border-red-500'
        )}
        {chip(
          'split',
          '⇄ Split',
          partition.split.length,
          'border-blue-500/40 text-blue-600 dark:text-blue-400 bg-blue-500/5 hover:bg-blue-500/15',
          'bg-blue-500/25 border-blue-500'
        )}
        <span className="text-[11px] text-muted-foreground ml-1">
          {covered} covered by every run
          {partition.uncovered.length > 0 && ` · ${partition.uncovered.length} without a verdict everywhere`}
          {' · counts are for all shared cases · click to filter the table'}
        </span>
      </div>

      {/* ── Category × run matrix (collapsible, open by default) ── */}
      {showCategories && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <button
            onClick={() => setCategoriesOpen(!categoriesOpen)}
            className="flex items-center gap-2 w-full text-left group"
            data-testid="insights-categories-toggle"
          >
            <Grid3x3 size={12} className="text-muted-foreground" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              By category
            </span>
            {!categoriesOpen && weakness && (
              <span className="text-[11px] text-red-500">
                ⚠ {weakness.category} weakest for all {runIds.length} runs
              </span>
            )}
            <ChevronRight
              size={12}
              className={cn('text-muted-foreground transition-transform ml-auto group-hover:text-foreground', categoriesOpen && 'rotate-90')}
            />
          </button>

          {categoriesOpen && (
            <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-2">
              <table className="text-[11px]" data-testid="insights-category-matrix">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-normal pr-3 py-0.5"></th>
                    {breakdown.categories.map(cat => (
                      <th key={cat} className="px-1 py-0.5 font-normal">
                        <button
                          onClick={() =>
                            onCategoryFilter(
                              categoryFilter?.label === cat
                                ? null
                                : { label: cat, categories: breakdown.members[cat] || [cat] }
                            )
                          }
                          className={cn(
                            'px-1.5 rounded hover:bg-muted transition-colors',
                            weakness?.category === cat && 'text-red-500 font-semibold',
                            categoryFilter?.label === cat && 'bg-primary/20 text-primary'
                          )}
                          title={`Filter the table to ${cat} cases`}
                        >
                          {cat}
                          {weakness?.category === cat && ' ⚠'}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runIds.map((runId, i) => (
                    <tr key={runId} data-testid={`insights-category-row-${i}`}>
                      <td className="pr-3 py-0.5 whitespace-nowrap">
                        <span
                          className="inline-block w-4 text-center rounded text-white text-[10px] font-mono font-semibold mr-1.5"
                          style={{ backgroundColor: RUN_COLORS[i % RUN_COLORS.length] }}
                        >
                          {i + 1}
                        </span>
                        <span className="text-foreground">{getRunName(runId)}</span>
                      </td>
                      {breakdown.categories.map(cat => {
                        const cell = breakdown.perRun[runId]?.[cat];
                        if (!cell || cell.total === 0) {
                          return (
                            <td key={cat} className="px-1 py-0.5 text-center text-muted-foreground">
                              —
                            </td>
                          );
                        }
                        const pct = Math.round((cell.passed / cell.total) * 100);
                        // Cells are deliberately NOT interactive: a cell is a
                        // run × category slice, but the only filter we can
                        // apply is category-wide — a clickable cell would
                        // advertise more precision than it delivers. Column
                        // headers carry the filter.
                        return (
                          <td key={cat} className="px-1 py-0.5">
                            <div
                              className="w-full min-w-[52px] text-center rounded px-1.5 py-0.5"
                              style={{ background: rateBackground(pct) }}
                              title={`${cell.passed}/${cell.total} passed`}
                            >
                              <span className="font-semibold text-foreground">{pct}%</span>{' '}
                              <span className="text-muted-foreground text-[10px]">
                                {cell.passed}/{cell.total}
                              </span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Shared-weakness callout */}
              {weakness && (
                <div
                  className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] leading-relaxed text-red-600 dark:text-red-300 max-w-md"
                  data-testid="insights-shared-weakness"
                >
                  <TriangleAlert size={13} className="shrink-0 mt-0.5" />
                  <span>
                    <b>{weakness.category}</b> is the weakest category for{' '}
                    {runIds.length === 2 ? 'both' : `all ${runIds.length}`} runs (
                    {runIds.map(id => `${weakness.rates[id]}%`).join(' / ')})
                    {weakness.allFailShare > 0 &&
                      ` and ${Math.round(weakness.allFailShare * 100)}% of the ${
                        runIds.length === 2 ? 'both-fail' : 'all-fail'
                      } cases are ${weakness.category}`}
                    {' — this points at a benchmark/corpus gap shared by every agent, not an agent choice.'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
