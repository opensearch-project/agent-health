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
  countRejudgeable,
  isRejudgeableResult,
  getRunActionVisibility,
  isOldEnoughForZombieCancel,
  ZOMBIE_CANCEL_MIN_AGE_MS,
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
  it('counts only completed results with NO judge verdict (the errored bucket the retry pipeline re-judges)', () => {
    const run = evalRun({
      results: {
        tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' }, // graded — not counted
        tc2: { status: 'completed', passFailStatus: 'failed', reportId: 'r2' }, // graded (real fail) — not counted
        tc3: { status: 'completed', reportId: 'r3' },                            // errored (no verdict) — counted
        tc4: { status: 'completed', passFailStatus: null, reportId: 'r4' },      // errored (explicit null) — counted
        tc5: { status: 'failed', reportId: 'r5' },                                // agent-failed, nothing to re-judge
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

describe('countRejudgeable', () => {
  it('counts every completed result regardless of verdict, PLUS judged failures (status failed carrying the passFailStatus mirror) — what scope=all re-judges', () => {
    expect(countRejudgeable(evalRun({
      results: {
        tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' },
        tc2: { status: 'completed', passFailStatus: 'failed', reportId: 'r2' },
        tc3: { status: 'completed', reportId: 'r3' },
        tc4: { status: 'failed', reportId: 'r4' },                              // executor crash / legacy: no verdict → not counted
        tc5: { status: 'pending', reportId: 'r5' },
        tc6: { status: 'failed', passFailStatus: 'failed', reportId: 'r6' },   // judged FAILED → counted
      },
    }))).toBe(4);
  });

  it('returns 0 when results is empty/missing', () => {
    expect(countRejudgeable(evalRun({ results: {} }))).toBe(0);
    expect(countRejudgeable(null)).toBe(0);
    expect(countRejudgeable({ status: 'completed' } as any)).toBe(0);
  });
});

// The report-aware predicate shared by the inspector (enablement + count) and
// the backend's scope=all selection (services/evaluation/retryJudgement.ts).
describe('isRejudgeableResult', () => {
  it('completed cases are re-judgeable whatever their verdict (passed / judge-failed / trace-failed)', () => {
    expect(isRejudgeableResult({ status: 'completed', passFailStatus: 'passed' }, { passFailStatus: 'passed' })).toBe(true);
    expect(isRejudgeableResult({ status: 'completed' }, { passFailStatus: null, failureStage: 'judge' })).toBe(true);
    expect(isRejudgeableResult({ status: 'completed' }, { passFailStatus: null, failureStage: 'trace' })).toBe(true);
  });
  it('an agent-request failure is never re-judgeable, even though the runner stores it as a completed result', () => {
    expect(isRejudgeableResult({ status: 'completed' }, { passFailStatus: null, failureStage: 'agent' })).toBe(false);
  });
  it('a judged FAILURE (status failed + failed verdict) is re-judgeable; a failed result without a verdict (crash) is not', () => {
    expect(isRejudgeableResult({ status: 'failed', passFailStatus: 'failed' }, { passFailStatus: 'failed' })).toBe(true);
    expect(isRejudgeableResult({ status: 'failed' }, { passFailStatus: null })).toBe(false);
    expect(isRejudgeableResult({ status: 'failed' }, {})).toBe(false);
  });
  it('needs both a result and a loaded report; pending / running / cancelled are never re-judgeable', () => {
    expect(isRejudgeableResult(undefined, { passFailStatus: 'passed' })).toBe(false);
    expect(isRejudgeableResult({ status: 'completed' }, null)).toBe(false);
    for (const status of ['pending', 'running', 'cancelled']) {
      expect(isRejudgeableResult({ status }, { passFailStatus: 'passed' })).toBe(false);
    }
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

  // Owner report (#509 follow-up): a benchmark whose two LEGACY embedded runs
  // (classic/CLI path, no evaluation-run doc) had an agent key that is no
  // longer configured could neither re-run nor retry judgement — both
  // greyed out as "isn't available for legacy benchmark-embedded runs".
  // Re-run opens the run dialog (which says the agent is gone and offers the
  // picker); retry judgement never needed the agent in the first place.
  it('re-run is available for BOTH shapes, regardless of status (legacy runs re-run via the create-mode run dialog)', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled']) {
      expect(getRunActionVisibility(evalRun({ status })).canRerun).toBe(true);
      const bmVisibility = getRunActionVisibility(benchmarkRun({ status }));
      expect(bmVisibility.canRerun).toBe(true);
      expect(bmVisibility.rerunDisabledReason).toBeUndefined();
    }
    expect(getRunActionVisibility(null).canRerun).toBe(false);
  });

  it('retry judgement is ENABLED for a terminal legacy benchmark-embedded run with completed cases — same counts as an EvaluationRun', () => {
    const results = {
      tc1: { status: 'completed', reportId: 'r1' },                          // classic shape: no passFailStatus mirror → judge-failed bucket
      tc2: { status: 'completed', passFailStatus: 'passed', reportId: 'r2' },
    };
    const legacy = getRunActionVisibility(benchmarkRun({ status: 'completed', results }));
    const modern = getRunActionVisibility(evalRun({ status: 'completed', results }));
    expect(legacy.canRetryJudgement).toBe(true);
    expect(legacy.retryJudgementDisabledReason).toBeUndefined();
    expect(legacy.judgeFailedCount).toBe(1);
    expect(legacy.rejudgeableCount).toBe(2);
    expect(legacy.retryJudgementCount).toBe(1);
    expect(legacy).toEqual(modern);
  });

  it('retry judgement on a legacy run still obeys the running / nothing-to-re-judge gates', () => {
    const running = getRunActionVisibility(benchmarkRun({ status: 'running', results: { tc1: { status: 'completed', reportId: 'r1' } } }));
    expect(running.canRetryJudgement).toBe(false);
    expect(running.retryJudgementDisabledReason).toMatch(/only available once the run finishes/i);
    const empty = getRunActionVisibility(benchmarkRun({ status: 'completed', results: { tc1: { status: 'failed', reportId: 'r1' } } }));
    expect(empty.canRetryJudgement).toBe(false);
    expect(empty.retryJudgementDisabledReason).toBe('No completed test cases to re-judge');
  });

  it('a legacy run with NO status (pre-status data, "treat as completed") is terminal and retryable', () => {
    const run = benchmarkRun({ status: undefined, results: { tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' } } });
    expect(isRunTerminal(run)).toBe(true);
    expect(isRunRunning(run)).toBe(false);
    expect(getRunActionVisibility(run).canRetryJudgement).toBe(true);
  });

  it('retry judgement is false while an EvaluationRun is still running, even with judge-failed cases', () => {
    const run = evalRun({
      status: 'running',
      results: { tc1: { status: 'completed', reportId: 'r1' } },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(false);
    expect(visibility.retryJudgementDisabledReason).toMatch(/only available once the run finishes/i);
  });

  // Owner follow-up to #468: "Retry judgement should be a retryable step all
  // the time" — a terminal run with ANY completed case is retryable (scope
  // 'all' re-judges graded cases too), not only one with judge failures.
  it('retry judgement is ENABLED for a terminal EvaluationRun with zero judge-failed cases (graded pass AND graded fail are re-judgeable); count = all cases', () => {
    const run = evalRun({
      status: 'completed',
      results: {
        tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' },
        tc2: { status: 'completed', passFailStatus: 'failed', reportId: 'r2' },
      },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(true);
    expect(visibility.judgeFailedCount).toBe(0);
    expect(visibility.rejudgeableCount).toBe(2);
    expect(visibility.retryJudgementCount).toBe(2);
    expect(visibility.retryJudgementDisabledReason).toBeUndefined();
  });

  it('retry judgement is true for a terminal EvaluationRun with >0 judge-failed cases; count = the judge-failed cases (default scope)', () => {
    const run = evalRun({
      status: 'completed',
      results: {
        tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' },
        tc2: { status: 'completed', reportId: 'r2' },
      },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(true);
    expect(visibility.judgeFailedCount).toBe(1);
    expect(visibility.rejudgeableCount).toBe(2);
    expect(visibility.retryJudgementCount).toBe(1);
    expect(visibility.retryJudgementDisabledReason).toBeUndefined();
  });

  it('retry judgement is DISABLED (with the no-output reason) for a terminal EvaluationRun with no completed case at all', () => {
    for (const results of [{}, { tc1: { status: 'failed', reportId: 'r1' } }, { tc1: { status: 'cancelled', reportId: 'r1' } }]) {
      const visibility = getRunActionVisibility(evalRun({ status: 'completed', results }));
      expect(visibility.canRetryJudgement).toBe(false);
      expect(visibility.rejudgeableCount).toBe(0);
      expect(visibility.retryJudgementCount).toBe(0);
      expect(visibility.retryJudgementDisabledReason).toBe('No completed test cases to re-judge');
    }
  });

  it('retry judgement is enabled for cancelled runs too (terminal), as long as some case completed', () => {
    const run = evalRun({
      status: 'cancelled',
      results: { tc1: { status: 'completed', passFailStatus: 'passed', reportId: 'r1' }, tc2: { status: 'cancelled', reportId: 'r2' } },
    });
    const visibility = getRunActionVisibility(run);
    expect(visibility.canRetryJudgement).toBe(true);
    expect(visibility.rejudgeableCount).toBe(1);
  });

  it('retry judgement is true for a "failed" (not just "completed") terminal run with judge-failed cases', () => {
    const run = evalRun({
      status: 'failed',
      results: { tc1: { status: 'completed', reportId: 'r1' } },
    });
    expect(getRunActionVisibility(run).canRetryJudgement).toBe(true);
  });
});

describe('isOldEnoughForZombieCancel', () => {
  it('is false for a run created just now', () => {
    expect(isOldEnoughForZombieCancel(new Date().toISOString())).toBe(false);
  });

  it('is false for a run created just under the threshold ago', () => {
    const createdAt = new Date(Date.now() - (ZOMBIE_CANCEL_MIN_AGE_MS - 500)).toISOString();
    expect(isOldEnoughForZombieCancel(createdAt)).toBe(false);
  });

  it('is true for a run created well past the threshold ago', () => {
    const createdAt = new Date(Date.now() - (ZOMBIE_CANCEL_MIN_AGE_MS + 5000)).toISOString();
    expect(isOldEnoughForZombieCancel(createdAt)).toBe(true);
  });

  it('is true (fails open) when createdAt is missing/unparseable — legacy docs should not be blocked forever', () => {
    expect(isOldEnoughForZombieCancel(undefined)).toBe(true);
    expect(isOldEnoughForZombieCancel('not-a-date')).toBe(true);
  });
});
