/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic scoring engine: scale normalization, weights, gates,
 * threshold, unevaluable semantics (some vs all), snapshot fields and the
 * matcher rows the Judge tab renders. Generic fixture vocabulary only.
 */

import type { Evaluator, TrajectoryStep } from '@/types';
import { scoreDeterministic, deterministicContentHash, MATCHER_ID_LIST_LIMIT } from '@/lib/scoring/deterministicScoring';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';

const makeEvaluator = (overrides: Partial<Evaluator> = {}): Evaluator =>
  ({
    id: 'eval-det-1',
    name: 'Ranked retrieval (test)',
    description: '',
    isSystem: false,
    currentVersion: 3,
    versions: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...normalizeDeterministicEvaluator({
      kind: 'deterministic',
      metrics: [
        { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true },
        { name: 'recall@3', compute: { type: 'ranked-recall', k: 3 }, weight: 2, primary: true },
        { name: 'mrr_pct', compute: { type: 'mrr' }, weight: 1, scale: { min: 0, max: 100 } },
      ],
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
      inputs: {
        gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' },
        prediction: { source: 'tool-hits-ordered', anchorTools: [{ tool: 'expand', argKey: 'seed' }] },
      },
    }),
    ...overrides,
  }) as Evaluator;

let n = 0;
const step = (p: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'type'>): TrajectoryStep => ({ id: `s${++n}`, timestamp: n, content: '', ...p }) as TrajectoryStep;
const hitsResult = (...ids: string[]) => step({ type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: ids.map(id => ({ id })) }) });

const testCase = { expectedOutcomes: ['The agent finds the right items', 'Gold: g1, g2'] };

describe('scoreDeterministic', () => {
  it('computes metrics in their own scale, weighted mean over normalized values, gates → verdict', () => {
    // ranked: cited g2 first, then g1, x. hit@1 = 0 (g2 is gold → 1 actually). Let's pin exact values.
    const report = { trajectory: [hitsResult('x', 'g1', 'y'), step({ type: 'response', content: 'Answer: (id: g1)' })] };
    const r = scoreDeterministic(makeEvaluator(), testCase, report);
    // ranked = ['g1', 'x', 'y']  → hit@1 = 1, recall@3 = 1/2, mrr = 1 → 100 on the 0–100 scale
    expect(r.evaluable).toBe(true);
    expect(r.metrics).toEqual({ 'hit@1': 1, 'recall@3': 0.5, mrr_pct: 100 });
    // weighted mean of normalized values: (1*1 + 2*0.5 + 1*1) / 4 = 0.75
    expect(r.score).toBeCloseTo(0.75);
    expect(r.passFailStatus).toBe('passed');
    expect(r.failReasons).toEqual([]);
    expect(r.unevaluable).toEqual([]);

    // Snapshot.
    expect(r.snapshot).toMatchObject({
      evaluatorId: 'eval-det-1',
      evaluatorVersion: 3,
      evaluatorName: 'Ranked retrieval (test)',
      weights: { 'hit@1': 1, 'recall@3': 2, mrr_pct: 1 },
      scale: { 'hit@1': { min: 0, max: 1 }, 'recall@3': { min: 0, max: 1 }, mrr_pct: { min: 0, max: 100 } },
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
      primaryMetrics: ['hit@1', 'recall@3'],
      goldIdsUsed: ['g1', 'g2'],
      goldRule: 'expected-outcomes-pattern',
      extractionRule: 'tool-hits-ordered',
      extraction: { candidateCount: 3, citedCount: 1, anchorsRemoved: 0 },
      unevaluable: [],
    });
    expect(r.snapshot.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.snapshot.contentHash).toBe(deterministicContentHash(makeEvaluator()));

    // Matcher rows: one per metric, gate row is `primary`, others `observe`, details carry gold/predicted.
    expect(r.matcherResults).toHaveLength(3);
    const [hit, recall, m] = r.matcherResults;
    expect(hit).toMatchObject({ description: 'hit@1 (ranked-hit@1) ≥ 1', pass: true, method: 'code-assertion', role: 'primary', actual: 1, expected: 1, score: 1 });
    expect(hit.details).toEqual({ gold: ['g1', 'g2'], goldTotal: 2, predicted: ['g1', 'x', 'y'], predictedTotal: 3, k: 1, extractionRule: 'tool-hits-ordered' });
    expect(recall).toMatchObject({ description: 'recall@3 (ranked-recall@3)', pass: true, role: 'observe', actual: 0.5, score: 0.5 });
    expect(recall.expected).toBeUndefined();
    expect(m).toMatchObject({ role: 'observe', actual: 100, score: 1 });
    expect((m.details as any).k).toBeUndefined();

    expect(r.summary).toMatch(/^Deterministic scoring: 1 of 2 gold ids among 3 candidates; first hit at rank 1; 1 cited in the answer\. hit@1=1, recall@3=0\.5, mrr_pct=100\. Verdict passed\.$/);
  });

  it('a failed gate fails the verdict with a gate reason; the gate row shows pass=false', () => {
    const report = { trajectory: [hitsResult('x', 'y', 'g2')] };
    const r = scoreDeterministic(makeEvaluator(), testCase, report);
    expect(r.metrics['hit@1']).toBe(0);
    expect(r.metrics['recall@3']).toBe(0.5);
    expect(r.metrics.mrr_pct).toBeCloseTo(100 / 3, 6);
    expect(r.passFailStatus).toBe('failed');
    expect(r.failReasons).toEqual(['gate:hit@1<1']);
    expect(r.matcherResults[0]).toMatchObject({ pass: false, role: 'primary' });
    expect(r.matcherResults[1]).toMatchObject({ pass: true, role: 'observe' });
    expect(r.summary).toContain('Verdict failed (gate:hit@1<1)');
  });

  it('threshold policy: pass iff weighted normalized score ≥ minScore', () => {
    const report = { trajectory: [hitsResult('x', 'y', 'g2')] }; // score = (0 + 2*0.5 + 1/3)/4 = 1/3
    const pass = scoreDeterministic(makeEvaluator({ passPolicy: { kind: 'threshold', minScore: 0.3 } }), testCase, report);
    expect(pass.score).toBeCloseTo(1 / 3);
    expect(pass.passFailStatus).toBe('passed');
    expect(pass.matcherResults.every(m => m.role === 'observe')).toBe(true);
    const fail = scoreDeterministic(makeEvaluator({ passPolicy: { kind: 'threshold', minScore: 0.5 } }), testCase, report);
    expect(fail.passFailStatus).toBe('failed');
    expect(fail.failReasons).toEqual(['threshold:0.333<0.5']);
  });

  it('structured expected.ids wins over the pattern and is recorded as the gold rule', () => {
    const r = scoreDeterministic(makeEvaluator(), { expected: { ids: ['x'] }, expectedOutcomes: ['Gold: g1'] }, { trajectory: [hitsResult('x')] });
    expect(r.snapshot.goldRule).toBe('expected.ids');
    expect(r.snapshot.goldIdsUsed).toEqual(['x']);
    expect(r.passFailStatus).toBe('passed');
  });

  it('anchors are removed before scoring and counted in the snapshot', () => {
    const trajectory = [
      step({ type: 'action', toolName: 'expand', toolArgs: { seed: ['g1'] } }),
      hitsResult('g1', 'g2', 'z'),
    ];
    const r = scoreDeterministic(makeEvaluator(), testCase, { trajectory });
    expect(r.prediction.ranked).toEqual(['g2', 'z']);
    expect(r.snapshot.extraction).toEqual({ candidateCount: 3, citedCount: 0, anchorsRemoved: 1 });
    expect(r.metrics['hit@1']).toBe(1);
  });

  it('ALL metrics unevaluable (no gold) → not evaluable: no verdict, no metrics, errored matcher rows', () => {
    const r = scoreDeterministic(makeEvaluator(), { expectedOutcomes: ['no gold line'] }, { trajectory: [hitsResult('a')] });
    expect(r.evaluable).toBe(false);
    expect(r.passFailStatus).toBeNull();
    expect(r.score).toBeNull();
    expect(r.metrics).toEqual({});
    expect(r.unevaluable).toEqual(['hit@1', 'recall@3', 'mrr_pct']);
    expect(r.failReasons).toEqual(['unevaluable:hit@1', 'unevaluable:recall@3', 'unevaluable:mrr_pct']);
    expect(r.snapshot.goldRule).toBeUndefined();
    expect(r.snapshot.goldIdsUsed).toEqual([]);
    expect(r.snapshot.unevaluable).toEqual(['hit@1', 'recall@3', 'mrr_pct']);
    expect(r.matcherResults.every(m => m.errored === true && m.pass === false && m.score === undefined && m.actual === undefined)).toBe(true);
    expect(r.matcherResults[0].errorMessage).toMatch(/no gold ids on the test case/);
    expect(r.summary).toMatch(/^Not evaluable: no gold ids/);
  });

  it('ALL metrics unevaluable (no candidates) → not evaluable with an extraction-specific reason', () => {
    const none = scoreDeterministic(makeEvaluator(), testCase, { trajectory: [step({ type: 'response', content: 'I could not find anything' })] });
    expect(none.evaluable).toBe(false);
    expect(none.matcherResults[0].errorMessage).toMatch(/no candidate ids found in the stored tool results \(rule: tool-hits-ordered\)/);
    const anchorsOnly = scoreDeterministic(makeEvaluator(), testCase, {
      trajectory: [step({ type: 'action', toolName: 'expand', toolArgs: { seed: 'g1' } }), hitsResult('g1')],
    });
    expect(anchorsOnly.evaluable).toBe(false);
    expect(anchorsOnly.matcherResults[0].errorMessage).toMatch(/every retrieved id was an anchor \(1 removed\)/);
    expect(anchorsOnly.summary).toMatch(/^Not evaluable: every retrieved id was an anchor/);
  });

  it('passing path carries no stray fail reasons (the unevaluable:<metric> reason is only ever emitted for unevaluable metrics)', () => {
    const r = scoreDeterministic(makeEvaluator(), testCase, { trajectory: [hitsResult('g1')] });
    expect(r.unevaluable).toEqual([]);
    expect(r.failReasons).toEqual([]);
    expect(r.passFailStatus).toBe('passed');
  });

  it('truncates gold/predicted lists on matcher rows to MATCHER_ID_LIST_LIMIT but keeps totals', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const goldIds = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const r = scoreDeterministic(makeEvaluator(), { expected: { ids: goldIds } }, { trajectory: [hitsResult(...ids)] });
    const d = r.matcherResults[0].details as any;
    expect(d.gold).toHaveLength(MATCHER_ID_LIST_LIMIT);
    expect(d.goldTotal).toBe(25);
    expect(d.predicted).toHaveLength(MATCHER_ID_LIST_LIMIT);
    expect(d.predictedTotal).toBe(30);
  });

  it('refuses a non-deterministic evaluator', () => {
    expect(() => scoreDeterministic({ ...makeEvaluator(), kind: 'llm' } as Evaluator, testCase, { trajectory: [] })).toThrow(/not a valid deterministic evaluator/);
  });

  it('contentHash changes when the scoring-relevant parts change and ignores the name', () => {
    const base = deterministicContentHash(makeEvaluator());
    expect(deterministicContentHash(makeEvaluator({ name: 'renamed' }))).toBe(base);
    expect(deterministicContentHash(makeEvaluator({ passPolicy: { kind: 'threshold', minScore: 0.5 } }))).not.toBe(base);
  });
});
