/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeVerdict,
  normalizePassPolicy,
  scoringFieldsFromJudgment,
  sdkSessionScoring,
} from '@/lib/scoring/verdictEngine';
import type { ScoringSnapshot } from '@/types';

const weights = { a: 0.5, b: 0.3, c: 0.2 };
const base = { weights, passPolicy: { kind: 'llm-verdict' as const } };
const snap = (passPolicy: any, extra: Partial<ScoringSnapshot> = {}) => ({ ...base, passPolicy, ...extra });

describe('verdictEngine.computeVerdict — truth table', () => {
  describe('llm-verdict (frozen historical behaviour)', () => {
    it.each([
      ['passed', { a: 90, b: 90, c: 90 }],
      ['failed', { a: 90, b: 90, c: 90 }],
      ['passed', { a: 10, b: 10, c: 10 }],
      ['failed', { a: 10, b: 10, c: 10 }],
    ] as const)('verdict is the LLM\'s (%s) regardless of the score', (llm, metrics) => {
      const v = computeVerdict({ metrics, snapshot: snap({ kind: 'llm-verdict' }), llmVerdict: llm });
      expect(v.passFailStatus).toBe(llm);
      expect(v.llmVerdict).toBe(llm);
      expect(v.verdictConflict).toBe(false);
      expect(v.score).not.toBeNull(); // still computed for display
    });

    it('a missing LLM verdict reads as failed with an explicit reason (never passed)', () => {
      const v = computeVerdict({ metrics: { a: 100, b: 100, c: 100 }, snapshot: snap({ kind: 'llm-verdict' }) });
      expect(v.passFailStatus).toBe('failed');
      expect(v.reasons).toEqual(['no-llm-verdict']);
      expect(v.llmVerdict).toBeUndefined();
    });

    it('an unevaluable rubric does not change the LLM verdict but is recorded', () => {
      const v = computeVerdict({ metrics: { a: 90, b: 90 }, snapshot: snap({ kind: 'llm-verdict' }), llmVerdict: 'passed' });
      expect(v.passFailStatus).toBe('passed');
      expect(v.unevaluable).toEqual(['c']);
      expect(v.scored).toBe(2);
      expect(v.total).toBe(3);
    });
  });

  describe('threshold', () => {
    const policy = { kind: 'threshold', minScore: 0.7 };

    it('passes when the weighted mean >= minScore and every rubric is evaluable', () => {
      // 0.5*80 + 0.3*70 + 0.2*60 = 40+21+12 = 73 → 0.73
      const v = computeVerdict({ metrics: { a: 80, b: 70, c: 60 }, snapshot: snap(policy), llmVerdict: 'passed' });
      expect(v.score).toBeCloseTo(0.73, 5);
      expect(v.passFailStatus).toBe('passed');
      expect(v.verdictConflict).toBe(false);
      expect(v.reasons).toEqual([]);
    });

    it('passes exactly at the threshold (>=)', () => {
      const v = computeVerdict({ metrics: { a: 70, b: 70, c: 70 }, snapshot: snap(policy) });
      expect(v.score).toBeCloseTo(0.7, 9);
      expect(v.passFailStatus).toBe('passed');
    });

    it('fails below the threshold and records the LLM conflict when the LLM said passed', () => {
      // 0.5*60 + 0.3*70 + 0.2*60 = 30+21+12 = 63
      const v = computeVerdict({ metrics: { a: 60, b: 70, c: 60 }, snapshot: snap(policy), llmVerdict: 'passed' });
      expect(v.passFailStatus).toBe('failed');
      expect(v.llmVerdict).toBe('passed');
      expect(v.verdictConflict).toBe(true);
      expect(v.reasons[0]).toMatch(/^score 0\.630 < 0\.7$/);
    });

    it('conflict is also recorded the other way round (computed pass, LLM failed) — never overrides', () => {
      const v = computeVerdict({ metrics: { a: 90, b: 90, c: 90 }, snapshot: snap(policy), llmVerdict: 'failed' });
      expect(v.passFailStatus).toBe('passed');
      expect(v.verdictConflict).toBe(true);
    });

    it('an unevaluable rubric fails the verdict even when the partial mean is high (never silently pass)', () => {
      const v = computeVerdict({ metrics: { a: 100, b: 100 }, snapshot: snap(policy), llmVerdict: 'passed' });
      expect(v.score).toBeCloseTo(1, 9); // mean over the scorable rubrics only
      expect(v.unevaluable).toEqual(['c']);
      expect(v.passFailStatus).toBe('failed');
      expect(v.reasons).toEqual(['unevaluable:c']);
      expect(v.verdictConflict).toBe(true);
    });

    it('a non-numeric rubric is unevaluable, not 0', () => {
      const v = computeVerdict({ metrics: { a: 'high', b: 100, c: 100 } as any, snapshot: snap(policy) });
      expect(v.unevaluable).toEqual(['a']);
      expect(v.score).toBeCloseTo(1, 9);
      expect(v.passFailStatus).toBe('failed');
    });

    it('no scorable rubric → score null, failed, reason no-scored-rubrics', () => {
      const v = computeVerdict({ metrics: {}, snapshot: snap(policy), llmVerdict: 'passed' });
      expect(v.score).toBeNull();
      expect(v.passFailStatus).toBe('failed');
      expect(v.reasons).toEqual(['unevaluable:a', 'unevaluable:b', 'unevaluable:c', 'no-scored-rubrics']);
    });

    it('works without an LLM verdict (deterministic scoring): no llmVerdict, no conflict', () => {
      const v = computeVerdict({ metrics: { a: 90, b: 90, c: 90 }, snapshot: snap(policy) });
      expect(v.passFailStatus).toBe('passed');
      expect(v.llmVerdict).toBeUndefined();
      expect(v.verdictConflict).toBe(false);
    });
  });

  describe('gates', () => {
    const policy = { kind: 'gates', gates: [{ metric: 'a', min: 80 }, { metric: 'b', min: 50 }] };

    it('passes when every gate metric >= its min (raw scale), regardless of the mean', () => {
      const v = computeVerdict({ metrics: { a: 80, b: 50, c: 0 }, snapshot: snap(policy), llmVerdict: 'failed' });
      expect(v.passFailStatus).toBe('passed');
      expect(v.verdictConflict).toBe(true);
    });

    it('fails when any gate metric is below its min', () => {
      const v = computeVerdict({ metrics: { a: 79, b: 100, c: 100 }, snapshot: snap(policy), llmVerdict: 'passed' });
      expect(v.passFailStatus).toBe('failed');
      expect(v.reasons).toEqual(['gate a 79 < 80']);
      expect(v.verdictConflict).toBe(true);
    });

    it('an unevaluable gate metric fails the gate; an unevaluable non-gate rubric does not', () => {
      const missingGate = computeVerdict({ metrics: { b: 100, c: 100 }, snapshot: snap(policy) });
      expect(missingGate.passFailStatus).toBe('failed');
      expect(missingGate.reasons).toEqual(['unevaluable:a']);
      expect(missingGate.unevaluable).toEqual(['a']);

      const missingNonGate = computeVerdict({ metrics: { a: 100, b: 100 }, snapshot: snap(policy) });
      expect(missingNonGate.passFailStatus).toBe('passed');
      expect(missingNonGate.unevaluable).toEqual(['c']);
    });

    it('a gate on a metric the score does not weight still uses the declared scale', () => {
      const v = computeVerdict({
        metrics: { a: 100, b: 100, c: 100, hit1: 1 },
        snapshot: snap({ kind: 'gates', gates: [{ metric: 'hit1', min: 1 }] }, { scale: { hit1: { min: 0, max: 1 } } }),
      });
      expect(v.passFailStatus).toBe('passed');
    });

    it('an empty gate list never passes', () => {
      const v = computeVerdict({ metrics: { a: 100, b: 100, c: 100 }, snapshot: snap({ kind: 'gates', gates: [] }) });
      expect(v.passFailStatus).toBe('failed');
      expect(v.reasons).toEqual(['no-gates-declared']);
    });
  });

  describe('normalization with custom scales', () => {
    it('normalizes each rubric by its own scale before weighting', () => {
      const v = computeVerdict({
        metrics: { a: 5, b: 1, c: 50 },
        snapshot: snap({ kind: 'threshold', minScore: 0.5 }, { scale: { a: { min: 0, max: 10 }, b: { min: 0, max: 1 }, c: { min: 0, max: 100 } } }),
      });
      // a=0.5, b=1, c=0.5 → 0.25+0.3+0.1 = 0.65
      expect(v.score).toBeCloseTo(0.65, 9);
      expect(v.passFailStatus).toBe('passed');
    });

    it('clamps out-of-range values instead of dropping them, and a gate min is compared in the same scale', () => {
      const v = computeVerdict({
        metrics: { a: 12, b: 1, c: 100 },
        snapshot: snap({ kind: 'gates', gates: [{ metric: 'a', min: 10 }] }, { scale: { a: { min: 0, max: 10 }, b: { min: 0, max: 1 } } }),
      });
      expect(v.score).toBeCloseTo(1, 9);
      expect(v.passFailStatus).toBe('passed');
    });

    it('an invalid scale makes the rubric unevaluable', () => {
      const v = computeVerdict({
        metrics: { a: 50, b: 50, c: 50 },
        snapshot: snap({ kind: 'threshold', minScore: 0.1 }, { scale: { a: { min: 5, max: 5 } } }),
      });
      expect(v.unevaluable).toEqual(['a']);
      expect(v.passFailStatus).toBe('failed');
    });
  });

  it('declared-unevaluable rubrics in the snapshot stay excluded', () => {
    const v = computeVerdict({
      metrics: { a: 100, b: 100, c: 100 },
      snapshot: snap({ kind: 'threshold', minScore: 0.5 }, { unevaluable: ['c'] }),
    });
    expect(v.unevaluable).toEqual(['c']);
    expect(v.passFailStatus).toBe('failed');
  });
});

describe('normalizePassPolicy', () => {
  it('defaults anything malformed to llm-verdict', () => {
    expect(normalizePassPolicy(undefined)).toEqual({ kind: 'llm-verdict' });
    expect(normalizePassPolicy(null)).toEqual({ kind: 'llm-verdict' });
    expect(normalizePassPolicy({ kind: 'threshold' })).toEqual({ kind: 'llm-verdict' });
    expect(normalizePassPolicy({ kind: 'bogus' })).toEqual({ kind: 'llm-verdict' });
  });
  it('keeps valid policies and drops malformed gate entries', () => {
    expect(normalizePassPolicy({ kind: 'threshold', minScore: 0.8 })).toEqual({ kind: 'threshold', minScore: 0.8 });
    expect(normalizePassPolicy({ kind: 'gates', gates: [{ metric: 'a', min: 1 }, { metric: 1 }, null] }))
      .toEqual({ kind: 'gates', gates: [{ metric: 'a', min: 1 }] });
  });
});

describe('scoringFieldsFromJudgment', () => {
  it('carries the engine fields and drops absent ones', () => {
    const snapshot = { evaluatorId: 'e', evaluatorVersion: 1, contentHash: 'h', weights: { a: 1 }, passPolicy: { kind: 'llm-verdict' } } as ScoringSnapshot;
    expect(scoringFieldsFromJudgment({ passFailStatus: 'passed', metrics: { a: 90 }, llmVerdict: 'passed', verdictConflict: false, score: 0.9, scoringSnapshot: snapshot }))
      .toEqual({ passFailStatus: 'passed', metrics: { a: 90 }, llmVerdict: 'passed', verdictConflict: false, score: 0.9, scoringSnapshot: snapshot });
    // Absent engine fields become explicit nulls so a re-judge can never keep
    // the previous judgement's snapshot / score / verdict via a merge.
    expect(scoringFieldsFromJudgment({ passFailStatus: 'failed', metrics: { a: 10 }, score: null }))
      .toEqual({ passFailStatus: 'failed', metrics: { a: 10 }, llmVerdict: null, verdictConflict: null, score: null, scoringSnapshot: null });
  });
});

describe('sdkSessionScoring', () => {
  const snapshot: ScoringSnapshot = { evaluatorId: 'e', evaluatorVersion: 1, contentHash: 'h', weights: { a: 1, b: 1 }, passPolicy: { kind: 'threshold', minScore: 0.5 } };
  it('returns {} without judge matchers carrying a snapshot', () => {
    expect(sdkSessionScoring([{ method: 'code-assertion' }], { a: 1 })).toEqual({});
    expect(sdkSessionScoring([{ method: 'llm-judge', errored: true, scoringSnapshot: snapshot }], { a: 1 })).toEqual({});
  });
  it('lifts the shared snapshot, recomputes the score over report metrics, and copies the single judge verdict', () => {
    const out = sdkSessionScoring(
      [{ method: 'llm-judge', scoringSnapshot: { ...snapshot, unevaluable: ['b'] }, llmVerdict: 'failed', verdictConflict: true }],
      { a: 80, b: 40 }
    );
    expect(out.scoringSnapshot).toEqual(snapshot); // per-call unevaluable dropped
    expect(out.score).toBeCloseTo(0.6, 9);
    expect(out.llmVerdict).toBe('failed');
    expect(out.verdictConflict).toBe(true);
  });
  it('marks report-level unevaluable rubrics, omits llmVerdict but keeps ANY conflict with several judge calls', () => {
    const out = sdkSessionScoring(
      [
        { method: 'llm-judge', scoringSnapshot: snapshot, llmVerdict: 'passed', verdictConflict: false },
        { method: 'llm-judge', scoringSnapshot: snapshot, llmVerdict: 'failed', verdictConflict: true },
      ],
      { a: 80 }
    );
    expect(out.scoringSnapshot?.unevaluable).toEqual(['b']);
    expect(out.llmVerdict).toBeUndefined();
    expect(out.verdictConflict).toBe(true);
  });
  it('refuses to attach one snapshot when the judge calls used different evaluator content', () => {
    expect(sdkSessionScoring(
      [{ method: 'llm-judge', scoringSnapshot: snapshot }, { method: 'llm-judge', scoringSnapshot: { ...snapshot, contentHash: 'other' } }],
      { a: 80, b: 80 }
    )).toEqual({});
  });
});
