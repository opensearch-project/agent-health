/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry judgement with a `kind: 'deterministic'` evaluator: the judge client
 * is NEVER invoked, every selected report is re-scored from its stored
 * trajectory, snapshot / metrics / matcher rows / judgeMode land on the
 * report, LLM-only fields are cleared, the run's stats + evaluatorId are
 * recomputed, and not-evaluable reports get the evaluator-error patch.
 */

import type { EvaluationReport, EvaluationRun, Evaluator } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/services/evaluation', () => ({ callBedrockJudge: jest.fn() }));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({ agents: [{ key: 'demo', name: 'Demo', useTraces: true }] })),
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/services/traces/fetchSpansForRun', () => ({ fetchSpansForRun: jest.fn(async () => ({ spans: [] })) }));
jest.mock('@/services/traces/spansToTrajectory', () => ({ spansToTrajectory: jest.fn(() => []) }));

import { callBedrockJudge } from '@/services/evaluation';
import { fetchSpansForRun } from '@/services/traces/fetchSpansForRun';
import { retryJudgementForRun, retryJudgementForCase, resolveEvaluatorDoc } from '@/services/evaluation/retryJudgement';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';

const mockedJudge = callBedrockJudge as jest.Mock;
const mockedFetchSpans = fetchSpansForRun as jest.Mock;

const evaluator: Evaluator = {
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

const hits = (...ids: string[]) => ({ id: 'r', timestamp: 1, type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: ids.map(id => ({ id })) }) });

function makeReport(id: string, testCaseId: string, overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id, testCaseId, timestamp: '2026-01-01T00:00:00Z', agentName: 'Demo', agentKey: 'demo', modelName: 'm', modelId: 'm',
    status: 'completed', metricsStatus: 'ready' as any, passFailStatus: 'passed',
    trajectory: [hits('g1', 'x')], metrics: { accuracy: 90 }, llmJudgeReasoning: 'old LLM reasoning',
    llmJudgeResponse: { modelId: 'judge', timestamp: '', promptTokens: 1, completionTokens: 1, latencyMs: 1, rawResponse: '{}' },
    matcherResults: [{ description: 'judge: expected outcomes', pass: true, method: 'llm-judge' }],
    ...overrides,
  } as EvaluationReport;
}

function makeStorage(reports: Record<string, EvaluationReport>, evaluators: Record<string, Evaluator>) {
  return {
    runs: {
      getById: jest.fn(async (id: string) => reports[id] ?? null),
      update: jest.fn(async (id: string, updates: any) => { reports[id] = { ...reports[id], ...updates }; return reports[id]; }),
    },
    evaluationRuns: { update: jest.fn(async (_id: string, updates: any) => updates) },
    testCases: {
      getById: jest.fn(async (id: string) => ({ id, name: id, expectedOutcomes: [`Gold: g1, g2`] })),
      getVersion: jest.fn(async (id: string, version: number) => ({ id, version, name: id, expectedOutcomes: [`Gold: g1, g2`] })),
    },
    evaluators: { getById: jest.fn(async (id: string) => evaluators[id] ?? null) },
  } as unknown as jest.Mocked<IStorageModule>;
}

const run = (results: Record<string, any>, extra: Partial<EvaluationRun> = {}): EvaluationRun =>
  ({ id: 'run-1', docType: 'evaluation-run', name: 'R', createdAt: '', status: 'completed', agentKey: 'demo', modelId: 'm',
     sources: [], trigger: 'ui', testCaseSnapshots: [], evaluatorId: 'eval-llm', results, ...extra }) as EvaluationRun;

beforeEach(() => { mockedJudge.mockReset(); mockedFetchSpans.mockReset(); mockedFetchSpans.mockResolvedValue({ spans: [] }); });

describe('retry judgement with a deterministic evaluator (override)', () => {
  it('never calls the LLM judge or the trace re-fetch; re-scores every report; recomputes run stats + evaluatorId', async () => {
    const reports: Record<string, EvaluationReport> = {
      'rep-a': makeReport('rep-a', 'tc-a'),                                        // hit@1 = 1 → passed
      'rep-b': makeReport('rep-b', 'tc-b', { trajectory: [hits('x', 'g2')] as any }), // hit@1 = 0 → failed (gate)
      'rep-c': makeReport('rep-c', 'tc-c', { trajectory: [{ id: 't', timestamp: 1, type: 'response', content: 'nothing found' }] as any }), // no candidates → not evaluable
    };
    const storage = makeStorage(reports, { 'eval-det': evaluator });
    const r = run({
      'tc-a': { reportId: 'rep-a', status: 'completed', passFailStatus: 'passed' },
      'tc-b': { reportId: 'rep-b', status: 'completed', passFailStatus: 'passed' },
      'tc-c': { reportId: 'rep-c', status: 'completed', passFailStatus: 'passed' },
    });

    const summary = await retryJudgementForRun(r, storage, { scope: 'all', overrides: { evaluatorId: 'eval-det' } });

    expect(mockedJudge).not.toHaveBeenCalled();
    expect(mockedFetchSpans).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ retried: 3, succeeded: 2, failed: 1 });
    expect(summary.results.map(x => [x.testCaseId, x.outcome, x.passFailStatus])).toEqual([
      ['tc-a', 'succeeded', 'passed'], ['tc-b', 'succeeded', 'failed'], ['tc-c', 'failed', null],
    ]);

    const a = reports['rep-a'];
    expect(a.judgeMode).toBe('deterministic');
    expect(a.evaluatorId).toBe('eval-det');
    expect(a.judgeModelId).toBeNull(); // no judge model was used
    expect(a.metrics).toEqual({ 'hit@1': 1, mrr: 1 });
    expect(a.passFailStatus).toBe('passed');
    expect(a.metricsStatus).toBe('completed');
    expect(a.scoringSnapshot).toMatchObject({ evaluatorId: 'eval-det', primaryMetrics: ['hit@1'], goldRule: 'expected-outcomes-pattern', extractionRule: 'tool-hits-ordered', goldIdsUsed: ['g1', 'g2'] });
    expect(a.matcherResults).toHaveLength(2);
    expect(a.matcherResults![0]).toMatchObject({ method: 'code-assertion', role: 'primary', pass: true });
    // LLM-only fields cleared — no stale judge reasoning next to code-computed metrics.
    expect(a.llmJudgeReasoning).toBe('');
    expect(a.llmJudgeResponse).toBeNull();
    expect(a.improvementStrategies).toEqual([]);
    // The stored trajectory is untouched (no trace refresh, no rewrite).
    expect(storage.runs.update).toHaveBeenCalledWith('rep-a', expect.not.objectContaining({ trajectory: expect.anything() }));

    const b = reports['rep-b'];
    expect(b.passFailStatus).toBe('failed');
    expect(b.metrics).toEqual({ 'hit@1': 0, mrr: 0.5 });

    const c = reports['rep-c'];
    expect(c.metricsStatus).toBe('error');
    expect(c.passFailStatus).toBeNull();
    expect(c.metrics).toEqual({});
    expect(c.traceError).toMatch(/Not evaluable by Ranked retrieval: Not evaluable: no candidate ids/);
    expect(c.scoringSnapshot?.unevaluable).toEqual(['hit@1', 'mrr']);
    expect(c.matcherResults?.every(m => m.errored)).toBe(true);

    // Run doc: results + stats recomputed, evaluatorId stamped with the override.
    const runUpdate = storage.evaluationRuns.update.mock.calls[0][1] as any;
    expect(runUpdate.evaluatorId).toBe('eval-det');
    expect(runUpdate.results['tc-a'].passFailStatus).toBe('passed');
    expect(runUpdate.results['tc-b'].passFailStatus).toBe('failed');
    expect(runUpdate.results['tc-c'].passFailStatus).toBeUndefined();
    expect(runUpdate.stats).toMatchObject({ passed: 1, failed: 1, errored: 1, total: 3 });
  });

  it("refuses scope 'errored' with a deterministic evaluator (would mix two scoring snapshots in one run)", async () => {
    const reports = { 'rep-a': makeReport('rep-a', 'tc-a', { metricsStatus: 'error' as any, passFailStatus: null as any }) };
    const storage = makeStorage(reports, { 'eval-det': evaluator });
    await expect(
      retryJudgementForRun(run({ 'tc-a': { reportId: 'rep-a', status: 'completed' } }), storage, { scope: 'errored', overrides: { evaluatorId: 'eval-det' } })
    ).rejects.toThrow(/use scope 'all'/);
    expect(storage.runs.update).not.toHaveBeenCalled();
    expect(mockedJudge).not.toHaveBeenCalled();
  });

  it("uses the run's own evaluator when no override is given and it is deterministic", async () => {
    const reports = { 'rep-a': makeReport('rep-a', 'tc-a') };
    const storage = makeStorage(reports, { 'eval-det': evaluator });
    await retryJudgementForRun(run({ 'tc-a': { reportId: 'rep-a', status: 'completed' } }, { evaluatorId: 'eval-det' }), storage, { scope: 'all' });
    expect(mockedJudge).not.toHaveBeenCalled();
    expect(reports['rep-a'].judgeMode).toBe('deterministic');
    const runUpdate = storage.evaluationRuns.update.mock.calls[0][1] as any;
    expect(runUpdate.evaluatorId).toBeUndefined(); // not overridden → not restamped
  });

  it('an LLM evaluator override still goes through the judge, passing the override id', async () => {
    mockedJudge.mockResolvedValue({ passFailStatus: 'passed', metrics: { accuracy: 80 }, llmJudgeReasoning: 'ok', improvementStrategies: [] });
    const reports = { 'rep-a': makeReport('rep-a', 'tc-a') };
    const llm = { ...evaluator, id: 'eval-llm-2', kind: 'llm', systemPrompt: 'judge it' } as Evaluator;
    const storage = makeStorage(reports, { 'eval-llm-2': llm });
    await retryJudgementForRun(run({ 'tc-a': { reportId: 'rep-a', status: 'completed' } }), storage, { scope: 'all', overrides: { evaluatorId: 'eval-llm-2' } });
    expect(mockedJudge).toHaveBeenCalledTimes(1);
    expect(mockedJudge.mock.calls[0][5]).toBe('eval-llm-2');
  });

  it('retryJudgementForCase: a scoring exception lands as the evaluator-error patch (never a verdict)', async () => {
    const reports = { 'rep-a': makeReport('rep-a', 'tc-a') };
    const storage = makeStorage(reports, {});
    const broken = { ...evaluator, inputs: { ...evaluator.inputs!, gold: { source: 'expectedOutcomes-pattern', pattern: '(' } } } as Evaluator;
    const out = await retryJudgementForCase(reports['rep-a'], { id: 'tc-a', expectedOutcomes: ['Gold: g1'] } as any, run({}), storage, undefined, { evaluatorId: 'x' }, broken);
    expect(out.passFailStatus).toBeNull();
    expect(out.error).toMatch(/not a valid regular expression/);
    expect(reports['rep-a'].metricsStatus).toBe('error');
    expect(reports['rep-a'].matcherResults).toEqual([]);
    expect(mockedJudge).not.toHaveBeenCalled();
  });

  it('resolveEvaluatorDoc: unset → null, unknown stored id → null, storage throwing → null', async () => {
    const storage = makeStorage({}, { 'eval-det': evaluator });
    expect(await resolveEvaluatorDoc(undefined, storage)).toBeNull();
    expect(await resolveEvaluatorDoc('nope', storage)).toBeNull();
    expect(await resolveEvaluatorDoc('eval-det', storage)).toBe(evaluator);
    (storage.evaluators.getById as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    expect(await resolveEvaluatorDoc('eval-det', storage)).toBeNull();
  });
});
