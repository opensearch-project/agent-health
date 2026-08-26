/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ensureTracePollingForReport } from '@/services/traces/browserRecovery';
import { tracePollingManager } from '@/services/traces/tracePoller';
import { asyncRunStorage } from '@/services/storage';
import { callBedrockJudge } from '@/services/evaluation';
import type { EvaluationReport, TestCase } from '@/types';

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    getState: jest.fn(),
    startPolling: jest.fn(),
    stopPolling: jest.fn(),
  },
}));

jest.mock('@/services/storage', () => ({
  asyncRunStorage: {
    updateReport: jest.fn(),
    getReportById: jest.fn(),
  },
}));

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  callBedrockJudge: jest.fn(),
}));

const mockGetState = tracePollingManager.getState as jest.MockedFunction<typeof tracePollingManager.getState>;
const mockStartPolling = tracePollingManager.startPolling as jest.MockedFunction<typeof tracePollingManager.startPolling>;
const mockUpdateReport = asyncRunStorage.updateReport as jest.MockedFunction<typeof asyncRunStorage.updateReport>;
const mockGetReportById = asyncRunStorage.getReportById as jest.MockedFunction<typeof asyncRunStorage.getReportById>;
const mockCallBedrockJudge = callBedrockJudge as jest.MockedFunction<typeof callBedrockJudge>;

function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'r1',
    timestamp: new Date().toISOString(),
    testCaseId: 'tc-1',
    agentName: 'demo',
    modelName: 'claude',
    status: 'completed',
    trajectory: [],
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 } as any,
    llmJudgeReasoning: '',
    runId: 'run-abc',
    metricsStatus: 'pending',
    ...overrides,
  } as EvaluationReport;
}

function makeTc(): TestCase {
  return {
    id: 'tc-1',
    name: 'Test',
    description: '',
    labels: [],
    category: 'RCA' as any,
    difficulty: 'Medium' as any,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '',
    updatedAt: '',
    initialPrompt: 'q',
    expectedOutcomes: { rootCauses: [], requiredFacts: [], conclusions: [] } as any,
    expectedTrajectory: [],
  } as unknown as TestCase;
}

describe('ensureTracePollingForReport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetState.mockReturnValue(undefined);
  });

  it('starts polling for a pending trace-mode report', () => {
    ensureTracePollingForReport(makeReport(), makeTc());
    expect(mockStartPolling).toHaveBeenCalledTimes(1);
    expect(mockStartPolling.mock.calls[0][0]).toBe('r1');
    expect(mockStartPolling.mock.calls[0][1]).toBe('run-abc');
  });

  it('is a no-op for non-pending reports', () => {
    ensureTracePollingForReport(makeReport({ metricsStatus: 'ready' }), makeTc());
    ensureTracePollingForReport(makeReport({ metricsStatus: 'error' }), makeTc());
    ensureTracePollingForReport(makeReport({ metricsStatus: undefined }), makeTc());
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('starts polling even when runId is missing (sessionId/window correlation)', () => {
    // REST-connector reports never carry a runId; the poller now derives
    // sessionId/service-window hints from the report, so recovery must not
    // skip them (they previously sat pending until boot recovery tombstoned
    // them).
    ensureTracePollingForReport(makeReport({ runId: undefined }), makeTc());
    expect(mockStartPolling).toHaveBeenCalledWith('r1', undefined, expect.anything());
  });

  it('respects minPendingAgeMs for freshly-created reports', () => {
    ensureTracePollingForReport(
      makeReport({ timestamp: new Date().toISOString() }),
      makeTc(),
      { minPendingAgeMs: 3 * 60 * 1000 }
    );
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('is a no-op when test case is null', () => {
    ensureTracePollingForReport(makeReport(), null);
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('is a no-op when polling is already running for this report', () => {
    mockGetState.mockReturnValue({ running: true } as any);
    ensureTracePollingForReport(makeReport(), makeTc());
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('writes ready + judge results to storage on traces-found and notifies onUpdated', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100 } as any,
      llmJudgeReasoning: 'good',
      improvementStrategies: [],
    } as any);
    mockUpdateReport.mockResolvedValue({} as any);
    const onUpdated = jest.fn();
    const fresh = makeReport({ metricsStatus: 'ready', passFailStatus: 'passed' });
    // First read = the true-fallback guard (still pending → proceed);
    // second read = post-update refresh handed to onUpdated.
    mockGetReportById
      .mockResolvedValueOnce(makeReport())
      .mockResolvedValue(fresh);

    ensureTracePollingForReport(makeReport(), makeTc(), { onUpdated });
    await captured.onTracesFound([], makeReport());

    expect(mockCallBedrockJudge).toHaveBeenCalledTimes(1);
    expect(mockUpdateReport).toHaveBeenCalledWith('r1', expect.objectContaining({
      metricsStatus: 'ready',
      passFailStatus: 'passed',
    }));
    expect(onUpdated).toHaveBeenCalledWith(fresh);
  });

  // Issue #320: the browser recovery poller must be a TRUE fallback — when
  // the server-side poller (a different runtime the local "already polling"
  // guard cannot see) has already produced a verdict, the browser must not
  // judge again or overwrite it.
  it('skips the judge when the persisted report already has a verdict (server won the race)', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    const serverVerdict = makeReport({ metricsStatus: 'ready', passFailStatus: 'failed' });
    mockGetReportById.mockResolvedValue(serverVerdict);
    const onUpdated = jest.fn();

    ensureTracePollingForReport(makeReport(), makeTc(), { onUpdated });
    await captured.onTracesFound([], makeReport());

    expect(mockCallBedrockJudge).not.toHaveBeenCalled();
    expect(mockUpdateReport).not.toHaveBeenCalled();
    // The caller still gets refreshed with the server's verdict
    expect(onUpdated).toHaveBeenCalledWith(serverVerdict);
  });

  it('skips the judge when the persisted report is calculating (judge mid-flight elsewhere)', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    mockGetReportById.mockResolvedValue(makeReport({ metricsStatus: 'calculating' }));
    const onUpdated = jest.fn();

    ensureTracePollingForReport(makeReport(), makeTc(), { onUpdated });
    await captured.onTracesFound([], makeReport());

    expect(mockCallBedrockJudge).not.toHaveBeenCalled();
    expect(mockUpdateReport).not.toHaveBeenCalled();
    // Calculating is NOT a final verdict — don't push it into the UI as one.
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('writes the canonical matcherResults surface (not just llmJudgeReasoning)', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100 } as any,
      llmJudgeReasoning: 'good',
      improvementStrategies: [],
    } as any);
    mockUpdateReport.mockResolvedValue({} as any);
    mockGetReportById
      .mockResolvedValueOnce(makeReport())
      .mockResolvedValue(makeReport({ metricsStatus: 'ready' }));

    ensureTracePollingForReport(makeReport(), makeTc());
    await captured.onTracesFound([], makeReport());

    const patch = mockUpdateReport.mock.calls[0][1] as any;
    expect(patch.matcherResults).toHaveLength(1);
    expect(patch.matcherResults[0]).toEqual(expect.objectContaining({ method: 'llm-judge', pass: true }));
  });

  it('writes error to storage when the judge throws', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    mockCallBedrockJudge.mockRejectedValue(new Error('bedrock down'));
    mockUpdateReport.mockResolvedValue({} as any);
    mockGetReportById
      .mockResolvedValueOnce(makeReport())
      .mockResolvedValue(makeReport({ metricsStatus: 'error' }));
    const onError = jest.fn();
    const onUpdated = jest.fn();

    ensureTracePollingForReport(makeReport(), makeTc(), { onError, onUpdated });
    await captured.onTracesFound([], makeReport());

    expect(mockUpdateReport).toHaveBeenCalledWith('r1', expect.objectContaining({
      metricsStatus: 'error',
      traceError: expect.stringContaining('bedrock down'),
    }));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onUpdated).toHaveBeenCalled();
  });

  it('forwards spans to onSpans before judging', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed', metrics: {} as any, llmJudgeReasoning: '', improvementStrategies: [],
    } as any);
    mockUpdateReport.mockResolvedValue({} as any);
    mockGetReportById
      .mockResolvedValueOnce(makeReport())
      .mockResolvedValue(makeReport({ metricsStatus: 'ready' }));
    const onSpans = jest.fn();
    const spans = [{ spanId: 's1', traceId: 't1', name: 'execute_tool x' }] as any;

    ensureTracePollingForReport(makeReport(), makeTc(), { onSpans });
    await captured.onTracesFound(spans, makeReport());

    expect(onSpans).toHaveBeenCalledWith(spans);
  });

  it('forwards poller-level errors to onError', () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    const onError = jest.fn();
    ensureTracePollingForReport(makeReport(), makeTc(), { onError });
    captured.onError(new Error('poll timeout'));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe('poll timeout');
  });
});
