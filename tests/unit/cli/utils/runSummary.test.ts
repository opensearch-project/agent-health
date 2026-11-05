/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Final-summary counting + exit code for the CLI run commands
 * (cli/utils/runSummary.ts). Regression for: `agent-health benchmark`
 * printed "✓ Passed: N" and exited 0 when ALL N cases ERRORED (every agent
 * request got a 403 — `results[*].status === 'completed'` with no
 * `passFailStatus`, report `metricsStatus: 'error'`).
 */

import {
  summarizeRunResults,
  buildSummaryCounts,
  countExecutionErrors,
  exitCodeForSummary,
  flagExitCode,
  formatPassRate,
  formatResultsLines,
  describeExitReason,
} from '@/cli/utils/runSummary';

/** The exact per-case shape the evaluation runner persists for an agent-request failure. */
const erroredResult = (n: number) => ({ reportId: `report-${n}`, status: 'completed' as const });
const passedResult = (n: number) => ({ reportId: `report-${n}`, status: 'completed' as const, passFailStatus: 'passed' as const });
const failedResult = (n: number) => ({ reportId: `report-${n}`, status: 'failed' as const, passFailStatus: 'failed' as const });
/** The runner's exception path: `status: 'failed'` + `error`, no verdict (services/evaluationRunner.ts catch block). */
const executionErrorResult = (n: number) => ({ reportId: '', status: 'failed' as const, error: `Evaluation error ${n}` });

const baseCounts = { passed: 0, failed: 0, errored: 0, pending: 0, notRun: 0, total: 0, executionErrors: 0, passRate: 0, passRateJudged: null as number | null };

describe('summarizeRunResults', () => {
  it('counts an all-errored run (every agent request rejected) as 0 passed / 0 failed / 5 errored — never as 5 passed', () => {
    const counts = summarizeRunResults({
      status: 'completed',
      results: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`tc-${n}`, erroredResult(n)])),
      testCaseSnapshots: new Array(5).fill({}),
    });
    expect(counts).toEqual({ ...baseCounts, errored: 5, total: 5, passRate: 0, passRateJudged: null });
  });

  it('does NOT fall back to a denormalized run.stats that claims passes for an all-errored run (the old-writer hole)', () => {
    // computeRunStats trusts run.stats in this exact shape (legacy UI data);
    // for a run the CLI just executed that would reproduce the original bug.
    const counts = summarizeRunResults({
      status: 'completed',
      results: { a: erroredResult(1), b: erroredResult(2) },
      // deliberately corrupt / stale denormalized stats
      ...({ stats: { passed: 2, failed: 0, errored: 0, pending: 0, notRun: 0, total: 2 } } as object),
    });
    expect(counts.passed).toBe(0);
    expect(counts.errored).toBe(2);
  });

  it('counts a mixed run exactly: 2 passed, 1 failed, 2 errored; judged pass rate 67%, planned-total pass rate 40%', () => {
    const counts = summarizeRunResults({
      status: 'completed',
      results: {
        'tc-1': passedResult(1),
        'tc-2': passedResult(2),
        'tc-3': failedResult(3),
        'tc-4': erroredResult(4),
        'tc-5': erroredResult(5),
      },
      testCaseSnapshots: new Array(5).fill({}),
    });
    expect(counts).toEqual({ ...baseCounts, passed: 2, failed: 1, errored: 2, total: 5, passRate: 40, passRateJudged: 67 });
  });

  it('keeps the all-judged shape unchanged (3 passed, 1 failed → 75%, nothing errored)', () => {
    const counts = summarizeRunResults({
      status: 'completed',
      results: { a: passedResult(1), b: passedResult(2), c: passedResult(3), d: failedResult(4) },
    });
    expect(counts).toEqual({ ...baseCounts, passed: 3, failed: 1, total: 4, passRate: 75, passRateJudged: 75 });
  });

  it('buckets never-started cases of a cancelled run as notRun, not as passed or errored', () => {
    const counts = summarizeRunResults({
      status: 'cancelled',
      results: { a: passedResult(1), b: { reportId: '', status: 'cancelled' } },
      testCaseSnapshots: new Array(3).fill({}),
    });
    expect(counts).toMatchObject({ ...baseCounts, passed: 1, notRun: 2, total: 3, passRateJudged: 100, passRate: expect.any(Number) });
    expect(counts.passRate).toBeCloseTo(33.33, 1);
  });

  it('surfaces the runner\'s exception path separately: counted as failed (UI parity) AND as executionErrors', () => {
    const counts = summarizeRunResults({
      status: 'completed',
      results: { a: passedResult(1), b: executionErrorResult(2), c: failedResult(3) },
    });
    expect(counts.failed).toBe(2);
    expect(counts.executionErrors).toBe(1);
  });

  it('handles a run with no results / no snapshots without crashing (total 0)', () => {
    expect(summarizeRunResults({ status: 'completed' })).toEqual(baseCounts);
    expect(summarizeRunResults({ status: 'completed', results: {}, testCaseSnapshots: [] })).toEqual(baseCounts);
  });
});

describe('countExecutionErrors', () => {
  it('counts only status failed + error + no verdict', () => {
    expect(countExecutionErrors({
      a: executionErrorResult(1),
      b: failedResult(2),                                   // judged failure
      c: { status: 'failed', error: '' },                   // empty error → not the exception path
      d: { status: 'completed', error: 'stale' },           // not failed
    })).toBe(1);
    expect(countExecutionErrors(undefined)).toBe(0);
  });
});

describe('buildSummaryCounts', () => {
  it('carries pending through (trace-mode judge not run yet / report not readable)', () => {
    const counts = buildSummaryCounts({ passed: 1, failed: 0, errored: 0, pending: 2, notRun: 0, total: 3 }, undefined);
    expect(counts.pending).toBe(2);
    expect(counts.passRateJudged).toBe(100);
    expect(counts.passRate).toBeCloseTo(33.33, 1);
  });
});

describe('exitCodeForSummary', () => {
  it('exits 1 when any case errored (the evaluation could not be performed)', () => {
    expect(exitCodeForSummary({ errored: 5, executionErrors: 0, notRun: 0, total: 5 })).toBe(1);
    expect(exitCodeForSummary({ errored: 1, executionErrors: 0, notRun: 0, total: 5 })).toBe(1);
  });

  it('exits 1 for execution errors, never-run cases, and an empty run (nothing evaluated)', () => {
    expect(exitCodeForSummary({ errored: 0, executionErrors: 1, notRun: 0, total: 3 })).toBe(1);
    expect(exitCodeForSummary({ errored: 0, executionErrors: 0, notRun: 2, total: 3 })).toBe(1);
    expect(exitCodeForSummary({ errored: 0, executionErrors: 0, notRun: 0, total: 0 })).toBe(1);
  });

  it('exits 0 when every case was judged — failed verdicts are data, not an error', () => {
    expect(exitCodeForSummary({ errored: 0, executionErrors: 0, notRun: 0, total: 4 })).toBe(0);
  });
});

describe('flagExitCode', () => {
  const original = process.exitCode;
  afterEach(() => { process.exitCode = original; });

  it('sets a non-zero exit code and never clears one that was already set', () => {
    process.exitCode = undefined;
    flagExitCode(0);
    expect(process.exitCode).toBeUndefined();
    flagExitCode(1);
    expect(process.exitCode).toBe(1);
    flagExitCode(0);
    expect(process.exitCode).toBe(1);
  });
});

describe('formatPassRate', () => {
  it('renders "—" when nothing was judged instead of a fabricated 0%', () => {
    expect(formatPassRate(null)).toBe('—');
    expect(formatPassRate(0)).toBe('0%');
    expect(formatPassRate(67)).toBe('67%');
  });
});

describe('formatResultsLines / describeExitReason', () => {
  it('shows an Errored line (and no "Passed: 5") for an all-errored run and explains the exit code', () => {
    const counts = { ...baseCounts, errored: 5, total: 5 };
    const lines = formatResultsLines(counts);
    expect(lines).toEqual([
      '✓ Passed: 0',
      '✗ Failed: 0',
      '⚠ Errored: 5 (not judged — the agent request or the evaluator failed)',
      'Total: 5',
    ]);
    expect(lines.join('\n')).not.toContain('Passed: 5');
    expect(describeExitReason(counts)).toBe('5 errored (agent request or evaluator failed) of 5 test case(s) could not be evaluated — exiting with code 1.');
  });

  it('omits the Errored / Pending / Not run lines when zero, keeping the familiar three-line block; no exit reason', () => {
    const counts = { ...baseCounts, passed: 3, failed: 1, total: 4, passRate: 75, passRateJudged: 75 };
    expect(formatResultsLines(counts)).toEqual(['✓ Passed: 3', '✗ Failed: 1', 'Total: 4']);
    expect(describeExitReason(counts)).toBeNull();
  });

  it('adds Pending / Not run lines and annotates execution errors on the Failed line', () => {
    const counts = { ...baseCounts, passed: 1, failed: 2, executionErrors: 1, pending: 1, notRun: 2, total: 6, passRateJudged: 33 };
    const lines = formatResultsLines(counts);
    expect(lines).toContain('✗ Failed: 2 (1 of these are execution errors, not verdicts)');
    expect(lines).toContain('… Pending: 1 (judge has not run yet)');
    expect(lines).toContain('− Not run: 2');
    expect(describeExitReason(counts)).toBe('1 hit an execution error, 2 never ran of 6 test case(s) could not be evaluated — exiting with code 1.');
  });

  it('explains an empty run', () => {
    expect(describeExitReason(baseCounts)).toBe('No test cases were evaluated — exiting with code 1.');
  });
});
