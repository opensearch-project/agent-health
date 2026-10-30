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
  exitCodeForSummary,
  formatPassRate,
  formatResultsLines,
} from '@/cli/utils/runSummary';

/** The exact per-case shape the evaluation runner persists for an agent-request failure. */
const erroredResult = (n: number) => ({ reportId: `report-${n}`, status: 'completed' as const });
const passedResult = (n: number) => ({ reportId: `report-${n}`, status: 'completed' as const, passFailStatus: 'passed' as const });
const failedResult = (n: number) => ({ reportId: `report-${n}`, status: 'failed' as const, passFailStatus: 'failed' as const });

describe('summarizeRunResults', () => {
  it('counts an all-errored run (every agent request rejected) as 0 passed / 0 failed / 5 errored — never as 5 passed', () => {
    const counts = summarizeRunResults({
      status: 'completed',
      results: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`tc-${n}`, erroredResult(n)])),
      stats: { passed: 0, failed: 0, errored: 5, pending: 0, notRun: 0, total: 5 },
      testCaseSnapshots: new Array(5).fill({}),
    });
    expect(counts).toEqual({ passed: 0, failed: 0, errored: 5, notRun: 0, total: 5, passRate: null });
  });

  it('counts a mixed run exactly: 2 passed, 1 failed, 2 errored; pass rate over the judged set only', () => {
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
    expect(counts).toEqual({ passed: 2, failed: 1, errored: 2, notRun: 0, total: 5, passRate: 67 });
  });

  it('keeps the all-judged shape unchanged (3 passed, 1 failed → 75%, nothing errored)', () => {
    const counts = summarizeRunResults({
      status: 'completed',
      results: { a: passedResult(1), b: passedResult(2), c: passedResult(3), d: failedResult(4) },
    });
    expect(counts).toEqual({ passed: 3, failed: 1, errored: 0, notRun: 0, total: 4, passRate: 75 });
  });

  it('buckets never-started cases of a cancelled run as notRun, not as passed or errored', () => {
    const counts = summarizeRunResults({
      status: 'cancelled',
      results: { a: passedResult(1), b: { reportId: '', status: 'cancelled' } },
      testCaseSnapshots: new Array(3).fill({}),
    });
    expect(counts).toEqual({ passed: 1, failed: 0, errored: 0, notRun: 2, total: 3, passRate: 100 });
  });
});

describe('exitCodeForSummary', () => {
  it('exits 1 when any case errored (the evaluation could not be performed)', () => {
    expect(exitCodeForSummary({ errored: 5 })).toBe(1);
    expect(exitCodeForSummary({ errored: 1 })).toBe(1);
  });

  it('exits 0 when every case was judged — failed verdicts are data, not an error', () => {
    expect(exitCodeForSummary({ errored: 0 })).toBe(0);
  });
});

describe('formatPassRate', () => {
  it('renders "—" when nothing was judged instead of a fabricated 0%', () => {
    expect(formatPassRate(null)).toBe('—');
    expect(formatPassRate(0)).toBe('0%');
    expect(formatPassRate(67)).toBe('67%');
  });
});

describe('formatResultsLines', () => {
  it('shows an Errored line (and no "Passed: 5") for an all-errored run', () => {
    const lines = formatResultsLines({ passed: 0, failed: 0, errored: 5, notRun: 0, total: 5, passRate: null });
    expect(lines).toEqual([
      '✓ Passed: 0',
      '✗ Failed: 0',
      '⚠ Errored: 5 (not judged — the agent request or the evaluator failed)',
      'Total: 5',
    ]);
    expect(lines.join('\n')).not.toContain('Passed: 5');
  });

  it('omits the Errored / Not run lines when they are zero, keeping the familiar three-line block', () => {
    expect(formatResultsLines({ passed: 3, failed: 1, errored: 0, notRun: 0, total: 4, passRate: 75 })).toEqual([
      '✓ Passed: 3',
      '✗ Failed: 1',
      'Total: 4',
    ]);
  });

  it('adds a Not run line for cases a cancelled run never reached', () => {
    const lines = formatResultsLines({ passed: 1, failed: 0, errored: 0, notRun: 2, total: 3, passRate: 100 });
    expect(lines).toContain('− Not run: 2');
  });
});
