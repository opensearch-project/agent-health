/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which evals3 pages can still show a given report?
 *
 * Deleting a run or a benchmark keeps the report documents (no cascade), and
 * deleting a test case keeps its reports too, so a report can outlive every
 * page that would normally show it. `ReportRedirect` (the retired
 * `/runs/:reportId` link) uses this to pick a destination; `ReportPage` (the
 * standalone report view) uses it to label what is gone and to link to
 * whatever still exists.
 */

import { asyncBenchmarkStorage } from '@/services/storage';
import { getEvaluationRun } from '@/services/client';
import type { EvaluationReport } from '@/types';

export interface ReportScope {
  /**
   * Can the run inspector actually open this report? True when the run still
   * exists — as an evaluation-run doc or (classic embedded runs) listed by
   * its benchmark — AND that run's results still point at this report (the
   * inspector selects the case by `results[*].reportId`; a report that a
   * later re-judgement replaced would open an inspector with nothing
   * selected). False → the run was deleted, or the report never had one.
   */
  runReachable: boolean;
  /**
   * Does the benchmark the report names still exist? Deleting a benchmark
   * keeps its runs, and the benchmark-scoped inspector bounces to the
   * Benchmarks list for an unknown benchmark — so such a run opens in the
   * bare run inspector instead.
   */
  benchmarkReachable: boolean;
}

interface RunResultsLike {
  results?: Record<string, { reportId?: string | null } | undefined>;
}

/**
 * Only a 404 means "no such run"; a transient/server failure propagates so
 * the caller can decide (the redirect falls back to the standalone report
 * page; the report page shows the report without labels) instead of treating
 * the run as deleted.
 */
async function fetchEvaluationRun(runId: string): Promise<RunResultsLike | null> {
  try {
    return (await getEvaluationRun(runId)) as RunResultsLike;
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return null;
    throw err;
  }
}

/** A run with a `results` map lists the report; a run without one is given the benefit of the doubt. */
function runListsReport(run: RunResultsLike | null | undefined, reportId: string): boolean {
  if (!run) return false;
  if (!run.results) return true;
  return Object.values(run.results).some(r => r?.reportId === reportId);
}

export async function resolveReportScope(
  report: Pick<EvaluationReport, 'id' | 'experimentId' | 'experimentRunId'>,
): Promise<ReportScope> {
  if (!report.experimentRunId) return { runReachable: false, benchmarkReachable: true };
  const [bm, run] = await Promise.all([
    report.experimentId ? asyncBenchmarkStorage.getById(report.experimentId) : Promise.resolve(null),
    fetchEvaluationRun(report.experimentRunId),
  ]);
  const benchmarkReachable = !report.experimentId || !!bm;
  if (run) return { runReachable: runListsReport(run, report.id), benchmarkReachable };
  // No first-class doc — a classic embedded run is reachable while the
  // benchmark still lists it (and it still lists this report).
  const embedded = bm?.runs?.find(r => r.id === report.experimentRunId) as RunResultsLike | undefined;
  return { runReachable: runListsReport(embedded, report.id), benchmarkReachable };
}
