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
 */

import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { asyncRunStorage, asyncBenchmarkStorage } from '@/services/storage';
import { getEvaluationRun } from '@/services/client';
import { resolveReportRedirect } from '@/lib/legacyRouteRedirects';
import type { EvaluationReport } from '@/types';

/**
 * Can the inspector actually open this report's run? True when the
 * evaluation-run doc exists, or (classic embedded runs) when the benchmark
 * still lists the run. False → the report is shown on the test case's detail
 * page instead, which needs only the report itself.
 */
async function runReachable(report: EvaluationReport): Promise<boolean> {
  if (!report.experimentRunId) return false;
  try {
    await getEvaluationRun(report.experimentRunId);
    return true;
  } catch { /* no first-class doc — check the benchmark projection below */ }
  if (!report.experimentId) return false;
  try {
    const bm = await asyncBenchmarkStorage.getById(report.experimentId);
    return !!bm?.runs?.some(r => r.id === report.experimentRunId);
  } catch {
    return false;
  }
}

export const ReportRedirect: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const { search } = useLocation();
  const [target, setTarget] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!runId) { setNotFound(true); return; }
    (async () => {
      const report = await asyncRunStorage.getReportById(runId);
      if (cancelled) return;
      if (!report) { setNotFound(true); return; }
      const reachable = await runReachable(report);
      if (cancelled) return;
      setTarget(resolveReportRedirect(report, { runReachable: reachable, search }));
    })().catch(err => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [runId, search]);

  if (target) return <Navigate to={target} replace />;
  if (notFound) return <Navigate to="/evaluations/runs" replace state={{ missingReportId: runId }} />;

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
