/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * First judgement of a NEW run's report with a `kind: 'deterministic'`
 * evaluator (services/evaluation/deterministicJudgement.ts): the verdict is
 * computed in code from the stored trajectory and persisted with no LLM
 * fields; not-evaluable reports get the evaluator-error patch (never a
 * silent pass, never a fake zero); evaluator resolution only "claims" a run
 * when the evaluator really is deterministic.
 */

import type { EvaluationReport, Evaluator, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';
import { applyDeterministicFirstJudgement, resolveDeterministicEvaluator } from '@/services/evaluation/deterministicJudgement';

const deterministic: Evaluator = {
  id: 'eval-det', name: 'Ranked retrieval', description: '', isSystem: false, currentVersion: 1, versions: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...normalizeDeterministicEvaluator({
    kind: 'deterministic',
    metrics: [
      { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true },
      { name: 'mrr', compute: { type: 'mrr' }, weight: 1 },
    ],
    passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
    inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' }, prediction: { source: 'tool-hits-ordered' } },
  }),
} as Evaluator;

const llmEvaluator = { id: 'eval-llm', name: 'LLM', systemPrompt: 'judge it' } as unknown as Evaluator;

const hits = (...ids: string[]) => ({ id: 'r', timestamp: 1, type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: ids.map(id => ({ id })) }) });

const testCase = { id: 'tc-1', name: 'case', expectedOutcomes: ['Gold: g1, g2'] } as unknown as TestCase;

function report(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'report-1', testCaseId: 'tc-1', timestamp: '2026-01-01T00:00:00Z', agentName: 'A', agentKey: 'a', modelName: 'm', modelId: 'm',
    status: 'completed', metricsStatus: 'completed' as any, trajectory: [hits('g1', 'x')], metrics: {}, llmJudgeReasoning: '',
    ...overrides,
  } as EvaluationReport;
}

function storage(evaluators: Record<string, Evaluator> = {}) {
  return {
    runs: { update: jest.fn(async (_id: string, updates: any) => updates) },
    evaluators: { getById: jest.fn(async (id: string) => evaluators[id] ?? null) },
  } as unknown as jest.Mocked<IStorageModule>;
}

describe('resolveDeterministicEvaluator', () => {
  it('returns the document only for a deterministic evaluator', async () => {
    const s = storage({ 'eval-det': deterministic, 'eval-llm': llmEvaluator });
    expect(await resolveDeterministicEvaluator('eval-det', s)).toBe(deterministic);
    expect(await resolveDeterministicEvaluator('eval-llm', s)).toBeNull();
  });

  it('is null for an unset id, an unknown id, and a storage failure (the LLM path stays the default)', async () => {
    const s = storage({});
    expect(await resolveDeterministicEvaluator(undefined, s)).toBeNull();
    expect(await resolveDeterministicEvaluator('nope', s)).toBeNull();
    (s.evaluators.getById as jest.Mock).mockRejectedValueOnce(new Error('storage down'));
    expect(await resolveDeterministicEvaluator('eval-det', s)).toBeNull();
  });

  it('is null for a system (LLM) evaluator id without touching storage', async () => {
    const s = storage({});
    expect(await resolveDeterministicEvaluator('system-rca-default', s)).toBeNull();
    expect(s.evaluators.getById).not.toHaveBeenCalled();
  });
});

describe('applyDeterministicFirstJudgement', () => {
  it('persists the code-computed verdict with no LLM fields and no judge model', async () => {
    const s = storage();
    const outcome = await applyDeterministicFirstJudgement(report(), testCase, deterministic, s);
    expect(outcome).toEqual({ passFailStatus: 'passed' });
    expect(s.runs.update).toHaveBeenCalledTimes(1);
    const [id, patch] = (s.runs.update as jest.Mock).mock.calls[0];
    expect(id).toBe('report-1');
    expect(patch).toMatchObject({
      passFailStatus: 'passed',
      metricsStatus: 'completed',
      metrics: { 'hit@1': 1, mrr: 1 },
      score: 1,
      judgeMode: 'deterministic',
      judgeModelId: null,
      evaluatorId: 'eval-det',
      llmJudgeReasoning: '',
      llmJudgeResponse: null,
      llmVerdict: null,
      verdictConflict: null,
      improvementStrategies: [],
    });
    expect(patch.scoringSnapshot.primaryMetrics).toEqual(['hit@1']);
    expect(patch.matcherResults).toHaveLength(2);
    expect(patch.traceError).toBeUndefined();
  });

  it('a failing verdict is persisted as failed (gate not met), still without an LLM', async () => {
    const s = storage();
    const outcome = await applyDeterministicFirstJudgement(report({ trajectory: [hits('x', 'g1')] }), testCase, deterministic, s);
    expect(outcome.passFailStatus).toBe('failed');
    const patch = (s.runs.update as jest.Mock).mock.calls[0][1];
    expect(patch.passFailStatus).toBe('failed');
    expect(patch.metrics).toEqual({ 'hit@1': 0, mrr: 0.5 });
    expect(patch.judgeMode).toBe('deterministic');
  });

  it('no candidates ⇒ NOT evaluable: evaluator-error patch, no verdict, empty metrics, snapshot kept', async () => {
    const s = storage();
    const outcome = await applyDeterministicFirstJudgement(report({ trajectory: [{ id: 'a', timestamp: 1, type: 'response', content: 'nothing found' } as any] }), testCase, deterministic, s);
    expect(outcome.passFailStatus).toBeNull();
    expect(outcome.error).toBeTruthy();
    const patch = (s.runs.update as jest.Mock).mock.calls[0][1];
    expect(patch.metricsStatus).toBe('error');
    expect(patch.passFailStatus).toBeNull();
    expect(patch.metrics).toEqual({});
    expect(patch.traceError).toContain('Not evaluable by Ranked retrieval');
    expect(patch.scoringSnapshot.unevaluable).toEqual(expect.arrayContaining(['hit@1', 'mrr']));
    expect(patch.judgeMode).toBe('deterministic');
    expect(patch.llmJudgeResponse).toBeNull();
  });

  it('a scorer exception lands as the evaluator-error patch and never throws out of the runner', async () => {
    const s = storage();
    // An evaluator whose inputs the engine cannot interpret makes scoreDeterministic throw.
    const broken = { ...deterministic, inputs: { ...deterministic.inputs, gold: { source: 'expectedOutcomes-pattern', pattern: '(' } } } as Evaluator;
    const outcome = await applyDeterministicFirstJudgement(report(), testCase, broken, s);
    expect(outcome.passFailStatus).toBeNull();
    expect(outcome.error).toBeTruthy();
    const patch = (s.runs.update as jest.Mock).mock.calls[0][1];
    expect(patch.metricsStatus).toBe('error');
    expect(patch.traceError).toContain('Deterministic scoring:');
    expect(patch.matcherResults).toEqual([]);
  });

  it('a storage failure while persisting the error patch is swallowed', async () => {
    const s = storage();
    (s.runs.update as jest.Mock).mockRejectedValue(new Error('write failed'));
    const broken = { ...deterministic, inputs: { ...deterministic.inputs, gold: { source: 'expectedOutcomes-pattern', pattern: '(' } } } as Evaluator;
    await expect(applyDeterministicFirstJudgement(report(), testCase, broken, s)).resolves.toMatchObject({ passFailStatus: null });
  });
});
