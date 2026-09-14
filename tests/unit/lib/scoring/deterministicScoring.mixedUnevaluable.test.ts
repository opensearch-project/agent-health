/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the "SOME metrics unevaluable ⇒ verdict failed with
 * unevaluable:<metric>, never a silent pass" rule. With today's registry all
 * three metric types become unevaluable under the same conditions (empty gold
 * / empty ranking), so the mixed state is simulated by stubbing the registry
 * to return `null` for one metric only.
 */

jest.mock('@/lib/metrics/index', () => {
  const actual = jest.requireActual('@/lib/metrics/index');
  return {
    ...actual,
    computeMetric: jest.fn((compute: any, inputs: any) => (compute.type === 'mrr' ? null : actual.computeMetric(compute, inputs))),
  };
});

import type { Evaluator } from '@/types';
import { scoreDeterministic } from '@/lib/scoring/deterministicScoring';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';

const evaluator = {
  id: 'e', name: 'e', description: '', isSystem: false, currentVersion: 1, versions: [], createdAt: '', updatedAt: '',
  ...normalizeDeterministicEvaluator({
    kind: 'deterministic',
    metrics: [
      { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true },
      { name: 'mrr', compute: { type: 'mrr' }, weight: 1 },
    ],
    passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
    inputs: { gold: { source: 'testCase.expected.ids' }, prediction: { source: 'tool-hits-ordered' } },
  }),
} as Evaluator;

it('some-unevaluable: the gate passes but the verdict is failed with an explicit reason; the mean excludes the missing metric', () => {
  const r = scoreDeterministic(evaluator, { expected: { ids: ['g'] } }, {
    trajectory: [{ id: '1', timestamp: 1, type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: [{ id: 'g' }] }) }],
  });
  expect(r.evaluable).toBe(true);
  expect(r.metrics).toEqual({ 'hit@1': 1 });
  expect(r.score).toBe(1); // only the evaluable metric contributes
  expect(r.unevaluable).toEqual(['mrr']);
  expect(r.passFailStatus).toBe('failed');
  expect(r.failReasons).toEqual(['unevaluable:mrr']);
  expect(r.snapshot.unevaluable).toEqual(['mrr']);
  expect(r.matcherResults[0]).toMatchObject({ pass: true, role: 'primary' });
  expect(r.matcherResults[1]).toMatchObject({ pass: false, errored: true, role: 'observe', errorMessage: 'metric could not be computed' });
  expect(r.summary).toContain('unevaluable: mrr');
  expect(r.summary).toContain('Verdict failed (unevaluable:mrr)');
});
