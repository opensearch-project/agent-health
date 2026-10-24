/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  abstain,
  computeMetric,
  describeMetricCompute,
  metricApplies,
  mrr,
  rankedHit,
  rankedRecall,
  validateMetricCompute,
  RANKED_METRIC_TYPES,
  MetricValidationError,
} from '@/lib/metrics/index';

describe('lib/metrics — abstain', () => {
  // gold-empty cases are the only ones the metric speaks to.
  it.each([
    ['gold empty, prediction empty → 1', [], [], 1],
    ['gold empty, prediction non-empty → 0', [], ['x'], 0],
    ['gold empty, prediction only blanks → 1 (blanks are not ids)', [], ['', '  '], 1],
    ['gold non-empty, prediction empty → null (not this metric\'s case)', ['g'], [], null],
    ['gold non-empty, prediction non-empty → null', ['g'], ['g'], null],
    ['gold of blanks counts as empty', ['  '], [], 1],
  ] as Array<[string, string[], string[], number | null]>)('%s', (_name, gold, ranked, expected) => {
    expect(abstain({ gold, ranked })).toBe(expected);
    expect(computeMetric({ type: 'abstain' }, { gold, ranked })).toBe(expected);
  });

  it('ignores emptyRanking (its own semantics for an empty ranking)', () => {
    expect(abstain({ gold: [], ranked: [], emptyRanking: 'zero' })).toBe(1);
    expect(abstain({ gold: ['g'], ranked: [], emptyRanking: 'zero' })).toBeNull();
  });

  it('is a registered compute type: validates, describes, and needs no params', () => {
    expect(validateMetricCompute({ type: 'abstain' })).toEqual({ type: 'abstain' });
    expect(validateMetricCompute({ type: 'abstain', k: 5 })).toEqual({ type: 'abstain' }); // extra keys dropped
    expect(describeMetricCompute({ type: 'abstain' })).toBe('abstain');
    expect(() => validateMetricCompute({ type: 'abstian' })).toThrow(MetricValidationError);
    expect(() => validateMetricCompute({ type: 'abstian' })).toThrow(/supported: ranked-hit, ranked-recall, mrr, abstain/);
  });
});

describe('lib/metrics — metricApplies', () => {
  it('ranked metrics apply iff gold is non-empty; abstain iff gold is empty', () => {
    for (const type of RANKED_METRIC_TYPES) {
      expect(metricApplies({ type }, ['g'])).toBe(true);
      expect(metricApplies({ type }, [])).toBe(false);
      expect(metricApplies({ type }, ['', ' '])).toBe(false);
    }
    expect(metricApplies({ type: 'abstain' }, [])).toBe(true);
    expect(metricApplies({ type: 'abstain' }, ['g'])).toBe(false);
  });
});

describe('lib/metrics — emptyRanking', () => {
  const gold = ['a', 'b'];
  it("default ('unevaluable'): an empty ranking is null for every ranked metric", () => {
    expect(rankedHit({ gold, ranked: [], k: 5 })).toBeNull();
    expect(rankedRecall({ gold, ranked: [], k: 5 })).toBeNull();
    expect(mrr({ gold, ranked: [] })).toBeNull();
  });
  it("'zero': an empty ranking computes naturally to 0 (hit 0, recall 0, mrr 0)", () => {
    expect(rankedHit({ gold, ranked: [], k: 5, emptyRanking: 'zero' })).toBe(0);
    expect(rankedRecall({ gold, ranked: [], k: 5, emptyRanking: 'zero' })).toBe(0);
    expect(rankedRecall({ gold, ranked: [], k: 5, denominator: 'min-k-gold', emptyRanking: 'zero' })).toBe(0);
    expect(mrr({ gold, ranked: [], emptyRanking: 'zero' })).toBe(0);
    expect(computeMetric({ type: 'ranked-hit', k: 1 }, { gold, ranked: [], emptyRanking: 'zero' })).toBe(0);
  });
  it("'zero' never rescues an empty gold set (still unevaluable)", () => {
    expect(rankedHit({ gold: [], ranked: [], k: 5, emptyRanking: 'zero' })).toBeNull();
    expect(rankedHit({ gold: [], ranked: ['x'], k: 5, emptyRanking: 'zero' })).toBeNull();
  });
  it("'zero' does not change a non-empty ranking", () => {
    expect(rankedHit({ gold, ranked: ['b'], k: 1, emptyRanking: 'zero' })).toBe(1);
    expect(mrr({ gold, ranked: ['x', 'a'], emptyRanking: 'zero' })).toBe(0.5);
  });
});
