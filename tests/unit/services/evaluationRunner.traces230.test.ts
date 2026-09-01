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
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/connectors/server', () => ({
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

// The real fetchSpansForRun calls fetchTracesForRun (runId + service-window
// union) which would hit a real HTTP endpoint. Stub it at the source.
jest.mock('@/services/traces/index', () => ({
  fetchTracesForRun: jest.fn(),
}));

import { runEvaluationWithConnector, invokeAgent } from '@/services/evaluation';
import { fetchTracesForRun } from '@/services/traces/index';

const mockRunEval = runEvaluationWithConnector as jest.Mock;
const mockInvokeAgent = invokeAgent as jest.Mock;
const mockFetchTraces = fetchTracesForRun as jest.MockedFunction<typeof fetchTracesForRun>;

/** Build a stub invokeAgent result (the pure invocation primitive). */
function stubInvocation(opts: { runId?: string | null } = {}) {
  return {
    trajectory: [{ type: 'response', content: 'agent output' }],
    rawEvents: [],
    runId: 'runId' in opts ? (opts.runId ?? undefined) : 'agent-run-id-123',
    agentDurationMs: 1000,
    connector: { type: 'agui-streaming' } as any,
  };
}

function createMockStorage(): IStorageModule {
  // Cross-surface parity (commit fd984c9e): the runner now pre-persists a
  // placeholder via `runs.create` and updates it via `runs.update`. Both
  // need to return the persisted doc so downstream `savedReport.X` reads
  // don't blow up. We track docs by id so the update path returns the
  // merged shape — mirrors the real adapter.
  const docs = new Map<string, any>();
  const passthroughCreate = jest.fn().mockImplementation((report: any) => {
    const id = report.id ?? `report-${docs.size + 1}`;
    const doc = { ...report, id };
    docs.set(id, doc);
    return Promise.resolve(doc);
  });
  const passthroughUpdate = jest.fn().mockImplementation((id: string, updates: any) => {
    const existing = docs.get(id) || { id };
    const merged = { ...existing, ...updates, id };
    docs.set(id, merged);
    return Promise.resolve(merged);
  });
  return {
    testCases: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), bulkUpsert: jest.fn(), search: jest.fn() },
    benchmarks: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), addRun: jest.fn(), updateRun: jest.fn(), deleteRun: jest.fn() },
    runs: { getById: jest.fn(), getAll: jest.fn(), create: passthroughCreate, update: passthroughUpdate, delete: jest.fn(), bulkCreate: jest.fn(), search: jest.fn(), getByTestCase: jest.fn(), getByExperiment: jest.fn(), getByExperimentRun: jest.fn(), getIterations: jest.fn(), countsByTestCase: jest.fn(), addAnnotation: jest.fn(), updateAnnotation: jest.fn(), deleteAnnotation: jest.fn() },
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
  // Cross-surface parity (commit fd984c9e): the FIRST `runs.create` call is
  // the running-placeholder; the FINAL report shape lands on `runs.update`.
  // Prefer the update-call payload when present, fall back to the create-
  // call payload for tests that exercise the no-prompt / pre-completion path.
  const updateCalls = (storage.runs.update as jest.Mock).mock.calls;
  if (updateCalls.length > 0) {
    // update is invoked as (placeholderId, reportFields) — return reportFields.
    return updateCalls[updateCalls.length - 1][1];
  }
  const createCalls = (storage.runs.create as jest.Mock).mock.calls;
  return createCalls[createCalls.length - 1]?.[0];
}

describe('executeEvaluationRun — issue #230 traces fixture pre-loading', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
    mockInvokeAgent.mockResolvedValue(stubInvocation());
  });

  it('Case A: useTraces=false → traces fixture returns silent zeros', async () => {
    const evalFn: EvaluateFn = jest.fn(async ({ agent, traces }: any) => {
      await agent.run('Test prompt');
      // Explicitly read the fixture to prove it does not throw.
      expect(traces.totalTokens).toBe(0);
      expect(traces.totalCost).toBe(0);
      expect(traces.spans).toEqual([]);
      // costSource passthrough (mirrors totalTokens/totalCost above): the
      // opt-out accessor reports 'none' rather than throwing or guessing.
      expect(traces.costSource).toBe('none');
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

  it('Case F: body never calls agent.run() but reads traces.totalTokens → throws the "after agent.run()" message (#8)', async () => {
    // Data-only / no-agent-run bodies cannot read traces: the accessor starts
    // unavailable and only the invoke callback swaps in a real one. Lock the
    // exact contract message so it is a stable, discoverable error.
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

    expect(evalFn).toHaveBeenCalled();
    expect((caught as Error).message).toMatch(/only available after agent\.run\(\) has been called/);
    // No agent.run() → no invocation, no trace polling.
    expect(mockInvokeAgent).not.toHaveBeenCalled();
    expect(mockFetchTraces).not.toHaveBeenCalled();
  });

  it('Case B: useTraces=true, polling yields no spans → reads on traces.* throw and the test fails', async () => {
    mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);

    let caught: unknown;
    const evalFn: EvaluateFn = jest.fn(async ({ agent, traces }: any) => {
      await agent.run('Test prompt');
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

    expect(mockFetchTraces).toHaveBeenCalledWith({
      runId: 'agent-run-id-123',
      includeWindowFallback: false,
      windowAgents: undefined,
    });
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

    const evalFn: EvaluateFn = jest.fn(async ({ agent, traces, expect: ahExpect }: any) => {
      await agent.run('Test prompt');
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

    const evalFn: EvaluateFn = jest.fn(async ({ agent, traces, expect: ahExpect }: any) => {
      const result = await agent.run('Test prompt');
      // Reading totalTokens gives the real aggregate, not 0.
      expect(traces.totalTokens).toBe(5000);
      ahExpect(traces.totalTokens).to.be.lessThan(10_000);
      // RFC 004 §4.6: traces are also exposed on the result itself.
      expect(result.traces).toBeDefined();
      expect(result.traces.totalTokens).toBe(5000);
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    expect(captureLastReport(storage).passFailStatus).toBe('passed');
  });

  it('Case E: useTraces=true but agent did not return a runId → traces accessor throws on read with the no-runId reason', async () => {
    mockInvokeAgent.mockResolvedValue(stubInvocation({ runId: undefined }));

    let caught: unknown;
    const evalFn: EvaluateFn = jest.fn(async ({ agent, traces }: any) => {
      await agent.run('Test prompt');
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
    expect((caught as Error).message).toMatch(/produced neither a runId nor a service-name window for trace correlation/);
    expect(captureLastReport(storage).passFailStatus).toBe('failed');
  });

  it('Case F (Copilot #234 review): useTraces=true + persistent fetch error → unavailable reason includes the underlying error message', async () => {
    mockFetchTraces.mockRejectedValue(new Error('OpenSearch 503: cluster overloaded'));

    let caught: unknown;
    const evalFn: EvaluateFn = jest.fn(async ({ agent, traces }: any) => {
      await agent.run('Test prompt');
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
    // `useTraces: true` must not surface a stale "Waiting for traces…"
    // placeholder. Under control inversion the report starts from
    // synthesizeEmptyReport (llmJudgeReasoning: '') and the deterministic
    // branch re-asserts '' — the placeholder can never appear. This guards
    // against a regression where the trace-mode placeholder leaked into the
    // saved report and the UI's Judge Reasoning panel showed it forever.
    mockInvokeAgent.mockResolvedValue(stubInvocation());
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

    const evalFn: EvaluateFn = jest.fn(async ({ agent }: any) => {
      const result = await agent.run('Test prompt');
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

  it('#334: a code-eval run attaches report.traceId + spans from the fetched traces (Traces tab renders for SDK runs)', async () => {
    mockInvokeAgent.mockResolvedValue(stubInvocation());
    mockFetchTraces.mockResolvedValue({
      spans: [
        {
          spanId: 'a', traceId: 'trace-xyz', name: 'invoke_agent',
          startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:00:01Z',
          status: 'OK', attributes: {},
        },
      ],
      total: 1,
    } as any);

    const evalFn: EvaluateFn = jest.fn(async ({ agent }: any) => {
      const result = await agent.run('Test prompt');
      expect(result.agentOutput.length).toBeGreaterThan(0);
    });

    await executeEvaluationRun(makeRun('traced-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    const saved = captureLastReport(storage);
    expect(saved.passFailStatus).toBe('passed');
    // Pre-fix the deterministic path left these unset → empty Traces tab. Now it
    // reuses the spans the pre-poll already fetched from OpenSearch.
    expect(saved.traceId).toBe('trace-xyz');
    expect(saved.spans).toHaveLength(1);
  });

  it('#335: an agent subprocess timeout is surfaced as an `errored` report (not a silent `failed`)', async () => {
    // agent.run() rejects → capturedResult never set → the run must be bucketed
    // `errored` (excluded from pass-rate) with the underlying timeout surfaced,
    // instead of a silent `failed` with an empty Judge card.
    mockInvokeAgent.mockRejectedValue(new Error('Subprocess timed out after 600000ms'));

    const evalFn: EvaluateFn = jest.fn(async ({ agent }: any) => {
      await agent.run('Test prompt');
    });

    await executeEvaluationRun(makeRun('plain-agent'), [TC], {
      storageModule: storage,
      evaluateFnMap: new Map([[TC.id, evalFn]]),
      onProgress: jest.fn(),
    });

    const saved = captureLastReport(storage);
    expect(saved.metricsStatus).toBe('error');
    expect(saved.passFailStatus).toBeNull();
    expect(saved.llmJudgeReasoning).toMatch(/Agent run did not complete/);
    expect(saved.llmJudgeReasoning).toMatch(/Subprocess timed out after 600000ms/);
    expect(saved.assertionError).toMatch(/Subprocess timed out after 600000ms/);
  });
});
