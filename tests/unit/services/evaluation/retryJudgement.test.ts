/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for services/evaluation/retryJudgement.ts
 *
 *   - isJudgeFailedCase / hasRejudgeableOutput / selectRetryableCases: pure
 *     selection predicates (no mocks needed).
 *   - retryJudgementForRun: full orchestration with a mocked judge + mocked
 *     storage module, verifying report updates, run.results, and
 *     recomputed stats.
 */

import type { EvaluationReport, EvaluationRun } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/services/evaluation', () => ({
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({ agents: [{ key: 'demo', name: 'Demo', useTraces: false }] })),
}));
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn(() => []),
}));
jest.mock('@/services/traces/fetchSpansForRun', () => ({
  fetchSpansForRun: jest.fn(async () => ({ spans: [] })),
}));
jest.mock('@/services/traces/spansToTrajectory', () => ({
  spansToTrajectory: jest.fn((spans: any[]) => spans.map((s: any) => ({ type: 'action', toolName: s.name }))),
}));

import { callBedrockJudge } from '@/services/evaluation';
import { fetchSpansForRun } from '@/services/traces/fetchSpansForRun';
import {
  isJudgeFailedCase,
  hasRejudgeableOutput,
  selectRetryableCases,
  retryJudgementForRun,
  retryJudgementForCase,
  countRetryableCases,
} from '@/services/evaluation/retryJudgement';

const mockedCallBedrockJudge = callBedrockJudge as jest.Mock;
const mockedFetchSpansForRun = fetchSpansForRun as jest.Mock;

function makeReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'report-1',
    timestamp: '2026-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    agentName: 'Demo',
    agentKey: 'demo',
    modelName: 'demo-model',
    modelId: 'demo-model',
    status: 'completed',
    trajectory: [{ type: 'assistant', content: 'hello' } as any],
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    llmJudgeReasoning: '',
    ...overrides,
  } as EvaluationReport;
}

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'eval-run-1',
    docType: 'evaluation-run',
    name: 'My Run',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'demo-model',
    sources: [],
    trigger: 'ui',
    testCaseSnapshots: [],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

describe('isJudgeFailedCase', () => {
  it('is false when there is no report or result', () => {
    expect(isJudgeFailedCase(null, { status: 'completed' })).toBe(false);
    expect(isJudgeFailedCase(makeReport(), undefined)).toBe(false);
  });

  it('is false unless the run-level result is completed (agent must have finished)', () => {
    const report = makeReport({ metricsStatus: 'error' as any });
    expect(isJudgeFailedCase(report, { status: 'running' })).toBe(false);
    expect(isJudgeFailedCase(report, { status: 'failed' })).toBe(false);
  });

  it('is false unless metricsStatus is exactly "error" (matches the UI\'s ERRORED bucket)', () => {
    expect(isJudgeFailedCase(makeReport({ metricsStatus: undefined }), { status: 'completed' })).toBe(false);
    expect(isJudgeFailedCase(makeReport({ metricsStatus: 'pending' as any }), { status: 'completed' })).toBe(false);
    expect(isJudgeFailedCase(makeReport({ metricsStatus: 'ready' as any, passFailStatus: 'passed' }), { status: 'completed' })).toBe(false);
  });

  it('is true for a completed agent execution with metricsStatus error and a stored trajectory', () => {
    const report = makeReport({ metricsStatus: 'error' as any, passFailStatus: null as any });
    expect(isJudgeFailedCase(report, { status: 'completed' })).toBe(true);
  });

  it('excludes agent_failed cases: metricsStatus error but NO trajectory to re-judge', () => {
    // buildEvaluatorErrorPatch('agent_failed', …) also sets metricsStatus:'error',
    // but the agent never produced output — nothing stored to salvage.
    const report = makeReport({ metricsStatus: 'error' as any, trajectory: [] });
    expect(isJudgeFailedCase(report, { status: 'completed' })).toBe(false);
  });

  describe('legacy pre-fix judge-failure shape (status: failed, no metricsStatus)', () => {
    // Before services/evaluation/index.ts split the judge call into its own
    // catch, a judge-step failure after a SUCCESSFUL agent run landed as
    // status:'failed' + "Evaluation failed: <judge error>" with no
    // metricsStatus. Runs persisted in that shape (e.g. every case of a
    // 62-case run against a non-instrumented REST agent hitting the old
    // agent-trace-judge 400) must still be salvageable.
    const legacy = makeReport({
      status: 'failed',
      metricsStatus: undefined,
      passFailStatus: undefined,
      llmJudgeReasoning:
        'Evaluation failed: Bedrock Judge validation error (not retryable): The agent (trace) judge provider needs a runId or at least one trace correlation hint',
    });

    it('is true when the trajectory exists and the reasoning names the judge', () => {
      expect(isJudgeFailedCase(legacy, { status: 'completed' })).toBe(true);
    });

    it('is false for a legacy-shape AGENT failure (reasoning does not name the judge)', () => {
      const agentFail = makeReport({ ...legacy, llmJudgeReasoning: 'Evaluation failed: ECONNREFUSED' } as any);
      expect(isJudgeFailedCase(agentFail, { status: 'completed' })).toBe(false);
    });

    it('is false when the legacy-shape report has no trajectory (nothing to re-judge)', () => {
      expect(isJudgeFailedCase(makeReport({ ...legacy, trajectory: [] } as any), { status: 'completed' })).toBe(false);
    });

    it('is selected by selectRetryableCases under the default errored scope', () => {
      const run = makeRun({ results: { 'tc-1': { reportId: 'report-1', status: 'completed' } } as any });
      expect(selectRetryableCases(run, { 'report-1': legacy }, 'errored')).toEqual(['tc-1']);
    });
  });
});

describe('hasRejudgeableOutput', () => {
  it('requires a non-empty trajectory', () => {
    expect(hasRejudgeableOutput(makeReport({ trajectory: [] }))).toBe(false);
    expect(hasRejudgeableOutput(makeReport())).toBe(true);
    expect(hasRejudgeableOutput(null)).toBe(false);
  });
});

describe('selectRetryableCases', () => {
  it('scope=errored selects only judge-failed cases', () => {
    const run = makeRun({
      results: {
        'tc-errored': { reportId: 'r-errored', status: 'completed' } as any,
        'tc-passed': { reportId: 'r-passed', status: 'completed', passFailStatus: 'passed' } as any,
        'tc-agent-crash': { reportId: 'r-crash', status: 'completed' } as any,
        'tc-pending': { reportId: 'r-pending', status: 'pending' } as any,
      },
    });
    const reportsById = {
      'r-errored': makeReport({ id: 'r-errored', metricsStatus: 'error' as any }),
      'r-passed': makeReport({ id: 'r-passed', metricsStatus: 'ready' as any, passFailStatus: 'passed' }),
      'r-crash': makeReport({ id: 'r-crash', metricsStatus: 'error' as any, trajectory: [] }),
      'r-pending': makeReport({ id: 'r-pending', metricsStatus: 'pending' as any }),
    };
    expect(selectRetryableCases(run, reportsById, 'errored')).toEqual(['tc-errored']);
  });

  it('scope=all selects every completed case with rejudgeable output, regardless of current verdict', () => {
    const run = makeRun({
      results: {
        'tc-errored': { reportId: 'r-errored', status: 'completed' } as any,
        'tc-passed': { reportId: 'r-passed', status: 'completed', passFailStatus: 'passed' } as any,
        'tc-agent-crash': { reportId: 'r-crash', status: 'completed' } as any,
      },
    });
    const reportsById = {
      'r-errored': makeReport({ id: 'r-errored', metricsStatus: 'error' as any }),
      'r-passed': makeReport({ id: 'r-passed', metricsStatus: 'ready' as any, passFailStatus: 'passed' }),
      'r-crash': makeReport({ id: 'r-crash', metricsStatus: 'error' as any, trajectory: [] }),
    };
    expect(selectRetryableCases(run, reportsById, 'all').sort()).toEqual(['tc-errored', 'tc-passed']);
  });

  it('skips results with no reportId', () => {
    const run = makeRun({ results: { 'tc-nope': { status: 'completed' } as any } });
    expect(selectRetryableCases(run, {}, 'errored')).toEqual([]);
  });
});

describe('retryJudgementForRun', () => {
  function makeStorage(reports: Record<string, EvaluationReport>): jest.Mocked<Pick<IStorageModule, 'runs' | 'evaluationRuns' | 'testCases'>> {
    return {
      runs: {
        getById: jest.fn(async (id: string) => reports[id] ?? null),
        update: jest.fn(async (id: string, updates: any) => {
          reports[id] = { ...reports[id], ...updates };
          return reports[id];
        }),
      } as any,
      evaluationRuns: {
        update: jest.fn(async (_id: string, updates: any) => updates),
      } as any,
      testCases: {
        getById: jest.fn(async (id: string) => ({ id, name: id, expectedOutcomes: ['does the thing'] })),
      } as any,
    };
  }

  beforeEach(() => {
    mockedCallBedrockJudge.mockReset();
    mockedFetchSpansForRun.mockReset();
    mockedFetchSpansForRun.mockResolvedValue({ spans: [] });
  });

  it('rebuilds the trajectory from a fresh trace re-fetch for trace-mode agents (trace_timeout can now succeed)', async () => {
    mockedFetchSpansForRun.mockResolvedValueOnce({ spans: [{ name: 'search_logs' }] });
    mockedCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
      llmJudgeReasoning: 'ok',
      improvementStrategies: [],
    });

    const reports: Record<string, EvaluationReport> = {
      'r-trace': makeReport({ id: 'r-trace', testCaseId: 'tc-trace', metricsStatus: 'error' as any, runId: 'agent-run-1', trajectory: [] as any }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({ results: { 'tc-trace': { reportId: 'r-trace', status: 'completed' } as any } });
    const agentConfig = { key: 'demo', name: 'Demo', useTraces: true } as any;
    const testCase: any = { id: 'tc-trace', name: 'tc-trace', expectedOutcomes: ['x'] };

    const outcome = await retryJudgementForCase(reports['r-trace'], testCase, run, storage as any, agentConfig);

    expect(outcome.passFailStatus).toBe('passed');
    expect(mockedFetchSpansForRun).toHaveBeenCalledWith('agent-run-1', expect.objectContaining({ maxAttempts: 3 }));
    // The judge was called with the RE-BUILT trajectory (from spans), not the
    // report's originally-empty one — proves the trace re-fetch result is used.
    expect(mockedCallBedrockJudge.mock.calls[0][0]).toEqual([{ type: 'action', toolName: 'search_logs' }]);
  });

  it('falls back to the stored trajectory when a trace-mode re-fetch finds nothing', async () => {
    mockedFetchSpansForRun.mockResolvedValueOnce({ spans: [] });
    mockedCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'failed',
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      llmJudgeReasoning: 'still nothing',
      improvementStrategies: [],
    });

    const storedTrajectory = [{ type: 'assistant', content: 'stored' }] as any;
    const reports: Record<string, EvaluationReport> = {
      'r-trace2': makeReport({ id: 'r-trace2', testCaseId: 'tc-trace2', metricsStatus: 'error' as any, runId: 'agent-run-2', trajectory: storedTrajectory }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({ results: { 'tc-trace2': { reportId: 'r-trace2', status: 'completed' } as any } });
    const agentConfig = { key: 'demo', name: 'Demo', useTraces: true } as any;
    const testCase: any = { id: 'tc-trace2', name: 'tc-trace2', expectedOutcomes: ['x'] };

    await retryJudgementForCase(reports['r-trace2'], testCase, run, storage as any, agentConfig);

    expect(mockedCallBedrockJudge.mock.calls[0][0]).toEqual(storedTrajectory);
  });

  it('retries only judge-failed cases, updates the report + run.results, and recomputes stats', async () => {
    mockedCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
      llmJudgeReasoning: 'Looks good',
      improvementStrategies: [],
    });

    const reports: Record<string, EvaluationReport> = {
      'r-errored': makeReport({ id: 'r-errored', testCaseId: 'tc-errored', metricsStatus: 'error' as any }),
      'r-passed': makeReport({ id: 'r-passed', testCaseId: 'tc-passed', metricsStatus: 'ready' as any, passFailStatus: 'passed' }),
    };
    const storage = makeStorage(reports);

    const run = makeRun({
      judgeModelId: 'demo-model',
      evaluatorId: 'rca-default',
      results: {
        'tc-errored': { reportId: 'r-errored', status: 'completed' } as any,
        'tc-passed': { reportId: 'r-passed', status: 'completed', passFailStatus: 'passed' } as any,
      },
    });

    const summary = await retryJudgementForRun(run, storage as any);

    expect(summary.retried).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(mockedCallBedrockJudge).toHaveBeenCalledTimes(1);

    // Only the errored report was touched.
    expect(reports['r-errored'].passFailStatus).toBe('passed');
    expect(reports['r-errored'].metricsStatus).toBe('completed');
    expect(reports['r-passed'].passFailStatus).toBe('passed'); // untouched, still its original value

    const updateCall = (storage.evaluationRuns.update as jest.Mock).mock.calls[0];
    expect(updateCall[0]).toBe('eval-run-1');
    expect(updateCall[1].results['tc-errored'].passFailStatus).toBe('passed');
    expect(updateCall[1].stats).toEqual({ passed: 2, failed: 0, errored: 0, pending: 0, notRun: 0, total: 2 });
  });

  it('re-persists the canonical evaluator-error patch when the judge call fails again', async () => {
    mockedCallBedrockJudge.mockRejectedValue(new Error('Bedrock validation error'));

    const reports: Record<string, EvaluationReport> = {
      'r-errored': makeReport({ id: 'r-errored', testCaseId: 'tc-errored', metricsStatus: 'error' as any }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({
      results: { 'tc-errored': { reportId: 'r-errored', status: 'completed' } as any },
    });

    const summary = await retryJudgementForRun(run, storage as any);

    expect(summary.retried).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].error).toContain('Bedrock validation error');
    expect(reports['r-errored'].metricsStatus).toBe('error');
    expect(reports['r-errored'].passFailStatus).toBeNull();

    const updateCall = (storage.evaluationRuns.update as jest.Mock).mock.calls[0];
    // Still-failed case stays out of passed/failed — bucketed errored, same as
    // the original run.
    expect(updateCall[1].stats.errored).toBe(1);
    expect(updateCall[1].results['tc-errored'].passFailStatus).toBeUndefined();
  });

  it('clears stale matcherResults/improvementStrategies when a scope=all retry fails on a previously-passed case (codex_review finding)', async () => {
    mockedCallBedrockJudge.mockRejectedValue(new Error('Bedrock 400'));

    const reports: Record<string, EvaluationReport> = {
      'r-was-passing': makeReport({
        id: 'r-was-passing',
        testCaseId: 'tc-was-passing',
        metricsStatus: 'ready' as any,
        passFailStatus: 'passed',
        matcherResults: [{ description: 'judge: x', pass: true, method: 'llm-judge' } as any],
        improvementStrategies: [{ title: 'x' } as any],
      }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({
      results: { 'tc-was-passing': { reportId: 'r-was-passing', status: 'completed', passFailStatus: 'passed' } as any },
    });

    await retryJudgementForRun(run, storage as any, { scope: 'all' });

    // The retry failed — the report must not keep showing the STALE passing
    // matcher entry alongside metricsStatus:'error' (a Judge-tab inconsistency).
    expect(reports['r-was-passing'].metricsStatus).toBe('error');
    expect(reports['r-was-passing'].matcherResults).toEqual([]);
    expect(reports['r-was-passing'].improvementStrategies).toEqual([]);
    // The retry-specific message is preserved for diagnostics.
    expect(reports['r-was-passing'].traceError).toContain('Retry judgement');
    expect(reports['r-was-passing'].traceError).toContain('Bedrock 400');
  });

  it('falls back to BEDROCK_MODEL_ID env before the agent\'s own modelId when no judge model is set', async () => {
    process.env.BEDROCK_MODEL_ID = 'env-judge-model';
    mockedCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
      llmJudgeReasoning: 'ok',
      improvementStrategies: [],
    });

    try {
      const reports: Record<string, EvaluationReport> = {
        'r-no-judge-model': makeReport({ id: 'r-no-judge-model', testCaseId: 'tc-x', metricsStatus: 'error' as any, judgeModelId: undefined, modelId: 'agent-model' }),
      };
      const storage = makeStorage(reports);
      const run = makeRun({ judgeModelId: undefined, results: { 'tc-x': { reportId: 'r-no-judge-model', status: 'completed' } as any } });

      await retryJudgementForRun(run, storage as any);

      // Judge model resolution: run.judgeModelId (unset) > report.judgeModelId
      // (unset) > BEDROCK_MODEL_ID env > report.modelId (agent's model, last
      // resort). Must NOT silently judge with the agent's own model when the
      // env default is available.
      expect(mockedCallBedrockJudge.mock.calls[0][4]).toBe('env-judge-model');
    } finally {
      delete process.env.BEDROCK_MODEL_ID;
    }
  });

  it('returns a no-op summary when there is nothing to retry', async () => {
    const reports: Record<string, EvaluationReport> = {
      'r-passed': makeReport({ id: 'r-passed', metricsStatus: 'ready' as any, passFailStatus: 'passed' }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({
      results: { 'tc-passed': { reportId: 'r-passed', status: 'completed', passFailStatus: 'passed' } as any },
    });

    const summary = await retryJudgementForRun(run, storage as any);

    expect(summary).toEqual({ retried: 0, succeeded: 0, failed: 0, results: [] });
    expect(mockedCallBedrockJudge).not.toHaveBeenCalled();
    // Run doc still gets its stats recomputed/persisted even with zero retries.
    expect(storage.evaluationRuns.update).toHaveBeenCalledTimes(1);
  });

  it('scope=all re-judges every rejudgeable case, including already-passed ones', async () => {
    mockedCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'failed',
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      llmJudgeReasoning: 'Actually wrong',
      improvementStrategies: [],
    });

    const reports: Record<string, EvaluationReport> = {
      'r-passed': makeReport({ id: 'r-passed', testCaseId: 'tc-passed', metricsStatus: 'ready' as any, passFailStatus: 'passed' }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({
      results: { 'tc-passed': { reportId: 'r-passed', status: 'completed', passFailStatus: 'passed' } as any },
    });

    const summary = await retryJudgementForRun(run, storage as any, { scope: 'all' });

    expect(summary.retried).toBe(1);
    expect(mockedCallBedrockJudge).toHaveBeenCalledTimes(1);
    expect(reports['r-passed'].passFailStatus).toBe('failed');
  });

  it('records a failure when the test case backing a selected result no longer exists', async () => {
    const reports: Record<string, EvaluationReport> = {
      'r-errored': makeReport({ id: 'r-errored', testCaseId: 'tc-gone', metricsStatus: 'error' as any }),
    };
    const storage = makeStorage(reports);
    (storage.testCases.getById as jest.Mock).mockResolvedValue(null);
    const run = makeRun({ results: { 'tc-gone': { reportId: 'r-errored', status: 'completed' } as any } });

    const summary = await retryJudgementForRun(run, storage as any);

    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].error).toBe('test case not found');
    expect(mockedCallBedrockJudge).not.toHaveBeenCalled();
  });

  it('reports progress via onProgress as each case completes (0/N up front, then N/N once all finish)', async () => {
    mockedCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
      llmJudgeReasoning: 'ok',
      improvementStrategies: [],
    });

    const reports: Record<string, EvaluationReport> = {
      'r-a': makeReport({ id: 'r-a', testCaseId: 'tc-a', metricsStatus: 'error' as any }),
      'r-b': makeReport({ id: 'r-b', testCaseId: 'tc-b', metricsStatus: 'error' as any }),
    };
    const storage = makeStorage(reports);
    const run = makeRun({
      results: {
        'tc-a': { reportId: 'r-a', status: 'completed' } as any,
        'tc-b': { reportId: 'r-b', status: 'completed' } as any,
      },
    });

    const progressCalls: Array<[number, number]> = [];
    const summary = await retryJudgementForRun(run, storage as any, {
      onProgress: (completed, total) => progressCalls.push([completed, total]),
    });

    expect(summary.retried).toBe(2);
    // First call is the pre-flight 0/N so a poller sees a total immediately;
    // every call after that has a non-decreasing `completed` up to N/N on
    // the last call (exact interleaving with concurrency isn't asserted).
    expect(progressCalls[0]).toEqual([0, 2]);
    expect(progressCalls[progressCalls.length - 1]).toEqual([2, 2]);
    expect(progressCalls.every(([, total]) => total === 2)).toBe(true);
    const completedValues = progressCalls.map(([completed]) => completed);
    for (let i = 1; i < completedValues.length; i++) {
      expect(completedValues[i]).toBeGreaterThanOrEqual(completedValues[i - 1]);
    }
  });

  describe('countRetryableCases', () => {
    it('matches selectRetryableCases\' length without doing any judge work', async () => {
      const reports: Record<string, EvaluationReport> = {
        'r-errored': makeReport({ id: 'r-errored', testCaseId: 'tc-errored', metricsStatus: 'error' as any }),
        'r-passed': makeReport({ id: 'r-passed', testCaseId: 'tc-passed', metricsStatus: 'ready' as any, passFailStatus: 'passed' }),
      };
      const storage = makeStorage(reports);
      const run = makeRun({
        results: {
          'tc-errored': { reportId: 'r-errored', status: 'completed' } as any,
          'tc-passed': { reportId: 'r-passed', status: 'completed', passFailStatus: 'passed' } as any,
        },
      });

      const count = await countRetryableCases(run, storage as any);
      expect(count).toBe(1);
      expect(mockedCallBedrockJudge).not.toHaveBeenCalled();

      const countAll = await countRetryableCases(run, storage as any, 'all');
      expect(countAll).toBe(2);
    });

    it('returns 0 when there is nothing to retry', async () => {
      const storage = makeStorage({});
      const run = makeRun({ results: {} });
      expect(await countRetryableCases(run, storage as any)).toBe(0);
    });
  });
});
