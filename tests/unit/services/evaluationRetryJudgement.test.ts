/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for retryJudgementForRun (services/evaluationRetryJudgement.ts)
 * — re-judging a run's judge-failed test cases in place, without
 * re-invoking the agent. Mocks callBedrockJudge and the storage module.
 */

const mockCallBedrockJudge = jest.fn();
jest.mock('@/services/evaluation', () => ({
  callBedrockJudge: (...args: any[]) => mockCallBedrockJudge(...args),
}));

jest.mock('@/services/traces/judgeAgentsHints', () => ({
  buildJudgeAgentsHints: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn().mockReturnValue({ agents: [] }),
}));

import { retryJudgementForRun } from '@/services/evaluationRetryJudgement';
import type { EvaluationRun, TestCase } from '@/types';

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'eval-run-1',
    docType: 'evaluation-run',
    name: 'My Run',
    createdAt: '2026-01-01T00:00:00Z',
    status: 'completed',
    agentKey: 'demo',
    modelId: 'claude-sonnet',
    sources: [],
    trigger: 'ui',
    testCaseSnapshots: [],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

function makeTestCase(id: string): TestCase {
  return {
    id,
    name: `Case ${id}`,
    category: 'Test',
    difficulty: 'Easy',
    initialPrompt: 'q',
    expectedOutcomes: ['a'],
    context: [],
    expectedTrajectory: [],
    currentVersion: 1,
  } as unknown as TestCase;
}

function makeStorage() {
  const reports: Record<string, any> = {};
  const testCases: Record<string, TestCase> = {};
  return {
    runs: {
      getById: jest.fn((id: string) => Promise.resolve(reports[id] || null)),
      update: jest.fn((id: string, patch: any) => {
        reports[id] = { ...reports[id], ...patch };
        return Promise.resolve(reports[id]);
      }),
    },
    testCases: {
      getById: jest.fn((id: string) => Promise.resolve(testCases[id] || null)),
    },
    evaluationRuns: {
      update: jest.fn((_id: string, patch: any) => Promise.resolve(patch)),
    },
    _reports: reports,
    _testCases: testCases,
  } as any;
}

describe('retryJudgementForRun', () => {
  beforeEach(() => {
    mockCallBedrockJudge.mockReset();
  });

  it('returns all-zero outcome when there are no judge-failed results', async () => {
    const storage = makeStorage();
    const run = makeRun({
      results: { tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' } as any },
    });
    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome).toEqual({ retried: 0, nowPassed: 0, stillFailed: 0, skipped: 0, skipReasons: {} });
    expect(mockCallBedrockJudge).not.toHaveBeenCalled();
    expect(storage.evaluationRuns.update).not.toHaveBeenCalled();
  });

  it('re-judges a judge-failed case, flips it to passed, and updates the report + run stats', async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [{ type: 'assistant' }], runId: 'agent-run-1' };
    storage._testCases['tc1'] = makeTestCase('tc1');
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 90 },
      llmJudgeReasoning: 'Now correctly identifies the cause',
      improvementStrategies: [],
    });

    const run = makeRun({
      judgeModelId: 'judge-x',
      evaluatorId: 'ev-1',
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);

    expect(outcome.retried).toBe(1);
    expect(outcome.nowPassed).toBe(1);
    expect(outcome.stillFailed).toBe(0);
    expect(outcome.skipped).toBe(0);

    expect(mockCallBedrockJudge).toHaveBeenCalledWith(
      storage._reports['r1'].trajectory,
      expect.objectContaining({ expectedOutcomes: ['a'] }),
      undefined,
      undefined,
      'judge-x',
      'ev-1',
      'agent-run-1',
      []
    );

    expect(storage.runs.update).toHaveBeenCalledWith('r1', expect.objectContaining({ passFailStatus: 'passed' }));
    expect(storage.evaluationRuns.update).toHaveBeenCalledWith(
      'eval-run-1',
      expect.objectContaining({
        results: expect.objectContaining({ tc1: expect.objectContaining({ passFailStatus: 'passed' }) }),
        stats: expect.objectContaining({ passed: 1, failed: 0 }),
      })
    );
  });

  it('still counts a case that remains failing after re-judgement', async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [] };
    storage._testCases['tc1'] = makeTestCase('tc1');
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'failed',
      metrics: { accuracy: 10 },
      llmJudgeReasoning: 'Still does not identify the cause',
      improvementStrategies: [],
    });

    const run = makeRun({
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(1);
    expect(outcome.nowPassed).toBe(0);
    expect(outcome.stillFailed).toBe(1);
  });

  it('skips a judge-failed case whose report no longer exists, without throwing', async () => {
    const storage = makeStorage();
    // No report seeded for r-missing.
    const run = makeRun({
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r-missing' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(outcome.skipReasons.tc1).toMatch(/no longer exists/i);
    expect(mockCallBedrockJudge).not.toHaveBeenCalled();
  });

  it('skips a judge-failed case whose test case no longer exists', async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [] };
    // No test case seeded for tc1.
    const run = makeRun({
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(outcome.skipReasons.tc1).toMatch(/test case tc1 no longer exists/i);
  });

  it('skips a case when the judge call itself throws, and still processes the rest', async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [] };
    storage._reports['r2'] = { id: 'r2', trajectory: [] };
    storage._testCases['tc1'] = makeTestCase('tc1');
    storage._testCases['tc2'] = makeTestCase('tc2');
    mockCallBedrockJudge
      .mockRejectedValueOnce(new Error('judge unavailable'))
      .mockResolvedValueOnce({ passFailStatus: 'passed', metrics: {}, llmJudgeReasoning: 'ok', improvementStrategies: [] });

    const run = makeRun({
      results: {
        tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any,
        tc2: { status: 'completed', passFailStatus: 'failed', reportId: 'r2' } as any,
      },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.skipReasons.tc1).toBe('judge unavailable');
  });

  it('does not touch results/results that are agent-failed, pending, or already passed', async () => {
    const storage = makeStorage();
    const run = makeRun({
      results: {
        tc1: { status: 'failed', reportId: 'r1' } as any, // agent-failed, not judge-failed
        tc2: { status: 'pending' } as any,
        tc3: { status: 'completed', passFailStatus: 'passed', reportId: 'r3' } as any,
      },
    });
    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(0);
    expect(mockCallBedrockJudge).not.toHaveBeenCalled();
  });
});
