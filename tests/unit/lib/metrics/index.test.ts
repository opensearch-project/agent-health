/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture table for the typed ranked-retrieval metric registry (lib/metrics).
 * Every row is hand-computed. `null` = unevaluable (never 0).
 */

import {
  rankedHit,
  rankedRecall,
  mrr,
  computeMetric,
  validateMetricCompute,
  describeMetricCompute,
  dedupeIds,
  MetricValidationError,
  METRIC_COMPUTE_TYPES,
} from '@/lib/metrics/index';

const gold = ['g1', 'g2', 'g3'];

describe('lib/metrics — fixture table', () => {
  const table: Array<{
    name: string;
    gold: string[];
    ranked: string[];
    k: number;
    hit: number | null;
    recallFull: number | null;
    recallMinK: number | null;
    mrr: number | null;
  }> = [
    { name: 'first hit at rank 1', gold, ranked: ['g1', 'x', 'y'], k: 5, hit: 1, recallFull: 1 / 3, recallMinK: 1 / 3, mrr: 1 },
    { name: 'first hit at rank 3', gold, ranked: ['x', 'y', 'g2', 'z'], k: 5, hit: 1, recallFull: 1 / 3, recallMinK: 1 / 3, mrr: 1 / 3 },
    { name: 'hit outside k', gold, ranked: ['x', 'y', 'g2'], k: 2, hit: 0, recallFull: 0, recallMinK: 0, mrr: 1 / 3 },
    { name: 'no hits at all', gold, ranked: ['x', 'y', 'z'], k: 5, hit: 0, recallFull: 0, recallMinK: 0, mrr: 0 },
    { name: 'duplicates in ranked are counted once', gold, ranked: ['g1', 'g1', 'g1', 'x'], k: 5, hit: 1, recallFull: 1 / 3, recallMinK: 1 / 3, mrr: 1 },
    { name: 'k larger than ranked length', gold, ranked: ['g1', 'g2'], k: 20, hit: 1, recallFull: 2 / 3, recallMinK: 2 / 3, mrr: 1 },
    { name: 'gold larger than k — full-gold caps recall below 1, min-k-gold reaches 1', gold: ['a', 'b', 'c', 'd', 'e'], ranked: ['a', 'b'], k: 2, hit: 1, recallFull: 2 / 5, recallMinK: 1, mrr: 1 },
    { name: 'all gold retrieved in order', gold, ranked: ['g1', 'g2', 'g3'], k: 3, hit: 1, recallFull: 1, recallMinK: 1, mrr: 1 },
    { name: 'duplicate gold ids are one gold entry', gold: ['g1', 'g1'], ranked: ['g1'], k: 1, hit: 1, recallFull: 1, recallMinK: 1, mrr: 1 },
    { name: 'empty output → unevaluable', gold, ranked: [], k: 5, hit: null, recallFull: null, recallMinK: null, mrr: null },
    { name: 'missing gold → unevaluable', gold: [], ranked: ['x'], k: 5, hit: null, recallFull: null, recallMinK: null, mrr: null },
    { name: 'whitespace-only ids are ignored', gold: ['  '], ranked: ['x'], k: 5, hit: null, recallFull: null, recallMinK: null, mrr: null },
  ];

  it.each(table)('$name', row => {
    expect(rankedHit({ gold: row.gold, ranked: row.ranked, k: row.k })).toBe(row.hit);
    const rf = rankedRecall({ gold: row.gold, ranked: row.ranked, k: row.k });
    const rm = rankedRecall({ gold: row.gold, ranked: row.ranked, k: row.k, denominator: 'min-k-gold' });
    if (row.recallFull === null) expect(rf).toBeNull(); else expect(rf).toBeCloseTo(row.recallFull, 10);
    if (row.recallMinK === null) expect(rm).toBeNull(); else expect(rm).toBeCloseTo(row.recallMinK, 10);
    const m = mrr({ gold: row.gold, ranked: row.ranked });
    if (row.mrr === null) expect(m).toBeNull(); else expect(m).toBeCloseTo(row.mrr, 10);
  });

  it('defaults the recall denominator to full-gold', () => {
    expect(rankedRecall({ gold: ['a', 'b', 'c', 'd'], ranked: ['a', 'b'], k: 2 })).toBeCloseTo(0.5);
  });

  it('accepts numeric ids and trims strings', () => {
    expect(rankedHit({ gold: [' 42 '], ranked: [42 as unknown as string], k: 1 })).toBe(1);
    expect(dedupeIds([1, '1', ' 2', 2, '', null, undefined])).toEqual(['1', '2']);
  });

  it('rejects invalid k / denominator', () => {
    expect(() => rankedHit({ gold, ranked: ['g1'], k: 0 })).toThrow(MetricValidationError);
    expect(() => rankedHit({ gold, ranked: ['g1'], k: 1.5 })).toThrow(/positive integer/);
    expect(() => rankedRecall({ gold, ranked: ['g1'], k: 1, denominator: 'nope' as any })).toThrow(/denominator/);
  });
});

describe('lib/metrics — registry', () => {
  it('lists exactly the supported compute types', () => {
    expect([...METRIC_COMPUTE_TYPES]).toEqual(['ranked-hit', 'ranked-recall', 'mrr', 'abstain']);
  });

  it('computeMetric dispatches by type', () => {
    const inputs = { gold: ['g'], ranked: ['x', 'g'] };
    expect(computeMetric({ type: 'ranked-hit', k: 1 }, inputs)).toBe(0);
    expect(computeMetric({ type: 'ranked-hit', k: 2 }, inputs)).toBe(1);
    expect(computeMetric({ type: 'ranked-recall', k: 2 }, inputs)).toBe(1);
    expect(computeMetric({ type: 'mrr' }, inputs)).toBeCloseTo(0.5);
  });

  it('unknown / malformed compute types are validation errors', () => {
    expect(() => computeMetric({ type: 'ndcg', k: 5 } as any, { gold: ['g'], ranked: ['g'] })).toThrow(/unknown compute type "ndcg"/);
    expect(() => validateMetricCompute(null)).toThrow(MetricValidationError);
    expect(() => validateMetricCompute({ type: 'ranked-recall', k: 5, denominator: 'x' })).toThrow(/denominator/);
    expect(() => validateMetricCompute({ type: 'ranked-hit' })).toThrow(/k must be/);
  });

  it('validateMetricCompute normalizes (fills the recall denominator default)', () => {
    expect(validateMetricCompute({ type: 'ranked-recall', k: 20 })).toEqual({ type: 'ranked-recall', k: 20, denominator: 'full-gold' });
    expect(validateMetricCompute({ type: 'mrr', k: 99 })).toEqual({ type: 'mrr' });
  });

  it('describeMetricCompute', () => {
    expect(describeMetricCompute({ type: 'ranked-hit', k: 5 })).toBe('ranked-hit@5');
    expect(describeMetricCompute({ type: 'ranked-recall', k: 20, denominator: 'min-k-gold' })).toBe('ranked-recall@20 (min-k-gold)');
    expect(describeMetricCompute({ type: 'mrr' })).toBe('mrr');
  });
});
