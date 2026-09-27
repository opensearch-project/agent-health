/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic scoring engine with the `response-results` prediction source
 * and the `abstain` metric: applicability (ranked metrics ↔ gold present,
 * abstain ↔ gold explicitly empty), empty-vs-absent prediction, gates on
 * not-applicable metrics, snapshot / matcher-row provenance. Also pins that
 * `tool-hits-ordered` keeps its pilot behaviour. Generic fixture vocabulary.
 */

import type { Evaluator, TrajectoryStep } from '@/types';
import { scoreDeterministic, extractPrediction } from '@/lib/scoring/deterministicScoring';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';

const METRICS = [
  { name: 'hit@5', compute: { type: 'ranked-hit', k: 5 }, weight: 1, primary: true },
  { name: 'recall@20', compute: { type: 'ranked-recall', k: 20 }, weight: 1, primary: true },
  { name: 'abstain', compute: { type: 'abstain' }, weight: 1, primary: true },
];

const makeEvaluator = (overrides: Record<string, unknown> = {}): Evaluator =>
  ({
    id: 'eval-rr-1',
    name: 'Consumer-facing retrieval (test)',
    description: '',
    isSystem: false,
    currentVersion: 1,
    versions: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...normalizeDeterministicEvaluator({
      kind: 'deterministic',
      metrics: METRICS,
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }, { metric: 'abstain', min: 1 }] },
      inputs: {
        gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' },
        prediction: { source: 'response-results' },
      },
      ...overrides,
    }),
  }) as Evaluator;

let n = 0;
const step = (p: Partial<TrajectoryStep> & Pick<TrajectoryStep, 'type'>): TrajectoryStep => ({ id: `s${++n}`, timestamp: n, content: '', ...p }) as TrajectoryStep;
const toolHits = (...ids: string[]) => step({ type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: ids.map(id => ({ id })) }) });
const jsonAnswer = (ids: string[], extra: Record<string, unknown> = {}) =>
  step({ type: 'response', content: JSON.stringify({ answer: null, results: ids.map((id, i) => ({ id, rank: i + 1, score: 1 })), ...extra }) });

const hitRowHasNoFlag = (rows: Array<{ description: string; notApplicable?: boolean }>) =>
  rows.filter(m => !m.description.startsWith('abstain')).every(m => m.notApplicable === undefined);

const withGold = { expectedOutcomes: ['prose', 'Gold: g1, g2'] };
const noGold = { expectedOutcomes: ['prose', 'Gold: none'] };
const undeclared = { expectedOutcomes: ['prose only'] };

describe('scoreDeterministic — response-results + abstain', () => {
  it('gold present: ranked metrics score what the agent RETURNED (not what it retrieved); abstain is not applicable', () => {
    const report = { trajectory: [toolHits('g1', 'g2', 'x'), jsonAnswer(['x', 'g2'])] };
    const r = scoreDeterministic(makeEvaluator(), withGold, report);
    expect(r.prediction).toMatchObject({ rule: 'response-results', ranked: ['x', 'g2'], parsedFrom: 'json', present: true });
    expect(r.metrics).toEqual({ 'hit@5': 1, 'recall@20': 0.5 });
    expect(r.notApplicable).toEqual(['abstain']);
    expect(r.unevaluable).toEqual([]);
    // mean over the two applicable metrics only.
    expect(r.score).toBeCloseTo(0.75);
    // gate on abstain is skipped (not applicable); hit@5 gate holds → passed.
    expect(r.passFailStatus).toBe('passed');
    expect(r.failReasons).toEqual([]);
    expect(r.snapshot).toMatchObject({ extractionRule: 'response-results', extraction: { candidateCount: 2, parsedFrom: 'json' }, notApplicable: ['abstain'], unevaluable: [] });
    expect(r.snapshot.extraction).not.toHaveProperty('citedCount');
    const abstainRow = r.matcherResults.find(m => m.description.startsWith('abstain'))!;
    expect(abstainRow).toMatchObject({ pass: true, role: 'observe', notApplicable: true, actual: undefined, expected: undefined });
    expect(hitRowHasNoFlag(r.matcherResults)).toBe(true);
    expect(abstainRow.details).toMatchObject({ notApplicable: true, parsedFrom: 'json', extractionRule: 'response-results' });
    expect(abstainRow.details!.notApplicableReason).toMatch(/abstain only scores cases whose gold is explicitly empty/);
    expect(abstainRow.errored).toBeUndefined();
    const hitRow = r.matcherResults.find(m => m.description.startsWith('hit@5'))!;
    expect(hitRow).toMatchObject({ pass: true, role: 'primary', actual: 1, expected: 1 });
    expect(hitRow.details).toMatchObject({ predicted: ['x', 'g2'], parsedFrom: 'json' });
    expect(r.summary).toMatch(/1 of 2 gold ids among 2 candidates; first hit at rank 2; ranked list parsed from the response \(json\)/);
    expect(r.summary).toMatch(/not applicable: abstain/);
  });

  describe('abstain truth table through the engine', () => {
    it('gold explicitly empty + empty returned list → abstain 1, ranked metrics not applicable → passed', () => {
      const r = scoreDeterministic(makeEvaluator(), noGold, { trajectory: [toolHits('a', 'b'), jsonAnswer([], { results_source: 'abstain' })] });
      expect(r.metrics).toEqual({ abstain: 1 });
      expect(r.notApplicable).toEqual(['hit@5', 'recall@20']);
      expect(r.unevaluable).toEqual([]);
      expect(r.score).toBe(1);
      expect(r.passFailStatus).toBe('passed');
      expect(r.matcherResults.find(m => m.description.startsWith('abstain'))).toMatchObject({ pass: true, role: 'primary', actual: 1, expected: 1 });
      expect(r.matcherResults.find(m => m.description.startsWith('hit@5'))).toMatchObject({ pass: true, role: 'observe' });
      expect(r.summary).toMatch(/gold is explicitly empty; the agent returned 0 candidates/);
    });

    it('gold explicitly empty + non-empty list → abstain 0 → failed on the abstain gate', () => {
      const r = scoreDeterministic(makeEvaluator(), noGold, { trajectory: [jsonAnswer(['a'])] });
      expect(r.metrics).toEqual({ abstain: 0 });
      expect(r.passFailStatus).toBe('failed');
      expect(r.failReasons).toEqual(['gate:abstain<1']);
    });

    it('gold explicitly empty via expected.ids = [] behaves the same when the evaluator reads that field (rule recorded)', () => {
      const ev = makeEvaluator({ inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'response-results' } } });
      const r = scoreDeterministic(ev, { expected: { ids: [] }, expectedOutcomes: ['prose'] }, { trajectory: [jsonAnswer([])] });
      expect(r.metrics).toEqual({ abstain: 1 });
      expect(r.snapshot).toMatchObject({ goldRule: 'expected.ids', goldIdsUsed: [] });
      // Under the pattern source, `expected.ids: []` is NOT "no gold" — it is unset → gold undeclared.
      const r2 = scoreDeterministic(makeEvaluator(), { expected: { ids: [] }, expectedOutcomes: ['prose'] }, { trajectory: [jsonAnswer([])] });
      expect(r2.evaluable).toBe(false);
      expect(r2.goldDeclared).toBe(false);
    });

    it('gold present + empty returned list → ranked metrics 0 (a real outcome), abstain not applicable → failed on the gate', () => {
      const r = scoreDeterministic(makeEvaluator(), withGold, { trajectory: [toolHits('g1'), jsonAnswer([])] });
      expect(r.metrics).toEqual({ 'hit@5': 0, 'recall@20': 0 });
      expect(r.unevaluable).toEqual([]);
      expect(r.notApplicable).toEqual(['abstain']);
      expect(r.passFailStatus).toBe('failed');
      expect(r.failReasons).toEqual(['gate:hit@5<1']);
    });

    it('gold present + a response with NO recognisable list → unevaluable (a parser miss is never scored as 0)', () => {
      const r = scoreDeterministic(makeEvaluator(), withGold, { trajectory: [step({ type: 'response', content: 'Nothing relevant found.' })] });
      expect(r.evaluable).toBe(false);
      expect(r.passFailStatus).toBeNull();
      expect(r.metrics).toEqual({});
      expect(r.unevaluable).toEqual(['hit@5', 'recall@20', 'abstain']);
      expect(r.snapshot.extraction).toEqual({ candidateCount: 0, parsedFrom: 'none' });
      expect(r.matcherResults[0].errorMessage).toMatch(/no ranked list recognised in the final response .*an explicit empty list scores as an abstention/);
      expect(r.summary).toMatch(/Not evaluable: no ranked list recognised/);
    });

    it('a gates policy whose every gate is not applicable to the case → NO verdict (never a silent pass)', () => {
      // Only ranked gates; gold-empty case with abstain declared as observe-only.
      const ev = makeEvaluator({ passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }] } });
      const r = scoreDeterministic(ev, noGold, { trajectory: [jsonAnswer([])] });
      expect(r.metrics).toEqual({ abstain: 1 }); // observed, but…
      expect(r.evaluable).toBe(false);
      expect(r.passFailStatus).toBeNull();
      expect(r.notApplicable).toEqual(['hit@5', 'recall@20']);
      expect(r.summary).toMatch(/none of the pass-policy gates applies to this case .*observed abstain=1\. Add a gate on a metric that speaks to gold-empty cases/);
      // Conversely an abstain-only gate on a gold case has no applicable gate either.
      const ev2 = makeEvaluator({ passPolicy: { kind: 'gates', gates: [{ metric: 'abstain', min: 1 }] } });
      const r2 = scoreDeterministic(ev2, withGold, { trajectory: [jsonAnswer(['g1'])] });
      expect(r2.passFailStatus).toBeNull();
      expect(r2.summary).toMatch(/speaks to cases with gold ids/);
    });

    it('gold NOT declared → every metric unevaluable, not a verdict (never an abstain credit)', () => {
      const r = scoreDeterministic(makeEvaluator(), undeclared, { trajectory: [jsonAnswer([])] });
      expect(r.evaluable).toBe(false);
      expect(r.passFailStatus).toBeNull();
      expect(r.metrics).toEqual({});
      expect(r.unevaluable).toEqual(['hit@5', 'recall@20', 'abstain']);
      expect(r.notApplicable).toEqual([]);
      expect(r.goldDeclared).toBe(false);
      expect(r.summary).toMatch(/Not evaluable: no gold ids on the test case/);
      expect(r.matcherResults.every(m => m.errored === true && m.pass === false)).toBe(true);
    });

    it('no final response step at all → absent prediction → every metric unevaluable (an abstaining agent is indistinguishable from a crashed one)', () => {
      const r = scoreDeterministic(makeEvaluator(), noGold, { trajectory: [toolHits('a')] });
      expect(r.evaluable).toBe(false);
      expect(r.passFailStatus).toBeNull();
      expect(r.unevaluable).toEqual(['hit@5', 'recall@20', 'abstain']);
      expect(r.prediction.present).toBe(false);
      expect(r.summary).toMatch(/Not evaluable: no final response step in the stored trajectory \(rule: response-results\)/);
      expect(r.matcherResults[0].errorMessage).toMatch(/no final response step/);
    });
  });

  it('no applicable metric (ranked-only evaluator on an explicitly gold-empty case) → not evaluable with a specific reason', () => {
    const ev = makeEvaluator({ metrics: METRICS.slice(0, 2), passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }] } });
    const r = scoreDeterministic(ev, noGold, { trajectory: [jsonAnswer([])] });
    expect(r.evaluable).toBe(false);
    expect(r.passFailStatus).toBeNull();
    expect(r.notApplicable).toEqual(['hit@5', 'recall@20']);
    expect(r.unevaluable).toEqual([]);
    expect(r.summary).toMatch(/no metric applies to this case \(gold is explicitly empty and the evaluator declares no abstain metric\)/);
    const evAbstainOnly = makeEvaluator({ metrics: [METRICS[2]], passPolicy: { kind: 'threshold', minScore: 1 } });
    const r2 = scoreDeterministic(evAbstainOnly, withGold, { trajectory: [jsonAnswer(['g1'])] });
    expect(r2.passFailStatus).toBeNull();
    expect(r2.summary).toMatch(/declares only abstain metrics and this case has gold ids/);
  });

  it('threshold policy averages only the applicable metrics', () => {
    const ev = makeEvaluator({ passPolicy: { kind: 'threshold', minScore: 0.6 } });
    // hit@5 1, recall 0.5 → 0.75 ≥ 0.6 → passed, abstain excluded.
    expect(scoreDeterministic(ev, withGold, { trajectory: [jsonAnswer(['g1', 'x'])] })).toMatchObject({ score: 0.75, passFailStatus: 'passed' });
    // gold-empty + abstained → abstain 1 → passed
    expect(scoreDeterministic(ev, noGold, { trajectory: [jsonAnswer([])] })).toMatchObject({ score: 1, passFailStatus: 'passed' });
  });

  it('honours path / idField / rankField from the evaluator inputs', () => {
    const ev = makeEvaluator({
      inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' }, prediction: { source: 'response-results', path: 'data.recs', idField: 'doc_id', rankField: 'pos' } },
    });
    const content = JSON.stringify({ data: { recs: [{ doc_id: 'x', pos: 2 }, { doc_id: 'g1', pos: 1 }] } });
    const r = scoreDeterministic(ev, withGold, { trajectory: [step({ type: 'response', content })] });
    expect(r.prediction.ranked).toEqual(['g1', 'x']);
    expect(r.metrics).toEqual({ 'hit@5': 1, 'recall@20': 0.5 });
  });

  it('reads a non-streaming connector raw payload when the response step is a rendering', () => {
    const rawEvents = [{ answer: null, results: [{ id: 'g2', rank: 1 }, { id: 'z', rank: 2 }], results_source: 'return_results' }];
    const r = scoreDeterministic(makeEvaluator(), withGold, {
      trajectory: [step({ type: 'response', content: 'Ranked results (2):\n1. id g2 — item\n2. id z — item' })],
      rawEvents,
    });
    expect(r.prediction).toMatchObject({ ranked: ['g2', 'z'], parsedFrom: 'raw-event' });
    expect(r.snapshot.extraction).toEqual({ candidateCount: 2, parsedFrom: 'raw-event' });
  });
});

describe('scoreDeterministic — tool-hits-ordered keeps its pilot behaviour', () => {
  const toolEv = (metrics = METRICS.slice(0, 2)) =>
    makeEvaluator({
      metrics,
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }] },
      inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' }, prediction: { source: 'tool-hits-ordered' } },
    });

  it('no candidates in the stored tool results → ranked metrics unevaluable (NOT zero), snapshot keeps citedCount / anchorsRemoved', () => {
    const r = scoreDeterministic(toolEv(), withGold, { trajectory: [step({ type: 'response', content: 'nothing' })] });
    expect(r.evaluable).toBe(false);
    expect(r.unevaluable).toEqual(['hit@5', 'recall@20']);
    expect(r.matcherResults[0].errorMessage).toMatch(/no candidate ids found in the stored tool results \(rule: tool-hits-ordered\)/);
    const ok = scoreDeterministic(toolEv(), withGold, { trajectory: [toolHits('g1')] });
    expect(ok.snapshot.extraction).toEqual({ candidateCount: 1, citedCount: 0, anchorsRemoved: 0 });
    expect(ok.matcherResults[0].details).not.toHaveProperty('parsedFrom');
    expect(ok.snapshot).not.toHaveProperty('notApplicable');
  });

  it('empty trajectory → absent prediction → unevaluable even for abstain on a gold-empty case', () => {
    const r = scoreDeterministic(toolEv(METRICS), noGold, { trajectory: [] });
    expect(r.evaluable).toBe(false);
    expect(r.unevaluable).toEqual(['hit@5', 'recall@20', 'abstain']);
  });

  it('abstain with tool-hits-ordered (stored before the validator forbade it) is UNEVALUABLE, never a fake abstention credit', () => {
    const r = scoreDeterministic(toolEv(METRICS), noGold, { trajectory: [step({ type: 'response', content: 'Best match: (id: 77).' })] });
    expect(r.metrics).toEqual({});
    expect(r.unevaluable).toEqual(['abstain']);
    expect(r.notApplicable).toEqual(['hit@5', 'recall@20']);
    expect(r.passFailStatus).toBeNull();
    expect(r.matcherResults.find(m => m.description.startsWith('abstain'))!.errorMessage).toMatch(/abstain cannot be observed through tool-hits-ordered/);
  });

  it('extractPrediction dispatches by source', () => {
    const report = { trajectory: [toolHits('t1'), jsonAnswer(['r1'])] };
    expect(extractPrediction(report, { source: 'tool-hits-ordered' })).toMatchObject({ rule: 'tool-hits-ordered', ranked: ['t1'], present: true });
    expect(extractPrediction(report, { source: 'response-results' })).toMatchObject({ rule: 'response-results', ranked: ['r1'], present: true });
  });
});
