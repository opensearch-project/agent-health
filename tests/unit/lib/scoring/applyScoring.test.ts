/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  applyScoring,
  applyScoringToJudgeResponse,
  buildScoringSnapshot,
  evaluatorContentHash,
} from '@/lib/scoring/applyScoring';
import { validateScoringConfig } from '@/lib/scoring/validateScoringConfig';
import type { Evaluator } from '@/types';

function evaluator(overrides: Partial<Evaluator> = {}, scoring: Partial<Evaluator['scoringConfig']> = {}): Evaluator {
  const now = '2026-01-01T00:00:00.000Z';
  const scoringConfig = {
    metrics: [
      { name: 'relevance', weight: 0.6, scale: 100 },
      { name: 'grounding', weight: 0.4, scale: 100 },
    ],
    passThreshold: 70,
    scale: 100,
    ...scoring,
  };
  return {
    id: 'eval-demo',
    name: 'Demo evaluator',
    description: '',
    isSystem: false,
    currentVersion: 1,
    versions: [],
    createdAt: now,
    updatedAt: now,
    systemPrompt: 'judge it',
    scoringConfig,
    inferenceConfig: {},
    ...overrides,
  } as Evaluator;
}

describe('evaluatorContentHash / buildScoringSnapshot — determinism', () => {
  it('same evaluator content → same hash; metric order and key order do not matter', () => {
    const a = evaluator();
    const b = evaluator({}, { metrics: [...a.scoringConfig.metrics].reverse() });
    expect(evaluatorContentHash(a)).toBe(evaluatorContentHash(b));
    expect(evaluatorContentHash(a)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('an absent passPolicy hashes identically to an explicit llm-verdict (the default)', () => {
    expect(evaluatorContentHash(evaluator())).toBe(evaluatorContentHash(evaluator({}, { passPolicy: { kind: 'llm-verdict' } })));
  });

  it.each([
    ['weight', { metrics: [{ name: 'relevance', weight: 0.7, scale: 100 }, { name: 'grounding', weight: 0.3, scale: 100 }] }],
    ['scale', { metrics: [{ name: 'relevance', weight: 0.6, scale: 10 }, { name: 'grounding', weight: 0.4, scale: 100 }] }],
    ['passPolicy', { passPolicy: { kind: 'threshold', minScore: 0.7 } }],
    ['primaryMetrics', { primaryMetrics: ['relevance'] }],
  ] as const)('a %s change produces a new hash', (_label, scoring) => {
    expect(evaluatorContentHash(evaluator({}, scoring as any))).not.toBe(evaluatorContentHash(evaluator()));
  });

  it('a prompt change produces a new hash', () => {
    expect(evaluatorContentHash(evaluator({ systemPrompt: 'judge it harder' }))).not.toBe(evaluatorContentHash(evaluator()));
  });

  it('metadata (name / description / id / version) does not affect the hash', () => {
    expect(evaluatorContentHash(evaluator({ id: 'x', name: 'Y', description: 'z', currentVersion: 9 }))).toBe(evaluatorContentHash(evaluator()));
  });

  it('freezes weights, per-metric scales, policy and identity', () => {
    const snap = buildScoringSnapshot(evaluator({}, { passPolicy: { kind: 'threshold', minScore: 0.7 }, primaryMetrics: ['grounding'] }), {
      judgeModelId: 'judge-model-1',
      unevaluable: ['grounding'],
    });
    expect(snap).toEqual({
      evaluatorId: 'eval-demo',
      evaluatorVersion: 1,
      contentHash: expect.stringMatching(/^sha256:/),
      evaluatorName: 'Demo evaluator',
      weights: { grounding: 0.4, relevance: 0.6 },
      scale: { grounding: { min: 0, max: 100 }, relevance: { min: 0, max: 100 } },
      passPolicy: { kind: 'threshold', minScore: 0.7 },
      primaryMetrics: ['grounding'],
      judgeModelId: 'judge-model-1',
      unevaluable: ['grounding'],
    });
  });
});

describe('applyScoring (metrics, evaluator, llmVerdict?)', () => {
  it('llm-verdict evaluator: verdict is the LLM\'s, snapshot still written, score computed', () => {
    const r = applyScoring({ relevance: 40, grounding: 40 }, evaluator(), 'passed', { judgeModelId: 'm' });
    expect(r.passFailStatus).toBe('passed');
    expect(r.llmVerdict).toBe('passed');
    expect(r.verdictConflict).toBe(false);
    expect(r.score).toBeCloseTo(0.4, 9);
    expect(r.scoringSnapshot.passPolicy).toEqual({ kind: 'llm-verdict' });
    expect(r.scoringSnapshot.judgeModelId).toBe('m');
  });

  it('threshold evaluator: computed verdict wins, LLM verdict kept, conflict flagged', () => {
    const r = applyScoring({ relevance: 60, grounding: 60 }, evaluator({}, { passPolicy: { kind: 'threshold', minScore: 0.7 } }), 'passed');
    expect(r.passFailStatus).toBe('failed');
    expect(r.llmVerdict).toBe('passed');
    expect(r.verdictConflict).toBe(true);
    expect(r.score).toBeCloseTo(0.6, 9);
  });

  it('is callable without an LLM verdict (deterministic scoring) and records the unevaluable rubric', () => {
    const r = applyScoring({ relevance: 90 }, evaluator({}, { passPolicy: { kind: 'threshold', minScore: 0.5 } }));
    expect(r.llmVerdict).toBeUndefined();
    expect(r.verdictConflict).toBe(false);
    expect(r.scoringSnapshot.unevaluable).toEqual(['grounding']);
    expect(r.passFailStatus).toBe('failed'); // unevaluable never silently passes
  });

  it('never writes a 0 for a rubric the judge did not return', () => {
    const r = applyScoring({ relevance: 90 }, evaluator());
    expect(r.score).toBeCloseTo(0.9, 9);
    expect(r.scoringSnapshot.unevaluable).toEqual(['grounding']);
  });
});

describe('applyScoringToJudgeResponse', () => {
  it('moves the parsed pass_fail_status to llmVerdict and stamps the engine verdict + snapshot', () => {
    const out = applyScoringToJudgeResponse(
      { passFailStatus: 'passed', metrics: { relevance: 50, grounding: 50 }, llmJudgeReasoning: 'r' },
      evaluator({}, { passPolicy: { kind: 'threshold', minScore: 0.7 } }),
      'resolved-judge'
    );
    expect(out.passFailStatus).toBe('failed');
    expect(out.llmVerdict).toBe('passed');
    expect(out.verdictConflict).toBe(true);
    expect(out.score).toBeCloseTo(0.5, 9);
    expect(out.scoringSnapshot?.judgeModelId).toBe('resolved-judge');
    expect(out.metrics).toEqual({ relevance: 50, grounding: 50 }); // untouched
    expect(out.llmJudgeReasoning).toBe('r');
  });

  it('prefers the judgeDebug model id (what actually ran) over the resolved id', () => {
    const out = applyScoringToJudgeResponse(
      { passFailStatus: 'passed', metrics: {}, judgeDebug: { modelId: 'actual/model' } },
      evaluator(),
      'resolved-judge'
    );
    expect(out.scoringSnapshot?.judgeModelId).toBe('actual/model');
    expect(out.score).toBeUndefined(); // nothing scorable → no fabricated number
    expect(out.scoringSnapshot?.unevaluable).toEqual(['grounding', 'relevance']); // canonical (name-sorted) order
  });
});

describe('validateScoringConfig', () => {
  const ok = { metrics: [{ name: 'a', weight: 1, scale: 100 }, { name: 'b', weight: 2, scale: 5 }], passThreshold: 70, scale: 100 };

  it('accepts a plain config and every valid policy', () => {
    expect(validateScoringConfig(ok)).toBeNull();
    expect(validateScoringConfig({ ...ok, passPolicy: { kind: 'llm-verdict' } })).toBeNull();
    expect(validateScoringConfig({ ...ok, passPolicy: { kind: 'threshold', minScore: 0 } })).toBeNull();
    expect(validateScoringConfig({ ...ok, passPolicy: { kind: 'threshold', minScore: 1 } })).toBeNull();
    expect(validateScoringConfig({ ...ok, passPolicy: { kind: 'gates', gates: [{ metric: 'b', min: 5 }] }, primaryMetrics: ['a', 'b'] })).toBeNull();
  });

  it.each([
    ['not an object', null, /must be an object/],
    ['no metrics', { ...ok, metrics: [] }, /non-empty array/],
    ['unnamed metric', { ...ok, metrics: [{ weight: 1 }] }, /name is required/],
    ['duplicate name', { ...ok, metrics: [{ name: 'a', weight: 1 }, { name: 'a', weight: 1 }] }, /duplicate metric name/],
    ['zero weight', { ...ok, metrics: [{ name: 'a', weight: 0 }] }, /weight must be a number > 0/],
    ['negative scale', { ...ok, metrics: [{ name: 'a', weight: 1, scale: -1 }] }, /scale must be a number > 0/],
    ['threshold > 1', { ...ok, passPolicy: { kind: 'threshold', minScore: 70 } }, /\[0, 1\]/],
    ['threshold NaN', { ...ok, passPolicy: { kind: 'threshold', minScore: 'x' } }, /\[0, 1\]/],
    ['empty gates', { ...ok, passPolicy: { kind: 'gates', gates: [] } }, /non-empty array/],
    ['gate unknown metric', { ...ok, passPolicy: { kind: 'gates', gates: [{ metric: 'zzz', min: 1 }] } }, /unknown metric 'zzz'/],
    ['gate min above scale', { ...ok, passPolicy: { kind: 'gates', gates: [{ metric: 'b', min: 6 }] } }, /within the metric scale \[0, 5\]/],
    ['unknown policy kind', { ...ok, passPolicy: { kind: 'all-gates-pass' } }, /kind must be one of/],
    ['primary unknown', { ...ok, primaryMetrics: ['nope'] }, /unknown metric 'nope'/],
    ['primary not array', { ...ok, primaryMetrics: 'a' }, /array of metric names/],
  ])('rejects %s', (_label, cfg, re) => {
    expect(validateScoringConfig(cfg)).toMatch(re);
  });

  it('accepts a missing / llm-verdict policy (the default); `kind: \'deterministic\'` evaluators are validated by lib/evaluators/deterministic instead', () => {
    expect(validateScoringConfig(ok)).toBeNull();
    expect(validateScoringConfig({ ...ok, passPolicy: { kind: 'llm-verdict' } })).toBeNull();
  });
});
