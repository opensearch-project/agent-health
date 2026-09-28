/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fast-fail for unreachable agent endpoints — benchmark-runner path
 * (services/benchmarkRunner.ts `executeRun`), mirroring
 * evaluationRunner.fastFailUnreachable.test.ts: REAL evaluation primitives
 * against a fake connector; the endpoint breaker refuses the remainder of the
 * run, agent-failed reports are final (`metricsStatus: 'error'`, never
 * trace-polled), and the run carries `agentFailureSummary`.
 */
import { executeRun } from '@/services/benchmarkRunner';
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
  agents: [{ key: 'dead-agent', name: 'Dead Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: true, headers: {} }],
  models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4', display_name: 'Claude Sonnet' } },
};
jest.mock('@/lib/constants', () => ({ get DEFAULT_CONFIG() { return mockConfig; } }));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: () => mockConfig }));

beforeAll(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

function connectionRefused(): TypeError {
  const e = new TypeError('fetch failed');
  const cause = new Error('connect ECONNREFUSED 10.0.0.5:9000') as Error & { code: string };
  cause.code = 'ECONNREFUSED';
  (e as any).cause = cause;
  return e;
}

const testCases: TestCase[] = Array.from({ length: 5 }, (_, i) => ({
  id: `tc-${i + 1}`, name: `TC ${i + 1}`, initialPrompt: `search products ${i + 1}`, context: [], expectedOutcomes: ['ok'],
})) as unknown as TestCase[];

const benchmark: Benchmark = {
  id: 'bench-1', name: 'Bench', description: '', testCaseIds: testCases.map(t => t.id), runs: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
} as unknown as Benchmark;

function makeRun(): BenchmarkRun {
  return {
    id: 'run-1', name: 'Run', agentKey: 'dead-agent', modelId: 'claude-sonnet', status: 'running', results: {},
    createdAt: new Date().toISOString(),
  } as unknown as BenchmarkRun;
}

describe('executeRun (benchmark path) — fast-fail for unreachable agent endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    savedReports.length = 0;
  });

  it('dead endpoint: 3 dials, breaker refuses 2, every report final as agent_failed, no polling, run summary set', async () => {
    mockExecute.mockImplementation(() => Promise.reject(connectionRefused()));
    const storageModule = { testCases: { getAll: jest.fn().mockResolvedValue({ items: testCases }) } } as any;

    const result = await executeRun(benchmark, makeRun(), () => {}, { client: {} as any, storageModule });

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(savedReports).toHaveLength(5);
    for (const r of savedReports) {
      expect(r.status).toBe('failed');
      expect(r.metricsStatus).toBe('error');
      expect(r.passFailStatus).toBeNull();
      expect(r.traceError).toMatch(/kind=agent_failed/);
    }
    expect(savedReports.filter(r => r.traceError.includes('ECONNREFUSED — connection refused while calling agent endpoint agent.internal:9000'))).toHaveLength(3);
    expect(savedReports.filter(r => r.traceError.includes('this case was not attempted'))).toHaveLength(2);
    expect(result.agentFailureSummary).toBe(
      'Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, agent.internal:9000); 2 further cases were not attempted',
    );
    expect(Object.values(result.results).every(r => r.status === 'completed' && r.reportId)).toBe(true);
  });

  it('an unknown agentKey keeps the per-case error path (threshold resolution never throws up front)', async () => {
    const storageModule = { testCases: { getAll: jest.fn().mockResolvedValue({ items: testCases.slice(0, 2) }) } } as any;
    const run = { ...makeRun(), agentKey: 'nope' } as BenchmarkRun;
    const result = await executeRun({ ...benchmark, testCaseIds: ['tc-1', 'tc-2'] }, run, () => {}, { client: {} as any, storageModule });
    expect(result.results['tc-1']).toMatchObject({ status: 'failed', error: 'Agent not found: nope' });
    expect(result.agentFailureSummary).toBeUndefined();
  });
});
