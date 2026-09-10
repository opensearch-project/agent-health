/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { EvaluationRun, TestCase } from '@/types';
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

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [{ key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000', connectorType: 'agui-streaming' }],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4', display_name: 'Claude Sonnet' } },
  })),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [{ key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000', connectorType: 'agui-streaming' }],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn(() => []),
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn() },
}));

// Telemetry is gated by isEvalTelemetryEnabled(); mock it so a test can inject
// a sentinel eval-span context and assert invokeAgent runs inside it (Strategy A).
jest.mock('@/lib/telemetry', () => ({
  startTestCaseSpan: jest.fn(() => null),
  finalizeTestCaseSpan: jest.fn(),
  addEvaluationResultEvents: jest.fn(),
}));

import { runEvaluationWithConnector, invokeAgent } from '@/services/evaluation';
import { startTestCaseSpan } from '@/lib/telemetry';
import { context } from '@opentelemetry/api';

const mockRunEval = runEvaluationWithConnector as jest.Mock;
const mockInvokeAgent = invokeAgent as jest.Mock;
const mockStartTestCaseSpan = startTestCaseSpan as jest.Mock;

/** Build a stub invokeAgent result (the pure invocation primitive). */
function stubInvocation(opts: {
  trajectory?: any[];
  rawEvents?: any[];
  runId?: string | null;
  agentDurationMs?: number;
} = {}) {
  return {
    trajectory: opts.trajectory ?? [],
    rawEvents: opts.rawEvents ?? [],
    runId: opts.runId ?? null,
    agentDurationMs: opts.agentDurationMs ?? 0,
    connector: { type: 'agui-streaming' } as any,
  };
}

function createMockStorage(): IStorageModule {
  return {
    testCases: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), bulkUpsert: jest.fn(), search: jest.fn() },
    benchmarks: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), addRun: jest.fn(), updateRun: jest.fn(), deleteRun: jest.fn() },
    runs: { getById: jest.fn(), getAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), bulkCreate: jest.fn(), search: jest.fn(), getByTestCase: jest.fn(), getByExperiment: jest.fn(), getByExperimentRun: jest.fn(), getIterations: jest.fn(), countsByTestCase: jest.fn(), addAnnotation: jest.fn(), updateAnnotation: jest.fn(), deleteAnnotation: jest.fn() },
    evaluationRuns: { create: jest.fn(), getById: jest.fn(), update: jest.fn(), delete: jest.fn(), list: jest.fn(), updateResult: jest.fn() },
    analytics: { query: jest.fn(), aggregations: jest.fn(), writeRecord: jest.fn(), backfill: jest.fn() },
    evaluators: { getAll: jest.fn(), getById: jest.fn(), getVersions: jest.fn(), getVersion: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    sessionMetadata: { get: jest.fn(), put: jest.fn(), list: jest.fn() },
    health: jest.fn().mockResolvedValue({ status: 'green' }),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as IStorageModule;
}

describe('executeEvaluationRun - deterministic evaluation', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
  });

  it('drives the agent via agent.run() and runs the deterministic body (no LLM judge)', async () => {
    let captured: any;
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      captured = await fixtures.agent.run('Test prompt');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-1', evaluateFn]]);

    const testCase: TestCase = {
      id: 'tc-1',
      name: 'Deterministic Test',
      initialPrompt: 'Test prompt',
      context: [],
    } as unknown as TestCase;

    const run: EvaluationRun = {
      id: 'run-1',
      name: 'Test Run',
      agentKey: 'test-agent',
      modelId: 'claude-sonnet',
      status: 'running',
      results: {},
      createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({
      trajectory: [{ type: 'response', content: 'Agent output' }],
      agentDurationMs: 1000,
    }));

    (storage.runs.create as jest.Mock).mockResolvedValue({
      id: 'report-1',
      trajectory: [{ type: 'response', content: 'Agent output' }],
      rawEvents: [],
      status: 'completed',
      passFailStatus: 'passed',
      evaluationType: 'deterministic',
      performanceMetrics: { durationMs: 1000 },
    });

    const onProgress = jest.fn();

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress,
    });

    // Control inversion: the classic eager judge path is NOT used; the body
    // invokes the agent itself via agent.run() → invokeAgent().
    expect(mockRunEval).not.toHaveBeenCalled();
    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);

    // The result returned by agent.run() carries the captured trajectory.
    expect(captured).toMatchObject({
      agentOutput: 'Agent output',
      rawEvents: [],
      durationMs: 1000,
    });
    expect(captured.trajectory).toEqual([{ type: 'response', content: 'Agent output' }]);
  });

  it('marks report as passed when evaluate function does not throw', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('P');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-1', evaluateFn]]);

    const testCase: TestCase = { id: 'tc-1', name: 'Test', initialPrompt: 'P', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({ agentDurationMs: 500 }));

    (storage.runs.create as jest.Mock).mockImplementation((report: any) => {
      expect(report.passFailStatus).toBe('passed');
      expect(report.evaluationType).toBe('deterministic');
      return Promise.resolve({ ...report, id: 'report-1' });
    });

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    expect(run.results['tc-1'].status).toBe('completed');
  });

  it('marks report as failed when evaluate function throws', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('P');
      throw new Error('expected 0 to not equal 0');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-1', evaluateFn]]);

    const testCase: TestCase = { id: 'tc-1', name: 'Test', initialPrompt: 'P', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({
      trajectory: [{ type: 'response', content: 'Bad output' }],
      agentDurationMs: 500,
    }));

    (storage.runs.create as jest.Mock).mockImplementation((report: any) => {
      expect(report.passFailStatus).toBe('failed');
      expect(report.evaluationType).toBe('deterministic');
      expect(report.assertionError).toBe('expected 0 to not equal 0');
      return Promise.resolve({ ...report, id: 'report-1' });
    });

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    // Run-level status mirrors the report's verdict so aggregate
    // stats reflect the actual pass/fail outcome.
    expect(run.results['tc-1'].status).toBe('failed');
    expect(run.results['tc-1'].passFailStatus).toBe('failed');
  });

  it('uses LLM judge path when test case is not in evaluateFnMap', async () => {
    const evaluateFnMap = new Map<string, EvaluateFn>([['other-tc', jest.fn()]]);

    const testCase: TestCase = { id: 'tc-no-eval', name: 'LLM Test', initialPrompt: 'P', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockRunEval.mockResolvedValue({
      id: 'report-1',
      trajectory: [],
      rawEvents: [],
      status: 'completed',
      passFailStatus: 'passed',
      performanceMetrics: { durationMs: 500 },
    });

    (storage.runs.create as jest.Mock).mockResolvedValue({
      id: 'report-1',
      status: 'completed',
      passFailStatus: 'passed',
    });

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    // Should NOT pass skipJudge since this test case has no evaluate function
    expect(mockRunEval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ skipJudge: false })
    );
  });

  it('skips agent invocation entirely when test case has no prompt', async () => {
    const evaluateFn: EvaluateFn = jest.fn();
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-noprompt', evaluateFn]]);

    const testCase: TestCase = {
      id: 'tc-noprompt',
      name: 'Deterministic Only',
      // No initialPrompt at all
      context: [],
      currentVersion: 1,
    } as unknown as TestCase;
    const run: EvaluationRun = {
      id: 'run-1',
      agentKey: 'test-agent',
      modelId: 'claude-sonnet',
      status: 'running',
      results: {},
      createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    let savedReport: any = null;
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => {
      savedReport = report;
      return Promise.resolve({ ...report });
    });

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    // Verify neither invocation path ran — body never called agent.run()
    expect(mockRunEval).not.toHaveBeenCalled();
    expect(mockInvokeAgent).not.toHaveBeenCalled();

    // Verify the deterministic body still ran with an empty result
    expect(evaluateFn).toHaveBeenCalledTimes(1);
    expect(evaluateFn).toHaveBeenCalledWith(expect.objectContaining({
      trajectory: [],
      agentOutput: '',
      rawEvents: [],
      durationMs: 0,
    }));

    // Verify a synthetic report was persisted with deterministic verdict
    expect(savedReport).not.toBeNull();
    expect(savedReport.passFailStatus).toBe('passed');
    expect(savedReport.evaluationType).toBe('deterministic');
    expect(savedReport.skipJudge).toBe(true);
    expect(savedReport.testCaseId).toBe('tc-noprompt');
    expect(run.results['tc-noprompt'].status).toBe('completed');
  });

  it('invokes the agent via agent.run() when the body calls it', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('Do something');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-prompt', evaluateFn]]);

    const testCase: TestCase = {
      id: 'tc-prompt',
      name: 'Hybrid',
      initialPrompt: 'Do something',
      context: [],
    } as unknown as TestCase;
    const run: EvaluationRun = {
      id: 'run-1',
      agentKey: 'test-agent',
      modelId: 'claude-sonnet',
      status: 'running',
      results: {},
      createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({ agentDurationMs: 100 }));
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => Promise.resolve({ ...report, id: 'report-1' }));

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    // invokeAgent WAS called via the body's agent.run(); the classic eager
    // judge path was not used.
    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
    expect(mockRunEval).not.toHaveBeenCalled();
  });

  it('forwards agent.run() env to invokeAgent (AgentRunOptions.env, RFC 004)', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('Do something', { env: { WORKSPACE_DIR: '/tmp/ws' } });
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-env', evaluateFn]]);

    const testCase: TestCase = {
      id: 'tc-env',
      name: 'Env forwarding',
      initialPrompt: 'Do something',
      context: [],
    } as unknown as TestCase;
    const run: EvaluationRun = {
      id: 'run-1',
      agentKey: 'test-agent',
      modelId: 'claude-sonnet',
      status: 'running',
      results: {},
      createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({ agentDurationMs: 100 }));
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => Promise.resolve({ ...report, id: 'report-1' }));

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    // The 4th arg to invokeAgent is InvokeAgentOptions — it must carry env.
    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
    expect(mockInvokeAgent.mock.calls[0][3]).toEqual(
      expect.objectContaining({ env: { WORKSPACE_DIR: '/tmp/ws' } })
    );
  });

  it('binds run.evaluatorId onto the judge fixture so destructured judge() inherits it (UI-equivalent)', async () => {
    // This is the regression test for the SDK ↔ UI evaluator-parity gap.
    // The runner must hand the test body a `judge` whose POST body to
    // /api/judge carries `run.evaluatorId` automatically — exactly what
    // the UI "Run Test" path does via callBedrockJudge → /api/judge.
    //
    // We capture the `judge` fixture the runner passes to the test body,
    // mock global.fetch, and assert the request body's `evaluatorId`
    // matches the run-level value without the body explicitly passing it.

    let capturedJudge: any;
    const evaluateFn: EvaluateFn = (fixtures: any) => {
      capturedJudge = fixtures.judge;
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-eval', evaluateFn]]);

    const testCase: TestCase = {
      id: 'tc-eval',
      name: 'Eval-bound test',
      initialPrompt: 'Investigate',
      context: [],
    } as unknown as TestCase;

    const run: EvaluationRun = {
      id: 'run-eval-1',
      agentKey: 'test-agent',
      modelId: 'claude-sonnet',
      evaluatorId: 'system-rca-default',
      status: 'running',
      results: {},
      createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    mockRunEval.mockResolvedValue({
      id: 'report-eval-1',
      trajectory: [{ type: 'response', content: 'final' }],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 50 },
    });
    (storage.runs.create as jest.Mock).mockImplementation((report: any) =>
      Promise.resolve({ ...report, id: 'report-eval-1' }),
    );

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    expect(capturedJudge).toBeDefined();

    // Now invoke the captured judge through a mocked fetch and inspect
    // the body. We don't care about the verdict here — only that the
    // run.evaluatorId rode along.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ passFailStatus: 'passed', metrics: { accuracy: 100 }, llmJudgeReasoning: '' }),
      text: async () => '',
    });
    (global as any).fetch = fetchMock as unknown as typeof fetch;

    await capturedJudge(
      { trajectory: [{ type: 'response', content: 'x' }] },
      'identifies the issue',
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.evaluatorId).toBe('system-rca-default');

    // Per-call override still wins over the bound run-level evaluator —
    // matches UI behaviour where users can pick a different evaluator
    // for a specific test.
    fetchMock.mockClear();
    await capturedJudge(
      { trajectory: [{ type: 'response', content: 'x' }] },
      'claim',
      { evaluatorId: 'user:override' },
    );
    const overrideInit = fetchMock.mock.calls[0][1] as RequestInit;
    const overrideBody = JSON.parse(overrideInit.body as string);
    expect(overrideBody.evaluatorId).toBe('user:override');
  });

  it('does not set evaluatorId on the body when run.evaluatorId is undefined (server uses default)', async () => {
    let capturedJudge: any;
    const evaluateFn: EvaluateFn = (fixtures: any) => {
      capturedJudge = fixtures.judge;
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-default', evaluateFn]]);

    const testCase: TestCase = {
      id: 'tc-default',
      name: 'Default-evaluator test',
      initialPrompt: 'Run',
      context: [],
    } as unknown as TestCase;

    const run: EvaluationRun = {
      id: 'run-default',
      agentKey: 'test-agent',
      modelId: 'claude-sonnet',
      // evaluatorId intentionally omitted
      status: 'running',
      results: {},
      createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    mockRunEval.mockResolvedValue({
      id: 'r',
      trajectory: [],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 1 },
    });
    (storage.runs.create as jest.Mock).mockImplementation((report: any) =>
      Promise.resolve({ ...report, id: 'r' }),
    );

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ passFailStatus: 'passed', metrics: { accuracy: 100 }, llmJudgeReasoning: '' }),
      text: async () => '',
    });
    (global as any).fetch = fetchMock as unknown as typeof fetch;

    await capturedJudge({ trajectory: [{ type: 'response', content: 'x' }] }, 'claim');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect('evaluatorId' in body).toBe(false);
  });

  it('reflects the agent.run() result into fixtures.result so afterEach hooks observe it (#248)', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('Investigate');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-hook', evaluateFn]]);

    // afterEach reads `result` — under control inversion it must see the
    // captured run, not the empty placeholder.
    let seenInAfterEach: any;
    const hooksByFile = new Map<string, any[]>([
      ['file.eval.js', [{
        kind: 'afterEach',
        fn: (fx: any) => { seenInAfterEach = fx.result; },
        sourceFile: 'file.eval.js',
      }]],
    ]);
    const testHookScopes = new Map<string, { sourceFile?: string; describePath?: string }>([
      ['tc-hook', { sourceFile: 'file.eval.js' }],
    ]);

    const testCase: TestCase = {
      id: 'tc-hook', name: 'Hooked', initialPrompt: 'Investigate', context: [],
    } as unknown as TestCase;
    const run: EvaluationRun = {
      id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet',
      status: 'running', results: {}, createdAt: new Date().toISOString(),
    } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({
      trajectory: [{ type: 'response', content: 'Found the root cause' }],
      agentDurationMs: 42,
    }));
    (storage.runs.create as jest.Mock).mockImplementation((report: any) =>
      Promise.resolve({ ...report, id: 'report-hook' }));

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      hooksByFile,
      testHookScopes,
      onProgress: jest.fn(),
    });

    expect(seenInAfterEach).toBeDefined();
    expect(seenInAfterEach.agentOutput).toBe('Found the root cause');
    expect(seenInAfterEach.durationMs).toBe(42);
  });

  it('observe-role judge failure does NOT fail the test (RFC 004 gate/observe)', async () => {
    // Body records an observe verdict that fails — but observe never gates.
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('Investigate');
      await fixtures.judge.observe(
        { trajectory: [{ type: 'response', content: 'x' }] },
        'some observational claim',
      );
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-obs', evaluateFn]]);
    const testCase: TestCase = { id: 'tc-obs', name: 'Obs', initialPrompt: 'Investigate', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({ trajectory: [{ type: 'response', content: 'out' }], agentDurationMs: 5 }));
    let saved: any;
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => { saved = report; return Promise.resolve({ ...report, id: 'r' }); });
    // #258 unified flow: a `running` placeholder is created first, then the
    // final report persists via runs.update(placeholderId, reportFields).
    (storage.runs.update as jest.Mock).mockImplementation((_id: any, fields: any) => { saved = fields; return Promise.resolve({ ...fields, id: _id }); });

    // Judge endpoint returns a FAILED verdict.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ passFailStatus: 'failed', metrics: { accuracy: 10 }, llmJudgeReasoning: 'off-topic' }),
      text: async () => '',
    });

    await executeEvaluationRun(run, [testCase], { storageModule: storage, evaluateFnMap, onProgress: jest.fn() });

    // Observe verdict failed, but the test still PASSES (observe never gates).
    expect(saved.passFailStatus).toBe('passed');
    expect(run.results['tc-obs'].status).toBe('completed');
  });

  it('judge endpoint error buckets the run as errored (not failed)', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('Investigate');
      await fixtures.judge({ trajectory: [{ type: 'response', content: 'x' }] }, 'a claim');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-err', evaluateFn]]);
    const testCase: TestCase = { id: 'tc-err', name: 'Err', initialPrompt: 'Investigate', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockInvokeAgent.mockResolvedValue(stubInvocation({ trajectory: [{ type: 'response', content: 'out' }], agentDurationMs: 5 }));
    let saved: any;
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => { saved = report; return Promise.resolve({ ...report, id: 'r' }); });
    // #258 unified flow: final report persists via runs.update(placeholderId, reportFields).
    (storage.runs.update as jest.Mock).mockImplementation((_id: any, fields: any) => { saved = fields; return Promise.resolve({ ...fields, id: _id }); });

    // Judge endpoint errors (HTTP 500).
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({}), text: async () => 'judge boom',
    });

    await executeEvaluationRun(run, [testCase], { storageModule: storage, evaluateFnMap, onProgress: jest.fn() });

    // Errored, not failed: metricsStatus 'error', passFailStatus cleared.
    expect(saved.metricsStatus).toBe('error');
    expect(saved.passFailStatus).toBeNull();
    expect(saved.traceError).toMatch(/judge boom/);
  });

  it('custom evaluate() fixture gates the test (#244)', async () => {
    const { defineEvaluator, clearEvaluators } = require('@/lib/testCases/evaluators');
    clearEvaluators();
    defineEvaluator('output-is-ok', ({ result }: any) => ({
      pass: result.agentOutput.includes('root cause'),
      reasoning: 'must mention root cause',
    }));

    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      const result = await fixtures.agent.run('Investigate');
      await fixtures.evaluate(result, 'output-is-ok');
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-ce', evaluateFn]]);
    const testCase: TestCase = { id: 'tc-ce', name: 'CE', initialPrompt: 'Investigate', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;
    let saved: any;
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => { saved = report; return Promise.resolve({ ...report, id: 'r' }); });
    // #258 unified flow: final report persists via runs.update(placeholderId, reportFields).
    (storage.runs.update as jest.Mock).mockImplementation((_id: any, fields: any) => { saved = fields; return Promise.resolve({ ...fields, id: _id }); });

    // Agent output does NOT mention 'root cause' → evaluator fails → test fails.
    mockInvokeAgent.mockResolvedValue(stubInvocation({ trajectory: [{ type: 'response', content: 'all good' }], agentDurationMs: 3 }));
    await executeEvaluationRun(run, [testCase], { storageModule: storage, evaluateFnMap, onProgress: jest.fn() });
    expect(saved.passFailStatus).toBe('failed');
    const ev = (saved.matcherResults ?? []).find((m: any) => m.method === 'evaluator');
    expect(ev).toBeDefined();
    expect(ev.pass).toBe(false);

    // Now output mentions it → evaluator passes → test passes.
    mockInvokeAgent.mockResolvedValue(stubInvocation({ trajectory: [{ type: 'response', content: 'the root cause is X' }], agentDurationMs: 3 }));
    run.results = {};
    await executeEvaluationRun(run, [testCase], { storageModule: storage, evaluateFnMap, onProgress: jest.fn() });
    expect(saved.passFailStatus).toBe('passed');
  });

  it('forwards agent.run(prompt, { env }) through to invokeAgent (#256 §4.6)', async () => {
    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => {
      await fixtures.agent.run('Investigate', { env: { WORKSPACE_DIR: '/tmp/ws', TOKEN: 'abc' } });
    });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-env', evaluateFn]]);
    const testCase: TestCase = { id: 'tc-env', name: 'Env', initialPrompt: 'Investigate', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;
    mockInvokeAgent.mockResolvedValue(stubInvocation({ trajectory: [{ type: 'response', content: 'out' }], agentDurationMs: 1 }));
    (storage.runs.create as jest.Mock).mockImplementation((r: any) => Promise.resolve({ ...r, id: 'r' }));

    await executeEvaluationRun(run, [testCase], { storageModule: storage, evaluateFnMap, onProgress: jest.fn() });

    // invokeAgent must receive the structured env on its options arg, not drop it.
    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
    const optsArg = mockInvokeAgent.mock.calls[0][3];
    expect(optsArg.env).toEqual({ WORKSPACE_DIR: '/tmp/ws', TOKEN: 'abc' });
  });

  it('runs invokeAgent inside the eval-span OTel context so connectors propagate trace context (#256, Strategy A)', async () => {
    // Inject a sentinel eval-span context; the runner must make it active
    // (via context.with) while invokeAgent runs — that is what lets connectors
    // propagate W3C trace context to the agent (AGENTS.md Strategy A).
    const sentinelCtx = context.active().setValue(Symbol('eval-span'), true);
    const fakeSpan = { setAttribute: jest.fn(), setStatus: jest.fn(), end: jest.fn() };
    mockStartTestCaseSpan.mockImplementation(() => ({ span: fakeSpan, context: sentinelCtx }));

    // No OTel SDK/context-manager is registered in unit tests, so context.active()
    // can't observe the wrap directly (NoopContextManager). Spy on context.with to
    // assert the runner activates the eval-span context around the invocation — the
    // noop `with` still executes its callback, so invokeAgent runs as normal.
    const withSpy = jest.spyOn(context, 'with');
    let invokeRan = false;
    mockInvokeAgent.mockImplementation(async () => {
      invokeRan = true;
      return stubInvocation({ trajectory: [{ type: 'response', content: 'out' }], agentDurationMs: 1 });
    });

    const evaluateFn: EvaluateFn = jest.fn(async (fixtures: any) => { await fixtures.agent.run('Investigate'); });
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-otel', evaluateFn]]);
    const testCase: TestCase = { id: 'tc-otel', name: 'Otel', initialPrompt: 'Investigate', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;
    (storage.runs.create as jest.Mock).mockImplementation((r: any) => Promise.resolve({ ...r, id: 'r' }));

    await executeEvaluationRun(run, [testCase], { storageModule: storage, evaluateFnMap, onProgress: jest.fn() });

    expect(mockStartTestCaseSpan).toHaveBeenCalled();
    expect(invokeRan).toBe(true);
    // The invocation must be wrapped in the eval span's context (Strategy A).
    const wrappedInEvalSpan = withSpy.mock.calls.some((c) => c[0] === sentinelCtx);
    expect(wrappedInEvalSpan).toBe(true);
    withSpy.mockRestore();
  });
});
