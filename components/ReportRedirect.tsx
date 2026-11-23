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
 * The only error state left is "the report itself could not be fetched".
 *
 * Deleting a run or a benchmark keeps the report documents (no cascade), and
 * deleting a test case keeps its reports too, so a report can outlive every
 * page that could show it. Such a report — run gone AND test case gone —
 * opens on the standalone report page (`/evaluations/reports/:reportId`),
 * which renders the report from its own document, exactly as the retired
 * page did.
 */

import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { mergeSearch, reportPath, resolveReportRedirect } from '@/lib/legacyRouteRedirects';
import { resolveReportScope } from '@/lib/reportScope';

export const ReportRedirect: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const { search } = useLocation();
  const [target, setTarget] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Fresh resolution per URL: an error from a previous `/runs/:id` must not
    // linger (the route element is reused across in-place param changes).
    setTarget(null); setNotFound(false); setError(null);
    if (!runId) { setNotFound(true); return; }
    (async () => {
      const report = await asyncRunStorage.getReportById(runId);
      if (cancelled) return;
      if (!report) { setNotFound(true); return; }
      try {
        const scope = await resolveReportScope(report);
        if (cancelled) return;
        let testCaseReachable = true;
        if (!scope.runReachable) {
          // The fallback is the test case's detail page — which redirects to
          // the Test Cases list when the test case is gone; the standalone
          // report page takes over then.
          const testCase = await asyncTestCaseStorage.getById(report.testCaseId);
          if (cancelled) return;
          testCaseReachable = !!testCase;
        }
        setTarget(resolveReportRedirect(report, { ...scope, testCaseReachable, search }));
      } catch {
        // The report exists but its run / benchmark / test case could not be
        // looked up (transient failure, not a 404): never an error page for
        // an existing report — the standalone report page needs only the
        // report document and says what it could not verify.
        if (!cancelled) setTarget(mergeSearch(reportPath(report.id), search));
      }
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
