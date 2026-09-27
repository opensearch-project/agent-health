/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The "N verdict changes" badge (comparisonService.countRowsByStatus) and the
 * insights band's "Split" bucket (comparisonInsights.partitionByAgreement)
 * must be the SAME number — they share one predicate module. The property
 * test below generates random two-run rows (every verdict/status/errored
 * shape the comparison page can produce) and checks the two counts agree.
 */

import fc from 'fast-check';
import { hasVerdict, isVerdictDifference, rowVerdictAgreement, verdictOf } from '@/lib/comparison/verdictAgreement';
import { partitionByAgreement } from '@/lib/comparisonInsights';
import { classifyRow, countRowsByStatus } from '@/services/comparisonService';
import type { TestCaseComparisonRow, TestCaseRunResult } from '@/types';

const row = (results: Record<string, TestCaseRunResult>): TestCaseComparisonRow => ({
  testCaseId: 'tc',
  testCaseName: 'tc',
  labels: [],
  category: 'RCA',
  difficulty: 'Easy',
  results,
  hasVersionDifference: false,
  versions: [],
});

describe('verdictOf', () => {
  it('reads the judge verdict when present', () => {
    expect(verdictOf({ status: 'completed', passFailStatus: 'passed' })).toBe('passed');
    expect(verdictOf({ status: 'completed', passFailStatus: 'failed' })).toBe('failed');
  });
  it('counts an agent-crashed run (status failed) as a fail verdict', () => {
    expect(verdictOf({ status: 'failed' })).toBe('failed');
  });
  it('has no verdict for missing, evaluator-errored (#242) or verdict-less completed results', () => {
    expect(verdictOf(undefined)).toBeNull();
    expect(verdictOf({ status: 'missing' })).toBeNull();
    expect(verdictOf({ status: 'completed', errored: true })).toBeNull();
    expect(verdictOf({ status: 'completed' })).toBeNull();
    expect(hasVerdict({ status: 'completed' })).toBe(false);
  });
});

describe('rowVerdictAgreement', () => {
  const A: TestCaseRunResult = { status: 'completed', passFailStatus: 'passed' };
  const B: TestCaseRunResult = { status: 'completed', passFailStatus: 'failed' };
  it('buckets allPass / allFail / split / uncovered', () => {
    expect(rowVerdictAgreement(row({ a: A, b: A }), ['a', 'b'])).toBe('allPass');
    expect(rowVerdictAgreement(row({ a: B, b: B }), ['a', 'b'])).toBe('allFail');
    expect(rowVerdictAgreement(row({ a: A, b: B }), ['a', 'b'])).toBe('split');
    expect(rowVerdictAgreement(row({ a: A, b: { status: 'missing' } }), ['a', 'b'])).toBe('uncovered');
    expect(rowVerdictAgreement(row({ a: A, b: { status: 'completed', errored: true } }), ['a', 'b'])).toBe('uncovered');
    expect(rowVerdictAgreement(row({ a: A }), [])).toBe('uncovered');
    expect(isVerdictDifference(row({ a: A, b: B }), ['a', 'b'])).toBe(true);
  });
});

// ─── Property: verdict differences == Split ─────────────────────────────────

const resultArb: fc.Arbitrary<TestCaseRunResult> = fc.oneof(
  fc.constant<TestCaseRunResult>({ status: 'missing' }),
  fc.constant<TestCaseRunResult>({ status: 'failed' }),
  fc.constant<TestCaseRunResult>({ status: 'completed', errored: true }),
  fc.constant<TestCaseRunResult>({ status: 'completed' }),
  fc.record({
    status: fc.constant<'completed'>('completed'),
    passFailStatus: fc.constantFrom<'passed' | 'failed'>('passed', 'failed'),
    accuracy: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
    score: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  }),
);

const rowsArb = fc.array(
  fc.record({ a: resultArb, b: resultArb }).map(({ a, b }) => row({ a, b })),
  { minLength: 0, maxLength: 40 },
);

describe('verdict differences vs Split (shared predicate)', () => {
  it('countRowsByStatus.verdictDifferences equals partitionByAgreement.split.length for any two-run row set', () => {
    fc.assert(
      fc.property(rowsArb, rows => {
        const counts = countRowsByStatus(rows, 'a');
        const partition = partitionByAgreement(rows, ['a', 'b']);
        expect(counts.verdictDifferences).toBe(partition.split.length);
        // …and independent of which run is the baseline.
        expect(countRowsByStatus(rows, 'b').verdictDifferences).toBe(partition.split.length);
      }),
      { numRuns: 200 },
    );
  });

  it('a verdict-kind row is exactly a split row; score-only rows are allPass/allFail rows', () => {
    fc.assert(
      fc.property(rowsArb, rows => {
        for (const r of rows) {
          const { kind } = classifyRow(r, 'a');
          const agreement = rowVerdictAgreement(r, ['a', 'b']);
          if (kind === 'verdict') expect(agreement).toBe('split');
          if (agreement === 'split') expect(kind).toBe('verdict');
          if (kind === 'score-only') expect(['allPass', 'allFail']).toContain(agreement);
          if (agreement === 'uncovered') expect(kind).toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('classifyRow', () => {
  it('flags a verdict change with direction relative to the baseline', () => {
    expect(classifyRow(row({ a: { status: 'completed', passFailStatus: 'passed' }, b: { status: 'completed', passFailStatus: 'failed' } }), 'a'))
      .toEqual({ status: 'regression', kind: 'verdict' });
    expect(classifyRow(row({ a: { status: 'completed', passFailStatus: 'failed' }, b: { status: 'completed', passFailStatus: 'passed' } }), 'a'))
      .toEqual({ status: 'improvement', kind: 'verdict' });
    // Agent crash on b counts as a fail verdict — consistent with Split.
    expect(classifyRow(row({ a: { status: 'completed', passFailStatus: 'passed' }, b: { status: 'failed' } }), 'a'))
      .toEqual({ status: 'regression', kind: 'verdict' });
  });

  it('flags a score-only move only when verdicts agree and the snapshot scores differ by > 5', () => {
    const passed = (score?: number): TestCaseRunResult => ({ status: 'completed', passFailStatus: 'passed', score });
    expect(classifyRow(row({ a: passed(90), b: passed(70) }), 'a')).toEqual({ status: 'regression', kind: 'score-only' });
    expect(classifyRow(row({ a: passed(70), b: passed(90) }), 'a')).toEqual({ status: 'improvement', kind: 'score-only' });
    expect(classifyRow(row({ a: passed(70), b: passed(74) }), 'a')).toEqual({ status: 'neutral', kind: null });
  });

  it('never compares a snapshot score against a legacy metric', () => {
    const a: TestCaseRunResult = { status: 'completed', passFailStatus: 'passed', score: 90 };
    const b: TestCaseRunResult = { status: 'completed', passFailStatus: 'passed', accuracy: 10 };
    expect(classifyRow(row({ a, b }), 'a')).toEqual({ status: 'neutral', kind: null });
  });

  it('legacy reports: score-only moves use `accuracy` when BOTH carry it — never an invented zero-filled combination', () => {
    const passed = (extra: Partial<TestCaseRunResult>): TestCaseRunResult => ({ status: 'completed', passFailStatus: 'passed', ...extra });
    expect(classifyRow(row({ a: passed({ accuracy: 90 }), b: passed({ accuracy: 60 }) }), 'a')).toEqual({ status: 'regression', kind: 'score-only' });
    // One side has no accuracy (custom rubrics only) → nothing honest to diff → neutral.
    expect(classifyRow(row({ a: passed({ accuracy: 90 }), b: passed({ faithfulness: 10 }) }), 'a')).toEqual({ status: 'neutral', kind: null });
    // Faithfulness alone (the old 30%-weighted input) no longer produces a "move".
    expect(classifyRow(row({ a: passed({ faithfulness: 100 }), b: passed({ faithfulness: 0 }) }), 'a')).toEqual({ status: 'neutral', kind: null });
  });

  it('is neutral when the baseline or another run has no verdict (evaluator-errored is not a regression)', () => {
    expect(classifyRow(row({ a: { status: 'completed', passFailStatus: 'passed' }, b: { status: 'completed', errored: true } }), 'a'))
      .toEqual({ status: 'neutral', kind: null });
    expect(classifyRow(row({ a: { status: 'missing' }, b: { status: 'completed', passFailStatus: 'passed' } }), 'a'))
      .toEqual({ status: 'neutral', kind: null });
    expect(classifyRow(row({ b: { status: 'completed', passFailStatus: 'passed' } }), 'a'))
      .toEqual({ status: 'neutral', kind: null });
  });
});
