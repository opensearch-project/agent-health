/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry judgement × empty responses: a report the runner classified as an
 * empty response (`agentError.kind === 'empty-response'`) is never selected
 * for re-judging and, if handed to `retryJudgementForCase` directly, is
 * refused without a judge call — so "Retry judgement" cannot flip an empty
 * response to pass (the owner incident in reverse).
 */
import type { EvaluationReport, EvaluationRun } from '@/types';

jest.mock('@/services/evaluation', () => ({ callBedrockJudge: jest.fn() }));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({ agents: [{ key: 'demo', name: 'Demo', useTraces: false }] })),
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/services/traces/fetchSpansForRun', () => ({ fetchSpansForRun: jest.fn(async () => ({ spans: [] })) }));
jest.mock('@/services/traces/spansToTrajectory', () => ({ spansToTrajectory: jest.fn(() => []) }));

import { callBedrockJudge } from '@/services/evaluation';
import {
  isJudgeFailedCase,
  hasRejudgeableOutput,
  selectRetryableCases,
  retryJudgementForCase,
} from '@/services/evaluation/retryJudgement';

const mockedJudge = callBedrockJudge as jest.Mock;

const EMPTY_AGENT_ERROR = {
  stage: 'agent' as const, kind: 'empty-response' as const, code: 'EMPTY_RESPONSE',
  message: 'EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint h:1: no agent steps',
};

function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'report-1', timestamp: '2026-01-01T00:00:00Z', testCaseId: 'tc-1', agentName: 'Demo', agentKey: 'demo',
    modelName: 'demo-model', modelId: 'demo-model', status: 'failed', metricsStatus: 'error',
    trajectory: [{ type: 'response', content: 'No results available (source=unknown).' } as any],
    rawEvents: [{ answer: null, results: [], steps: [] }],
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    llmJudgeReasoning: '', agentError: EMPTY_AGENT_ERROR,
    ...overrides,
  } as EvaluationReport;
}

function makeStorage(reports: Record<string, any>) {
  return {
    runs: {
      getById: jest.fn(async (id: string) => reports[id] ?? null),
      update: jest.fn(async (id: string, updates: any) => { reports[id] = { ...reports[id], ...updates }; return reports[id]; }),
    },
  } as any;
}

describe('retry judgement never re-judges an empty response', () => {
  beforeEach(() => { mockedJudge.mockReset(); mockedJudge.mockResolvedValue({ passFailStatus: 'passed', metrics: { accuracy: 100 }, llmJudgeReasoning: 'Any reply at all — fully achieved', improvementStrategies: [] }); });

  it('isJudgeFailedCase / hasRejudgeableOutput are false for a report with agentError (even with a stored trajectory)', () => {
    const report = makeReport();
    expect(isJudgeFailedCase(report, { reportId: 'report-1', status: 'completed' })).toBe(false);
    expect(hasRejudgeableOutput(report)).toBe(false);
    // Transport / unreachable members of the family too.
    expect(hasRejudgeableOutput(makeReport({ agentError: { stage: 'agent', kind: 'transport', code: 'ECONNREFUSED', message: 'x' } }))).toBe(false);
    // Sanity: a genuine judge failure with a trajectory and no agentError stays retryable.
    expect(isJudgeFailedCase(makeReport({ agentError: undefined, status: 'completed' }), { reportId: 'report-1', status: 'completed' })).toBe(true);
  });

  it('selectRetryableCases skips it under both scopes', () => {
    const run = { results: { 'tc-1': { reportId: 'report-1', status: 'completed' }, 'tc-2': { reportId: 'report-2', status: 'completed' } } } as unknown as Pick<EvaluationRun, 'results'>;
    const reports = {
      'report-1': makeReport(),
      'report-2': makeReport({ id: 'report-2', testCaseId: 'tc-2', status: 'completed', agentError: undefined, trajectory: [{ type: 'assistant', content: 'real answer' } as any] }),
    };
    expect(selectRetryableCases(run, reports, 'errored')).toEqual(['tc-2']);
    expect(selectRetryableCases(run, reports, 'all')).toEqual(['tc-2']);
  });

  it('retryJudgementForCase on an empty-response report: no judge call, agent_empty_response re-stamped, passFailStatus null', async () => {
    const reports: Record<string, any> = { 'report-1': makeReport() };
    const storage = makeStorage(reports);
    const outcome = await retryJudgementForCase(reports['report-1'], { id: 'tc-1', name: 'tc', expectedOutcomes: ['Any reply at all.'] } as any, { judgeModelId: 'demo-model' } as any, storage, { key: 'demo', name: 'Demo', useTraces: false } as any);
    expect(mockedJudge).not.toHaveBeenCalled();
    expect(outcome.passFailStatus).toBeNull();
    expect(outcome.error).toMatch(/^not judged: empty response — /);
    expect(reports['report-1'].metricsStatus).toBe('error');
    expect(reports['report-1'].passFailStatus).toBeNull();
    expect(reports['report-1'].traceError).toMatch(/kind=agent_empty_response/);
    expect(reports['report-1'].agentError).toEqual(EMPTY_AGENT_ERROR);
    expect(reports['report-1'].matcherResults).toEqual([]);
  });

  it('a legacy report WITHOUT agentError whose stored trajectory classifies as empty is refused too (and gains agentError)', async () => {
    const reports: Record<string, any> = { 'report-1': makeReport({ agentError: undefined, trajectory: [{ type: 'response', content: '{}' } as any], rawEvents: [{}] }) };
    const storage = makeStorage(reports);
    const outcome = await retryJudgementForCase(reports['report-1'], { id: 'tc-1', name: 'tc', expectedOutcomes: ['x'] } as any, {} as any, storage, { key: 'demo', name: 'Demo', useTraces: false } as any);
    expect(mockedJudge).not.toHaveBeenCalled();
    expect(outcome.passFailStatus).toBeNull();
    expect(reports['report-1'].agentError).toMatchObject({ stage: 'agent', kind: 'empty-response', code: 'EMPTY_RESPONSE' });
  });

  it('a report with a real trajectory is still re-judged', async () => {
    const reports: Record<string, any> = { 'report-1': makeReport({ agentError: undefined, trajectory: [{ type: 'assistant', content: 'real answer' } as any], rawEvents: [] }) };
    const storage = makeStorage(reports);
    const outcome = await retryJudgementForCase(reports['report-1'], { id: 'tc-1', name: 'tc', expectedOutcomes: ['x'] } as any, {} as any, storage, { key: 'demo', name: 'Demo', useTraces: false } as any);
    expect(mockedJudge).toHaveBeenCalledTimes(1);
    expect(outcome.passFailStatus).toBe('passed');
  });
});
