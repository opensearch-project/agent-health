/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * ReportPage — `/evaluations/reports/:reportId`: one EvaluationReport,
 * rendered from its own document alone.
 *
 * The run inspector needs the run document and the test case page needs the
 * test case; neither delete cascades to report documents, so a report can
 * outlive both. This page is where such a report still opens (the retired
 * `/runs/:reportId` page rendered the report this way — it never consulted
 * the run and tolerated a missing test case). It reuses the inspector's
 * right-hand panel and says plainly what is gone, linking to whatever still
 * exists (the run's inspector, the test case's page).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Breadcrumbs } from './Breadcrumbs';
import { TestCaseInspectorPanel } from './TestCaseInspectorPanel';
import { getResultStatus } from './ResultStatus';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { resolveReportScope, type ReportScope } from '@/lib/reportScope';
import { resolveReportRedirect, testCaseRunPath } from '@/lib/legacyRouteRedirects';
import { markPageReady } from '@/lib/pageLatency';
import type { EvaluationReport, TestCase } from '@/types';

interface Loaded {
  report: EvaluationReport;
  testCase: TestCase | null;
  /** Unknown (null) when the run / benchmark / test case lookups failed — the report still renders. */
  scope: ReportScope | null;
  testCaseKnown: boolean;
}

export const ReportPage: React.FC = () => {
  const { reportId } = useParams<{ reportId: string }>();
  const [data, setData] = useState<Loaded | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Generation guard: a slow load for a previous `:reportId` (or an earlier
  // Retry) must not overwrite the current one.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    const current = () => gen === generation.current;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setData(null);
    if (!reportId) { setNotFound(true); setLoading(false); return; }
    try {
      const report = await asyncRunStorage.getReportById(reportId);
      if (!current()) return;
      if (!report) { setNotFound(true); return; }
      // The report is the only thing this page needs. The lookups that
      // label what is gone (and link to what is left) are best-effort: if
      // they fail the report still renders, without labels or links.
      const [testCase, scope] = await Promise.all([
        asyncTestCaseStorage.getById(report.testCaseId).then(tc => ({ ok: true as const, tc }), () => ({ ok: false as const, tc: null })),
        resolveReportScope(report).then(sc => sc, () => null),
      ]);
      if (!current()) return;
      setData({ report, testCase: testCase.tc, testCaseKnown: testCase.ok, scope });
    } catch (err) {
      if (!current()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current()) {
        setLoading(false);
        markPageReady('report');
      }
    }
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground" data-testid="report-page-loading">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading report…
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-3 max-w-md px-4" data-testid="report-page-not-found">
          <AlertTriangle size={32} className="mx-auto text-amber-500" />
          <p className="text-sm font-medium">Report not found</p>
          <p className="text-sm text-muted-foreground">No run report with id {reportId} exists. It may have been deleted.</p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/evaluations/runs">Go to Evaluation Runs</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-3" data-testid="report-page-error">
          <AlertTriangle size={32} className="mx-auto text-amber-500" />
          <p className="text-sm text-muted-foreground">Could not load run report {reportId}: {error}</p>
          <Button variant="outline" size="sm" onClick={() => load()}>Retry</Button>
        </div>
      </div>
    );
  }

  const { report, testCase, scope, testCaseKnown } = data;
  const runDeleted = !!report.experimentRunId && scope !== null && !scope.runReachable;
  const testCaseDeleted = testCaseKnown && !testCase;
  const unverified = scope === null || !testCaseKnown;
  const inspectorHref = scope?.runReachable ? resolveReportRedirect(report, scope) : null;
  const testCaseHref = testCase ? testCaseRunPath(testCase.id, report.id) : null;
  const status = getResultStatus({ status: report.status }, report);

  return (
    <div className="h-full flex flex-col" data-testid="report-page">
      <div className="px-4 py-3 border-b bg-card shrink-0">
        <Breadcrumbs
          items={[
            { label: 'Evaluations', href: '/evaluations/runs' },
            { label: 'Evaluation Runs', href: '/evaluations/runs' },
            { label: testCase?.name ?? 'Run report' },
          ]}
          actions={<>
            {inspectorHref && (
              <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                <Link to={inspectorHref} data-testid="report-page-open-run">Open in run inspector</Link>
              </Button>
            )}
            {testCaseHref && (
              <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                <Link to={testCaseHref} data-testid="report-page-open-test-case">Open test case</Link>
              </Button>
            )}
          </>}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-base font-semibold truncate" data-testid="report-page-title">
            {testCase?.name ?? 'Run report'}
          </h1>
          <span className="text-xs text-muted-foreground font-mono truncate">{report.id}</span>
        </div>
        {(runDeleted || testCaseDeleted || unverified) && (
          <div
            className="mt-2 flex items-start gap-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs"
            data-testid="report-page-orphan-note"
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-400" />
            <div className="space-y-0.5">
              {runDeleted && (
                <div data-testid="report-page-run-deleted">
                  <span className="font-medium">Run deleted</span>
                  <span className="text-muted-foreground"> — the evaluation run this report belonged to ({report.experimentRunId}) no longer exists.</span>
                </div>
              )}
              {testCaseDeleted && (
                <div data-testid="report-page-test-case-deleted">
                  <span className="font-medium">Test case deleted</span>
                  <span className="text-muted-foreground"> — the test case ({report.testCaseId}) no longer exists; its definition is not available.</span>
                </div>
              )}
              {unverified && (
                <div data-testid="report-page-unverified">
                  <span className="font-medium">Could not check the run or test case</span>
                  <span className="text-muted-foreground"> — the lookup failed; the report is shown from its stored copy.</span>
                  {' '}
                  <button type="button" className="underline" onClick={() => load()}>Retry</button>
                </div>
              )}
              <div className="text-muted-foreground">This is the report as it was stored when the case ran.</div>
            </div>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {/* `testCaseFullRecord` stays unset: the banner above already says the
            test case is gone, so the panel's own "Test case deleted" note
            (meant for the run inspector) is not repeated here. */}
        <TestCaseInspectorPanel report={report} testCase={testCase} status={status} />
      </div>
    </div>
  );
};
