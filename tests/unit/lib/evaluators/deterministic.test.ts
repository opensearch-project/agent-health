/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  validateDeterministicEvaluator,
  normalizeDeterministicEvaluator,
  synthesizeScoringConfig,
  isDeterministicEvaluator,
  metricScale,
  deterministicEvaluatorCanonical,
} from '@/lib/evaluators/deterministic';

const valid = () => ({
  name: 'Ranked retrieval',
  kind: 'deterministic',
  metrics: [
    { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.5, primary: true },
    { name: 'recall@20', compute: { type: 'ranked-recall', k: 20 }, weight: 0.3 },
    { name: 'mrr', compute: { type: 'mrr' }, weight: 0.2, scale: { min: 0, max: 100 } },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
  inputs: {
    gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' },
    prediction: { source: 'tool-hits-ordered', anchorTools: [{ tool: 'expand', argKey: 'seed_ids' }] },
  },
});

describe('validateDeterministicEvaluator', () => {
  it('accepts a well-formed document (gates and threshold)', () => {
    expect(validateDeterministicEvaluator(valid())).toEqual([]);
    expect(validateDeterministicEvaluator({ ...valid(), passPolicy: { kind: 'threshold', minScore: 0.7 } })).toEqual([]);
    expect(validateDeterministicEvaluator({ ...valid(), inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'tool-hits-ordered' } } })).toEqual([]);
  });

  it.each([
    ['not an object', null, /must be an object/],
    ['wrong kind', { ...valid(), kind: 'llm' }, /kind must be 'deterministic'/],
    ['empty metrics', { ...valid(), metrics: [] }, /non-empty array/],
    ['metric not object', { ...valid(), metrics: [null] }, /metrics\[0\] must be an object/],
    ['missing metric name', { ...valid(), metrics: [{ compute: { type: 'mrr' }, weight: 1 }] }, /name must be a non-empty string/],
    ['duplicate names', { ...valid(), metrics: [{ name: 'a', compute: { type: 'mrr' }, weight: 1 }, { name: 'a', compute: { type: 'mrr' }, weight: 1 }] }, /duplicated/],
    ['unknown compute type', { ...valid(), metrics: [{ name: 'x', compute: { type: 'ndcg', k: 5 }, weight: 1 }] }, /unknown compute type "ndcg"/],
    ['bad k', { ...valid(), metrics: [{ name: 'x', compute: { type: 'ranked-hit', k: -1 }, weight: 1 }] }, /k must be a positive integer/],
    ['zero weight', { ...valid(), metrics: [{ name: 'x', compute: { type: 'mrr' }, weight: 0 }] }, /weight must be a finite number > 0/],
    ['bad scale', { ...valid(), metrics: [{ name: 'x', compute: { type: 'mrr' }, weight: 1, scale: { min: 1, max: 1 } }] }, /scale must be/],
    ['primary not boolean', { ...valid(), metrics: [{ name: 'x', compute: { type: 'mrr' }, weight: 1, primary: 'yes' }] }, /primary must be a boolean/],
    ['llm-verdict rejected', { ...valid(), passPolicy: { kind: 'llm-verdict' } }, /'llm-verdict' is not allowed/],
    ['missing passPolicy', { ...valid(), passPolicy: undefined }, /passPolicy is required/],
    ['unknown policy kind', { ...valid(), passPolicy: { kind: 'magic' } }, /passPolicy.kind must be/],
    ['threshold out of range', { ...valid(), passPolicy: { kind: 'threshold', minScore: 70 } }, /minScore must be a number in \[0, 1\]/],
    ['gates empty', { ...valid(), passPolicy: { kind: 'gates', gates: [] } }, /gates must be a non-empty array/],
    ['gate not object', { ...valid(), passPolicy: { kind: 'gates', gates: [1] } }, /gates\[0\] must be an object/],
    ['gate names undeclared metric', { ...valid(), passPolicy: { kind: 'gates', gates: [{ metric: 'nope', min: 1 }] } }, /does not name a declared metric/],
    ['gate min not number', { ...valid(), passPolicy: { kind: 'gates', gates: [{ metric: 'mrr', min: 'x' }] } }, /min must be a finite number/],
    ['missing inputs', { ...valid(), inputs: undefined }, /inputs is required/],
    ['missing gold', { ...valid(), inputs: { prediction: { source: 'tool-hits-ordered' } } }, /inputs.gold is required/],
    ['unknown gold source', { ...valid(), inputs: { gold: { source: 'x' }, prediction: { source: 'tool-hits-ordered' } } }, /gold.source must be/],
    ['pattern missing', { ...valid(), inputs: { gold: { source: 'expectedOutcomes-pattern' }, prediction: { source: 'tool-hits-ordered' } } }, /pattern is required/],
    ['pattern invalid regex', { ...valid(), inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '(' }, prediction: { source: 'tool-hits-ordered' } } }, /not a valid regular expression/],
    ['pattern without capture group', { ...valid(), inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: .+$' }, prediction: { source: 'tool-hits-ordered' } } }, /exactly one capture group \(found 0\)/],
    ['pattern with two groups', { ...valid(), inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '(a)(b)' }, prediction: { source: 'tool-hits-ordered' } } }, /found 2/],
    ['missing prediction', { ...valid(), inputs: { gold: { source: 'testCase.expected.ids' } } }, /prediction is required/],
    ['unknown prediction source', { ...valid(), inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'report.output' } } }, /prediction.source must be 'tool-hits-ordered'/],
    ['bad idFields', { ...valid(), inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'tool-hits-ordered', idFields: 'id' } } }, /idFields must be an array/],
    ['bad hitsPaths', { ...valid(), inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'tool-hits-ordered', hitsPaths: [1] } } }, /hitsPaths must be an array/],
    ['bad anchorTools', { ...valid(), inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'tool-hits-ordered', anchorTools: 'x' } } }, /anchorTools must be an array/],
    ['bad anchorTools entry', { ...valid(), inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'tool-hits-ordered', anchorTools: [{ tool: 'x' }] } } }, /anchorTools\[0\] must be \{ tool, argKey \}/],
  ])('rejects: %s', (_label, doc, re) => {
    const errors = validateDeterministicEvaluator(doc);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(re);
  });
});

describe('normalizeDeterministicEvaluator / synthesizeScoringConfig', () => {
  it('fills defaults, clears the prompt and synthesizes a legacy scoringConfig mirror', () => {
    const n = normalizeDeterministicEvaluator(valid());
    expect(n.kind).toBe('deterministic');
    expect(n.systemPrompt).toBe('');
    expect(n.inferenceConfig).toEqual({});
    expect(n.metrics[0]).toEqual({ name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.5, scale: { min: 0, max: 1 }, primary: true });
    expect(n.metrics[1]).toEqual({ name: 'recall@20', compute: { type: 'ranked-recall', k: 20, denominator: 'full-gold' }, weight: 0.3, scale: { min: 0, max: 1 }, primary: false });
    expect(n.metrics[2].scale).toEqual({ min: 0, max: 100 });
    expect(n.scoringConfig).toEqual({
      metrics: [
        { name: 'hit@1', description: 'ranked-hit@1', weight: 0.5, scale: 1 },
        { name: 'recall@20', description: 'ranked-recall@20', weight: 0.3, scale: 1 },
        { name: 'mrr', description: 'mrr', weight: 0.2, scale: 100 },
      ],
      passThreshold: 0,
      scale: 100,
    });
  });

  it('threshold policies map to passThreshold on the 0–100 scale', () => {
    expect(synthesizeScoringConfig([], { kind: 'threshold', minScore: 0.75 }).passThreshold).toBe(75);
    expect(synthesizeScoringConfig([], undefined).passThreshold).toBe(0);
  });

  it('helpers', () => {
    expect(isDeterministicEvaluator({ kind: 'deterministic' })).toBe(true);
    expect(isDeterministicEvaluator({ kind: 'llm' })).toBe(false);
    expect(isDeterministicEvaluator(undefined)).toBe(false);
    expect(metricScale({ scale: undefined })).toEqual({ min: 0, max: 1 });
    expect(metricScale({ scale: { min: 5, max: 1 } })).toEqual({ min: 0, max: 1 });
    // Canonical form is key-order independent and drops undefined.
    const a = deterministicEvaluatorCanonical({ kind: 'deterministic', metrics: [{ name: 'm', weight: 1, compute: { type: 'mrr' } }], passPolicy: { kind: 'threshold', minScore: 0.5 }, inputs: undefined } as any);
    const b = deterministicEvaluatorCanonical({ inputs: undefined, passPolicy: { minScore: 0.5, kind: 'threshold' }, metrics: [{ compute: { type: 'mrr' }, weight: 1, name: 'm' }], kind: 'deterministic' } as any);
    expect(a).toBe(b);
  });
});
