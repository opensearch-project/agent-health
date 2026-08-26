/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  partitionByAgreement,
  bucketRow,
  extractRowCategory,
  buildCategoryBreakdown,
  detectSharedWeakness,
  UNCATEGORIZED,
  OTHER_CATEGORY,
} from '@/lib/comparisonInsights';
import type { TestCaseComparisonRow } from '@/types';

const RUN_A = 'run-a';
const RUN_B = 'run-b';
const RUN_C = 'run-c';

function row(
  id: string,
  name: string,
  verdicts: Record<string, 'passed' | 'failed' | 'errored' | 'missing'>,
  labels: string[] = []
): TestCaseComparisonRow {
  const results: TestCaseComparisonRow['results'] = {};
  for (const [runId, v] of Object.entries(verdicts)) {
    if (v === 'missing') {
      results[runId] = { status: 'missing' };
    } else if (v === 'errored') {
      results[runId] = { status: 'completed', errored: true };
    } else {
      results[runId] = { status: 'completed', passFailStatus: v };
    }
  }
  return {
    testCaseId: id,
    testCaseName: name,
    labels,
    category: 'Unknown' as any,
    difficulty: 'Medium' as any,
    results,
    hasVersionDifference: false,
    versions: [],
  };
}

describe('partitionByAgreement', () => {
  it('buckets 2-run rows into allPass / allFail / split / uncovered', () => {
    const rows = [
      row('t1', 't1', { [RUN_A]: 'passed', [RUN_B]: 'passed' }),
      row('t2', 't2', { [RUN_A]: 'failed', [RUN_B]: 'failed' }),
      row('t3', 't3', { [RUN_A]: 'passed', [RUN_B]: 'failed' }),
      row('t4', 't4', { [RUN_A]: 'failed', [RUN_B]: 'passed' }),
      row('t5', 't5', { [RUN_A]: 'passed', [RUN_B]: 'missing' }),
    ];
    const p = partitionByAgreement(rows, [RUN_A, RUN_B]);
    expect(p.allPass.map(r => r.testCaseId)).toEqual(['t1']);
    expect(p.allFail.map(r => r.testCaseId)).toEqual(['t2']);
    expect(p.split.map(r => r.testCaseId)).toEqual(['t3', 't4']);
    expect(p.uncovered.map(r => r.testCaseId)).toEqual(['t5']);
  });

  it('treats evaluator-errored results as NO verdict (uncovered), not as fails (#242 semantics)', () => {
    // "The judge broke" must not be conflated with "the agent failed" —
    // otherwise infrastructure noise poisons the All-fail bucket.
    const rows = [
      row('t1', 't1', { [RUN_A]: 'errored', [RUN_B]: 'failed' }),
      row('t2', 't2', { [RUN_A]: 'errored', [RUN_B]: 'passed' }),
    ];
    const p = partitionByAgreement(rows, [RUN_A, RUN_B]);
    expect(p.uncovered.map(r => r.testCaseId)).toEqual(['t1', 't2']);
    expect(p.allFail).toHaveLength(0);
    expect(p.split).toHaveLength(0);
  });

  it('treats a run-level failure (status failed, no judge verdict) as a fail verdict', () => {
    const r1: TestCaseComparisonRow = row('t1', 't1', { [RUN_B]: 'passed' });
    r1.results[RUN_A] = { status: 'failed' };
    const p = partitionByAgreement([r1], [RUN_A, RUN_B]);
    expect(p.split.map(r => r.testCaseId)).toEqual(['t1']);
  });

  it('treats a completed result with NO verdict at all as uncovered', () => {
    const r1: TestCaseComparisonRow = row('t1', 't1', { [RUN_B]: 'passed' });
    r1.results[RUN_A] = { status: 'completed' }; // no passFailStatus, not errored
    const p = partitionByAgreement([r1], [RUN_A, RUN_B]);
    expect(p.uncovered.map(r => r.testCaseId)).toEqual(['t1']);
  });

  it('generalizes to 3 runs: split = any mix of pass and fail', () => {
    const rows = [
      row('t1', 't1', { [RUN_A]: 'passed', [RUN_B]: 'passed', [RUN_C]: 'passed' }),
      row('t2', 't2', { [RUN_A]: 'passed', [RUN_B]: 'passed', [RUN_C]: 'failed' }),
      row('t3', 't3', { [RUN_A]: 'failed', [RUN_B]: 'failed', [RUN_C]: 'failed' }),
    ];
    const p = partitionByAgreement(rows, [RUN_A, RUN_B, RUN_C]);
    expect(p.allPass).toHaveLength(1);
    expect(p.split).toHaveLength(1);
    expect(p.allFail).toHaveLength(1);
  });

  it('bucketRow matches the partition semantics', () => {
    const r1 = row('t1', 't1', { [RUN_A]: 'passed', [RUN_B]: 'failed' });
    const r2 = row('t2', 't2', { [RUN_A]: 'passed', [RUN_B]: 'missing' });
    expect(bucketRow(r1, [RUN_A, RUN_B])).toBe('split');
    expect(bucketRow(r2, [RUN_A, RUN_B])).toBeNull();
  });
});

describe('extractRowCategory', () => {
  it('parses the bracketed tag from imported-benchmark names', () => {
    expect(extractRowCategory(row('t', 'qst_0011 [basic] How long…', {}))).toBe('basic');
    expect(extractRowCategory(row('t', 'qst_0492 [info_not_found] For the…', {}))).toBe('info_not_found');
  });

  it('falls back to topic: labels, then uncategorized', () => {
    expect(extractRowCategory(row('t', 'no tag here', {}, ['topic:Retrieval']))).toBe('retrieval');
    // category:RAG is deliberately ignored — it is stamped on every imported case
    expect(extractRowCategory(row('t', 'no tag here', {}, ['category:RAG']))).toBe(UNCATEGORIZED);
  });
});

describe('buildCategoryBreakdown', () => {
  const rows = [
    ...[1, 2, 3, 4, 5].map(i =>
      row(`b${i}`, `q [basic] ${i}`, { [RUN_A]: i <= 4 ? 'passed' : 'failed', [RUN_B]: 'passed' } as any)
    ),
    ...[1, 2, 3, 4, 5].map(i =>
      row(`s${i}`, `q [semantic] ${i}`, { [RUN_A]: i <= 2 ? 'passed' : 'failed', [RUN_B]: i <= 3 ? 'passed' : 'failed' } as any)
    ),
    row('m1', 'q [misc] 1', { [RUN_A]: 'passed', [RUN_B]: 'passed' }),
  ];

  it('computes per-run rates and rolls small categories into (other)', () => {
    const b = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    expect(b.categories).toEqual(['basic', 'semantic', OTHER_CATEGORY]);
    expect(b.perRun[RUN_A].basic).toEqual({ passed: 4, total: 5 });
    expect(b.perRun[RUN_A].semantic).toEqual({ passed: 2, total: 5 });
    expect(b.perRun[RUN_B].semantic).toEqual({ passed: 3, total: 5 });
    expect(b.perRun[RUN_A][OTHER_CATEGORY]).toEqual({ passed: 1, total: 1 });
  });

  it('exposes members so the (other) rollup is filterable with the same semantics it was computed with', () => {
    const b = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    expect(b.members.basic).toEqual(['basic']);
    expect(b.members[OTHER_CATEGORY]).toEqual(['misc']);
  });

  it('a real [other] name tag cannot collide with the synthetic (other) bucket', () => {
    // extractRowCategory only matches [\w-]+ — parentheses in the sentinel
    // names are outside that charset by construction.
    expect(extractRowCategory(row('t', 'q [other] real category', {}))).toBe('other');
    expect('other').not.toBe(OTHER_CATEGORY);
  });

  it('skips runs with missing verdicts in the cell totals', () => {
    const rowsWithGap = [
      row('g1', 'q [basic] g1', { [RUN_A]: 'passed', [RUN_B]: 'missing' }),
      row('g2', 'q [basic] g2', { [RUN_A]: 'passed', [RUN_B]: 'passed' }),
    ];
    const b = buildCategoryBreakdown(rowsWithGap, [RUN_A, RUN_B], 1);
    expect(b.perRun[RUN_A].basic).toEqual({ passed: 2, total: 2 });
    expect(b.perRun[RUN_B].basic).toEqual({ passed: 1, total: 1 });
  });
});

describe('detectSharedWeakness', () => {
  function scenario(semanticRates: { a: number; b: number }, basicRates: { a: number; b: number }) {
    // 10 cases per category; rates control how many pass
    const rows: TestCaseComparisonRow[] = [];
    for (let i = 1; i <= 10; i++) {
      rows.push(
        row(`s${i}`, `q [semantic] ${i}`, {
          [RUN_A]: i <= semanticRates.a ? 'passed' : 'failed',
          [RUN_B]: i <= semanticRates.b ? 'passed' : 'failed',
        } as any)
      );
      rows.push(
        row(`b${i}`, `q [basic] ${i}`, {
          [RUN_A]: i <= basicRates.a ? 'passed' : 'failed',
          [RUN_B]: i <= basicRates.b ? 'passed' : 'failed',
        } as any)
      );
    }
    const partition = partitionByAgreement(rows, [RUN_A, RUN_B]);
    const breakdown = buildCategoryBreakdown(rows, [RUN_A, RUN_B], 5);
    return detectSharedWeakness(breakdown, partition, [RUN_A, RUN_B]);
  }

  it('flags a category that is the weakest for every run', () => {
    const w = scenario({ a: 6, b: 6 }, { a: 9, b: 9 }); // semantic 60/60, basic 90/90
    expect(w).not.toBeNull();
    expect(w!.category).toBe('semantic');
    expect(w!.rates).toEqual({ [RUN_A]: 60, [RUN_B]: 60 });
    expect(w!.allFailShare).toBeGreaterThan(0);
  });

  it('returns null when runs disagree about their weakest category', () => {
    // semantic weak for A only; basic weak for B only
    const w = scenario({ a: 5, b: 9 }, { a: 9, b: 5 });
    expect(w).toBeNull();
  });

  it('returns null when another category is meaningfully lower for one run (honest "weakest" claim)', () => {
    // For B, basic (40%) is far below semantic (60%) — semantic is NOT B's
    // weakest, so no shared-weakness claim even though semantic has the
    // lower mean? (means: semantic 60, basic 65) — semantic IS mean-weakest
    // but fails the per-run weakest check.
    const w = scenario({ a: 6, b: 6 }, { a: 9, b: 4 });
    expect(w).toBeNull();
  });

  it('returns null when nothing is genuinely weak', () => {
    const w = scenario({ a: 9, b: 8 }, { a: 9, b: 9 }); // 90/80 vs 90/90 — strong everywhere
    expect(w).toBeNull();
  });
});
