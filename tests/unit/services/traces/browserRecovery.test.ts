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

  it('is a no-op when runId is missing', () => {
    ensureTracePollingForReport(makeReport({ runId: undefined }), makeTc());
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
    mockGetReportById.mockResolvedValue(fresh);

    ensureTracePollingForReport(makeReport(), makeTc(), { onUpdated });
    await captured.onTracesFound([], makeReport());

    expect(mockCallBedrockJudge).toHaveBeenCalledTimes(1);
    expect(mockUpdateReport).toHaveBeenCalledWith('r1', expect.objectContaining({
      metricsStatus: 'ready',
      passFailStatus: 'passed',
    }));
    expect(onUpdated).toHaveBeenCalledWith(fresh);
  });

  it('writes error to storage when the judge throws', async () => {
    let captured: any;
    mockStartPolling.mockImplementation((_id, _runId, callbacks) => { captured = callbacks; });
    mockCallBedrockJudge.mockRejectedValue(new Error('bedrock down'));
    mockUpdateReport.mockResolvedValue({} as any);
    mockGetReportById.mockResolvedValue(makeReport({ metricsStatus: 'error' }));
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
