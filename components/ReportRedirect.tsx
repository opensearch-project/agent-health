/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * ReportRedirect — resolves the retired `/runs/:runId` route.
 *
 * That route's `:runId` was a REPORT id (one test case's `EvaluationReport`),
 * not an evaluation-run id, so it cannot be redirected by a static table: the
 * report has to be fetched to learn which run (and benchmark) it belongs to.
 * Reports of a run open in the run inspector with `?reportId=` preselecting
 * the case; standalone single-case reports open on the test case's detail
 * page with `?run=` preselecting the run (lib/legacyRouteRedirects.ts →
 * `resolveReportRedirect`). A report that no longer exists lands on the
 * evaluation-runs list with an explicit message instead of a blank page.
 *
 * Deleting a run or a benchmark keeps the report documents (no cascade), and
 * deleting a test case keeps its reports too, so a report can outlive every
 * page that could show it. Such an orphan — run gone AND test case gone —
 * gets an explicit explanation here rather than a silent bounce to a list.
 */

import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { asyncRunStorage, asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { getEvaluationRun } from '@/services/client';
import { resolveReportRedirect } from '@/lib/legacyRouteRedirects';
import type { EvaluationReport } from '@/types';

interface ReportScope {
  /**
   * Can the inspector actually open this report's run? True when the
   * evaluation-run doc exists, or (classic embedded runs) when the benchmark
   * still lists the run. False → the report is shown on the test case's
   * detail page instead, which needs only the report itself.
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

/**
 * Only a 404 means "no such run"; a transient/server failure propagates so
 * the user sees an error (and can reload) instead of being misrouted to the
 * test case page as if the run had been deleted.
 */
async function evaluationRunExists(runId: string): Promise<boolean> {
  try {
    await getEvaluationRun(runId);
    return true;
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return false;
    throw err;
  }
}

async function resolveScope(report: EvaluationReport): Promise<ReportScope> {
  if (!report.experimentRunId) return { runReachable: false, benchmarkReachable: true };
  const [bm, runExists] = await Promise.all([
    report.experimentId ? asyncBenchmarkStorage.getById(report.experimentId) : Promise.resolve(null),
    evaluationRunExists(report.experimentRunId),
  ]);
  const benchmarkReachable = !report.experimentId || !!bm;
  if (runExists) return { runReachable: true, benchmarkReachable };
  // No first-class doc — a classic embedded run is reachable while the
  // benchmark still lists it.
  const runReachable = !!bm?.runs?.some(r => r.id === report.experimentRunId);
  return { runReachable, benchmarkReachable };
}

export const ReportRedirect: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const { search } = useLocation();
  const [target, setTarget] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [orphan, setOrphan] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!runId) { setNotFound(true); return; }
    (async () => {
      const report = await asyncRunStorage.getReportById(runId);
      if (cancelled) return;
      if (!report) { setNotFound(true); return; }
      const scope = await resolveScope(report);
      if (cancelled) return;
      if (!scope.runReachable) {
        // The fallback is the test case's detail page — which redirects to
        // the Test Cases list when the test case is gone. Explain instead.
        const testCase = await asyncTestCaseStorage.getById(report.testCaseId);
        if (cancelled) return;
        if (!testCase) { setOrphan(true); return; }
      }
      setTarget(resolveReportRedirect(report, { ...scope, search }));
    })().catch(err => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [runId, search]);

  if (target) return <Navigate to={target} replace />;
  if (notFound) return <Navigate to="/evaluations/runs" replace state={{ missingReportId: runId }} />;

  if (orphan) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-sm" data-testid="report-redirect-orphan">
        <div className="flex items-start gap-2 max-w-xl rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" />
          <div>
            <div className="font-medium">Run report {runId} has nowhere to open</div>
            <div className="text-muted-foreground mt-1">
              The report still exists, but the run it belonged to and its test case were both deleted,
              so neither the run inspector nor the test case page can show it.
            </div>
          </div>
        </div>
        <Link to="/evaluations/runs" className="text-primary underline" data-testid="report-redirect-orphan-runs-link">
          Go to Evaluation Runs
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="report-redirect">
      {error ? (
        <span data-testid="report-redirect-error">Could not open run report {runId}: {error}</span>
      ) : (
        <>
          <Loader2 size={16} className="animate-spin" />
          <span>Opening run report…</span>
        </>
      )}
    </div>
  );
};
