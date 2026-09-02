/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the run-lifecycle action-visibility matrix (delete/cancel/
 * re-run/retry-judgement). Pure predicates — no storage/IO — so every
 * (docType, status, results) combination in the matrix is exercised
 * directly here without booting a server.
 */

import {
  isEvaluationRun,
  isRunRunning,
  isRunTerminal,
  countJudgeFailed,
  getRunActionVisibility,
} from '@/lib/runActions';

function evalRun(overrides: any = {}) {
  return { docType: 'evaluation-run', status: 'completed', results: {}, ...overrides };
}

function benchmarkRun(overrides: any = {}) {
  return { status: 'completed', results: {}, ...overrides };
}

describe('isEvaluationRun', () => {
  it('is true for docType evaluation-run', () => {
    expect(isEvaluationRun(evalRun())).toBe(true);
  });

  it('is false for a legacy benchmark-embedded run (no docType)', () => {
    expect(isEvaluationRun(benchmarkRun())).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isEvaluationRun(null)).toBe(false);
    expect(isEvaluationRun(undefined)).toBe(false);
  });
});

describe('isRunRunning / isRunTerminal', () => {
  it.each(['completed', 'failed', 'cancelled'])('status=%s is terminal, not running', (status) => {
    const run = evalRun({ status });
    expect(isRunRunning(run)).toBe(false);
    expect(isRunTerminal(run)).toBe(true);
  });

  it('status=running is running, not terminal', () => {
    const run = evalRun({ status: 'running' });
    expect(isRunRunning(run)).toBe(true);
    expect(isRunTerminal(run)).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isRunRunning(null)).toBe(false);
    expect(isRunTerminal(undefined)).toBe(false);
  });
});

describe('countJudgeFailed', () => {
  it('counts only completed results with passFailStatus failed', () => {
    const run = evalRun({
      results: {
        tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' },
        tc2: { status: 'completed', passFailStatus: 'failed', reportId: 'r2' },
        tc3: { status: 'completed', passFailStatus: 'failed', reportId: 'r3' },
        tc4: { status: 'failed', reportId: 'r4' }, // agent-failed, not judge-failed
        tc5: { status: 'completed', reportId: 'r5' }, // errored (no verdict) — not counted
        tc6: { status: 'pending' },
      },
    });
    expect(countJudgeFailed(run)).toBe(2);
  });

  it('returns 0 when results is empty/missing', () => {
    expect(countJudgeFailed(evalRun({ results: {} }))).toBe(0);
    expect(countJudgeFailed(evalRun({ results: undefined }))).toBe(0);
    expect(countJudgeFailed(null)).toBe(0);
  });
});

describe('getRunActionVisibility — full matrix', () => {
  it('delete is always true, for every docType/status combination', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled']) {
      expect(getRunActionVisibility(evalRun({ status })).canDelete).toBe(true);
      expect(getRunActionVisibility(benchmarkRun({ status })).canDelete).toBe(true);
    }
  });

  it('cancel is true only while status is running, for both docTypes', () => {
    expect(getRunActionVisibility(evalRun({ status: 'running' })).canCancel).toBe(true);
    expect(getRunActionVisibility(benchmarkRun({ status: 'running' })).canCancel).toBe(true);
    for (const status of ['completed', 'failed', 'cancelled']) {
      expect(getRunActionVisibility(evalRun({ status })).canCancel).toBe(false);
      expect(getRunActionVisibility(benchmarkRun({ status })).canCancel).toBe(false);
    }
  });

  it('re-run is true only for EvaluationRun docs, regardless of status', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled']) {
      expect(getRunActionVisibility(evalRun({ status })).canRerun).toBe(true);
      const bmVisibility = getRunActionVisibility(benchmarkRun({ status }));
      expect(bmVisibility.canRerun).toBe(false);
      expect(bmVisibility.rerunDisabledReason).toMatch(/legacy benchmark-embedded/i);
    }
  });

  it('retry judgement is false for benchmark-embedded runs regardless of status/results', () => {
    const run = benchmarkRun({
      status: 'completed',
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(false);
    expect(visibility.retryJudgementDisabledReason).toMatch(/legacy benchmark-embedded/i);
  });

  it('retry judgement is false while an EvaluationRun is still running, even with judge-failed cases', () => {
    const run = evalRun({
      status: 'running',
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(false);
    expect(visibility.retryJudgementDisabledReason).toMatch(/only available once the run finishes/i);
  });

  it('retry judgement is false for a terminal EvaluationRun with zero judge-failed cases', () => {
    const run = evalRun({
      status: 'completed',
      results: { tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' } },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(false);
    expect(visibility.judgeFailedCount).toBe(0);
    expect(visibility.retryJudgementDisabledReason).toMatch(/no judge-failed/i);
  });

  it('retry judgement is true for a terminal EvaluationRun with >0 judge-failed cases', () => {
    const run = evalRun({
      status: 'completed',
      results: {
        tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' },
        tc2: { status: 'completed', passFailStatus: 'failed', reportId: 'r2' },
      },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(true);
    expect(visibility.judgeFailedCount).toBe(1);
    expect(visibility.retryJudgementDisabledReason).toBeUndefined();
  });

  it('retry judgement is true for a "failed" (not just "completed") terminal run with judge-failed cases', () => {
    const run = evalRun({
      status: 'failed',
      results: { tc1: { status: 'completed', passFailStatus: 'failed', reportId: 'r1' } },
    });
    expect(getRunActionVisibility(run).canRetryJudgement).toBe(true);
  });
});
