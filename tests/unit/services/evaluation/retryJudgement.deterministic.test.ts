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
import { retryJudgementForRun, retryJudgementForCase, resolveEvaluatorDoc, preflightRetryJudgement } from '@/services/evaluation/retryJudgement';
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
    // Verdict-engine fields from the earlier LLM judgement (lib/scoring/verdictEngine.ts).
    llmVerdict: 'passed', verdictConflict: true, score: 0.9,
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
    // "Not evaluable" is NOT "failed": tc-c's rules did not apply (no
    // candidate ids) — a distinct outcome with its reason, never counted
    // under `failed` (owner incident: "0 succeeded · 3 still failed" for a
    // run whose evaluator fit none of the cases).
    expect(summary).toMatchObject({ retried: 3, succeeded: 2, failed: 0, notEvaluable: 1, abstain: 0 });
    expect(summary.results.map(x => [x.testCaseId, x.outcome, x.passFailStatus])).toEqual([
      ['tc-a', 'succeeded', 'passed'], ['tc-b', 'succeeded', 'failed'], ['tc-c', 'not-evaluable', null],
    ]);
    // tc-c's only step is a response with no list and there are no tool results.
    expect(summary.results[2].reason).toMatch(/^no ranked list recognised in the final response/);
    expect(summary.results[2].error).toBeUndefined();
    // Not-evaluable cases carry the structured diagnostics; plain scored cases do not.
    expect(summary.results[2].diagnostics).toMatchObject({
      gold: { source: 'expectedOutcomes[0]', ids: ['g1', 'g2'], explicitlyEmpty: false },
      candidates: { sourceUsed: 'none', count: 0, anchorRemoved: 0, returned: false, weak: false },
      toolsScanned: [],
    });
    expect(summary.results[0].diagnostics).toBeUndefined();

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
    // No LLM was involved: the earlier judgement's verdict-engine fields are cleared, the score is the deterministic weighted mean.
    expect(a.llmVerdict).toBeNull();
    expect(a.verdictConflict).toBeNull();
    expect(a.score).toBe(1);
    // The stored trajectory is untouched (no trace refresh, no rewrite).
    expect(storage.runs.update).toHaveBeenCalledWith('rep-a', expect.not.objectContaining({ trajectory: expect.anything() }));

    const b = reports['rep-b'];
    expect(b.passFailStatus).toBe('failed');
    expect(b.metrics).toEqual({ 'hit@1': 0, mrr: 0.5 });

    // Not evaluable → the PREVIOUS judgement is preserved byte-for-byte (the
    // old LLM verdict, metrics, reasoning, matcher row all stand) and the
    // attempt is recorded as lastRetryAttempt with reason + diagnostics.
    const c = reports['rep-c'];
    const { lastRetryAttempt: cAttempt, ...cRest } = c as any;
    expect(cRest).toEqual(makeReport('rep-c', 'tc-c', { trajectory: [{ id: 't', timestamp: 1, type: 'response', content: 'nothing found' }] as any }));
    expect(c.passFailStatus).toBe('passed');
    expect(c.metricsStatus).toBe('ready');
    expect(c.llmJudgeReasoning).toBe('old LLM reasoning');
    expect(c.scoringSnapshot).toBeUndefined();
    expect(c.traceError).toBeUndefined();
    expect(cAttempt).toMatchObject({
      evaluatorId: 'eval-det', evaluatorName: 'Ranked retrieval', scope: 'all', outcome: 'not-evaluable',
      reason: expect.stringMatching(/^no ranked list recognised in the final response/),
      diagnostics: { gold: { ids: ['g1', 'g2'] }, candidates: { sourceUsed: 'none' } },
    });
    // Exactly one write for rep-c, carrying only the attempt.
    const cWrites = (storage.runs.update as jest.Mock).mock.calls.filter(w => w[0] === 'rep-c');
    expect(cWrites).toHaveLength(1);
    expect(Object.keys(cWrites[0][1])).toEqual(['lastRetryAttempt']);
    // The successfully re-scored reports clear any earlier attempt.
    expect(reports['rep-a'].lastRetryAttempt).toBeNull();

    // Run doc: results + stats recomputed, evaluatorId stamped with the override.
    const runUpdate = storage.evaluationRuns.update.mock.calls.at(-1)![1] as any; // final write (#509 writes lastJudgementRetry up front)
    // #509 contract: the run's ORIGINAL evaluatorId is not rewritten; the selection lives in lastJudgementRetry.
    expect(runUpdate.evaluatorId).toBeUndefined();
    const firstUpdate = storage.evaluationRuns.update.mock.calls[0][1] as any;
    expect(firstUpdate.lastJudgementRetry).toMatchObject({ scope: 'all', evaluatorId: 'eval-det' });
    expect(runUpdate.results['tc-a'].passFailStatus).toBe('passed');
    expect(runUpdate.results['tc-b'].passFailStatus).toBe('failed');
    // tc-c keeps its PREVIOUS verdict (passed) — a failed attempt never demotes a case to errored.
    expect(runUpdate.results['tc-c'].passFailStatus).toBe('passed');
    expect(runUpdate.stats).toMatchObject({ passed: 2, failed: 1, errored: 0, total: 3 });
    expect(runUpdate.lastRetryAttempt).toMatchObject({ evaluatorId: 'eval-det', evaluatorName: 'Ranked retrieval', scope: 'all', retried: 3, succeeded: 2, notEvaluable: 1, failed: 0 });
    expect(Object.values(runUpdate.lastRetryAttempt.reasons)).toEqual([1]);
  });

  describe('preflightRetryJudgement — read-only evaluability check for the dialog', () => {
    it('deterministic evaluator: counts evaluable vs not-evaluable cases, groups the reasons, forces scope all, writes nothing', async () => {
      const reports: Record<string, EvaluationReport> = {
        'rep-a': makeReport('rep-a', 'tc-a'),
        'rep-b': makeReport('rep-b', 'tc-b', { trajectory: [{ id: 't', timestamp: 1, type: 'response', content: 'nothing found' }] as any }),
        'rep-c': makeReport('rep-c', 'tc-c', { trajectory: [{ id: 't', timestamp: 1, type: 'response', content: 'nothing found' }] as any }),
        'rep-d': makeReport('rep-d', 'tc-d', { metricsStatus: 'error' as any, passFailStatus: null as any }),
      };
      const storage = makeStorage(reports, { 'eval-det': evaluator });
      // tc-d's test case has no gold line at all.
      (storage.testCases.getById as jest.Mock).mockImplementation(async (id: string) =>
        id === 'tc-d' ? { id, name: id, expectedOutcomes: ['plain prose, no gold line'] } : { id, name: id, expectedOutcomes: ['Gold: g1, g2'] });
      const r = run({
        'tc-a': { reportId: 'rep-a', status: 'completed', passFailStatus: 'passed' },
        'tc-b': { reportId: 'rep-b', status: 'completed', passFailStatus: 'passed' },
        'tc-c': { reportId: 'rep-c', status: 'completed', passFailStatus: 'failed' },
        'tc-d': { reportId: 'rep-d', status: 'completed' },
      });

      const pre = await preflightRetryJudgement(r, storage, { scope: 'errored', overrides: { evaluatorId: 'eval-det' } });

      const NO_LIST = 'no ranked list recognised in the final response (expected a JSON object/array with a results list, a fenced JSON block, or list lines labelled `id`; an explicit empty list scores as an abstention)';
      const NO_GOLD = 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)';
      expect(pre).toMatchObject({ evaluatorId: 'eval-det', evaluatorName: 'Ranked retrieval', deterministic: true, scope: 'all', total: 4, evaluable: 1, notEvaluable: 3 });
      expect(pre.reasons).toEqual({ [NO_LIST]: 2, [NO_GOLD]: 1 });
      expect(pre.cases.map(c => [c.testCaseId, c.evaluable, c.reason])).toEqual([
        ['tc-a', true, undefined],
        ['tc-b', false, NO_LIST],
        ['tc-c', false, NO_LIST],
        ['tc-d', false, NO_GOLD],
      ]);
      // Every pre-flighted case carries the same diagnostics the retry would persist.
      expect(pre.cases[1].diagnostics).toMatchObject({ gold: { ids: ['g1', 'g2'] }, candidates: { sourceUsed: 'none' } });
      expect(pre.cases[0].diagnostics).toMatchObject({ candidates: { sourceUsed: 'tool-hits', count: 2 } });
      // Read-only: no report or run doc touched, no judge called.
      expect(storage.runs.update).not.toHaveBeenCalled();
      expect(storage.evaluationRuns.update).not.toHaveBeenCalled();
      expect(mockedJudge).not.toHaveBeenCalled();
    });

    it('evaluator that fits nothing → evaluable 0 (the dialog disables Confirm on this)', async () => {
      const reports = { 'rep-a': makeReport('rep-a', 'tc-a', { trajectory: [{ id: 't', timestamp: 1, type: 'response', content: 'x' }] as any }) };
      const storage = makeStorage(reports, { 'eval-det': evaluator });
      const pre = await preflightRetryJudgement(run({ 'tc-a': { reportId: 'rep-a', status: 'completed' } }, { evaluatorId: 'eval-det' }), storage);
      expect(pre).toMatchObject({ deterministic: true, total: 1, evaluable: 0, notEvaluable: 1 });
    });

    it("LLM evaluator: evaluability is unknown up front — deterministic false, counts = the scope's selection, honours scope 'errored'", async () => {
      const reports = {
        'rep-a': makeReport('rep-a', 'tc-a'),
        'rep-b': makeReport('rep-b', 'tc-b', { metricsStatus: 'error' as any, passFailStatus: null as any }),
      };
      const llm = { ...evaluator, id: 'eval-llm', kind: 'llm', systemPrompt: 'judge it' } as Evaluator;
      const storage = makeStorage(reports, { 'eval-llm': llm });
      const pre = await preflightRetryJudgement(run({
        'tc-a': { reportId: 'rep-a', status: 'completed', passFailStatus: 'passed' },
        'tc-b': { reportId: 'rep-b', status: 'completed' },
      }), storage, { scope: 'errored' });
      expect(pre).toEqual({ evaluatorId: 'eval-llm', evaluatorName: 'Ranked retrieval', deterministic: false, scope: 'errored', total: 1, evaluable: 1, notEvaluable: 0, abstain: 0, reasons: {}, cases: [] });
      expect(mockedJudge).not.toHaveBeenCalled();
    });

    it('run with no evaluator at all: evaluatorId null, not deterministic', async () => {
      const storage = makeStorage({ 'rep-a': makeReport('rep-a', 'tc-a') }, {});
      const pre = await preflightRetryJudgement(run({ 'tc-a': { reportId: 'rep-a', status: 'completed' } }, { evaluatorId: undefined }), storage, { scope: 'all' });
      expect(pre).toMatchObject({ evaluatorId: null, evaluatorName: null, deterministic: false, scope: 'all', total: 1, evaluable: 1 });
    });

    it('missing report / test case count as not evaluable with an explicit reason', async () => {
      const storage = makeStorage({ 'rep-a': makeReport('rep-a', 'tc-a') }, { 'eval-det': evaluator });
      (storage.testCases.getVersion as jest.Mock).mockResolvedValue(null);
      const r = run({ 'tc-a': { reportId: 'rep-a', status: 'completed' }, 'tc-b': { reportId: 'rep-gone', status: 'completed' } },
        { evaluatorId: 'eval-det', testCaseSnapshots: [{ id: 'tc-a', version: 3, name: 'a' }] as any });
      const pre = await preflightRetryJudgement(r, storage);
      // tc-b's report is missing → not selectable at all (selectRetryableCases needs a report), so only tc-a is in scope.
      expect(pre.total).toBe(1);
      expect(pre.cases).toEqual([{ testCaseId: 'tc-a', evaluable: false, reason: 'test case version 3 not found' }]);
    });
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
    const runUpdate = storage.evaluationRuns.update.mock.calls.at(-1)![1] as any; // final write (#509 writes lastJudgementRetry up front)
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

  it('retryJudgementForCase: a scoring exception preserves the judgement and records an `error` attempt (never a verdict, never an error patch)', async () => {
    const reports = { 'rep-a': makeReport('rep-a', 'tc-a') };
    const before = JSON.parse(JSON.stringify(reports['rep-a']));
    const storage = makeStorage(reports, {});
    const broken = { ...evaluator, inputs: { ...evaluator.inputs!, gold: { source: 'expectedOutcomes-pattern', pattern: '(' } } } as Evaluator;
    const out = await retryJudgementForCase(reports['rep-a'], { id: 'tc-a', expectedOutcomes: ['Gold: g1'] } as any, run({}), storage, undefined, { evaluatorId: 'x' }, broken, 'all');
    expect(out.passFailStatus).toBeNull();
    expect(out.error).toMatch(/not a valid regular expression/);
    const { lastRetryAttempt, ...rest } = reports['rep-a'] as any;
    expect(rest).toEqual(before);
    expect(lastRetryAttempt).toMatchObject({ outcome: 'error', scope: 'all', evaluatorId: 'eval-det', reason: expect.stringMatching(/^Deterministic scoring: .*not a valid regular expression/) });
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

/**
 * Owner incident (generic reproduction): a run re-scored with a ranked
 * retrieval evaluator read "0 succeeded · 3 still failed" — every case
 * "not evaluable" — although
 *   (1) the gold lines carried ids in exactly the declared format, followed
 *       by the products' names in parentheses,
 *   (2) the tool results held the ids, and the agent's final ranked list
 *       sat in the LAST tool's result (`records[]`) and in the single raw
 *       response payload (`results[]`), not in the `hits` the configured
 *       `tool-hits-ordered` rule reads,
 *   (3) the abstain case's first expectedOutcomes line began with "NONE".
 * The extractor blamed the data: "every retrieved id was an anchor",
 * "no candidate ids found in the stored tool results", "no gold ids on the
 * test case". With the ordered candidate chain, parenthesis-aware gold
 * parsing and explicit-NONE gold the three cases score / score / abstain,
 * and each result explains where its gold and candidates came from.
 */
describe('owner incident — misreported "not evaluable" cases (synthetic)', () => {
  const productEvaluator: Evaluator = {
    ...evaluator,
    id: 'eval-products',
    name: 'Ranked products',
    ...normalizeDeterministicEvaluator({
      kind: 'deterministic',
      metrics: [
        { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.25, primary: true },
        { name: 'hit@5', compute: { type: 'ranked-hit', k: 5 }, weight: 0.15, primary: true },
        { name: 'recall@20', compute: { type: 'ranked-recall', k: 20, denominator: 'full-gold' }, weight: 0.35, primary: true },
        { name: 'mrr', compute: { type: 'mrr' }, weight: 0.25 },
      ],
      passPolicy: { kind: 'gates', gates: [{ metric: 'hit@5', min: 1 }] },
      inputs: {
        gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold product id\\(s\\):\\s*(.+)$' },
        prediction: { source: 'tool-hits-ordered', idFields: ['id', '_id'], hitsPaths: ['hits', 'results'], anchorTools: [{ tool: 'expand_relations', argKey: 'seed_ids' }] },
      },
    }),
  } as Evaluator;

  // Tool results as the connector stores them: `[{ text: '<json>' }]`, sometimes
  // prefixed with the rendered call (`tool(args) -> …`).
  const wrapped = (payload: unknown, rendered?: string) => `${rendered ? `${rendered} -> ` : ''}${JSON.stringify([{ text: JSON.stringify(payload) }])}`;
  const t = (id: string, type: string, extra: Record<string, unknown>) => ({ id, timestamp: 1, type, ...extra });

  /** Case 1: anchor 44793 is the only `hits` entry; the ranked answer is the last tool's `records` + the raw payload. */
  const trajectoryAnchorOnlyHits = [
    t('a1', 'action', { toolName: 'search', toolArgs: { q: 'gel hand wraps' } }),
    t('r1', 'tool_result', { toolName: 'search', content: wrapped({ status: 'ok', hit_count: 1, hits: [{ id: '44793', title: 'anchor product' }] }) }),
    t('a2', 'action', { toolName: 'expand_relations', toolArgs: { seed_ids: ['44793'], relationship: 'ALSO_BOUGHT' } }),
    t('r2', 'tool_result', { toolName: 'expand_relations', content: wrapped({ status: 'ok', forward: { records: [{ id: '290226' }, { id: '706155' }, { id: '116770' }] }, reverse: { records: [] } }) }),
    t('a3', 'action', { toolName: 'return_results', toolArgs: { ids: ['290226', '116770', '706155'] } }),
    t('r3', 'tool_result', { toolName: 'return_results', content: wrapped({ status: 'ok', result_count: 3, records: [{ id: '290226' }, { id: '706155' }, { id: '116770' }] }) }),
    t('resp', 'response', { content: 'Ranked results (3):\n1. id 290226 — first gel wrap\n2. id 706155 — other wrap\n3. id 116770 — second gel wrap\nAnchor ids (excluded): 44793' }),
  ];
  const rawEventsCase1 = [{ answer: null, results: [{ id: '290226', rank: 1 }, { id: '706155', rank: 2 }, { id: '116770', rank: 3 }], seed_ids: ['44793'], results_source: 'return_results' }];

  /** Case 2: every tool result is a rendered `tool(args) -> [{text}]` string (unparseable as a whole); gold at rank 4. */
  const trajectoryRendered = [
    t('a1', 'action', { toolName: 'search', toolArgs: { q: 'daypack' } }),
    t('r1', 'tool_result', { toolName: 'search', content: wrapped({ status: 'ok', hits: [{ id: '292003' }] }, 'search({"q":"daypack"})') }),
    t('a2', 'action', { toolName: 'expand_relations', toolArgs: { seed_ids: ['292003'] } }),
    t('r2', 'tool_result', { toolName: 'expand_relations', content: wrapped({ status: 'ok', forward: { records: [{ id: '151903' }, { id: '399426' }, { id: '233140' }, { id: '428457' }, { id: '610678' }] } }, 'expand_relations({"seed_ids":["292003"]})') }),
    t('a3', 'action', { toolName: 'return_results', toolArgs: { ids: ['151903', '399426', '233140', '428457', '610678'] } }),
    t('r3', 'tool_result', { toolName: 'return_results', content: wrapped({ status: 'ok', result_count: 5, records: ['151903', '399426', '233140', '428457', '610678'].map(id => ({ id })) }, 'return_results({"ids":[…]})') }),
    t('resp', 'response', { content: 'Ranked results (5):\n1. id 151903 — pack A\n2. id 399426 — pack B\n3. id 233140 — pack C\n4. id 428457 — daypack\n5. id 610678 — pack E' }),
  ];

  /** Case 3: abstain — the anchor has no edges; the agent committed no results. */
  const trajectoryAbstain = [
    t('a1', 'action', { toolName: 'search', toolArgs: { q: 'arrow rest' } }),
    t('r1', 'tool_result', { toolName: 'search', content: wrapped({ status: 'ok', hits: [{ id: '956711' }] }) }),
    t('a2', 'action', { toolName: 'expand_relations', toolArgs: { seed_ids: ['956711'] } }),
    t('r2', 'tool_result', { toolName: 'expand_relations', content: wrapped({ status: 'ok', forward: { records: [] }, reverse: { records: [] }, neighbour_count: 0 }) }),
    t('resp', 'response', { content: 'No results committed (results_source=abstain).\nAnchor ids (resolved, excluded from results): 956711' }),
  ];
  const rawEventsAbstain = [{ answer: null, results: [], seed_ids: ['956711'], results_source: 'abstain' }];

  const testCases: Record<string, { expectedOutcomes: string[] }> = {
    'tc-1': { expectedOutcomes: ['Gold product id(s): 290226, 116770 (First Gel Hand Wrap; Second Gel Hand Wrap)', 'The agent resolves the anchor and keeps only gel hand wraps.'] },
    'tc-2': { expectedOutcomes: ['Gold product id(s): 428457 (Some Daypack)', 'The agent ranks the neighbours by "daypack".'] },
    'tc-3': { expectedOutcomes: ['NONE — the anchor has no related edges in either direction. The answer states that no co-purchase data exists and recommends ZERO products.', 'The agent must have attempted the relationship hop before concluding.'] },
  };

  function storageFor(reports: Record<string, EvaluationReport>) {
    const storage = makeStorage(reports, { 'eval-products': productEvaluator });
    (storage.testCases.getById as jest.Mock).mockImplementation(async (id: string) => ({ id, name: id, ...testCases[id] }));
    return storage;
  }

  it('scores / scores / abstains — and every result says where gold and candidates came from', async () => {
    const reports: Record<string, EvaluationReport> = {
      'rep-1': makeReport('rep-1', 'tc-1', { trajectory: trajectoryAnchorOnlyHits as any, rawEvents: rawEventsCase1 as any, metricsStatus: 'error' as any, passFailStatus: null as any, traceError: 'Not evaluable (kind=not_evaluable): every retrieved id was an anchor (1 removed)' }),
      'rep-2': makeReport('rep-2', 'tc-2', { trajectory: trajectoryRendered as any, metricsStatus: 'error' as any, passFailStatus: null as any }),
      'rep-3': makeReport('rep-3', 'tc-3', { trajectory: trajectoryAbstain as any, rawEvents: rawEventsAbstain as any, metricsStatus: 'error' as any, passFailStatus: null as any }),
    };
    const storage = storageFor(reports);
    const r = run({
      'tc-1': { reportId: 'rep-1', status: 'completed' },
      'tc-2': { reportId: 'rep-2', status: 'completed' },
      'tc-3': { reportId: 'rep-3', status: 'completed' },
    }, { evaluatorId: 'eval-products' });

    // Pre-flight predicts the same outcome the retry produces.
    const pre = await preflightRetryJudgement(r, storage);
    expect(pre).toMatchObject({ deterministic: true, total: 3, evaluable: 3, notEvaluable: 0, abstain: 1, reasons: {} });
    expect(pre.cases.map(c => [c.testCaseId, c.evaluable, c.abstain ?? false])).toEqual([['tc-1', true, false], ['tc-2', true, false], ['tc-3', true, true]]);

    const summary = await retryJudgementForRun(r, storage, { scope: 'all' });
    expect(mockedJudge).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ retried: 3, succeeded: 3, failed: 0, notEvaluable: 0, abstain: 1 });
    expect(summary.results.map(x => [x.testCaseId, x.outcome, x.passFailStatus, x.abstain ?? false])).toEqual([
      ['tc-1', 'succeeded', 'passed', false],
      ['tc-2', 'succeeded', 'passed', false],
      ['tc-3', 'succeeded', 'passed', true],
    ]);

    // Case 1 — gold parsed WITHOUT the names; candidates from the RETURNED list, not the anchor-only hits.
    const one = reports['rep-1'];
    expect(one.scoringSnapshot?.goldIdsUsed).toEqual(['290226', '116770']);
    expect(one.metrics).toEqual({ 'hit@1': 1, 'hit@5': 1, 'recall@20': 1, mrr: 1 });
    expect(one.scoringSnapshot?.extraction).toMatchObject({ sourceUsed: 'response-results', parsedFrom: 'raw-event', candidateCount: 3, anchorsRemoved: 0 });
    const d1 = one.scoringSnapshot?.diagnostics!;
    expect(d1.gold).toEqual({ source: 'expectedOutcomes[0]', ids: ['290226', '116770'], explicitlyEmpty: false });
    expect(d1.candidates).toMatchObject({ sourceUsed: 'response-results', count: 3, anchorRemoved: 0, returned: true, weak: false });
    expect(d1.candidates.sourceTried).toEqual([
      { source: 'response-results', count: 3, detail: 'final response (raw-event)' },
      { source: 'results-tool', count: 3, detail: "tool 'return_results' records" },
      { source: 'tool-hits', count: 1, detail: "tool 'search' hits (hits / results)" },
      { source: 'tool-hits', count: 0, detail: "tool 'expand_relations' hits (hits / results)" },
      { source: 'tool-hits', count: 0, detail: "tool 'return_results' hits (hits / results)" },
    ]);
    expect(d1.toolsScanned).toEqual(['search', 'expand_relations', 'return_results']);
    expect(one.traceError).toBeUndefined();

    // Case 2 — rendered tool results are parsed past their prefix; gold at rank 4 → hit@5 gate holds.
    const two = reports['rep-2'];
    expect(two.scoringSnapshot?.goldIdsUsed).toEqual(['428457']);
    expect(two.metrics).toEqual({ 'hit@1': 0, 'hit@5': 1, 'recall@20': 1, mrr: 0.25 });
    expect(two.passFailStatus).toBe('passed');
    // No raw payload here: the labelled list lines of the answer win, and the results tool agrees.
    expect(two.scoringSnapshot?.extraction).toMatchObject({ sourceUsed: 'response-results', parsedFrom: 'text', candidateCount: 5 });
    expect(two.scoringSnapshot?.diagnostics?.candidates.sourceTried).toEqual(expect.arrayContaining([
      { source: 'results-tool', count: 5, detail: "tool 'return_results' records" },
      { source: 'tool-hits', count: 1, detail: "tool 'search' hits (hits / results)" },
    ]));

    // Case 3 — NONE line = gold explicitly empty; the returned list is empty → abstain, passed. Never "no gold ids".
    const three = reports['rep-3'];
    expect(three.passFailStatus).toBe('passed');
    expect(three.metrics).toEqual({ abstain: 1 });
    expect(three.scoringSnapshot).toMatchObject({ goldRule: 'expected-outcomes-none', goldIdsUsed: [], notApplicable: ['hit@1', 'hit@5', 'recall@20', 'mrr'] });
    expect(three.scoringSnapshot?.diagnostics?.gold).toEqual({ source: 'expectedOutcomes[0] (explicitly none)', ids: [], explicitlyEmpty: true });
    expect(three.scoringSnapshot?.diagnostics?.candidates).toMatchObject({ sourceUsed: 'response-results', count: 0, returned: true });
    expect(three.matcherResults?.find(m => m.description.startsWith('abstain (implicit'))).toMatchObject({ pass: true, actual: 1 });
    expect(summary.results[2].diagnostics).toBeDefined(); // abstain cases carry diagnostics too

    // Run doc: three verdicts, no errored case.
    const runUpdate = storage.evaluationRuns.update.mock.calls.at(-1)![1] as any; // final write (#509 writes lastJudgementRetry up front)
    expect(runUpdate.stats).toMatchObject({ passed: 3, failed: 0, errored: 0, total: 3 });
  });

  it('the same three cases WITHOUT any returned list fall through to the configured hits and explain themselves', async () => {
    // Strip the answer / raw payload / results tool: only the exploratory hits remain.
    const hitsOnly = (steps: any[]) => steps.filter(s => s.type !== 'response' && !/return_results/.test(s.toolName ?? ''));
    const reports: Record<string, EvaluationReport> = {
      'rep-1': makeReport('rep-1', 'tc-1', { trajectory: hitsOnly(trajectoryAnchorOnlyHits) as any }),
      'rep-3': makeReport('rep-3', 'tc-3', { trajectory: hitsOnly(trajectoryAbstain) as any }),
    };
    const storage = storageFor(reports);
    const r = run({ 'tc-1': { reportId: 'rep-1', status: 'completed' }, 'tc-3': { reportId: 'rep-3', status: 'completed' } }, { evaluatorId: 'eval-products' });
    const summary = await retryJudgementForRun(r, storage, { scope: 'all' });
    expect(summary).toMatchObject({ retried: 2, succeeded: 0, failed: 0, notEvaluable: 2 });
    const [one, three] = summary.results;
    // Case 1: the only hit is the anchor → the reason names the anchor filter and the diagnostics show the 1 id it removed.
    expect(one.reason).toBe('every candidate id was an anchor (removed by the anchor filter)');
    expect(one.diagnostics?.candidates).toMatchObject({ sourceUsed: 'tool-hits', count: 1, anchorRemoved: 0 + 1, returned: false });
    // Case 3: gold explicitly empty, but nothing RETURNED to observe an abstention from.
    expect(three.reason).toBe('abstention cannot be observed: the only candidates came from retrieved tool hits, not a returned list');
    expect(three.diagnostics?.gold.explicitlyEmpty).toBe(true);
    // Preserved judgement + recorded attempt, on both reports and the run.
    expect(reports['rep-3'].passFailStatus).toBe('passed');
    expect(reports['rep-3'].lastRetryAttempt).toMatchObject({ outcome: 'not-evaluable', reason: three.reason, evaluatorName: 'Ranked products' });
    const runUpdate = storage.evaluationRuns.update.mock.calls.at(-1)![1] as any; // final write (#509 writes lastJudgementRetry up front)
    expect(runUpdate.lastRetryAttempt).toMatchObject({ retried: 2, succeeded: 0, notEvaluable: 2, failed: 0 });
    expect(runUpdate.lastRetryAttempt.reasons).toEqual({ [one.reason as string]: 1, [three.reason as string]: 1 });
  });
});
