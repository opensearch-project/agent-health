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
  const testCaseVersions: Record<string, TestCase> = {};
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
      getVersion: jest.fn((id: string, version: number) => Promise.resolve(testCaseVersions[`${id}@${version}`] || null)),
    },
    evaluationRuns: {
      update: jest.fn((_id: string, patch: any) => Promise.resolve(patch)),
    },
    _reports: reports,
    _testCases: testCases,
    _testCaseVersions: testCaseVersions,
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

  it("judges against the RUN'S SNAPSHOTTED test-case version, not the current (possibly edited) one", async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [] };
    // Current doc has drifted since the run executed...
    storage._testCases['tc1'] = { ...makeTestCase('tc1'), expectedOutcomes: ['edited after the run'] };
    // ...but the version pinned in testCaseSnapshots still has the ORIGINAL criteria.
    storage._testCaseVersions['tc1@1'] = { ...makeTestCase('tc1'), expectedOutcomes: ['original criteria at run time'] };
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed', metrics: {}, llmJudgeReasoning: 'ok', improvementStrategies: [],
    });

    const run = makeRun({
      testCaseSnapshots: [{ id: 'tc1', version: 1, name: 'Case tc1' }],
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(1);
    expect(storage.testCases.getVersion).toHaveBeenCalledWith('tc1', 1);
    expect(storage.testCases.getById).not.toHaveBeenCalled();
    expect(mockCallBedrockJudge).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ expectedOutcomes: ['original criteria at run time'] }),
      undefined, undefined, undefined, undefined, undefined, []
    );
  });

  it('falls back to the current test-case doc when the run has no snapshot version recorded (legacy run)', async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [] };
    storage._testCases['tc1'] = makeTestCase('tc1');
    mockCallBedrockJudge.mockResolvedValue({
      passFailStatus: 'passed', metrics: {}, llmJudgeReasoning: 'ok', improvementStrategies: [],
    });

    const run = makeRun({
      testCaseSnapshots: [], // legacy run, no snapshot version for tc1
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.retried).toBe(1);
    expect(storage.testCases.getById).toHaveBeenCalledWith('tc1');
    expect(storage.testCases.getVersion).not.toHaveBeenCalled();
  });

  it('skips when the snapshotted test-case version no longer exists, with a version-specific reason', async () => {
    const storage = makeStorage();
    storage._reports['r1'] = { id: 'r1', trajectory: [] };
    // No entry in _testCaseVersions for tc1@1 — that historical version was pruned/never existed.
    const run = makeRun({
      testCaseSnapshots: [{ id: 'tc1', version: 1, name: 'Case tc1' }],
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } as any },
    });

    const outcome = await retryJudgementForRun(run, storage);
    expect(outcome.skipped).toBe(1);
    expect(outcome.skipReasons.tc1).toMatch(/version 1 no longer exists/i);
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
