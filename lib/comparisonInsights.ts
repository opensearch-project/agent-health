/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison insights — deterministic agreement + category math for the
 * comparison page's insights band (and, later, as grounding context for the
 * "What's actually different" LLM deep-dive).
 *
 * Everything here is pure arithmetic over the already-loaded comparison rows:
 * no API calls, no LLM. The band renders the *what* (which runs agree where,
 * which categories are weak); the deep-dive explains the *why*.
 *
 * Generalized to N runs from the start:
 *   - 2 runs  → "Both pass / Both fail / Split"
 *   - 3+ runs → "All pass / All fail / Split"
 */

import type { TestCaseComparisonRow } from '@/types';
import { getCategoryFromLabels, getSubcategoryFromLabels } from '@/lib/testCaseLabels';
import { rowVerdictAgreement, verdictOf } from '@/lib/comparison/verdictAgreement';

/** Agreement bucket for a row across the selected runs. */
export type AgreementBucket = 'allPass' | 'allFail' | 'split';

export interface AgreementPartition {
  allPass: TestCaseComparisonRow[];
  allFail: TestCaseComparisonRow[];
  split: TestCaseComparisonRow[];
  /** Rows where at least one run has no verdict (missing report / not run). */
  uncovered: TestCaseComparisonRow[];
}

/**
 * Partition rows into agreement buckets across the given runs.
 * A row only participates when EVERY selected run has a verdict for it —
 * partially-covered rows go to `uncovered` (they can't agree or disagree).
 *
 * The verdict predicate lives in `lib/comparison/verdictAgreement.ts` and is
 * shared with `calculateRowStatus` so "Split" here and "N verdict changes"
 * on the table header are always the same number.
 */
export function partitionByAgreement(
  rows: TestCaseComparisonRow[],
  runIds: string[]
): AgreementPartition {
  const partition: AgreementPartition = { allPass: [], allFail: [], split: [], uncovered: [] };
  if (runIds.length === 0) return partition;

  for (const row of rows) {
    partition[rowVerdictAgreement(row, runIds)].push(row);
  }
  return partition;
}

/** Bucket a single row (same semantics as {@link partitionByAgreement}); null = uncovered. */
export function bucketRow(row: TestCaseComparisonRow, runIds: string[]): AgreementBucket | null {
  const agreement = rowVerdictAgreement(row, runIds);
  return agreement === 'uncovered' ? null : agreement;
}

/**
 * Synthetic bucket names. Parentheses are deliberately outside the
 * name-tag charset (`[\w-]`), so a real benchmark category can never
 * collide with these rollup buckets.
 */
export const UNCATEGORIZED = '(uncategorized)';
/** Rollup bucket for categories with too few cases to be meaningful. */
export const OTHER_CATEGORY = '(other)';

/**
 * Extract a row's category.
 * Priority:
 *   1. The `subcategory:<x>` label — the proper, purpose-built tag for this
 *      (set via the SDK's `test(name, { labels: ['subcategory:basic'] })`,
 *      the JSON/CLI import's `subcategory` field, or the Test Case editor).
 *      Prefer this over anything scraped from free text: it's validated,
 *      exported/round-tripped, and shown elsewhere in the UI (EvalsPage,
 *      BenchmarkEditor) — a real column, not a regex guess.
 *   2. A bracketed tag embedded in the test-case name — a convention older
 *      imported benchmarks used before `subcategory` existed (e.g.
 *      "qst_0011 [basic] How long is …"). Kept only for benchmarks that
 *      predate the `subcategory` field; new imports should set it instead.
 *   3. A `topic:<x>` label (the generic labels system, pre-dates
 *      `subcategory` as a dedicated concept).
 *   4. {@link UNCATEGORIZED}.
 * (`category:<x>` labels are intentionally NOT used here: imported benchmarks
 * commonly stamp a single `category:RAG` on every case, which would collapse
 * the breakdown into one column — that's the coarse domain, not this facet.
 * {@link categoryLabelIsUsableFallback} + {@link extractRowCategoryEffective}
 * add `category:` back in, but ONLY for the comparisons where it's actually
 * informative — see their docs.)
 */
export function extractRowCategory(row: Pick<TestCaseComparisonRow, 'testCaseName' | 'labels'>): string {
  const subcategory = getSubcategoryFromLabels(row.labels);
  if (subcategory) return subcategory.toLowerCase();
  const m = /\[([\w-]+)\]/.exec(row.testCaseName || '');
  if (m) return m[1].toLowerCase();
  const topic = (row.labels || []).find(l => l.toLowerCase().startsWith('topic:'));
  if (topic) return topic.slice('topic:'.length).toLowerCase();
  return UNCATEGORIZED;
}

/**
 * Whether `category:` should be used as a LAST-RESORT fallback facet for
 * this set of rows. True only when, among the rows {@link extractRowCategory}
 * leaves as {@link UNCATEGORIZED} (rows with a real `[bracket]`/`topic:`
 * facet keep using that, whether or not `category:` also varies — one
 * differently-tagged row must not disable the fallback for every OTHER row
 * that has nothing better):
 *   1. There's at least one such row.
 *   2. The `category:` label, normalized the same way {@link
 *      extractRowCategoryEffective} returns it (lowercased, so
 *      `category:RAG` and `category:rag` count as ONE value, not two —
 *      inconsistent casing must not look like variance), has ≥2 distinct
 *      values that EACH appear on ≥2 rows. The 2-per-value floor keeps a
 *      single stray/typo'd label from flipping this on for what is really a
 *      uniform category with one dirty row — that must still resolve to
 *      "nothing to facet by", not a real-facet-plus-a-noise-column matrix.
 * A uniformly-stamped `category:RAG` (the case the original "intentionally
 * NOT used" heuristic was written for) stays excluded — falling back to it
 * would add a redundant single-value column to every such comparison,
 * exactly the noise that heuristic was trying to avoid. WixQA-400's
 * `category:expertwritten|simulated` (200/200) is the motivating case where
 * it DOES vary (both values well above the floor) and is genuinely useful.
 * Callers that resolve a per-row category for a set of rows should compute
 * this ONCE for the whole set and pass it to every {@link
 * extractRowCategoryEffective} call, so the matrix, its shared-weakness
 * callout, and the table's click-to-filter all agree on the same facet.
 */
export function categoryLabelIsUsableFallback(
  rows: Pick<TestCaseComparisonRow, 'testCaseName' | 'labels'>[]
): boolean {
  const uncategorizedRows = rows.filter(r => extractRowCategory(r) === UNCATEGORIZED);
  if (uncategorizedRows.length === 0) return false;
  const counts = new Map<string, number>();
  for (const r of uncategorizedRows) {
    const category = getCategoryFromLabels(r.labels)?.toLowerCase();
    if (category) counts.set(category, (counts.get(category) || 0) + 1);
  }
  const distinctMeaningfulValues = Array.from(counts.values()).filter(n => n >= 2).length;
  return distinctMeaningfulValues > 1;
}

/**
 * {@link extractRowCategory}, extended with the `category:` fallback when
 * {@link categoryLabelIsUsableFallback} (computed once per row-set, passed
 * in as `useCategoryFallback`) says it's actually informative for this
 * comparison. Only reached when the base extraction is {@link
 * UNCATEGORIZED} — a real bracket/topic facet always wins.
 */
export function extractRowCategoryEffective(
  row: Pick<TestCaseComparisonRow, 'testCaseName' | 'labels'>,
  useCategoryFallback: boolean
): string {
  const base = extractRowCategory(row);
  if (base !== UNCATEGORIZED || !useCategoryFallback) return base;
  const category = getCategoryFromLabels(row.labels);
  return category ? category.toLowerCase() : UNCATEGORIZED;
}

export interface CategoryCell {
  passed: number;
  total: number;
}

export interface CategoryBreakdown {
  /** Display order: by case count desc; `other` (if present) always last. */
  categories: string[];
  /** runId → category → {passed,total}. Totals may differ per run (missing results are skipped). */
  perRun: Record<string, Record<string, CategoryCell>>;
  /** Overall case count per category (across rows, not per run). */
  totals: Record<string, number>;
  /**
   * Raw categories each displayed column represents. Identity for real
   * categories; the union of rolled-up raw categories for `(other)`.
   * Filtering MUST use this mapping so clicking `(other)` matches exactly
   * the rows its cell counted.
   */
  members: Record<string, string[]>;
  /**
   * Whether this breakdown fell back to the `category:` label (see {@link
   * categoryLabelIsUsableFallback}). Callers that need to resolve a row's
   * category OUTSIDE this function (e.g. {@link detectSharedWeakness}, or
   * the compare page's click-to-filter) must pass this to {@link
   * extractRowCategoryEffective} to stay consistent with what's displayed.
   */
  usesCategoryFallback: boolean;
}

/**
 * Default minimum case count for a category to get its own column; smaller
 * ones roll up into `other`. Callers with small datasets may lower this —
 * a cell needs enough cases that a single verdict flip doesn't swing it
 * by tens of percentage points.
 */
export const MIN_CATEGORY_CASES = 5;

/** Per-category pass rates per run, with small categories rolled into `other`. */
export function buildCategoryBreakdown(
  rows: TestCaseComparisonRow[],
  runIds: string[],
  minCases: number = MIN_CATEGORY_CASES
): CategoryBreakdown {
  // Raw counts per category (row-level, for rollup decisions)
  const useCategoryFallback = categoryLabelIsUsableFallback(rows);
  const rawTotals: Record<string, number> = {};
  for (const row of rows) {
    const cat = extractRowCategoryEffective(row, useCategoryFallback);
    rawTotals[cat] = (rawTotals[cat] || 0) + 1;
  }

  const keep = new Set(Object.keys(rawTotals).filter(c => rawTotals[c] >= minCases));
  const resolve = (cat: string) => (keep.has(cat) ? cat : OTHER_CATEGORY);

  const members: Record<string, string[]> = {};
  for (const raw of Object.keys(rawTotals)) {
    const col = resolve(raw);
    (members[col] = members[col] || []).push(raw);
  }

  const perRun: Record<string, Record<string, CategoryCell>> = {};
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const cat = resolve(extractRowCategoryEffective(row, useCategoryFallback));
    totals[cat] = (totals[cat] || 0) + 1;
    for (const runId of runIds) {
      const verdict = verdictOf(row.results[runId]);
      if (verdict === null) continue;
      perRun[runId] = perRun[runId] || {};
      const cell = (perRun[runId][cat] = perRun[runId][cat] || { passed: 0, total: 0 });
      cell.total += 1;
      if (verdict === 'passed') cell.passed += 1;
    }
  }

  const categories = Object.keys(totals).sort((a, b) => {
    if (a === OTHER_CATEGORY) return 1;
    if (b === OTHER_CATEGORY) return -1;
    return (totals[b] || 0) - (totals[a] || 0);
  });

  return { categories, perRun, totals, members, usesCategoryFallback: useCategoryFallback };
}

export interface SharedWeakness {
  category: string;
  /** runId → pass-rate percent (0-100) in this category. */
  rates: Record<string, number>;
  /** Fraction (0-1) of all-fail cases that belong to this category. */
  allFailShare: number;
}

/**
 * Tie tolerance (pp) for the "weakest" claim. Kept at rounding-error level
 * on purpose: the callout says "weakest category", so another category may
 * not be meaningfully lower for any run — a 5pp allowance here would make
 * the copy dishonest.
 */
const WEAKEST_TOLERANCE_PP = 1;
/** Don't flag a shared weakness unless the mean rate is actually weak. */
const WEAKNESS_MAX_MEAN_RATE = 75;

/**
 * Detect a category that is the weakest (within {@link WEAKEST_TOLERANCE_PP})
 * for EVERY selected run — the "shared floor". When present, it usually
 * indicates a benchmark/corpus-level problem rather than an agent choice.
 * Returns null when runs disagree about their weakest category or nothing is
 * genuinely weak. `other`/`uncategorized` rollups are never flagged.
 */
export function detectSharedWeakness(
  breakdown: CategoryBreakdown,
  partition: AgreementPartition,
  runIds: string[]
): SharedWeakness | null {
  const candidates = breakdown.categories.filter(
    c => c !== OTHER_CATEGORY && c !== UNCATEGORIZED
  );
  if (candidates.length < 2 || runIds.length === 0) return null;

  const rate = (runId: string, cat: string): number | null => {
    const cell = breakdown.perRun[runId]?.[cat];
    if (!cell || cell.total === 0) return null;
    return (cell.passed / cell.total) * 100;
  };

  // Mean-weakest candidate across runs.
  let best: { cat: string; mean: number } | null = null;
  for (const cat of candidates) {
    const rates = runIds.map(id => rate(id, cat)).filter((x): x is number => x !== null);
    if (rates.length !== runIds.length) continue; // needs coverage in every run
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    if (!best || mean < best.mean) best = { cat, mean };
  }
  if (!best || best.mean >= WEAKNESS_MAX_MEAN_RATE) return null;

  // It must be every run's weakest category (within tolerance).
  for (const runId of runIds) {
    const candidateRate = rate(runId, best.cat);
    if (candidateRate === null) return null;
    for (const cat of candidates) {
      if (cat === best.cat) continue;
      const r = rate(runId, cat);
      if (r !== null && r < candidateRate - WEAKEST_TOLERANCE_PP) return null;
    }
  }

  const rates: Record<string, number> = {};
  for (const runId of runIds) rates[runId] = Math.round(rate(runId, best.cat)!);
  const allFailInCat = partition.allFail.filter(row => extractRowCategoryEffective(row, breakdown.usesCategoryFallback) === best!.cat).length;
  const allFailShare = partition.allFail.length > 0 ? allFailInCat / partition.allFail.length : 0;

  return { category: best.cat, rates, allFailShare };
}
