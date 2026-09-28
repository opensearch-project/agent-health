/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for services/evaluation/tracePolling.ts — the trace-mode polled
 * judge shared by `/api/evaluate` (runSingleUseCase) and boot-time trace
 * recovery. Ported from the former services/benchmarkRunner.ts suite, which
 * exercised the same callbacks through the removed legacy runner.
 */

import {
  startTracePollingForReportWithModule,
  refreshBenchmarkRunStats,
} from '@/services/evaluation/tracePolling';
import type { EvaluationReport, TestCase } from '@/types';

const mockCallBedrockJudge = jest.fn();
jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  callBedrockJudge: (...args: any[]) => mockCallBedrockJudge(...args),
}));

const mockStartPollingAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPollingAsync: (...args: any[]) => mockStartPollingAsync(...args),
  },
}));

const mockEmitDeferredTestCaseSpan = jest.fn();
jest.mock('@/lib/telemetry', () => ({
  ...jest.requireActual('@/lib/telemetry'),
  emitDeferredTestCaseSpan: (...args: any[]) => mockEmitDeferredTestCaseSpan(...args),
}));

const mockGetCustomAgents = jest.fn().mockReturnValue([]);
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: (...args: any[]) => mockGetCustomAgents(...args),
}));

const mockConfig = {
  agents: [
    {
      key: 'test-agent',
      name: 'Test Agent',
      endpoint: 'http://test-agent.example.com',
      headers: {},
      traceServiceName: 'test-agent-service',
      tracePolling: { intervalMs: 250, maxAttempts: 7 },
    },
  ],
  models: {
    'claude-sonnet': { model_id: 'anthropic.claude-3-sonnet-20240229-v1:0', display_name: 'Claude Sonnet' },
  },
};
jest.mock('@/lib/constants', () => ({
  get DEFAULT_CONFIG() { return mockConfig; },
}));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => mockConfig,
}));

const mockRunsUpdate = jest.fn().mockResolvedValue({});
const mockRunsGetById = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksUpdateRun = jest.fn().mockResolvedValue(true);
const storage = {
  runs: { update: mockRunsUpdate, getById: mockRunsGetById },
  benchmarks: { getById: mockBenchmarksGetById, updateRun: mockBenchmarksUpdateRun },
} as any;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const testCase = {
  id: 'tc-1',
  name: 'Test Case',
  initialPrompt: 'Prompt',
  expectedOutcomes: ['Expected outcome 1'],
  expectedTrajectory: [],
} as unknown as TestCase;

const report = (overrides: Partial<EvaluationReport> = {}): EvaluationReport => ({
  id: 'saved-report-1',
  runId: 'trace-run-id',
  metricsStatus: 'pending',
  modelId: 'claude-sonnet',
  agentKey: 'test-agent',
  trajectory: [],
  ...overrides,
} as unknown as EvaluationReport);

const judgment = {
  passFailStatus: 'passed',
  metrics: { accuracy: 95 },
  llmJudgeReasoning: 'Test passed',
  improvementStrategies: [],
};

/** Start polling and return the callbacks/options handed to the poller. */
async function startAndCapture(r: EvaluationReport) {
  await startTracePollingForReportWithModule(r, testCase, storage);
  const call = mockStartPollingAsync.mock.calls[0];
  return { reportId: call[0], runId: call[1], callbacks: call[2], options: call[3] };
}

describe('startTracePollingForReportWithModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartPollingAsync.mockResolvedValue(undefined);
    mockRunsUpdate.mockResolvedValue({});
    mockGetCustomAgents.mockReturnValue([]);
  });

  it('polls with the report id + runId and forwards the agent config (hooks, polling overrides)', async () => {
    const { reportId, runId, options } = await startAndCapture(report());
    expect(reportId).toBe('saved-report-1');
    expect(runId).toBe('trace-run-id');
    expect(options.agentConfig?.key).toBe('test-agent');
    expect(options.intervalMs).toBe(250);
    expect(options.maxAttempts).toBe(7);
  });

  it('starts polling even when runId is missing (sessionId/window/traceId correlation)', async () => {
    const { runId } = await startAndCapture(report({ runId: undefined }));
    expect(runId).toBeUndefined();
    expect(mockStartPollingAsync).toHaveBeenCalledTimes(1);
  });

  it('should call Bedrock judge when traces are found and persist the verdict on the canonical matcher surface', async () => {
    mockCallBedrockJudge.mockResolvedValue(judgment);
    const { callbacks } = await startAndCapture(report());

    const spans = [{ traceId: 'trace-1', name: 'test-span' }];
    const updatedReport = { id: 'saved-report-1', trajectory: [{ type: 'response', content: 'Traced response' }] };
    await callbacks.onTracesFound(spans, updatedReport);

    expect(mockCallBedrockJudge).toHaveBeenCalledWith(
      updatedReport.trajectory,
      expect.objectContaining({ expectedOutcomes: testCase.expectedOutcomes }),
      [],
      expect.any(Function),
      'anthropic.claude-3-sonnet-20240229-v1:0',
      undefined,
      'trace-run-id',
      // Strategy C hints carry the connector's service name.
      expect.arrayContaining([expect.objectContaining({ serviceName: 'test-agent-service' })])
    );
    expect(mockRunsUpdate).toHaveBeenCalledWith('saved-report-1', expect.objectContaining({
      trajectory: updatedReport.trajectory,
      metricsStatus: 'ready',
      passFailStatus: 'passed',
      matcherResults: [expect.objectContaining({ method: 'llm-judge', pass: true })],
      llmJudgeResponse: expect.objectContaining({ modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' }),
    }));
    expect(mockEmitDeferredTestCaseSpan).toHaveBeenCalledWith(
      testCase,
      expect.objectContaining({ passFailStatus: 'passed' }),
      { name: 'standalone:test-agent' },
      'saved-report-1',
      'trace-run-id',
      undefined,
      undefined,
      'trace-1'
    );
  });

  it('prefers report.judgeModelId over the agent model for the polled judge', async () => {
    mockCallBedrockJudge.mockResolvedValue(judgment);
    const { callbacks } = await startAndCapture(report({ judgeModelId: 'judge-model-x', evaluatorId: 'eval-1' } as any));

    await callbacks.onTracesFound([], { id: 'saved-report-1', trajectory: [] });

    expect(mockCallBedrockJudge.mock.calls[0][4]).toBe('judge-model-x');
    expect(mockCallBedrockJudge.mock.calls[0][5]).toBe('eval-1');
  });

  it('regression: forwards a fallback runId (traceId) to the agent-trace judge when the connector never returned one (#trace-poll-fix)', async () => {
    mockCallBedrockJudge.mockResolvedValue(judgment);
    const { callbacks } = await startAndCapture(report({ runId: undefined, traceId: 'eval-trace-id-123' } as any));

    await callbacks.onTracesFound([{ traceId: 'agent-own-trace-id', name: 'test-span' }], { id: 'saved-report-1', trajectory: [] });

    expect(mockCallBedrockJudge.mock.calls[0][6]).toBe('eval-trace-id-123');
  });

  it('regression: falls back to undefined (fail-closed) when neither runId nor traceId are available, NOT a fabricated report.id', async () => {
    mockCallBedrockJudge.mockResolvedValue(judgment);
    const { callbacks } = await startAndCapture(report({ runId: undefined, traceId: undefined } as any));

    await callbacks.onTracesFound([{ traceId: 'agent-own-trace-id', name: 'test-span' }], { id: 'saved-report-1', trajectory: [] });

    expect(mockCallBedrockJudge.mock.calls[0][6]).toBeUndefined();
  });

  it('should handle judge errors gracefully (canonical evaluator-error patch)', async () => {
    mockCallBedrockJudge.mockRejectedValue(new Error('Judge failed'));
    const { callbacks } = await startAndCapture(report());

    await callbacks.onTracesFound([], { id: 'saved-report-1', trajectory: [] });

    expect(mockRunsUpdate).toHaveBeenCalledWith('saved-report-1', expect.objectContaining({
      metricsStatus: 'error',
      traceError: expect.stringContaining('Judge evaluation failed'),
    }));
  });

  it('refreshes the parent benchmark run stats after a verdict and after a judge failure', async () => {
    mockBenchmarksGetById.mockResolvedValue({
      id: 'bench-1',
      runs: [{ id: 'run-1', results: { 'tc-1': { reportId: 'saved-report-1', status: 'completed' } } }],
    });
    mockRunsGetById.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready', passFailStatus: 'passed' });
    mockCallBedrockJudge.mockResolvedValue(judgment);
    const { callbacks } = await startAndCapture(report({ experimentId: 'bench-1', experimentRunId: 'run-1' } as any));

    await callbacks.onTracesFound([{ traceId: 't' }], { id: 'saved-report-1', trajectory: [] });
    expect(mockBenchmarksUpdateRun).toHaveBeenCalledWith('bench-1', 'run-1', expect.objectContaining({
      stats: { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 },
    }));
    expect(mockEmitDeferredTestCaseSpan.mock.calls[0][2]).toEqual({ name: 'benchmark:bench-1' });
    expect(mockEmitDeferredTestCaseSpan.mock.calls[0][3]).toBe('run-1');

    mockBenchmarksUpdateRun.mockClear();
    mockCallBedrockJudge.mockRejectedValue(new Error('boom'));
    await callbacks.onTracesFound([], { id: 'saved-report-1', trajectory: [] });
    expect(mockBenchmarksUpdateRun).toHaveBeenCalledTimes(1);
  });

  it('onAttempt is a no-op and onError logs', async () => {
    const { callbacks } = await startAndCapture(report());
    expect(() => callbacks.onAttempt(1, 10)).not.toThrow();
    callbacks.onError(new Error('Polling failed'));
    expect(console.error).toHaveBeenCalled();
  });
});

describe('refreshBenchmarkRunStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBenchmarksUpdateRun.mockResolvedValue(true);
  });

  it('buckets reports into passed / failed / errored / pending and clears a stale judgeFailureSummary', async () => {
    mockBenchmarksGetById.mockResolvedValue({
      id: 'bench-1',
      runs: [{
        id: 'run-1',
        results: {
          a: { reportId: 'r-a', status: 'completed' },
          b: { reportId: 'r-b', status: 'completed' },
          c: { reportId: 'r-c', status: 'completed' },
          d: { reportId: 'r-d', status: 'completed' },
          e: { reportId: '', status: 'pending' },
        },
      }],
    });
    mockRunsGetById.mockImplementation(async (id: string) => ({
      'r-a': { id, metricsStatus: 'ready', passFailStatus: 'passed' },
      'r-b': { id, metricsStatus: 'ready', passFailStatus: 'failed' },
      'r-c': { id, metricsStatus: 'error', traceError: 'Judge evaluation failed: x' },
      'r-d': { id, metricsStatus: 'pending' },
    } as any)[id]);

    await refreshBenchmarkRunStats(storage, 'bench-1', 'r-a');

    expect(mockBenchmarksUpdateRun).toHaveBeenCalledWith('bench-1', 'run-1', expect.objectContaining({
      stats: { passed: 1, failed: 1, pending: 2, errored: 1, total: 5 },
    }));
    expect(mockBenchmarksUpdateRun.mock.calls[0][2]).toHaveProperty('judgeFailureSummary');
  });

  it('is a no-op when the benchmark or the owning run cannot be found', async () => {
    mockBenchmarksGetById.mockResolvedValueOnce(null);
    await refreshBenchmarkRunStats(storage, 'missing', 'r-a');
    mockBenchmarksGetById.mockResolvedValueOnce({ id: 'bench-1', runs: [{ id: 'run-1', results: {} }] });
    await refreshBenchmarkRunStats(storage, 'bench-1', 'r-unowned');
    expect(mockBenchmarksUpdateRun).not.toHaveBeenCalled();
  });

  it('never throws — storage errors are logged', async () => {
    mockBenchmarksGetById.mockRejectedValue(new Error('storage down'));
    await expect(refreshBenchmarkRunStats(storage, 'bench-1', 'r-a')).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
