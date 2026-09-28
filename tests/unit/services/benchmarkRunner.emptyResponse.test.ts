/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Empty-response failure — benchmark-runner path (services/benchmarkRunner.ts
 * `executeRun` and `runSingleUseCase`), mirroring
 * evaluationRunner.emptyResponse.test.ts: REAL evaluation primitives against a
 * fake REST connector; an empty result is a final `agent_empty_response`
 * report (never polled, never judged), a real answer is judged, and the run
 * carries `agentFailureSummary`.
 */
import { executeRun, runSingleUseCase } from '@/services/benchmarkRunner';
import { callBedrockJudge } from '@/services/evaluation/bedrockJudge';
import type { Benchmark, BenchmarkRun, TestCase } from '@/types';

const mockExecute = jest.fn();
jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: {
    getForAgent: jest.fn(() => ({
      type: 'rest', name: 'Fake REST', supportsStreaming: false, buildPayload: () => ({}),
      execute: (...args: any[]) => mockExecute(...args),
    })),
  },
}));

jest.mock('@/services/evaluation/bedrockJudge', () => ({ callBedrockJudge: jest.fn(), simulateBedrockJudge: jest.fn() }));
const mockJudge = callBedrockJudge as jest.Mock;

const savedReports: any[] = [];
jest.mock('@/server/services/storage', () => ({
  getAllTestCasesWithClient: jest.fn(),
  saveReportWithClient: jest.fn(async (_client: any, report: any) => {
    const saved = { ...report, id: report.id ?? `saved-${savedReports.length + 1}` };
    savedReports.push(saved);
    return saved;
  }),
  updateRunWithClient: jest.fn(),
  updateBenchmarkRunStatsForReport: jest.fn(),
  updateTestCaseLastRunAt: jest.fn().mockResolvedValue(undefined),
}));

const mockStartPolling = jest.fn();
jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPolling: (...args: any[]) => mockStartPolling(...args),
    startPollingAsync: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const mockConfig = {
  agents: [
    { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: false, headers: {} },
    { key: 'traced-agent', name: 'Traced Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: true, headers: {} },
  ],
  models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4', display_name: 'Claude Sonnet' } },
};
jest.mock('@/lib/constants', () => ({ get DEFAULT_CONFIG() { return mockConfig; } }));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: () => mockConfig }));

beforeAll(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

function restResult(body: any) {
  const content = body && typeof body.answer === 'string' && body.answer ? body.answer : JSON.stringify(body, null, 2);
  return { trajectory: [{ id: 'r', timestamp: Date.now(), type: 'response', content }], runId: null, rawEvents: [body], metadata: { status: 200 } };
}

const testCases: TestCase[] = Array.from({ length: 5 }, (_, i) => ({
  id: `tc-${i + 1}`, name: `TC ${i + 1}`, initialPrompt: `search products ${i + 1}`, context: [], expectedOutcomes: ['Any reply at all.'],
})) as unknown as TestCase[];

const benchmark: Benchmark = {
  id: 'bench-1', name: 'Bench', description: '', testCaseIds: testCases.map(t => t.id), runs: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
} as unknown as Benchmark;

function makeRun(agentKey = 'rest-agent'): BenchmarkRun {
  return {
    id: 'run-1', name: 'Run', agentKey, modelId: 'claude-sonnet', judgeModelId: 'demo-model', status: 'running', results: {},
    createdAt: new Date().toISOString(),
  } as unknown as BenchmarkRun;
}
const PASS = { passFailStatus: 'passed', metrics: { accuracy: 100 }, llmJudgeReasoning: 'ok', improvementStrategies: [], judgeDurationMs: 1, judgeAttempts: 1 };

describe('executeRun (benchmark path) — empty agent responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    savedReports.length = 0;
    mockJudge.mockResolvedValue(PASS);
  });

  it('`200 {}` everywhere: 3 dials then the breaker refuses 2; every report final as agent_empty_response / unreachable; judge never called', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const storageModule = { testCases: { getAll: jest.fn().mockResolvedValue({ items: testCases }) } } as any;

    const result = await executeRun(benchmark, makeRun(), () => {}, { client: {} as any, storageModule });

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(savedReports).toHaveLength(5);
    for (const r of savedReports) {
      expect(r.status).toBe('failed');
      expect(r.metricsStatus).toBe('error');
      expect(r.passFailStatus).toBeNull();
      expect(r.agentError?.stage).toBe('agent');
    }
    const empties = savedReports.filter(r => r.agentError.kind === 'empty-response');
    expect(empties).toHaveLength(3);
    for (const r of empties) {
      expect(r.traceError).toMatch(/^Agent returned an empty response \(kind=agent_empty_response\)/);
      expect(r.trajectory).toEqual([expect.objectContaining({ content: '{}' })]);
    }
    expect(savedReports.filter(r => r.agentError.kind === 'unreachable')).toHaveLength(2);
    expect(result.agentFailureSummary).toBe(
      'Agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, agent.internal:9000); 2 further cases were not attempted',
    );
    expect(Object.values(result.results).every(r => r.status === 'completed' && r.reportId)).toBe(true);
  });

  it('a real answer on every case is judged as before (no summary, no agentError)', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({ answer: 'Here are the products.' })));
    const storageModule = { testCases: { getAll: jest.fn().mockResolvedValue({ items: testCases.slice(0, 2) }) } } as any;
    const result = await executeRun({ ...benchmark, testCaseIds: ['tc-1', 'tc-2'] }, makeRun(), () => {}, { client: {} as any, storageModule });
    expect(mockJudge).toHaveBeenCalledTimes(2);
    expect(savedReports.every(r => r.passFailStatus === 'passed' && r.agentError === undefined)).toBe(true);
    expect(result.agentFailureSummary).toBeUndefined();
  });
});

describe('runSingleUseCase (/api/evaluate path) — empty agent responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    savedReports.length = 0;
    mockJudge.mockResolvedValue(PASS);
  });

  function makeStorage() {
    const docs = new Map<string, any>();
    return {
      docs,
      runs: {
        create: jest.fn(async (r: any) => { const doc = { ...r, id: r.id ?? 'rep-1', timestamp: r.timestamp ?? 't' }; docs.set(doc.id, doc); return doc; }),
        update: jest.fn(async (id: string, u: any) => { const doc = { ...(docs.get(id) ?? { id }), ...u, id, timestamp: 't' }; docs.set(id, doc); return doc; }),
        getById: jest.fn(async (id: string) => docs.get(id) ?? null),
      },
      testCases: { getById: jest.fn().mockResolvedValue(null), update: jest.fn() },
    } as any;
  }

  it('a useTraces agent returning `200 {}` is final (agent_empty_response, agentError persisted) and never enters trace polling', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const storage = makeStorage();
    const reportId = await runSingleUseCase(makeRun('traced-agent'), testCases[0], storage, undefined, undefined, undefined, { awaitTraces: true });
    const saved = storage.docs.get(reportId);
    expect(saved.status).toBe('failed');
    expect(saved.metricsStatus).toBe('error');
    expect(saved.agentError).toMatchObject({ stage: 'agent', kind: 'empty-response', code: 'EMPTY_RESPONSE' });
    expect(saved.traceError).toMatch(/kind=agent_empty_response/);
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it('placeholder-update path persists agentError too', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const storage = makeStorage();
    await storage.runs.create({ id: 'placeholder-1', status: 'running', metricsStatus: 'pending' });
    const reportId = await runSingleUseCase(makeRun('rest-agent'), testCases[0], storage, undefined, undefined, 'placeholder-1');
    expect(reportId).toBe('placeholder-1');
    const saved = storage.docs.get('placeholder-1');
    expect(saved.agentError?.kind).toBe('empty-response');
    expect(saved.metricsStatus).toBe('error');
    expect(saved.passFailStatus).toBeNull();
    expect(mockJudge).not.toHaveBeenCalled();
  });
});
