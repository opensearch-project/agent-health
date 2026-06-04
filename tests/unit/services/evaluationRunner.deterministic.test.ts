/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import type { EvaluateFn } from '@/services/sourceResolver';

jest.mock('@/services/evaluation', () => ({
  runEvaluationWithConnector: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/services/connectors/server', () => ({
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

import { runEvaluationWithConnector } from '@/services/evaluation';

const mockRunEval = runEvaluationWithConnector as jest.Mock;

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

  it('calls evaluate function instead of LLM judge when evaluateFnMap has entry', async () => {
    const evaluateFn: EvaluateFn = jest.fn();
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

    mockRunEval.mockResolvedValue({
      id: 'report-1',
      trajectory: [{ type: 'response', content: 'Agent output' }],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 1000 },
    });

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

    // Verify skipJudge was passed
    expect(mockRunEval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ skipJudge: true })
    );

    // Verify evaluate function was called with correct args
    expect(evaluateFn).toHaveBeenCalledWith(expect.objectContaining({
      trajectory: [{ type: 'response', content: 'Agent output' }],
      agentOutput: 'Agent output',
      rawEvents: [],
      durationMs: 1000,
    }));
  });

  it('marks report as passed when evaluate function does not throw', async () => {
    const evaluateFn: EvaluateFn = jest.fn();
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-1', evaluateFn]]);

    const testCase: TestCase = { id: 'tc-1', name: 'Test', initialPrompt: 'P', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockRunEval.mockResolvedValue({
      id: 'report-1',
      trajectory: [],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 500 },
    });

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
    const evaluateFn: EvaluateFn = jest.fn().mockRejectedValue(new Error('expected 0 to not equal 0'));
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-1', evaluateFn]]);

    const testCase: TestCase = { id: 'tc-1', name: 'Test', initialPrompt: 'P', context: [] } as unknown as TestCase;
    const run: EvaluationRun = { id: 'run-1', agentKey: 'test-agent', modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;

    mockRunEval.mockResolvedValue({
      id: 'report-1',
      trajectory: [{ type: 'response', content: 'Bad output' }],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 500 },
    });

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

    // Verify the connector was NEVER called — agent invocation skipped
    expect(mockRunEval).not.toHaveBeenCalled();

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

  it('still calls agent when prompt is present even if evaluate function exists', async () => {
    const evaluateFn: EvaluateFn = jest.fn();
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

    mockRunEval.mockResolvedValue({
      id: 'report-1',
      trajectory: [],
      rawEvents: [],
      status: 'completed',
      performanceMetrics: { durationMs: 100 },
    });
    (storage.runs.create as jest.Mock).mockImplementation((report: any) => Promise.resolve({ ...report, id: 'report-1' }));

    await executeEvaluationRun(run, [testCase], {
      storageModule: storage,
      evaluateFnMap,
      onProgress: jest.fn(),
    });

    // Connector WAS called — prompt is present
    expect(mockRunEval).toHaveBeenCalledTimes(1);
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
      evaluatorId: 'system:cp-oncall',
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
    expect(body.evaluatorId).toBe('system:cp-oncall');

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
});
