/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Final-summary counts and exit code for the CLI run commands (`benchmark`
 * in both its unified `-f file.eval.js` / `-t` / `-d` mode and its legacy
 * single-JSON-file mode).
 *
 * Why this module exists: the unified `benchmark` summary used to count every
 * `run.results[*].status === 'completed'` entry as PASSED. The evaluation
 * runner writes `status: 'completed'` for any case whose execution finished —
 * including one whose agent request failed (403 from expired credentials,
 * connection refused, …) and which therefore has NO verdict
 * (`passFailStatus` absent, report `metricsStatus: 'error'`). A run in which
 * every single agent request was rejected printed "✓ Passed: N" and exited 0.
 *
 * Counts come from `bucketRunResults` (lib/runStats), the same bucketing the
 * UI's runs list / run detail / comparison pages use, so the CLI cannot
 * disagree with the web UI about the same run. It is called directly (not via
 * `computeRunStats`) on purpose: that wrapper's legacy-shape fallback trusts
 * the denormalized `run.stats` when every result looks errored, which is right
 * for historical runs in the UI but is exactly the "count completed as
 * passed" hole for a run this CLI just executed — fail loud instead.
 *
 * Kept free of ESM-only deps (`chalk`, `ora`) so unit tests import the real
 * functions rather than mirroring their logic.
 *
 * Exit-code convention (docs/CLI.md → "Exit Codes"): `0` success, `1` error.
 * A test case that was judged and FAILED is data, not an error — the command
 * did its job, so a run with failed verdicts still exits 0 (unchanged
 * behaviour; pipelines gate on the counts). The command exits 1 when the
 * evaluation was NOT performed for some case: errored (agent request rejected
 * / judge could not run), an execution error inside the runner, a planned
 * case that never ran (cancelled run), or nothing to evaluate at all. An
 * all-errored run therefore never exits 0 as a "pass".
 */

import { bucketRunResults } from '@/lib/runStats.js';
import type { BenchmarkRunStatus } from '@/types/index.js';

/** Per-case result entry as persisted on `EvaluationRun.results` / `BenchmarkRun.results`. */
export interface RunResultEntry {
  status?: string;
  passFailStatus?: string;
  error?: string;
}

export interface RunSummaryCounts {
  /** Judged and passed. */
  passed: number;
  /**
   * Judged and failed, PLUS cases whose execution failed inside the runner
   * (the repo-wide bucketing counts both as `failed`; see `executionErrors`).
   */
  failed: number;
  /** Executed, but no verdict could be produced (agent request rejected, judge could not run). */
  errored: number;
  /** Still running / report not readable yet (trace-mode judge pending, report not fetched). */
  pending: number;
  /** Planned but never executed (run cancelled / executor died before reaching them). */
  notRun: number;
  /** Planned test cases. */
  total: number;
  /**
   * Of `failed`: results written by the runner's exception path
   * (`status: 'failed'` + `error`, no `passFailStatus`) — the case was never
   * judged. Displayed as failed for parity with the UI, but it is not a
   * verdict, so it fails the exit code like an errored case.
   */
  executionErrors: number;
  /**
   * Pass rate over the planned total (`passed / total * 100`), the formula
   * the `-o json` output has always used — kept for existing automation.
   * `0` when nothing was planned.
   */
  passRate: number;
  /**
   * Pass rate over the JUDGED set (`passed / (passed + failed)`, 0–100,
   * rounded — lib/runStats `passRateOverJudged`). `null` when nothing was
   * judged — render as "—", never as a fabricated 0%. This is what the human
   * table shows, so N errored cases read as "N errored", not "0%".
   */
  passRateJudged: number | null;
}

/** `status: 'failed'` with an `error` and no verdict = the runner's exception path, not a judge verdict. */
export function countExecutionErrors(results: Record<string, RunResultEntry> | undefined): number {
  return Object.values(results || {}).filter(
    r => r.status === 'failed' && !r.passFailStatus && typeof r.error === 'string' && r.error.length > 0
  ).length;
}

/** Assemble the summary from already-bucketed stats plus the raw results (for `executionErrors`). */
export function buildSummaryCounts(
  stats: { passed: number; failed: number; errored: number; pending: number; notRun: number; total: number },
  results: Record<string, RunResultEntry> | undefined
): RunSummaryCounts {
  const judged = stats.passed + stats.failed;
  return {
    passed: stats.passed,
    failed: stats.failed,
    errored: stats.errored,
    pending: stats.pending,
    notRun: stats.notRun,
    total: stats.total,
    executionErrors: countExecutionErrors(results),
    passRate: stats.total > 0 ? (stats.passed / stats.total) * 100 : 0,
    passRateJudged: judged > 0 ? Math.round((stats.passed / judged) * 100) : null,
  };
}

/**
 * Count a persisted evaluation run's per-case results into
 * passed / failed / errored / pending / notRun — never counting a
 * verdict-less `completed` entry as a pass.
 */
export function summarizeRunResults(run: {
  status?: BenchmarkRunStatus;
  results?: Record<string, RunResultEntry>;
  testCaseSnapshots?: unknown[];
}): RunSummaryCounts {
  const stats = bucketRunResults(run.results, run.testCaseSnapshots?.length, run.status);
  return buildSummaryCounts(stats, run.results);
}

/**
 * Process exit code for a run summary: `1` when the evaluation was not
 * performed for some planned case — errored, an execution error, never run —
 * or when there was nothing to evaluate; else `0`. Failed verdicts and a
 * pending trace-mode judge do not affect the exit code (see module doc).
 */
export function exitCodeForSummary(
  counts: Pick<RunSummaryCounts, 'errored' | 'executionErrors' | 'notRun' | 'total'>
): 0 | 1 {
  return counts.errored > 0 || counts.executionErrors > 0 || counts.notRun > 0 || counts.total === 0 ? 1 : 0;
}

/**
 * Record a non-zero exit code without ever clearing one set earlier.
 * `process.exitCode` is process-global and sticky; the commands set it (rather
 * than calling `process.exit`) so result links, `--export` and the server
 * cleanup in `finally` still run.
 */
export function flagExitCode(code: 0 | 1): void {
  if (code !== 0) process.exitCode = code;
}

/** `"83%"`, or `"—"` when nothing was judged. */
export function formatPassRate(passRateJudged: number | null): string {
  return passRateJudged === null ? '—' : `${passRateJudged}%`;
}

/**
 * The plain-text (uncoloured) lines of the `Results:` block printed after a
 * unified `benchmark` run. Lines for zero counts are omitted (except Passed /
 * Failed / Total) so the common all-judged case keeps its familiar shape.
 */
export function formatResultsLines(counts: RunSummaryCounts): string[] {
  const lines = [
    `✓ Passed: ${counts.passed}`,
    `✗ Failed: ${counts.failed}${counts.executionErrors > 0 ? ` (${counts.executionErrors} of these are execution errors, not verdicts)` : ''}`,
  ];
  if (counts.errored > 0) {
    lines.push(`⚠ Errored: ${counts.errored} (not judged — the agent request or the evaluator failed)`);
  }
  if (counts.pending > 0) {
    lines.push(`… Pending: ${counts.pending} (judge has not run yet)`);
  }
  if (counts.notRun > 0) {
    lines.push(`− Not run: ${counts.notRun}`);
  }
  lines.push(`Total: ${counts.total}`);
  return lines;
}

/**
 * One-line explanation of a non-zero exit code, or `null` when the run is
 * clean. Shared by both `benchmark` paths so the wording matches.
 */
export function describeExitReason(counts: RunSummaryCounts): string | null {
  if (counts.total === 0) return 'No test cases were evaluated — exiting with code 1.';
  const parts: string[] = [];
  if (counts.errored > 0) parts.push(`${counts.errored} errored (agent request or evaluator failed)`);
  if (counts.executionErrors > 0) parts.push(`${counts.executionErrors} hit an execution error`);
  if (counts.notRun > 0) parts.push(`${counts.notRun} never ran`);
  if (parts.length === 0) return null;
  return `${parts.join(', ')} of ${counts.total} test case(s) could not be evaluated — exiting with code 1.`;
}
