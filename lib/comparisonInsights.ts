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

/** Agreement bucket for a row across the selected runs. */
export type AgreementBucket = 'allPass' | 'allFail' | 'split';

export interface AgreementPartition {
  allPass: TestCaseComparisonRow[];
  allFail: TestCaseComparisonRow[];
  split: TestCaseComparisonRow[];
  /** Rows where at least one run has no verdict (missing report / not run). */
  uncovered: TestCaseComparisonRow[];
}

/** True when this run's result counts as a pass for agreement purposes. */
function isPass(r: { passFailStatus?: string | null } | undefined): boolean {
  return r?.passFailStatus === 'passed';
}

/**
 * True when the run produced *some verdict* we can bucket (pass OR fail).
 * Three shapes count:
 *   - a judge verdict (`passFailStatus` passed/failed);
 *   - a run-level failure (`status: 'failed'` — the agent errored/crashed on
 *     this case, which IS a fail verdict for agreement purposes).
 * NOT a verdict (→ uncovered): missing results, and evaluator-errored
 * reports (`errored: true`, `passFailStatus` cleared — issue #242 keeps
 * "the judge broke" distinct from "the agent failed"; bucketing them as
 * fails would poison All-fail with infrastructure noise).
 */
function hasVerdict(r: { status?: string; passFailStatus?: string | null; errored?: boolean } | undefined): boolean {
  if (!r || r.status === 'missing') return false;
  if (r.passFailStatus === 'passed' || r.passFailStatus === 'failed') return true;
  if (r.errored) return false;
  return r.status === 'failed';
}

/**
 * Partition rows into agreement buckets across the given runs.
 * A row only participates when EVERY selected run has a verdict for it —
 * partially-covered rows go to `uncovered` (they can't agree or disagree).
 */
export function partitionByAgreement(
  rows: TestCaseComparisonRow[],
  runIds: string[]
): AgreementPartition {
  const partition: AgreementPartition = { allPass: [], allFail: [], split: [], uncovered: [] };
  if (runIds.length === 0) return partition;

  for (const row of rows) {
    const results = runIds.map(id => row.results[id]);
    if (results.some(r => !hasVerdict(r))) {
      partition.uncovered.push(row);
      continue;
    }
    const passes = results.filter(r => isPass(r)).length;
    if (passes === runIds.length) partition.allPass.push(row);
    else if (passes === 0) partition.allFail.push(row);
    else partition.split.push(row);
  }
  return partition;
}

/** Bucket a single row (same semantics as {@link partitionByAgreement}); null = uncovered. */
export function bucketRow(row: TestCaseComparisonRow, runIds: string[]): AgreementBucket | null {
  const results = runIds.map(id => row.results[id]);
  if (results.some(r => !hasVerdict(r))) return null;
  const passes = results.filter(r => isPass(r)).length;
  if (passes === runIds.length) return 'allPass';
  if (passes === 0) return 'allFail';
  return 'split';
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
 *   1. A bracketed tag embedded in the test-case name — the convention used
 *      by imported benchmarks (e.g. "qst_0011 [basic] How long is …").
 *   2. A `topic:<x>` label (the generic labels system).
 *   3. {@link UNCATEGORIZED}.
 * (`category:<x>` labels are intentionally NOT used here: imported benchmarks
 * stamp a single `category:RAG` on every case, which would collapse the
 * breakdown into one column.)
 */
export function extractRowCategory(row: Pick<TestCaseComparisonRow, 'testCaseName' | 'labels'>): string {
  const m = /\[([\w-]+)\]/.exec(row.testCaseName || '');
  if (m) return m[1].toLowerCase();
  const topic = (row.labels || []).find(l => l.toLowerCase().startsWith('topic:'));
  if (topic) return topic.slice('topic:'.length).toLowerCase();
  return UNCATEGORIZED;
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
  const rawTotals: Record<string, number> = {};
  for (const row of rows) {
    const cat = extractRowCategory(row);
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
    const cat = resolve(extractRowCategory(row));
    totals[cat] = (totals[cat] || 0) + 1;
    for (const runId of runIds) {
      const r = row.results[runId];
      if (!hasVerdict(r)) continue;
      perRun[runId] = perRun[runId] || {};
      const cell = (perRun[runId][cat] = perRun[runId][cat] || { passed: 0, total: 0 });
      cell.total += 1;
      if (isPass(r)) cell.passed += 1;
    }
  }

  const categories = Object.keys(totals).sort((a, b) => {
    if (a === OTHER_CATEGORY) return 1;
    if (b === OTHER_CATEGORY) return -1;
    return (totals[b] || 0) - (totals[a] || 0);
  });

  return { categories, perRun, totals, members };
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
  const allFailInCat = partition.allFail.filter(row => extractRowCategory(row) === best!.cat).length;
  const allFailShare = partition.allFail.length > 0 ? allFailInCat / partition.allFail.length : 0;

  return { category: best.cat, rates, allFailShare };
}
