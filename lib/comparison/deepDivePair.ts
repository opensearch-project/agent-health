/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pair selection for the trace-grounded deep-dive ("What's actually
 * different") on a compare page with THREE OR MORE selected runs.
 *
 * The deep-dive is pairwise by design (`POST /api/comparison/deep-dive` takes
 * exactly two report ids) and that contract is deliberately kept — this
 * module only decides WHICH two of the selected runs it compares:
 *
 *  - default: A = the OLDEST selected run (the baseline), B = the NEWEST
 *  - a `deepDive=<idA>,<idB>` URL param overrides the default so a shared
 *    link reproduces the pair; an invalid/partial/absent param → default
 *  - A ≠ B is always enforced
 *
 * It also resolves, for the chosen [A, B], the representative TEST CASE the
 * job is anchored on (`resolveDeepDiveCasePair`) — reading report ids from
 * the run docs when the comparison rows don't carry them yet.
 *
 * Pure functions, unit tested directly.
 */

import { BenchmarkRun, TestCaseComparisonRow } from '@/types';

/** URL search param that pins the deep-dive pair (`deepDive=<idA>,<idB>`). */
export const DEEP_DIVE_PAIR_PARAM = 'deepDive';

export type DeepDivePair = [string, string];

const createdMs = (run: BenchmarkRun): number => {
  const t = Date.parse(run.createdAt ?? '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * Runs oldest → newest. Total ordering: `createdAt`, then `id` — so
 * identical/unparseable timestamps still sort the same no matter how the
 * input happens to be ordered. The pair picker lists its options in this
 * order (the page's selection order is the URL's A/B order, which is not a
 * useful order for a list to choose from).
 */
export function sortRunsChronologically<R extends BenchmarkRun>(runs: readonly R[]): R[] {
  return [...runs].sort((x, y) => createdMs(x) - createdMs(y) || x.id.localeCompare(y.id));
}

/**
 * Default pair for a set of selected runs: oldest (baseline) → A, newest → B
 * (see {@link sortRunsChronologically} for the ordering). `null` when fewer
 * than two runs are selected.
 */
export function defaultDeepDivePair(runs: BenchmarkRun[]): DeepDivePair | null {
  if (runs.length < 2) return null;
  const sorted = sortRunsChronologically(runs);
  return [sorted[0].id, sorted[sorted.length - 1].id];
}

/**
 * Parse `deepDive=<idA>,<idB>`. Valid only when both ids are distinct and both
 * name a currently selected run; anything else returns `null` (caller falls
 * back to {@link defaultDeepDivePair}).
 */
export function parseDeepDivePairParam(param: string | null | undefined, selectedRunIds: string[]): DeepDivePair | null {
  if (!param) return null;
  const parts = param.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (a === b) return null;
  if (!selectedRunIds.includes(a) || !selectedRunIds.includes(b)) return null;
  return [a, b];
}

/** Serialize a pair for the URL (`<idA>,<idB>`). */
export function serializeDeepDivePair(pair: DeepDivePair): string {
  return `${pair[0]},${pair[1]}`;
}

/**
 * Resolve the pair the panel should compare: the URL's pair when it is valid
 * for the current selection, else the default. Also reports whether the
 * resolved pair IS the default — the default pair auto-starts the (expensive)
 * LLM job exactly like the 2-run page does; any other pair waits for an
 * explicit click so switching runs never launches surprise LLM work.
 */
export function resolveDeepDivePair(
  runs: BenchmarkRun[],
  param: string | null | undefined
): { pair: DeepDivePair; isDefault: boolean } | null {
  const fallback = defaultDeepDivePair(runs);
  if (!fallback) return null;
  const fromUrl = parseDeepDivePairParam(param, runs.map((r) => r.id));
  if (!fromUrl) return { pair: fallback, isDefault: true };
  const isDefault = fromUrl[0] === fallback[0] && fromUrl[1] === fallback[1];
  return { pair: fromUrl, isDefault };
}

/**
 * Change ONE side of the pair while keeping A ≠ B: if the new value collides
 * with the other side, the other side takes the value this side used to hold
 * (a swap), which is the least surprising way to keep both selects valid.
 */
export function changeDeepDivePairSide(pair: DeepDivePair, side: 'A' | 'B', runId: string): DeepDivePair {
  const [a, b] = pair;
  if (side === 'A') return runId === b ? [runId, a] : [runId, b];
  return runId === a ? [b, runId] : [a, runId];
}

/**
 * Keep a URL pair only while both of its runs stay selected; otherwise drop
 * it (the page falls back to the default pair for the new selection).
 */
export function retainDeepDivePairForSelection(param: string | null | undefined, selectedRunIds: string[]): string | undefined {
  const pair = parseDeepDivePairParam(param, selectedRunIds);
  return pair ? serializeDeepDivePair(pair) : undefined;
}

// ── Representative test case for a resolved [A, B] pair ───────────────────────

/** The test case + report ids the deep-dive job is anchored on. */
export interface DeepDiveCasePair {
  testCaseId: string;
  testCaseName: string;
  reportIdA: string;
  reportIdB: string;
  /** Result-cache key: the two report ids (the model is appended by the panel). */
  cacheKey: string;
}

const reportIdOnRun = (run: BenchmarkRun, testCaseId: string): string | undefined =>
  run.results?.[testCaseId]?.reportId || undefined;

/**
 * Pick the representative test case for the deep-dive: the first case that
 * has a report on BOTH sides.
 *
 * Report ids are read from wherever they actually live, in order:
 *  1. the comparison row (`row.results[runId].reportId`) — present only once
 *     the page has fetched that report doc (`buildTestCaseComparisonRows`
 *     marks a not-yet-loaded report as `missing`, dropping its id);
 *  2. the run doc itself (`run.results[testCaseId].reportId`) — present from
 *     the moment the run pool loads, long before the (large) report docs are.
 *
 * Reading (2) is what keeps the panel mounted while the reports are still
 * downloading — and when that download fails outright — instead of silently
 * vanishing for the exact two runs the user asked to compare. Only the
 * rows are walked (the page builds one per test case across both runs, so
 * they cover every case), so the chosen case is always one the user can see.
 *
 * Among the candidates the one with the LOWEST `testCaseId` wins — NOT the
 * first row in table order. The table is sorted by category, then name, and
 * both arrive asynchronously (test-case metadata loads after the runs), so
 * "first row" changed under the panel as the page filled in: a different
 * representative case → a different report-id pair → a different cache key →
 * the auto-start effect fired a SECOND `POST /api/comparison/deep-dive` ~70 ms
 * after the first, and one full LLM generation per visit was wasted. The id
 * order never changes once the runs are known. `null` only when no test case
 * has a report on both sides (the panel then says so explicitly).
 */
export function resolveDeepDiveCasePair(
  runs: readonly BenchmarkRun[],
  rows: readonly TestCaseComparisonRow[]
): DeepDiveCasePair | null {
  if (runs.length !== 2) return null;
  const [runA, runB] = runs;
  const nameOf = (testCaseId: string, row: TestCaseComparisonRow): string =>
    row.testCaseName
    || runA.testCaseSnapshots?.find((s) => s.id === testCaseId)?.name
    || runB.testCaseSnapshots?.find((s) => s.id === testCaseId)?.name
    || testCaseId;
  const pairFor = (testCaseId: string, row: TestCaseComparisonRow): DeepDiveCasePair | null => {
    const a = row.results[runA.id]?.reportId || reportIdOnRun(runA, testCaseId);
    const b = row.results[runB.id]?.reportId || reportIdOnRun(runB, testCaseId);
    if (!a || !b) return null;
    return { testCaseId, testCaseName: nameOf(testCaseId, row), reportIdA: a, reportIdB: b, cacheKey: `${a}|${b}` };
  };

  let best: DeepDiveCasePair | null = null;
  for (const row of rows) {
    if (best && row.testCaseId.localeCompare(best.testCaseId) >= 0) continue;
    const pair = pairFor(row.testCaseId, row);
    if (pair) best = pair;
  }
  return best;
}
