/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  hasUsableSnapshot,
  normalizeRubric,
  primaryMetricMeans,
  rubricScale,
  rubricValuesByName,
  runAggregate,
  scoreFromSnapshot,
  scoredRubricNames,
} from '@/lib/scoring/snapshotScore';
import type { EvaluationReport, ScoringSnapshot } from '@/types';

const snapshot = (over: Partial<ScoringSnapshot> = {}): ScoringSnapshot => ({
  evaluatorId: 'eval-demo',
  evaluatorVersion: 1,
  contentHash: 'hash-1',
  weights: { fact_precision: 0.7, abstention_integrity: 0.3 },
  passPolicy: { kind: 'llm-verdict' },
  ...over,
});

const report = (metrics: Record<string, number | undefined>, snap?: ScoringSnapshot, metricsStatus: EvaluationReport['metricsStatus'] = 'ready') =>
  ({ metrics, scoringSnapshot: snap, metricsStatus }) as unknown as EvaluationReport;

describe('scoreFromSnapshot', () => {
  it('is legacy for a report without a snapshot — even when it has metrics (no alphabetical pick, no mean-of-all)', () => {
    expect(scoreFromSnapshot(report({ abstention_integrity: 92, fact_precision: 60 }))).toEqual({ source: 'legacy' });
    expect(scoreFromSnapshot(undefined)).toEqual({ source: 'legacy' });
    expect(scoreFromSnapshot(null)).toEqual({ source: 'legacy' });
  });

  it('is legacy for a snapshot with no positively-weighted rubric', () => {
    expect(scoreFromSnapshot(report({ a: 50 }, snapshot({ weights: {} })))).toEqual({ source: 'legacy' });
    expect(scoreFromSnapshot(report({ a: 50 }, snapshot({ weights: { a: 0 } })))).toEqual({ source: 'legacy' });
    expect(hasUsableSnapshot(report({ a: 50 }, snapshot({ weights: { a: -1 } })))).toBe(false);
    expect(hasUsableSnapshot(report({ a: 50 }, snapshot()))).toBe(true);
  });

  it('computes the weight-normalized mean over rubrics normalized to [0,1] (default scale 0–100)', () => {
    // The motivating case: abstention_integrity 92 must NOT become the score.
    const rs = scoreFromSnapshot(report({ fact_precision: 60, abstention_integrity: 92 }, snapshot()));
    expect(rs).toEqual({ source: 'snapshot', score: 0.7 * 0.6 + 0.3 * 0.92, scored: 2, total: 2, unevaluable: [] });
    expect((rs as { score: number }).score).toBeCloseTo(0.696, 10);
  });

  it('honours per-rubric scales and clamps out-of-range values', () => {
    const snap = snapshot({
      weights: { hit: 0.5, latency: 0.5 },
      scale: { hit: { min: 0, max: 1 }, latency: { min: 0, max: 10 } },
    });
    expect(scoreFromSnapshot(report({ hit: 1, latency: 5 }, snap))).toMatchObject({ score: 0.75, scored: 2, total: 2 });
    // 15 on a 0–10 scale clamps to 1.0; -3 on 0–1 clamps to 0.
    expect(scoreFromSnapshot(report({ hit: -3, latency: 15 }, snap))).toMatchObject({ score: 0.5 });
  });

  it('excludes unevaluable rubrics from the mean (never zero) but keeps them in total', () => {
    const snap = snapshot({ unevaluable: ['abstention_integrity'] });
    const rs = scoreFromSnapshot(report({ fact_precision: 80, abstention_integrity: 0 }, snap));
    // Only fact_precision counts: 0.8 — the 0 for abstention is ignored.
    expect(rs).toMatchObject({ source: 'snapshot', scored: 1, total: 2, unevaluable: ['abstention_integrity'] });
    expect((rs as { score: number }).score).toBeCloseTo(0.8, 10);
  });

  it('treats a rubric missing from metrics (or non-finite) as unevaluable, not 0', () => {
    const missing = scoreFromSnapshot(report({ fact_precision: 80 }, snapshot()));
    expect(missing).toMatchObject({ source: 'snapshot', scored: 1, total: 2, unevaluable: ['abstention_integrity'] });
    expect((missing as { score: number }).score).toBeCloseTo(0.8, 10);
    const nan = scoreFromSnapshot(report({ fact_precision: 80, abstention_integrity: NaN }, snapshot()));
    expect(nan).toMatchObject({ scored: 1, unevaluable: ['abstention_integrity'] });
    expect((nan as { score: number }).score).toBeCloseTo(0.8, 10);
  });

  it('treats an invalid scale (max <= min) as unevaluable', () => {
    const snap = snapshot({ scale: { abstention_integrity: { min: 5, max: 5 } } });
    expect(scoreFromSnapshot(report({ fact_precision: 100, abstention_integrity: 50 }, snap))).toMatchObject({
      score: 1, scored: 1, total: 2, unevaluable: ['abstention_integrity'],
    });
  });

  it('returns score null (not 0) when no rubric could be scored', () => {
    expect(scoreFromSnapshot(report({}, snapshot()))).toEqual({
      source: 'snapshot', score: null, scored: 0, total: 2, unevaluable: ['fact_precision', 'abstention_integrity'],
    });
  });

  it('ignores zero/negative-weight rubrics entirely and keeps declaration order', () => {
    const snap = snapshot({ weights: { b: 0.5, zero: 0, a: 0.5, neg: -1 } });
    expect(scoredRubricNames(snap)).toEqual(['b', 'a']);
    expect(scoreFromSnapshot(report({ a: 100, b: 0, zero: 100, neg: 100 }, snap))).toMatchObject({ score: 0.5, scored: 2, total: 2 });
  });
});

describe('helpers', () => {
  it('normalizeRubric maps onto [0,1] and rejects degenerate scales', () => {
    expect(normalizeRubric(50, { min: 0, max: 100 })).toBe(0.5);
    expect(normalizeRubric(150, { min: 0, max: 100 })).toBe(1);
    expect(normalizeRubric(-1, { min: 0, max: 100 })).toBe(0);
    expect(normalizeRubric(1, { min: 1, max: 1 })).toBeNull();
    expect(normalizeRubric(1, { min: 2, max: 1 })).toBeNull();
  });

  it('rubricScale defaults to 0–100 and ignores malformed entries', () => {
    expect(rubricScale(snapshot(), 'fact_precision')).toEqual({ min: 0, max: 100 });
    expect(rubricScale(snapshot({ scale: { x: { min: 0, max: 1 } } }), 'x')).toEqual({ min: 0, max: 1 });
    expect(rubricScale(snapshot({ scale: { x: { min: NaN, max: 1 } } }), 'x')).toEqual({ min: 0, max: 100 });
  });

  it('rubricValuesByName keeps stored order and drops non-finite values — the legacy read', () => {
    expect(Object.entries(rubricValuesByName({ zeta: 1, alpha: 2, bad: NaN, missing: undefined }))).toEqual([['zeta', 1], ['alpha', 2]]);
    expect(rubricValuesByName(undefined)).toEqual({});
  });

  it('primaryMetricMeans averages raw values over evaluated reports carrying them', () => {
    const reports = [
      report({ hit_at_1: 1, mrr: 1 }),
      report({ hit_at_1: 0 }),
      report({ hit_at_1: 1 }, undefined, 'error'), // errored → ignored
    ];
    expect(primaryMetricMeans(reports, ['hit_at_1', 'mrr', 'absent'])).toEqual({ hit_at_1: 0.5, mrr: 1, absent: undefined });
  });
});

describe('runAggregate', () => {
  it('is legacy when there are no evaluated reports', () => {
    expect(runAggregate([])).toEqual({ source: 'legacy', evaluatedReports: 0, withSnapshot: 0 });
    expect(runAggregate([report({ a: 1 }, snapshot(), 'error')])).toEqual({ source: 'legacy', evaluatedReports: 0, withSnapshot: 0 });
  });

  it('is legacy when ANY evaluated report lacks a snapshot (mixed run)', () => {
    const agg = runAggregate([
      report({ fact_precision: 80, abstention_integrity: 100 }, snapshot()),
      report({ fact_precision: 40, abstention_integrity: 80 }),
    ]);
    expect(agg).toEqual({ source: 'legacy', evaluatedReports: 2, withSnapshot: 1 });
  });

  it('averages per-report scores when every evaluated report has a snapshot; errored/pending reports are skipped', () => {
    const agg = runAggregate([
      report({ fact_precision: 80, abstention_integrity: 100 }, snapshot()),   // 0.86
      report({ fact_precision: 40, abstention_integrity: 80 }, snapshot()),    // 0.52
      report({ fact_precision: 0, abstention_integrity: 0 }, undefined, 'error'),
      report({ fact_precision: 0, abstention_integrity: 0 }, undefined, 'pending'),
    ]);
    expect(agg.source).toBe('snapshot');
    if (agg.source !== 'snapshot') throw new Error('unreachable');
    expect(agg.score).toBeCloseTo(0.69, 10);
    expect(agg.scoredReports).toBe(2);
    expect(agg.evaluatedReports).toBe(2);
    expect(agg.scoredRubrics).toBe(4);
    expect(agg.totalRubrics).toBe(4);
    expect(agg.snapshots).toHaveLength(1);
  });

  it('counts unscored-but-snapshotted reports in coverage, not in the mean; collects distinct snapshots by hash', () => {
    const agg = runAggregate([
      report({ fact_precision: 100, abstention_integrity: 100 }, snapshot()),
      report({}, snapshot({ contentHash: 'hash-2', evaluatorVersion: 2 })), // nothing scorable
    ]);
    if (agg.source !== 'snapshot') throw new Error('unreachable');
    expect(agg.score).toBe(1);
    expect(agg.scoredReports).toBe(1);
    expect(agg.evaluatedReports).toBe(2);
    expect(agg.scoredRubrics).toBe(2);
    expect(agg.totalRubrics).toBe(4);
    expect(agg.snapshots.map(s => s.contentHash)).toEqual(['hash-1', 'hash-2']);
  });

  it('yields score null when every report is unscorable', () => {
    const agg = runAggregate([report({}, snapshot())]);
    expect(agg).toMatchObject({ source: 'snapshot', score: null, scoredReports: 0, evaluatedReports: 1 });
  });
});
