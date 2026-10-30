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
 * The counts here come from `computeRunStats` (lib/runStats), the single
 * source of truth the UI's runs list / run detail / comparison pages use, so
 * the CLI can never disagree with the web UI about the same run again.
 *
 * Kept free of ESM-only deps (`chalk`, `ora`) so unit tests import the real
 * functions rather than mirroring their logic.
 *
 * Exit-code convention (docs/CLI.md → "Exit Codes"): `0` success, `1` error.
 * A test case that FAILED its evaluation is data, not an error — the command
 * did its job, so a run with failures still exits 0 (unchanged behaviour,
 * relied on by CI pipelines that read the counts). A test case that ERRORED
 * means the evaluation could NOT be performed (agent unreachable / rejected
 * the request, judge could not run): the tool did not do what was asked, so
 * the command exits 1. An all-errored run therefore never exits 0 as a
 * "pass".
 */

import { computeRunStats, passRateOverJudged } from '@/lib/runStats.js';
import type { BenchmarkRunStatus, RunStats } from '@/types/index.js';

export interface RunSummaryCounts {
  /** Judged and passed. */
  passed: number;
  /** Judged and failed (verdict `failed`, or the execution itself failed). */
  failed: number;
  /** Executed, but no verdict could be produced (agent request rejected, judge could not run). */
  errored: number;
  /** Planned but never executed (run cancelled / executor died before reaching them). */
  notRun: number;
  /** Planned test cases. */
  total: number;
  /**
   * Pass rate over the JUDGED set (`passed / (passed + failed)`), 0–100.
   * `null` when nothing was judged — render as "—", never as a fabricated 0%.
   */
  passRate: number | null;
}

/**
 * Count a persisted evaluation / benchmark run's per-case results into
 * passed / failed / errored / notRun — never counting a verdict-less
 * `completed` entry as a pass.
 */
export function summarizeRunResults(run: {
  status?: BenchmarkRunStatus;
  results?: Record<string, { status?: string; passFailStatus?: string }>;
  stats?: Partial<RunStats> | null;
  testCaseSnapshots?: unknown[];
}): RunSummaryCounts {
  const stats = computeRunStats(run);
  return {
    passed: stats.passed,
    failed: stats.failed,
    errored: stats.errored,
    notRun: stats.notRun,
    total: stats.total,
    passRate: passRateOverJudged(stats),
  };
}

/**
 * Process exit code for a run summary: `1` when any case ERRORED (the
 * evaluation could not be performed for it), else `0`. Failed verdicts do
 * not affect the exit code — see the module doc for the convention.
 */
export function exitCodeForSummary(counts: Pick<RunSummaryCounts, 'errored'>): 0 | 1 {
  return counts.errored > 0 ? 1 : 0;
}

/** `"83%"`, or `"—"` when nothing was judged. */
export function formatPassRate(passRate: number | null): string {
  return passRate === null ? '—' : `${passRate}%`;
}

/**
 * The plain-text (uncoloured) lines of the `Results:` block printed after a
 * unified `benchmark` run. Errored / not-run lines appear only when non-zero
 * so the common all-judged case keeps its familiar three-line shape.
 */
export function formatResultsLines(counts: RunSummaryCounts): string[] {
  const lines = [
    `✓ Passed: ${counts.passed}`,
    `✗ Failed: ${counts.failed}`,
  ];
  if (counts.errored > 0) {
    lines.push(`⚠ Errored: ${counts.errored} (not judged — the agent request or the evaluator failed)`);
  }
  if (counts.notRun > 0) {
    lines.push(`− Not run: ${counts.notRun}`);
  }
  lines.push(`Total: ${counts.total}`);
  return lines;
}
