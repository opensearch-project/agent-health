/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * executeEvaluationRun with a `kind: 'deterministic'` run evaluator (the
 * `POST /api/storage/evaluation-runs` path): the agent is invoked with
 * `skipJudge: true`, the verdict is computed in code from the returned
 * trajectory and persisted onto the report, the run stats reflect it, and
 * no LLM judge is involved — including for a trace-mode agent, whose
 * `pending` report must NOT enter trace polling. An LLM evaluator keeps the
 * pre-existing behaviour (`skipJudge: false`).
 */

import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { EvaluationRun, Evaluator, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/services/connectors/server', () => ({ connectorRegistry: { getForAgent: jest.fn() } }));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://localhost:3000', connectorType: 'rest', useTraces: false },
      { key: 'traced-agent', name: 'Traced Agent', endpoint: 'http://localhost:3001', connectorType: 'rest', useTraces: true },
    ],
    models: {},
  })),
}));
jest.mock('@/lib/constants', () => ({ DEFAULT_CONFIG: { agents: [], models: {} } }));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
const mockStartPolling = jest.fn();
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: (...a: any[]) => mockStartPolling(...a) } }));
jest.mock('@/lib/telemetry', () => ({
  startTestCaseSpan: jest.fn(() => null),
  finalizeTestCaseSpan: jest.fn(),
  addEvaluationResultEvents: jest.fn(),
}));

import { runEvaluationWithConnector, callBedrockJudge } from '@/services/evaluation';
const mockRunEval = runEvaluationWithConnector as jest.Mock;
const mockJudge = callBedrockJudge as jest.Mock;

const deterministic: Evaluator = {
  id: 'eval-det', name: 'Ranked retrieval', description: '', isSystem: false, currentVersion: 1, versions: [],
  createdAt: '', updatedAt: '',
  ...normalizeDeterministicEvaluator({
    kind: 'deterministic',
    metrics: [{ name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 1, primary: true }],
    passPolicy: { kind: 'gates', gates: [{ metric: 'hit@1', min: 1 }] },
    inputs: { gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold: (.+)$' }, prediction: { source: 'tool-hits-ordered' } },
  }),
} as Evaluator;
const llm = { id: 'eval-llm', name: 'LLM', systemPrompt: 'judge' } as unknown as Evaluator;

const hits = (...ids: string[]) => ({ id: 'r', timestamp: 1, type: 'tool_result', toolName: 'search', content: JSON.stringify({ hits: ids.map(id => ({ id })) }) });

function createStorage(docs: Record<string, any>): IStorageModule {
  return {
    runs: {
      create: jest.fn(async (r: any) => { const id = `placeholder-${r.testCaseId}`; docs[id] = { ...r, id }; return docs[id]; }),
      update: jest.fn(async (id: string, fields: any) => { docs[id] = { ...docs[id], ...fields, id }; return docs[id]; }),
      getById: jest.fn(async (id: string) => docs[id] ?? null),
    },
    evaluationRuns: { create: jest.fn(), getById: jest.fn(), update: jest.fn(), delete: jest.fn(), list: jest.fn(), updateResult: jest.fn(), mergeMissingResults: jest.fn() },
    evaluators: { getById: jest.fn(async (id: string) => ({ 'eval-det': deterministic, 'eval-llm': llm } as any)[id] ?? null) },
    health: jest.fn().mockResolvedValue({ status: 'green' }),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as IStorageModule;
}

const tc = (id: string, gold = 'g1'): TestCase =>
  ({ id, name: id, initialPrompt: `prompt ${id}`, context: [], expectedOutcomes: [`Gold: ${gold}`] } as unknown as TestCase);

const makeRun = (overrides: Partial<EvaluationRun> = {}): EvaluationRun =>
  ({ id: 'run-1', name: 'Run', agentKey: 'rest-agent', modelId: 'm', status: 'running', results: {}, createdAt: new Date().toISOString(), ...overrides } as unknown as EvaluationRun);

describe('executeEvaluationRun — deterministic run evaluator', () => {
  let docs: Record<string, any>;
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    docs = {};
    storage = createStorage(docs);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // The connector-side report, as `runEvaluationWithConnector` returns it
    // in SKIP JUDGE mode (no verdict, no metrics) — and in TRACE mode
    // (`metricsStatus: 'pending'`) for the traced agent.
    mockRunEval.mockImplementation(async (agent: any, _m: any, testCase: TestCase) => ({
      id: `report-${testCase.id}`, testCaseId: testCase.id,
      trajectory: testCase.id === 'tc-miss' ? [hits('x', 'g1')] : testCase.id === 'tc-empty' ? [{ type: 'response', content: 'nothing' }] : [hits('g1', 'x')],
      rawEvents: [], status: 'completed', metrics: {}, llmJudgeReasoning: '',
      ...(agent.useTraces ? { metricsStatus: 'pending' } : {}),
      performanceMetrics: { durationMs: 5 },
    }));
  });
  afterEach(() => jest.restoreAllMocks());

  it('skips the LLM judge, scores each report in code, and buckets hit / miss / not-evaluable correctly', async () => {
    const run = makeRun({ evaluatorId: 'eval-det' });
    const completed = await executeEvaluationRun(run, [tc('tc-hit'), tc('tc-miss'), tc('tc-empty')], {
      storageModule: storage, onProgress: jest.fn(), onTestCaseComplete: jest.fn(), concurrency: 3,
    } as any);

    // Agent invoked with the judge skipped, for every case.
    expect(mockRunEval).toHaveBeenCalledTimes(3);
    for (const call of mockRunEval.mock.calls) expect(call[4]).toMatchObject({ evaluatorId: 'eval-det', skipJudge: true });
    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();

    expect(completed.status).toBe('completed');
    expect(completed.results['tc-hit']).toMatchObject({ status: 'completed', passFailStatus: 'passed' });
    expect(completed.results['tc-miss']).toMatchObject({ status: 'failed', passFailStatus: 'failed' });
    expect(completed.results['tc-empty'].status).toBe('completed');
    expect(completed.results['tc-empty'].passFailStatus).toBeUndefined();
    expect(completed.stats).toEqual({ passed: 1, failed: 1, errored: 1, pending: 0, notRun: 0, total: 3 });

    // Non-traced: ONE storage write per report after the placeholder — the
    // judgement is merged into the report before its save, never a second pass.
    const hitWrites = (storage.runs.update as jest.Mock).mock.calls.filter(([id]) => id === 'placeholder-tc-hit');
    expect(hitWrites).toHaveLength(1);
    const hit = docs['placeholder-tc-hit'];
    expect(hit).toMatchObject({
      passFailStatus: 'passed', metricsStatus: 'completed', judgeMode: 'deterministic',
      metrics: { 'hit@1': 1 }, score: 1, evaluatorId: 'eval-det', judgeModelId: null, llmJudgeResponse: null,
    });
    expect(hit.scoringSnapshot.primaryMetrics).toEqual(['hit@1']);
    expect(docs['placeholder-tc-miss']).toMatchObject({ passFailStatus: 'failed', metrics: { 'hit@1': 0 }, judgeMode: 'deterministic' });
    const empty = docs['placeholder-tc-empty'];
    expect(empty.metricsStatus).toBe('error');
    expect(empty.passFailStatus).toBeNull();
    expect(empty.traceError).toContain('Not evaluable by Ranked retrieval');
    // No LLM ran, so the run names no judge model / provider.
    expect(completed.judgeModel).toBeUndefined();
  });

  it('a trace-mode agent + deterministic evaluator is scored from the SPAN-BUILT trajectory once traces land — no LLM', async () => {
    // The poller hands back the report with the trajectory rebuilt from spans
    // (here: a hit the connector never saw).
    mockStartPolling.mockImplementation((reportId: string, _runId: any, handlers: any) => {
      setImmediate(() => handlers.onTracesFound([{ traceId: 't1' }], { ...docs[reportId], trajectory: [hits('g1', 'z')] }));
    });
    const run = makeRun({ evaluatorId: 'eval-det', agentKey: 'traced-agent' });
    const completed = await executeEvaluationRun(run, [tc('tc-empty')], {
      storageModule: storage, onProgress: jest.fn(), onTestCaseComplete: jest.fn(),
    } as any);
    expect(mockStartPolling).toHaveBeenCalledTimes(1);
    expect(mockJudge).not.toHaveBeenCalled();
    // Connector trajectory had no candidates; the span-built one scores a hit.
    expect(completed.results['tc-empty']).toMatchObject({ status: 'completed', passFailStatus: 'passed' });
    expect(docs['placeholder-tc-empty']).toMatchObject({ metricsStatus: 'completed', judgeMode: 'deterministic', passFailStatus: 'passed', metrics: { 'hit@1': 1 } });
    expect(completed.stats.passed).toBe(1);
  });

  it('a trace-mode agent whose trace polling FAILS falls back to the stored connector trajectory (what Retry judgement scores)', async () => {
    mockStartPolling.mockImplementation((_reportId: string, _runId: any, handlers: any) => {
      setImmediate(() => handlers.onError(new Error('no spans within the budget')));
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const completed = await executeEvaluationRun(makeRun({ evaluatorId: 'eval-det', agentKey: 'traced-agent' }), [tc('tc-hit')], {
      storageModule: storage, onProgress: jest.fn(), onTestCaseComplete: jest.fn(),
    } as any);
    expect(mockJudge).not.toHaveBeenCalled();
    expect(completed.results['tc-hit']).toMatchObject({ status: 'completed', passFailStatus: 'passed' });
    expect(docs['placeholder-tc-hit']).toMatchObject({ judgeMode: 'deterministic', passFailStatus: 'passed' });
  });

  it('an LLM evaluator keeps the judge path (skipJudge: false) — no code scoring', async () => {
    mockRunEval.mockImplementation(async (_a: any, _m: any, testCase: TestCase) => ({
      id: `report-${testCase.id}`, testCaseId: testCase.id, trajectory: [hits('g1')], rawEvents: [],
      status: 'completed', passFailStatus: 'passed', metricsStatus: 'completed', metrics: { accuracy: 90 },
      llmJudgeReasoning: 'judged', performanceMetrics: { durationMs: 5 },
    }));
    const completed = await executeEvaluationRun(makeRun({ evaluatorId: 'eval-llm' }), [tc('tc-hit')], {
      storageModule: storage, onProgress: jest.fn(), onTestCaseComplete: jest.fn(),
    } as any);
    expect(mockRunEval.mock.calls[0][4]).toMatchObject({ evaluatorId: 'eval-llm', skipJudge: false });
    expect(docs['placeholder-tc-hit'].judgeMode).toBeUndefined();
    expect(completed.stats.passed).toBe(1);
  });
});
