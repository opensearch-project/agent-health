/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `computeSdkMatcherSessionMetrics`.
 *
 * This helper computes the report-level `metrics` shim for SDK matcher-session
 * runs (.bench.js / .eval.js with a code body). Pre-fix the runner inlined a
 * hardcoded `{0,0,0,0} / {100,100,100,100}` regardless of how many matchers
 * actually passed, which flattened partial credit AND silently dropped any
 * per-matcher dimensional metrics a custom evaluator might emit.
 *
 * The helper is the regression boundary: as long as these tests pass, the
 * report-level metrics on every SDK run reflect the actual matcher outcomes.
 */

import { computeSdkMatcherSessionMetrics } from '@/services/evaluation';
import type { MatcherResult } from '@/lib/matchers/types';

const m = (overrides: Partial<MatcherResult>): MatcherResult => ({
  description: overrides.description ?? 'matcher',
  pass: overrides.pass ?? true,
  method: overrides.method ?? 'code-assertion',
  ...overrides,
});

describe('computeSdkMatcherSessionMetrics', () => {
  // A body that never called judge() is a deterministic case (skipJudge,
  // judgeProvider 'none'): the four legacy keys are the RCA judge's rubric
  // and must not be fabricated for it — `{}` so the UI shows no score, only
  // the verdict and the matcher rows.
  describe('no LLM judge call in the body → no metrics (never the {100,100,100,100} placeholder)', () => {
    it('empty matcher results → {}', () => {
      expect(computeSdkMatcherSessionMetrics([])).toEqual({});
    });

    it('code assertions only, all passing → {} (not accuracy: 100)', () => {
      expect(computeSdkMatcherSessionMetrics([m({ pass: true }), m({ pass: true }), m({ pass: true })])).toEqual({});
      expect(computeSdkMatcherSessionMetrics([m({ pass: true }), m({ pass: true })])).not.toHaveProperty('accuracy');
    });

    it('code assertions only, some failing → {} (the verdict is passFailStatus, not a fake accuracy)', () => {
      expect(computeSdkMatcherSessionMetrics([m({ pass: true }), m({ pass: false })])).toEqual({});
    });

    it('observe-only / errored / notReached-only sessions → {}', () => {
      expect(computeSdkMatcherSessionMetrics([m({ pass: true, role: 'observe' }), m({ pass: false, role: 'observe' })])).toEqual({});
      expect(computeSdkMatcherSessionMetrics([m({ pass: false, errored: true })])).toEqual({});
    });

    it('a skipped or not-reached judge() does not count as a judge call', () => {
      expect(computeSdkMatcherSessionMetrics([m({ pass: true, method: 'llm-judge', skipped: true })])).toEqual({});
      expect(computeSdkMatcherSessionMetrics([m({ pass: true }), m({ pass: false, method: 'llm-judge', notReached: true })])).toEqual({});
    });

    it('body threw but no judge ran → {} (not {0,0,0,0})', () => {
      expect(computeSdkMatcherSessionMetrics([m({ pass: true })], { hasEvalError: true })).toEqual({});
    });
  });

  const j = (overrides: Partial<MatcherResult>): MatcherResult => m({ method: 'llm-judge', ...overrides });

  it('returns hard 0s when the bench body itself threw after judging (evalError bypass)', () => {
    // Even if every judged claim passed, an evalError means the body never
    // reached its conclusion — the run never produced a verdict to grade.
    expect(
      computeSdkMatcherSessionMetrics(
        [j({ pass: true }), j({ pass: true })],
        { hasEvalError: true },
      ),
    ).toEqual({
      accuracy: 0,
      faithfulness: 0,
      latency_score: 0,
      trajectory_alignment_score: 0,
    });
  });

  it('returns 100 across all four legacy keys when every judged gate passes', () => {
    expect(
      computeSdkMatcherSessionMetrics([
        j({ pass: true }),
        j({ pass: true }),
        j({ pass: true }),
      ]),
    ).toEqual({
      accuracy: 100,
      faithfulness: 100,
      latency_score: 100,
      trajectory_alignment_score: 100,
    });
  });

  // The headline regression: a 4-of-6 passing run must NOT show 0 (pre-fix
  // behavior). It must show 67 — the proportion of passing gate matchers.
  it('reflects partial credit (4-of-6 passing judged claims → accuracy 67, not 0)', () => {
    const res = computeSdkMatcherSessionMetrics([
      j({ pass: true }),
      j({ pass: true }),
      j({ pass: true }),
      j({ pass: true }),
      j({ pass: false }),
      j({ pass: false }),
    ]);
    expect(res.accuracy).toBe(67);
    expect(res.faithfulness).toBe(67);
    expect(res.latency_score).toBe(67);
    expect(res.trajectory_alignment_score).toBe(67);
  });

  it('code assertions count as gates alongside judged claims (1 judge pass + 1 code fail → 50)', () => {
    expect(computeSdkMatcherSessionMetrics([j({ pass: true }), m({ pass: false })]).accuracy).toBe(50);
  });

  it('excludes observe-role matchers from the denominator (RFC 004 §4.8)', () => {
    // 1 passing gate + 1 failing observe → gates = [pass:true] → 100, not 50.
    const res = computeSdkMatcherSessionMetrics([
      j({ pass: true, role: 'gate' }),
      j({ pass: false, role: 'observe' }),
    ]);
    expect(res.accuracy).toBe(100);
  });

  it('excludes errored matchers from the denominator', () => {
    // 1 passing gate + 1 errored → gates = [pass:true] → 100, not 50.
    const res = computeSdkMatcherSessionMetrics([
      j({ pass: true }),
      j({ pass: false, errored: true }),
    ]);
    expect(res.accuracy).toBe(100);
  });

  // Dimensional pass-through — the second part of the fix. A custom
  // 9-dimension RCA evaluator emits per-matcher
  // `judgeMetrics` like `{routing_accuracy, tool_correctness, ...}`. Each
  // dimension's MEAN across emitting gates becomes report-level metric.
  it('passes through per-matcher judgeMetrics dimensions as mean-aggregated keys', () => {
    const res = computeSdkMatcherSessionMetrics([
      m({
        pass: true,
        method: 'llm-judge',
        judgeMetrics: { routing_accuracy: 90, tool_correctness: 80, diagnostic_completeness: 70 } as any,
      }),
      m({
        pass: true,
        method: 'llm-judge',
        judgeMetrics: { routing_accuracy: 70, tool_correctness: 60, diagnostic_completeness: 50 } as any,
      }),
    ]);
    expect(res.routing_accuracy).toBe(80);        // (90 + 70) / 2
    expect(res.tool_correctness).toBe(70);        // (80 + 60) / 2
    expect(res.diagnostic_completeness).toBe(60); // (70 + 50) / 2
    // Legacy keys still present (BC) — pass-rate aggregate.
    expect(res.accuracy).toBe(100);
  });

  it('dimensional pass-through tolerates partial coverage (some matchers omit a dimension)', () => {
    const res = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge', judgeMetrics: { routing_accuracy: 80 } as any }),
      m({ pass: true, method: 'llm-judge', judgeMetrics: { tool_correctness: 60 } as any }),
      m({ pass: true, method: 'llm-judge', judgeMetrics: { routing_accuracy: 100 } as any }),
    ]);
    // routing_accuracy mean over the 2 emitting matchers: (80 + 100) / 2 = 90.
    expect(res.routing_accuracy).toBe(90);
    // tool_correctness mean over the 1 emitting matcher: 60.
    expect(res.tool_correctness).toBe(60);
  });

  it('dimensional values override the BC stub for the same key', () => {
    // Single matcher with judgeMetrics.accuracy=42; pass-rate = 100. The
    // dimensional value wins for `accuracy` (and only for that key).
    const res = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge', judgeMetrics: { accuracy: 42 } as any }),
    ]);
    expect(res.accuracy).toBe(42);                  // dimensional wins
    expect(res.faithfulness).toBe(100);             // BC stub still in effect
    expect(res.latency_score).toBe(100);
    expect(res.trajectory_alignment_score).toBe(100);
  });

  it('ignores non-finite or non-number dimension values', () => {
    const res = computeSdkMatcherSessionMetrics([
      m({
        pass: true,
        method: 'llm-judge',
        judgeMetrics: {
          routing_accuracy: 80,
          tool_correctness: NaN,
          diagnostic_completeness: undefined,
          calibration: 'high' as any,
        } as any,
      }),
    ]);
    expect(res.routing_accuracy).toBe(80);
    expect((res as any).tool_correctness).toBeUndefined();
    expect((res as any).diagnostic_completeness).toBeUndefined();
    expect((res as any).calibration).toBeUndefined();
  });

  it('rounds dimensional means to integer (matches the legacy 0..100 scale)', () => {
    const res = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge', judgeMetrics: { calibration: 70 } as any }),
      m({ pass: true, method: 'llm-judge', judgeMetrics: { calibration: 71 } as any }),
      m({ pass: true, method: 'llm-judge', judgeMetrics: { calibration: 71 } as any }),
    ]);
    expect(res.calibration).toBe(71); // 70.666… → 71
  });

  it('observe matchers do NOT contribute to dimensional means either', () => {
    const res = computeSdkMatcherSessionMetrics([
      m({ pass: true, method: 'llm-judge', judgeMetrics: { routing_accuracy: 80 } as any, role: 'gate' }),
      m({ pass: true, method: 'llm-judge', judgeMetrics: { routing_accuracy: 0 } as any, role: 'observe' }),
    ]);
    expect(res.routing_accuracy).toBe(80); // observe ignored
  });
});
