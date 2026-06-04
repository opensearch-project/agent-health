/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for issue #230 — the SDK `traces` fixture must
 * reflect real OTel data (or fail loudly) instead of always returning
 * silent zeros.
 *
 * Cases (matrix from the verification plan):
 *
 *   A. useTraces: false                    → silent zeros (opt-out preserved)
 *   B. useTraces: true,  no spans          → unavailable accessor (throws on read)
 *   C. useTraces: true,  spans 12k tokens  → assertion `lessThan(10_000)` FAILS
 *      (this is the original bug — pre-fix it silently passed against 0)
 *   D. useTraces: true,  spans  5k tokens  → assertion `lessThan(10_000)` passes
 *   E. useTraces: true,  no runId          → unavailable accessor (throws on read)
 */
import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { EvaluationRun, TestCase, AgentConfig } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import type { EvaluateFn } from '@/services/sourceResolver';

jest.mock('@/services/evaluation', () => ({
  runEvaluationWithConnector: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { getForAgent: jest.fn() },
}));

const TEST_AGENT_TRACES: AgentConfig = {
  key: 'traced-agent',
  name: 'Traced Agent',
  endpoint: 'http://localhost:3000',
  connectorType: 'agui-streaming',
  useTraces: true,
  // Tight polling so cases B/E don't slow the suite. fetchSpansForRun's
  // retry loop only sleeps between attempts, so 1 attempt with intervalMs
  // ignored takes ~0ms.
  tracePolling: { maxAttempts: 1, intervalMs: 0 },
};

const TEST_AGENT_NO_TRACES: AgentConfig = {
  key: 'plain-agent',
  name: 'Plain Agent',
  endpoint: 'http://localhost:3000',
  connectorType: 'agui-streaming',
  useTraces: false,
};

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      {
        key: 'traced-agent',
        name: 'Traced Agent',
        endpoint: 'http://localhost:3000',
        connectorType: 'agui-streaming',
        useTraces: true,
        tracePolling: { maxAttempts: 1, intervalMs: 0 },
      },
      {
        key: 'plain-agent',
        name: 'Plain Agent',
        endpoint: 'http://localhost:3000',
        connectorType: 'agui-streaming',
        useTraces: false,
      },
    ],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  })),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn(() => []),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn() },
}));

// The real fetchSpansForRun calls fetchTracesByRunIds which would try to
// hit a real HTTP endpoint. Stub it at the source.
jest.mock('@/services/traces/index', () => ({
  fetchTracesByRunIds: jest.fn(),
}));

import { runEvaluationWithConnector } from '@/services/evaluation';
import { fetchTracesByRunIds } from '@/services/traces/index';

const mockRunEval = runEvaluationWithConnector as jest.Mock;
const mockFetchTraces = fetchTracesByRunIds as jest.MockedFunction<typeof fetchTracesByRunIds>;

function createMockStorage(): IStorageModule {
  const passthroughCreate = jest.fn().mockImplementation((report: any) =>
    Promise.resolve({ ...report, id: report.id ?? 'report-1' })
  );
  return {
    testCases: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), bulkUpsert: jest.fn(), search: jest.fn() },
    benchmarks: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), addRun: jest.fn(), updateRun: jest.fn(), deleteRun: jest.fn() },
    runs: { getById: jest.fn(), getAll: jest.fn(), create: passthroughCreate, update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), search: jest.fn(), getByTestCase: jest.fn(), getByExperiment: jest.fn(), getByExperimentRun: jest.fn(), getIterations: jest.fn(), countsByTestCase: jest.fn(), addAnnotation: jest.fn(), updateAnnotation: jest.fn(), deleteAnnotation: jest.fn() },
    evaluationRuns: { create: jest.fn(), getById: jest.fn(), update: jest.fn(), delete: jest.fn(), list: jest.fn(), updateResult: jest.fn() },
    analytics: { query: jest.fn(), aggregations: jest.fn(), writeRecord: jest.fn(), backfill: jest.fn() },
    evaluators: { getAll: jest.fn(), getById: jest.fn(), getVersions: jest.fn(), getVersion: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    sessionMetadata: { get: jest.fn(), put: jest.fn(), list: jest.fn() },
    health: jest.fn().mockResolvedValue({ status: 'green' }),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as IStorageModule;
}

function makeRun(agentKey: string): EvaluationRun {
  return {
    id: 'run-1',
    name: 'Run',
    agentKey,
    modelId: 'claude-sonnet',
    status: 'running',
    results: {},
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}

const TC: TestCase = {
  id: 'tc-1',
  name: 'TC',
  initialPrompt: 'Test prompt',
  context: [],
} as unknown as TestCase;

function captureLastReport(storage: IStorageModule): any {
  return (storage.runs.create as jest.Mock).mock.calls[0]?.[0];
}

describe('executeEvaluationRun — issue #230 traces fixture pre-loading', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
    mockRunEval.mockResolvedValue({
      id: 'report-1',
      runId: 'agent-run-id-123',
      trajectory: [{ type: 'response', content: 'agent output' }],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 1000 },
    });
  });

  it('Case A: useTraces=false → traces fixture returns silent zeros', async () => {
    const evalFn: EvaluateFn = jest.fn(async ({ traces }: any) => {
      // Explicitly read the fixture to prove it does not throw.
      expect(traces.totalTokens).toBe(0);
      expect(traces.totalCost).toBe(0);
      expect(traces.spans).toEqual([]);
    });

    await executeEvaluationRun(makeRun('plain-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    expect(evalFn).toHaveBeenCalled();
    expect(captureLastReport(storage).passFailStatus).toBe('passed');
    // Should never poll for traces in opt-out mode.
    expect(mockFetchTraces).not.toHaveBeenCalled();
  });

  it('Case B: useTraces=true, polling yields no spans → reads on traces.* throw and the test fails', async () => {
    mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);

    let caught: unknown;
    const evalFn: EvaluateFn = jest.fn(async ({ traces }: any) => {
      try {
        // Pre-fix: this returned 0 silently → assertion passed.
        // Post-fix: reading totalTokens throws.
        const value = traces.totalTokens;
        void value;
      } catch (e) {
        caught = e;
        throw e;
      }
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    expect(mockFetchTraces).toHaveBeenCalledWith(['agent-run-id-123']);
    expect((caught as Error).message).toMatch(/traces fixture unavailable/);
    expect((caught as Error).message).toMatch(/no spans found for runId=agent-run-id-123/);
    expect(captureLastReport(storage).passFailStatus).toBe('failed');
    expect(captureLastReport(storage).assertionError).toMatch(/traces fixture unavailable/);
  });

  it('Case C: REGRESSION #230 — useTraces=true with 12k tokens makes lessThan(10_000) FAIL (was a silent pass before fix)', async () => {
    mockFetchTraces.mockResolvedValue({
      spans: [
        {
          spanId: 'a', traceId: 't', name: 'llm.call',
          startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:00:01Z',
          status: 'OK',
          attributes: {
            'gen_ai.usage.prompt_tokens': 9000,
            'gen_ai.usage.completion_tokens': 3000,
          },
        },
      ],
      total: 1,
    } as any);

    const evalFn: EvaluateFn = jest.fn(async ({ traces, expect: ahExpect }: any) => {
      ahExpect(traces.totalTokens).to.be.lessThan(10_000);
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    const report = captureLastReport(storage);
    expect(report.passFailStatus).toBe('failed');
    // Matcher session captured the failure with the real number.
    const matcherResults = report.matcherResults ?? [];
    const failed = matcherResults.find((m: any) => !m.pass);
    expect(failed).toBeDefined();
    // The error message must reflect 12000, not 0.
    expect(JSON.stringify(failed)).toMatch(/12000/);
  });

  it('Case D: useTraces=true with 5k tokens passes lessThan(10_000) using real numbers', async () => {
    mockFetchTraces.mockResolvedValue({
      spans: [
        {
          spanId: 'a', traceId: 't', name: 'llm.call',
          startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:00:01Z',
          status: 'OK',
          attributes: {
            'gen_ai.usage.prompt_tokens': 4000,
            'gen_ai.usage.completion_tokens': 1000,
          },
        },
      ],
      total: 1,
    } as any);

    const evalFn: EvaluateFn = jest.fn(async ({ traces, expect: ahExpect }: any) => {
      // Reading totalTokens gives the real aggregate, not 0.
      expect(traces.totalTokens).toBe(5000);
      ahExpect(traces.totalTokens).to.be.lessThan(10_000);
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    expect(captureLastReport(storage).passFailStatus).toBe('passed');
  });

  it('Case E: useTraces=true but agent did not return a runId → traces accessor throws on read with the no-runId reason', async () => {
    mockRunEval.mockResolvedValue({
      id: 'report-1',
      runId: undefined, // <-- missing
      trajectory: [{ type: 'response', content: 'agent output' }],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 1000 },
    });

    let caught: unknown;
    const evalFn: EvaluateFn = jest.fn(async ({ traces }: any) => {
      try {
        const value = traces.totalTokens;
        void value;
      } catch (e) {
        caught = e;
        throw e;
      }
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    expect(mockFetchTraces).not.toHaveBeenCalled();
    expect((caught as Error).message).toMatch(/produced no runId for trace correlation/);
    expect(captureLastReport(storage).passFailStatus).toBe('failed');
  });

  it('Case F (Copilot #234 review): useTraces=true + persistent fetch error → unavailable reason includes the underlying error message', async () => {
    mockFetchTraces.mockRejectedValue(new Error('OpenSearch 503: cluster overloaded'));

    let caught: unknown;
    const evalFn: EvaluateFn = jest.fn(async ({ traces }: any) => {
      try {
        const value = traces.totalTokens;
        void value;
      } catch (e) {
        caught = e;
        throw e;
      }
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    expect(mockFetchTraces).toHaveBeenCalled();
    // Crucially: the reason mentions "fetch failed" + the underlying error,
    // not the generic "no spans found". This is what Copilot's second
    // review comment on PR #234 asked for.
    expect((caught as Error).message).toMatch(/traces fixture unavailable: fetch failed for runId=agent-run-id-123: OpenSearch 503: cluster overloaded/);
    expect(captureLastReport(storage).passFailStatus).toBe('failed');
  });

  it('Case G: deterministic verdict on a useTraces=true agent must clear the trace-mode "Waiting for traces…" placeholder llmJudgeReasoning', async () => {
    // Repro: any deterministic body running against an agent with
    // `useTraces: true` produces a report whose `llmJudgeReasoning`
    // was initialised to 'Waiting for traces to become available...'
    // by the trace-mode init in `services/evaluation/index.ts`. The
    // deterministic runner overwrites metrics + matcherResults but
    // pre-fix did NOT clear that placeholder, so the UI's Judge
    // Reasoning panel showed it indefinitely — confusing users into
    // thinking the LLM judge was still pending when in fact the
    // verdict was already final.
    mockRunEval.mockResolvedValue({
      id: 'report-1',
      runId: 'agent-run-id-123',
      trajectory: [{ type: 'response', content: 'agent output' }],
      rawEvents: [],
      status: 'completed',
      metricsStatus: 'pending',
      llmJudgeReasoning: 'Waiting for traces to become available...',
      performanceMetrics: { durationMs: 1000 },
    });
    mockFetchTraces.mockResolvedValue({
      spans: [
        {
          spanId: 'a', traceId: 't', name: 'invoke_agent',
          startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:00:01Z',
          status: 'OK', attributes: {},
        },
      ],
      total: 1,
    } as any);

    const evalFn: EvaluateFn = jest.fn(async ({ result }: any) => {
      expect(result.agentOutput.length).toBeGreaterThan(0);
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    const saved = captureLastReport(storage);
    expect(saved.passFailStatus).toBe('passed');
    expect(saved.evaluationType).toBe('deterministic');
    // The placeholder must NOT survive into the saved report.
    expect(saved.llmJudgeReasoning).toBe('');
    expect(saved.llmJudgeReasoning).not.toMatch(/Waiting for traces/);
  });
});
