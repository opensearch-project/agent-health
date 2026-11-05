/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * executeRun (the benchmark `/execute` path) with a `kind: 'deterministic'`
 * run evaluator: the agent is invoked with `skipJudge: true`, the saved report
 * gets its FIRST judgement from the shared deterministic scorer through the
 * storage module (second write — `saveReportWithClient`'s allow-list predates
 * `judgeMode`), re-read so the result sees the verdict, and no LLM judge is
 * ever called. Trace-mode reports are scored once spans land (or from the
 * stored trajectory when polling fails). Without an explicit `storageModule`
 * the runner falls back to the server's initialised module; with none at all
 * it keeps the LLM path (where /api/judge answers one 400).
 */

import { executeRun } from '@/services/benchmarkRunner';
import type { Benchmark, BenchmarkRun, Evaluator, TestCase } from '@/types';
import { normalizeDeterministicEvaluator } from '@/lib/evaluators/deterministic';

const mockGetAllTestCasesWithClient = jest.fn();
const mockSaveReportWithClient = jest.fn();
const mockUpdateRunWithClient = jest.fn();
const mockUpdateBenchmarkRunStatsForReport = jest.fn().mockResolvedValue(undefined);
jest.mock('@/server/services/storage', () => ({
  getAllTestCasesWithClient: (...a: any[]) => mockGetAllTestCasesWithClient(...a),
  saveReportWithClient: (...a: any[]) => mockSaveReportWithClient(...a),
  updateRunWithClient: (...a: any[]) => mockUpdateRunWithClient(...a),
  updateBenchmarkRunStatsForReport: (...a: any[]) => mockUpdateBenchmarkRunStatsForReport(...a),
  updateTestCaseLastRunAt: jest.fn().mockResolvedValue(undefined),
}));

const mockRunEval = jest.fn();
const mockJudge = jest.fn();
jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: (...a: any[]) => mockRunEval(...a),
  invokeAgent: jest.fn(),
  callBedrockJudge: (...a: any[]) => mockJudge(...a),
}));
jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { getForAgent: jest.fn().mockReturnValue({ type: 'mock', name: 'Mock' }) },
}));
const mockStartPollingAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn(), startPollingAsync: (...a: any[]) => mockStartPollingAsync(...a) },
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: () => [] }));
const mockGetStorageModule = jest.fn();
jest.mock('@/server/adapters', () => ({ getStorageModule: () => mockGetStorageModule() }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const mockConfig = {
  agents: [
    { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://localhost:3000', connectorType: 'rest', useTraces: false },
    { key: 'traced-agent', name: 'Traced Agent', endpoint: 'http://localhost:3001', connectorType: 'rest', useTraces: true },
  ],
  models: {},
};
jest.mock('@/lib/constants', () => ({ get DEFAULT_CONFIG() { return mockConfig; } }));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: () => mockConfig }));

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

const tc = (id: string): TestCase => ({
  id, name: id, description: '', initialPrompt: `prompt ${id}`, context: [], expectedOutcomes: ['Gold: g1'],
  createdAt: '', updatedAt: '', currentVersion: 1, versions: [], labels: [], category: 'Retrieval', difficulty: 'Easy', isPromoted: true,
} as unknown as TestCase);
const benchmark = (ids: string[]): Benchmark => ({
  id: 'bm-1', name: 'B', description: '', testCaseIds: ids, runs: [], createdAt: '', updatedAt: '', currentVersion: 1,
  versions: [{ version: 1, createdAt: '', testCaseIds: ids }],
} as Benchmark);
const makeRun = (overrides: Partial<BenchmarkRun> = {}): BenchmarkRun =>
  ({ id: 'run-1', name: 'R', agentKey: 'rest-agent', modelId: 'm', createdAt: '', results: {}, evaluatorId: 'eval-det', ...overrides } as BenchmarkRun);

function makeStorage(docs: Record<string, any>, testCases: TestCase[]) {
  return {
    runs: {
      update: jest.fn(async (id: string, fields: any) => { docs[id] = { ...docs[id], ...fields, id }; return docs[id]; }),
      getById: jest.fn(async (id: string) => docs[id] ?? null),
    },
    evaluators: { getById: jest.fn(async (id: string) => ({ 'eval-det': deterministic, 'eval-llm': llm } as any)[id] ?? null) },
    testCases: { getAll: jest.fn(async () => ({ items: testCases })) },
  } as any;
}

describe('executeRun — deterministic run evaluator (benchmark execute path)', () => {
  let docs: Record<string, any>;
  let storage: any;
  const client = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    docs = {};
    storage = makeStorage(docs, [tc('tc-hit'), tc('tc-empty')]);
    mockGetStorageModule.mockReturnValue(storage);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRunEval.mockImplementation(async (agent: any, _m: any, testCase: TestCase) => ({
      id: `report-${testCase.id}`, testCaseId: testCase.id, status: 'completed', metrics: {}, llmJudgeReasoning: '', rawEvents: [],
      trajectory: testCase.id === 'tc-empty' ? [{ type: 'response', content: 'nothing' }] : [hits('g1', 'x')],
      ...(agent.useTraces ? { metricsStatus: 'pending' } : {}),
      performanceMetrics: { durationMs: 3 },
    }));
    mockSaveReportWithClient.mockImplementation(async (_c: any, report: any, opts: any) => {
      const id = `saved-${report.testCaseId}`;
      docs[id] = { ...report, id, experimentId: opts?.experimentId, experimentRunId: opts?.experimentRunId };
      return docs[id];
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('skips the LLM judge and persists a code verdict through the storage module (hit / not-evaluable)', async () => {
    mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit'), tc('tc-empty')]);
    const result = await executeRun(benchmark(['tc-hit', 'tc-empty']), makeRun(), jest.fn(), { client, storageModule: storage });

    expect(mockRunEval).toHaveBeenCalledTimes(2);
    for (const call of mockRunEval.mock.calls) expect(call[4]).toMatchObject({ evaluatorId: 'eval-det', skipJudge: true });
    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockStartPollingAsync).not.toHaveBeenCalled();

    expect(docs['saved-tc-hit']).toMatchObject({
      passFailStatus: 'passed', metricsStatus: 'completed', judgeMode: 'deterministic', metrics: { 'hit@1': 1 }, score: 1,
      evaluatorId: 'eval-det', judgeModelId: null, llmJudgeResponse: null,
    });
    expect(docs['saved-tc-empty']).toMatchObject({ metricsStatus: 'error', passFailStatus: null, judgeMode: 'deterministic', metrics: {} });
    expect(docs['saved-tc-empty'].traceError).toContain('Not evaluable by Ranked retrieval');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not score this case'));
    // Re-read after the judgement write so the result row points at the judged doc.
    expect(storage.runs.getById).toHaveBeenCalledWith('saved-tc-hit');
    expect(result.results['tc-hit']).toMatchObject({ reportId: 'saved-tc-hit', status: 'completed' });
    expect(result.results['tc-empty']).toMatchObject({ reportId: 'saved-tc-empty', status: 'completed' });
  });

  it('without an explicit storageModule, uses the server-initialised module (legacy client-only callers)', async () => {
    mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit')]);
    await executeRun(benchmark(['tc-hit']), makeRun(), jest.fn(), { client });
    expect(mockGetStorageModule).toHaveBeenCalled();
    expect(mockRunEval.mock.calls[0][4]).toMatchObject({ skipJudge: true });
    expect(mockJudge).not.toHaveBeenCalled();
    expect(docs['saved-tc-hit']).toMatchObject({ passFailStatus: 'passed', judgeMode: 'deterministic' });
  });

  it('with no storage at all (getStorageModule throws) the LLM path is kept — /api/judge answers the honest 400', async () => {
    mockGetStorageModule.mockImplementation(() => { throw new Error('storage not initialised'); });
    mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit')]);
    await executeRun(benchmark(['tc-hit']), makeRun(), jest.fn(), { client });
    expect(mockRunEval.mock.calls[0][4]).toMatchObject({ evaluatorId: 'eval-det', skipJudge: false });
    expect(docs['saved-tc-hit'].judgeMode).toBeUndefined();
  });

  it('an LLM evaluator keeps skipJudge: false and no code scoring', async () => {
    mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit')]);
    await executeRun(benchmark(['tc-hit']), makeRun({ evaluatorId: 'eval-llm' }), jest.fn(), { client, storageModule: storage });
    expect(mockRunEval.mock.calls[0][4]).toMatchObject({ evaluatorId: 'eval-llm', skipJudge: false });
    expect(storage.runs.update).not.toHaveBeenCalled();
  });

  it('an agent-stage failure is never scored (nothing to score)', async () => {
    mockRunEval.mockResolvedValueOnce({ id: 'report-tc-hit', testCaseId: 'tc-hit', status: 'failed', failureStage: 'agent', metricsStatus: 'error', trajectory: [], metrics: {}, rawEvents: [] });
    mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit')]);
    await executeRun(benchmark(['tc-hit']), makeRun(), jest.fn(), { client, storageModule: storage });
    expect(storage.runs.update).not.toHaveBeenCalled();
    expect(mockJudge).not.toHaveBeenCalled();
  });

  describe('trace-mode agent', () => {
    it('is scored from the span-built trajectory when traces land; run stats are recomputed; no LLM', async () => {
      mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-empty')]);
      mockStartPollingAsync.mockImplementation(async (reportId: string, _runId: any, handlers: any) => {
        // Span-built trajectory carries the hit the connector never saw.
        await handlers.onTracesFound([{ traceId: 't1' }], { ...docs[reportId], trajectory: [hits('g1', 'z')] });
      });
      const result = await executeRun(benchmark(['tc-empty']), makeRun({ agentKey: 'traced-agent' }), jest.fn(), { client, storageModule: storage });

      expect(mockStartPollingAsync).toHaveBeenCalledTimes(1);
      expect(mockJudge).not.toHaveBeenCalled();
      expect(mockUpdateRunWithClient).not.toHaveBeenCalled();
      expect(docs['saved-tc-empty']).toMatchObject({ passFailStatus: 'passed', metricsStatus: 'completed', judgeMode: 'deterministic', metrics: { 'hit@1': 1 } });
      expect(mockUpdateBenchmarkRunStatsForReport).toHaveBeenCalledWith(client, 'bm-1', 'saved-tc-empty');
      expect(result.results['tc-empty'].status).toBe('completed');
    });

    it('falls back to the stored connector trajectory when trace polling fails, and warns when not evaluable', async () => {
      mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit'), tc('tc-empty')]);
      mockStartPollingAsync.mockImplementation(async (_reportId: string, _runId: any, handlers: any) => {
        await handlers.onError(new Error('no spans within the budget'));
      });
      await executeRun(benchmark(['tc-hit', 'tc-empty']), makeRun({ agentKey: 'traced-agent' }), jest.fn(), { client, storageModule: storage });

      expect(mockJudge).not.toHaveBeenCalled();
      expect(docs['saved-tc-hit']).toMatchObject({ passFailStatus: 'passed', judgeMode: 'deterministic' });
      expect(docs['saved-tc-empty']).toMatchObject({ metricsStatus: 'error', passFailStatus: null });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('trace polling failed'));
    });

    it('a storage failure inside the poll-failure fallback is logged, never thrown into the poller', async () => {
      mockGetAllTestCasesWithClient.mockResolvedValue([tc('tc-hit')]);
      storage.runs.update.mockRejectedValue(new Error('write failed'));
      mockStartPollingAsync.mockImplementation(async (_reportId: string, _runId: any, handlers: any) => {
        await handlers.onError(new Error('no spans'));
      });
      await expect(executeRun(benchmark(['tc-hit']), makeRun({ agentKey: 'traced-agent' }), jest.fn(), { client, storageModule: storage })).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Deterministic judgement failed'), 'write failed');
    });
  });
});
