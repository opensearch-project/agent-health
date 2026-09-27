/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ONE definition of "did these runs agree on this case?" shared by the
 * comparison page's "N verdict changes" badge (services/comparisonService.ts
 * `calculateRowStatus` / `countRowsByStatus`) and the insights band's
 * "Split" bucket (lib/comparisonInsights.ts `partitionByAgreement`). Before
 * this module the two used different predicates (one skipped agent-crashed
 * runs, the other counted them as fails) and showed different numbers for
 * the same data ("1 differences" vs "15 split").
 *
 * A row's verdict for one run:
 *   - `passed` / `failed` when the judge produced that verdict;
 *   - `failed` when the run itself failed on the case (agent crashed — that
 *     IS a fail for agreement purposes);
 *   - `null` (no verdict) for missing results and evaluator-errored reports
 *     (#242: "the judge broke" is not "the agent failed").
 */

import type { TestCaseComparisonRow, TestCaseRunResult } from '@/types';

export type Verdict = 'passed' | 'failed';
export type VerdictAgreement = 'allPass' | 'allFail' | 'split' | 'uncovered';

type ResultLike = Pick<TestCaseRunResult, 'status' | 'passFailStatus' | 'errored'> | undefined | null;

/** The verdict a run reached on a case, or `null` when it has none. */
export function verdictOf(result: ResultLike): Verdict | null {
  if (!result || result.status === 'missing') return null;
  if (result.passFailStatus === 'passed' || result.passFailStatus === 'failed') return result.passFailStatus;
  if (result.errored) return null;
  return result.status === 'failed' ? 'failed' : null;
}

export function hasVerdict(result: ResultLike): boolean {
  return verdictOf(result) !== null;
}

/**
 * Agreement across the given runs. `uncovered` when ANY run lacks a verdict —
 * a case can neither agree nor disagree with a run that never judged it.
 */
export function rowVerdictAgreement(
  row: Pick<TestCaseComparisonRow, 'results'>,
  runIds: ReadonlyArray<string>
): VerdictAgreement {
  if (runIds.length === 0) return 'uncovered';
  const verdicts = runIds.map(id => verdictOf(row.results[id]));
  if (verdicts.some(v => v === null)) return 'uncovered';
  const passes = verdicts.filter(v => v === 'passed').length;
  if (passes === runIds.length) return 'allPass';
  if (passes === 0) return 'allFail';
  return 'split';
}

/** True iff the runs reached different verdicts on this case (== the insights band's "Split"). */
export function isVerdictDifference(
  row: Pick<TestCaseComparisonRow, 'results'>,
  runIds: ReadonlyArray<string>
): boolean {
  return rowVerdictAgreement(row, runIds) === 'split';
}
