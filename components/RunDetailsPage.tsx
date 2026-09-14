/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { ArrowLeft, Calendar, CheckCircle2, XCircle, Clock, Loader2, StopCircle, Timer, Download, GitCompare, AlertTriangle } from 'lucide-react';
import { getResultStatus, StatusIcon, StatusLabel, getErrorStage } from '@/components/evals3/ResultStatus';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { useSidebar } from '@/components/ui/sidebar';
import { asyncExperimentStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { cancelExperimentRun } from '@/services/client';
import { Experiment, ExperimentRun, EvaluationReport, TestCase } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getDifficultyColor, formatDate, getModelName, getJudgeModelLabel, getEvaluatorLabel } from '@/lib/utils';
import { formatDuration, formatCost, fetchBatchMetrics } from '@/services/metrics';
import { ENV_CONFIG } from '@/lib/config';
import { RunDetailsContent } from './RunDetailsContent';
import { RunSummaryBand, RunSummaryStats } from './RunSummaryBand';
import { RunInsightsPane } from './RunInsightsPane';

// ==================== Skeleton Components ====================

const PageSkeleton = ({ label }: { label?: string | null }) => (
  <div className="h-full flex flex-col" data-testid="run-details-loading">
    <div className="flex items-center justify-between p-4 border-b">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10 rounded" />
        <div>
          <Skeleton className="h-6 w-[200px] mb-2" />
          <Skeleton className="h-4 w-[300px]" />
        </div>
      </div>
    </div>
    {/* Explicit progress text so a large run never sits on a silent void -
        the reported bug had no indication anything was happening at all. */}
    <div className="flex items-center gap-2 px-6 pt-4 text-sm text-muted-foreground" data-testid="run-details-loading-label">
      <Loader2 size={14} className="animate-spin" />
      <span>{label || 'Loading run\u2026'}</span>
    </div>
    <div className="flex-1 p-6">
      <Skeleton className="h-full w-full" />
    </div>
  </div>
);

// ==================== Types ====================

interface ExperimentContext {
  experiment: Experiment;
  experimentRun: ExperimentRun;
  siblingReports: EvaluationReport[];
  testCases: TestCase[];
  reportsMap: Record<string, EvaluationReport | null>;
}

// ==================== Test Case List Component ====================
//
// Directly rendered below the RunSummaryBand on the bare route (no
// "Select a test case" empty pane, no redirect) — see RunDetailsPage's
// render body. Each row shows name, category/difficulty chips, verdict
// chip, and duration. Clicking a row is handled entirely by the caller via
// `onSelectItem` (sets `?testCase=<id>` on the URL).

interface TestCaseListProps {
  context: ExperimentContext;
  selectedItem: string;
  onSelectItem: (item: string) => void;
  /** When true (split/detail view), scroll the selected row into view once on mount/selection change — powers deep-link preselection. */
  scrollToSelected?: boolean;
  /**
   * When set, only these testCaseIds are rendered — powers "click a failure
   * theme in RunInsightsPane -> filter the list to just those cases".
   * `null`/`undefined` shows every case (no filter active).
   */
  filterIds?: string[] | null;
  /** Clears an active filter (rendered as a "Clear filter" chip next to the count). */
  onClearFilter?: () => void;
}

const TestCaseList = ({ context, selectedItem, onSelectItem, scrollToSelected, filterIds, onClearFilter }: TestCaseListProps) => {
  const { experimentRun, testCases, reportsMap } = context;

  const getTestCase = (testCaseId: string) => testCases.find(tc => tc.id === testCaseId);

  const testCaseIds = Object.keys(experimentRun.results || {});
  const visibleIds = filterIds ? testCaseIds.filter(id => filterIds.includes(id)) : testCaseIds;
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!scrollToSelected || !selectedItem) return;
    rowRefs.current[selectedItem]?.scrollIntoView?.({ block: 'center' });
  }, [scrollToSelected, selectedItem]);

  return (
    <ScrollArea className="h-full" data-testid="run-test-case-list">
      <div className="p-3 space-y-2">
        {/* Header with count + Overview (deselect) affordance */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Test Cases
            </span>
            {selectedItem && (
              <button
                type="button"
                data-testid="test-case-list-overview"
                className="text-xs text-opensearch-blue hover:underline flex items-center gap-1"
                onClick={() => { onSelectItem(''); onClearFilter?.(); }}
              >
                <ArrowLeft size={11} /> Overview
              </button>
            )}
          </div>
          <Badge variant="secondary" className="text-xs">
            {filterIds ? `${visibleIds.length} / ${testCaseIds.length}` : testCaseIds.length}
          </Badge>
        </div>
        {filterIds && (
          <div className="flex items-center justify-between px-1 -mt-1">
            <span className="text-[11px] text-muted-foreground">Filtered by failure theme</span>
            <button
              type="button"
              data-testid="test-case-list-clear-filter"
              className="text-[11px] text-opensearch-blue hover:underline"
              onClick={onClearFilter}
            >
              Clear filter
            </button>
          </div>
        )}

        {/* Test Cases */}
        {visibleIds.map(testCaseId => {
          const result = experimentRun.results[testCaseId];
          const report = result.reportId ? reportsMap[result.reportId] : null;
          const testCase = getTestCase(testCaseId);
          const isSelected = selectedItem === testCaseId;

          const resultStatus = getResultStatus(result, report);
          const durationMs = result.performanceMetrics?.durationMs;

          return (
            <Card
              key={testCaseId}
              ref={(el) => { rowRefs.current[testCaseId] = el; }}
              data-testid="test-case-row"
              data-test-case-id={testCaseId}
              data-status={resultStatus}
              className={`cursor-pointer transition-colors ${
                isSelected
                  ? 'border-opensearch-blue bg-opensearch-blue/5'
                  : 'hover:border-muted-foreground/30'
              }`}
              onClick={() => {
                onSelectItem(testCaseId);
              }}
            >
              <CardContent className="p-3">
                <div className="flex items-start gap-3">
                  {/* Status Icon */}
                  <div className="mt-0.5">
                    <StatusIcon status={resultStatus} size={18} stage={getErrorStage(resultStatus, report)} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-sm font-medium truncate ${
                        isSelected ? 'text-opensearch-blue' : ''
                      }`}>
                        {testCase?.name || testCaseId}
                      </p>
                      <StatusLabel status={resultStatus} stage={getErrorStage(resultStatus, report)} />
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {testCase?.category && (
                        <Badge variant="outline" className="text-xs">
                          {testCase.category}
                        </Badge>
                      )}
                      {testCase?.difficulty && (
                        <Badge
                          variant="outline"
                          className={`text-xs ${getDifficultyColor(testCase.difficulty)}`}
                        >
                          {testCase.difficulty}
                        </Badge>
                      )}
                      {durationMs != null && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Timer size={11} />
                          {formatDuration(durationMs)}
                        </span>
                      )}
                    </div>

                    {result.status === 'failed' && (
                      <p className="text-xs text-red-700 dark:text-red-400 mt-1">
                        Execution failed
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </ScrollArea>
  );
};

// ==================== Main Component ====================

export const RunDetailsPage: React.FC = () => {
  // Support /runs/:runId, /experiments/:experimentId/runs/:runId, and /benchmarks/:benchmarkId/runs/:runId routes
  const { runId, experimentId, benchmarkId } = useParams<{ runId: string; experimentId?: string; benchmarkId?: string }>();
  // Use benchmarkId or experimentId (backwards compat alias)
  const routeExperimentId = benchmarkId || experimentId;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  // Main app sidebar control
  const { setOpen: setMainSidebarOpen } = useSidebar();

  // Core state
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Human-readable progress for the initial skeleton ("Loading N cases…") so a
  // large run never sits on a silent blank pane while summaries load (#regression
  // repro: 84-case run, ~168MB unscoped test-case fetch + N sequential report
  // fetches, indefinite blank content pane).
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  // Set when loadRunData's try/catch catches a genuine fetch failure (as opposed
  // to a legitimate "not found" which still redirects). Rendered as an inline
  // error + Retry instead of silently returning null (a permanent blank pane).
  const [loadError, setLoadError] = useState<string | null>(null);
  // True while the FULL report for the currently selected test case is being
  // fetched on-demand (summaries alone don't include trajectory/messages).
  const [reportLoading, setReportLoading] = useState(false);
  // Full report bodies fetched on demand, keyed by reportId. `reportsMap` on
  // ExperimentContext stays summary-only (status/verdict fields) for the fast
  // initial paint; this cache is populated lazily as the user selects rows.
  const [fullReports, setFullReports] = useState<Record<string, EvaluationReport>>({});
  const [testCase, setTestCase] = useState<TestCase | null>(null);

  // Experiment context (only set if run is part of an experiment)
  const [experimentContext, setExperimentContext] = useState<ExperimentContext | null>(null);

  // UI state
  // Empty string = no test case selected (bare route renders the summary
  // band + full test-case list directly, no click-through). A non-empty
  // value is a testCaseId, synced to the `?testCase=` URL param.
  const [selectedItem, setSelectedItem] = useState<string>('');
  const [isCancelling, setIsCancelling] = useState(false);

  // Set when a "why runs failed" theme in RunInsightsPane is clicked - the
  // left test-case list narrows to just that theme's testCaseIds until
  // cleared ("Clear filter" chip) or the user hits "Overview".
  const [filterIds, setFilterIds] = useState<string[] | null>(null);

  // Evaluator id -> display name, fetched once (mirrors EvalRunsPage's
  // pattern) so the summary band can render a human-readable evaluator
  // label via lib/utils#getEvaluatorLabel instead of a raw id.
  const [evaluatorNames, setEvaluatorNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`)
      .then(r => (r.ok ? r.json() : { evaluators: [] }))
      .then(d => (Array.isArray(d?.evaluators) ? d.evaluators : []) as { id: string; name: string }[])
      .then(evaluators => setEvaluatorNames(new Map(evaluators.map(e => [e.id, e.name]))))
      .catch(err => console.error('Failed to load evaluators:', err));
  }, []);

  // Aggregate trace-based cost across the run's reports (mirrors
  // RunSummaryPanel's approach) so the band can show "cost if present".
  const [traceMetrics, setTraceMetrics] = useState<{ totalCostUsd: number } | null>(null);

  // Track base path for navigation (benchmarks vs experiments)
  const basePath = benchmarkId ? '/benchmarks' : '/experiments';

  // Load run data - supports both:
  // 1. Experiment runs: /experiments/:experimentId/runs/:runId (runId is ExperimentRun.id)
  // 2. Standalone runs: /runs/:runId (runId is EvaluationReport.id)
  const loadRunData = useCallback(async () => {
    if (!runId) {
      navigate('/test-cases');
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      // Case 1: Benchmark/Experiment run (with benchmarkId or experimentId)
      if (routeExperimentId) {
        setLoadingLabel('Loading benchmark\u2026');
        const exp = await asyncExperimentStorage.getById(routeExperimentId);

        if (!exp) {
          console.error('Benchmark not found:', routeExperimentId);
          navigate(basePath);
          return;
        }

        // Find the BenchmarkRun by ID
        const expRun = exp.runs?.find(r => r.id === runId);

        if (!expRun) {
          console.error('BenchmarkRun not found:', runId);
          navigate(`${basePath}/${routeExperimentId}/runs`);
          return;
        }

        const testCaseIds = Object.keys(expRun.results || {});
        const reportIds = Object.values(expRun.results || {}).map(r => r.reportId).filter(Boolean) as string[];

        // Regression/gap fix: this used to (a) fetch every FULL report one at a
        // time (N sequential ~0.3-2MB requests) and (b) fetch *every* test case
        // in the whole corpus via getAll() just to filter down to the ~N relevant
        // to this run (168MB observed on an 84-case run against the shared
        // cluster) - see #393/#429 for the same class of fix applied to the
        // evals3 RunInspectorPage, never ported to this legacy page. Now: one
        // lightweight status-only batch for reports, one id-scoped batch for
        // test cases. Full per-case report bodies are fetched lazily on
        // selection (see the effect below keyed on `selectedItem`).
        setLoadingLabel(`Loading ${testCaseIds.length} test case${testCaseIds.length === 1 ? '' : 's'}\u2026`);
        const [reportSummaries, relevantTestCases] = await Promise.all([
          asyncRunStorage.getReportSummariesByIds(reportIds),
          asyncTestCaseStorage.getByIds(testCaseIds),
        ]);
        const siblingReports: EvaluationReport[] = Object.values(reportSummaries);

        // Build reports map by reportId
        const reportsMap: Record<string, EvaluationReport | null> = {};
        Object.values(expRun.results || {}).forEach(result => {
          if (result.reportId) {
            const found = reportSummaries[result.reportId];
            reportsMap[result.reportId] = found || null;
          }
        });

        setExperimentContext({
          experiment: exp,
          experimentRun: expRun,
          siblingReports,
          testCases: relevantTestCases,
          reportsMap,
        });

        // Check URL param for selected test case, default to summary
        const testCaseFromUrl = searchParams.get('testCase');
        if (testCaseFromUrl && testCaseIds.includes(testCaseFromUrl)) {
          setSelectedItem(testCaseFromUrl);
          // Collapse main sidebar when loading with a test case selected
          setMainSidebarOpen(false);
        } else if (testCaseIds.length === 1) {
          // Auto-select the only test case when there's just one
          // (full-width layout has no sidebar/summary view)
          setSelectedItem(testCaseIds[0]);
          setMainSidebarOpen(false);
        } else {
          setSelectedItem('');
        }

        // Set first available report for header display
        const firstReportId = Object.values(expRun.results || {}).find(r => r.reportId)?.reportId;
        if (firstReportId) {
          const firstReport = siblingReports.find(r => r.id === firstReportId);
          setReport(firstReport || null);

          if (firstReport) {
            const tc = await asyncTestCaseStorage.getById(firstReport.testCaseId);
            setTestCase(tc);
          }
        } else {
          setReport(null);
          setTestCase(null);
        }
      }
      // Case 2: Standalone run (runId is a reportId)
      else {
        const standaloneReport = await asyncRunStorage.getReportById(runId);

        if (!standaloneReport) {
          console.error('[RunDetailsPage] Report not found:', runId);
          navigate('/test-cases');
          return;
        }

        setReport(standaloneReport);
        setExperimentContext(null);

        // Load the test case for this report
        const tc = await asyncTestCaseStorage.getById(standaloneReport.testCaseId);
        setTestCase(tc);
      }
    } catch (error) {
      // Genuine fetch failure (network error, 5xx, etc.) - surface an inline
      // error + Retry instead of silently navigating away or leaving a
      // permanent blank pane (the reported bug: "doesn't even tell me if it
      // is loading"). Legitimate not-found cases are handled above via
      // their own explicit navigate() calls, not this catch.
      console.error('Failed to load run:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load run.');
    } finally {
      setIsLoading(false);
      setLoadingLabel(null);
    }
  }, [runId, routeExperimentId, navigate, searchParams, setMainSidebarOpen]);

  useEffect(() => {
    loadRunData();
  }, [loadRunData]);

  // Lazy full-report fetch: the initial load only fetches lightweight
  // status summaries for every case in the run (fast, bounded size even for
  // large runs). The FULL report body (trajectory, messages, logs) for the
  // currently selected test case is fetched on demand here, exactly once per
  // reportId, mirroring the pattern in evals3/RunInspectorPage.tsx (#393).
  useEffect(() => {
    if (!experimentContext || !selectedItem) return;
    const reportId = experimentContext.experimentRun.results?.[selectedItem]?.reportId;
    if (!reportId || fullReports[reportId]) return;

    let cancelled = false;
    setReportLoading(true);
    asyncRunStorage.getReportById(reportId)
      .then(full => {
        if (cancelled || !full) return;
        setFullReports(prev => ({ ...prev, [reportId]: full }));
      })
      .catch(err => console.error('[RunDetailsPage] Failed to load full report:', reportId, err))
      .finally(() => { if (!cancelled) setReportLoading(false); });

    return () => { cancelled = true; };
  }, [experimentContext, selectedItem, fullReports]);

  // Summary band "cost if present": aggregate trace-based cost across every
  // report in the run that has a runId (agent-run correlation id). Uses the
  // lightweight summaries already in `experimentContext`, not the lazily
  // fetched full report bodies - no extra full-report fetches triggered.
  useEffect(() => {
    if (!experimentContext) { setTraceMetrics(null); return; }
    const runIds = experimentContext.siblingReports
      .filter((r): r is EvaluationReport => !!r?.runId)
      .map(r => r.runId!);
    if (runIds.length === 0) { setTraceMetrics(null); return; }
    fetchBatchMetrics(runIds)
      .then(data => setTraceMetrics(data.aggregate))
      .catch(() => setTraceMetrics(null));
  }, [experimentContext]);

  // Poll for updates when there are pending/running results
  useEffect(() => {
    const hasPending = experimentContext && Object.values(experimentContext.experimentRun.results || {})
      .some(r => r.status === 'pending' || r.status === 'running');

    if (hasPending) {
      const interval = setInterval(loadRunData, 5000);
      return () => clearInterval(interval);
    }
  }, [experimentContext, loadRunData]);

  // Handlers
  const handleBack = () => {
    if (experimentContext) {
      navigate(`${basePath}/${experimentContext.experiment.id}/runs`);
    } else if (location.state?.from) {
      const nextState = location.state.parentFrom
        ? { state: { from: location.state.parentFrom } }
        : undefined;
      navigate(location.state.from, nextState);
    } else if (report) {
      navigate(`/test-cases/${report.testCaseId}/runs`);
    } else {
      navigate(-1);
    }
  };

  const handleSelectItem = (item: string) => {
    setSelectedItem(item);

    // Update URL with selected test case. Pushes a new history entry (not
    // `replace`) so the back/forward buttons walk between "no case
    // selected" (full list) and each selected case - required for the
    // deep-linkable `?testCase=<id>` URL to be genuinely shareable/navigable.
    if (item) {
      searchParams.set('testCase', item);
      setSearchParams(searchParams);
      // Collapse main sidebar when selecting a specific test case run
      setMainSidebarOpen(false);
    } else {
      searchParams.delete('testCase');
      setSearchParams(searchParams);
    }
  };

  const handleViewAllReports = () => {
    if (report) {
      navigate(`/test-cases/${report.testCaseId}/runs`);
    }
  };

  // Calculate stats for experiment runs
  const getRunStats = () => {
    if (!experimentContext) return null;

    const { experimentRun, reportsMap } = experimentContext;
    let passed = 0;
    let failed = 0;
    let errored = 0;
    let pending = 0;
    let running = 0;
    let total = 0;

    Object.values(experimentRun.results || {}).forEach(result => {
      total++;
      const report = result.reportId ? reportsMap[result.reportId] : null;
      const status = getResultStatus(result, report || null);

      switch (status) {
        case 'passed': passed++; break;
        case 'failed': failed++; break;
        case 'errored': errored++; break;
        case 'running': running++; break;
        default: pending++; break;
      }
    });

    return { passed, failed, errored, pending, running, total };
  };

  // Download report in specified format (JSON/HTML/PDF) via server API
  const downloadReport = async (format: string) => {
    if (!routeExperimentId) return;

    const params = new URLSearchParams({ format });
    params.set('runIds', runId!);
    const url = `${ENV_CONFIG.backendUrl}/api/storage/benchmarks/${encodeURIComponent(routeExperimentId)}/report?${params.toString()}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText }));
        alert(`Report download failed: ${errorBody.error || response.statusText}`);
        return;
      }

      const contentDisposition = response.headers.get('content-disposition') || '';
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
      const safeName = (experimentContext?.experimentRun.name || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = filenameMatch?.[1] || `${safeName}_report.${format}`;

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('Report download failed:', error);
    }
  };

  // Determine if we should show the sidebar
  const hasSidebar = experimentContext && Object.keys(experimentContext.experimentRun.results || {}).length > 1;

  if (isLoading) {
    return <PageSkeleton label={loadingLabel} />;
  }

  // Genuine fetch failure: inline error + Retry, never a silent blank pane.
  if (loadError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="run-details-error">
        <AlertTriangle size={40} className="text-red-600 dark:text-red-400" />
        <p className="text-lg font-medium">Failed to load run</p>
        <p className="text-sm text-muted-foreground max-w-md">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => loadRunData()} data-testid="run-details-retry">
          Retry
        </Button>
      </div>
    );
  }

  // Handle case where neither experiment context nor standalone report is available
  if (!experimentContext && !report) {
    return null;
  }

  const stats = experimentContext ? getRunStats() : null;

  // Get selected report for display (only for experiment context)
  const getDisplayReport = (): EvaluationReport | null => {
    // Standalone run - use the report directly
    if (!experimentContext && report) {
      return report;
    }

    // Experiment run
    if (experimentContext) {
      if (!selectedItem) {
        return null;
      }

      const result = experimentContext.experimentRun.results?.[selectedItem];
      if (result?.reportId) {
        // Full body is fetched lazily (see the effect above); until it lands,
        // the summary alone isn't enough to render RunDetailsContent.
        return fullReports[result.reportId] || null;
      }
    }

    return null;
  };

  const displayReport = getDisplayReport();
  // Distinguishes "selected case has no report at all" (pending/running/never
  // ran) from "report exists, full body still loading" so the content pane
  // shows a spinner instead of a misleading "No report available".
  const selectedReportId = experimentContext && selectedItem
    ? experimentContext.experimentRun.results?.[selectedItem]?.reportId
    : undefined;
  const isDisplayReportLoading = !!selectedReportId && !displayReport;

  // For standalone runs, render a simpler view
  if (!experimentContext && report) {
    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={handleBack}>
              <ArrowLeft size={18} />
            </Button>
            <div>
              <h2 className="text-xl font-bold">
                {testCase?.name || 'Run Details'}
              </h2>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                <span className="flex items-center gap-1">
                  <Calendar size={12} />
                  {formatDate(report.timestamp)}
                </span>
                <span className="text-muted-foreground/50">·</span>
                <span>Model: {getModelName(report.modelName)}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>Agent: {report.agentName}</span>
                {report.evaluatorId && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span>Evaluator: {report.evaluatorId.replace('system-', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content - Full width for standalone runs */}
        <div className="flex-1 overflow-hidden">
          <RunDetailsContent
            report={report}
            showViewAllReports={true}
            onViewAllReports={handleViewAllReports}
          />
        </div>
      </div>
    );
  }

  const agentDisplayName = experimentContext
    ? DEFAULT_CONFIG.agents.find(a => a.key === experimentContext.experimentRun.agentKey)?.name
      || experimentContext.experimentRun.agentKey
    : '';

  // Pending/running/loading/no-report placeholder shown in the detail panel
  // when the selected case has no displayable report yet. Shared by both
  // the split (list + detail) and single-test-case full-width layouts.
  const renderCaseDetailPlaceholder = (resultStatus: string | undefined) => {
    const isRunning = resultStatus === 'running';
    const isPending = resultStatus === 'pending';

    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground h-full">
        <div className="text-center">
          {isRunning ? (
            <>
              <Loader2 size={48} className="mx-auto mb-4 text-blue-700 dark:text-blue-400 animate-spin" />
              <p className="text-lg font-medium">Test case running</p>
              <p className="text-sm mt-1">Executing test case...</p>
            </>
          ) : isPending ? (
            <>
              <Clock size={48} className="mx-auto mb-4 text-yellow-700 dark:text-yellow-400 animate-pulse" />
              <p className="text-lg font-medium">Test case pending</p>
              <p className="text-sm mt-1">Waiting for execution...</p>
            </>
          ) : isDisplayReportLoading ? (
            <>
              <Loader2 size={48} className="mx-auto mb-4 text-muted-foreground animate-spin" />
              <p className="text-lg font-medium">Loading report\u2026</p>
              <p className="text-sm mt-1">Fetching the full test case report</p>
            </>
          ) : (
            <>
              <XCircle size={48} className="mx-auto mb-4 opacity-20" />
              <p>No report available for this test case</p>
              <p className="text-sm mt-1">The test may have failed to execute</p>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col max-md:h-auto max-md:overflow-visible" data-testid="run-details-page">
      {/* Top action bar - back button + run-level actions. Run metadata and
          verdict counts live in RunSummaryBand below, not duplicated here. */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <Button variant="ghost" size="icon" onClick={handleBack} data-testid="back-button">
          <ArrowLeft size={18} />
        </Button>

        <div className="flex items-center gap-2">
          {/* Compare Runs button */}
          {routeExperimentId && experimentContext && (experimentContext.experiment.runs?.length ?? 0) > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/compare/${routeExperimentId}?runs=${runId}`)}
              data-testid="compare-runs-button"
            >
              <GitCompare size={14} className="mr-1" />
              Compare Runs
            </Button>
          )}

          {/* Download Report dropdown */}
          {routeExperimentId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="download-report-button">
                  <Download size={14} className="mr-1" />
                  Download Report
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => downloadReport('json')} data-testid="download-json">JSON</DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadReport('html')} data-testid="download-html">HTML</DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadReport('pdf')} data-testid="download-pdf">PDF</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Cancel button for running runs */}
          {experimentContext?.experimentRun.status === 'running' && (
            <Button
              variant="outline"
              size="sm"
              disabled={isCancelling}
              onClick={async () => {
                setIsCancelling(true);
                try {
                  await cancelExperimentRun(routeExperimentId!, runId!);
                  loadRunData(); // Refresh data
                } catch (error) {
                  console.error('Failed to cancel run:', error);
                } finally {
                  setIsCancelling(false);
                }
              }}
              className="text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 hover:bg-red-500/10 border-red-500/30"
            >
              <StopCircle size={14} className="mr-1" />
              {isCancelling ? 'Cancelling...' : 'Cancel'}
            </Button>
          )}
        </div>
      </div>

      {/* Run summary band - always visible: name, agent/model, judge/evaluator,
          started/duration/cost, verdict counts. Replaces the old click-through
          "Summary" sidebar entry (RunSummaryPanel) - no longer a selectable
          pane, just always-on context above the case list / detail. */}
      <RunSummaryBand
        runName={experimentContext.experimentRun.name}
        description={experimentContext.experimentRun.description}
        benchmarkName={experimentContext.experiment.name}
        agentName={agentDisplayName}
        modelName={getModelName(experimentContext.experimentRun.modelId)}
        judgeModelLabel={getJudgeModelLabel(experimentContext.experimentRun.judgeModelId)}
        evaluatorLabel={getEvaluatorLabel(experimentContext.experimentRun.evaluatorId, evaluatorNames)}
        startedAt={experimentContext.experimentRun.createdAt}
        durationMs={experimentContext.experimentRun.performanceMetrics?.durationMs}
        concurrency={experimentContext.experimentRun.performanceMetrics?.concurrency}
        costUsd={traceMetrics?.totalCostUsd}
        stats={stats as RunSummaryStats}
      />

      {/* Content: split view is ALWAYS shown once there's more than one test
          case (owner feedback on the redesign: "I liked the split view ...
          If no test case is selected, the right side can show an
          aggregated view"). Left = test-case list (optionally filtered by
          a clicked failure theme). Right = the selected case's detail, or
          RunInsightsPane (verdict overview, why-runs-failed themes,
          slowest/costliest, folded-in legacy details) when nothing is
          selected. */}
      {hasSidebar ? (
        <ResizablePanelGroup direction="horizontal" className="flex-1 max-md:!h-auto max-md:!overflow-visible max-md:!flex-col">
          <ResizablePanel defaultSize={28} minSize={18} maxSize={42} className="border-r max-md:!h-auto max-md:!min-h-0 max-md:!overflow-visible max-md:border-r-0 max-md:border-b">
            <TestCaseList
              context={experimentContext!}
              selectedItem={selectedItem}
              onSelectItem={handleSelectItem}
              scrollToSelected={!!selectedItem}
              filterIds={filterIds}
              onClearFilter={() => setFilterIds(null)}
            />
          </ResizablePanel>

          <ResizableHandle withHandle className="max-md:hidden" />

          <ResizablePanel defaultSize={72} className="max-md:!h-auto max-md:!min-h-0 max-md:!overflow-visible">
            <div className="h-full overflow-hidden max-md:h-auto max-md:overflow-visible">
              {selectedItem ? (
                displayReport ? (
                  <RunDetailsContent
                    report={displayReport}
                    showViewAllReports={true}
                    onViewAllReports={handleViewAllReports}
                    performanceMetrics={experimentContext!.experimentRun.results?.[selectedItem]?.performanceMetrics}
                  />
                ) : (
                  renderCaseDetailPlaceholder(experimentContext?.experimentRun.results?.[selectedItem]?.status)
                )
              ) : (
                <RunInsightsPane
                  experimentRun={experimentContext!.experimentRun}
                  testCases={experimentContext!.testCases}
                  reportsMap={experimentContext!.reportsMap}
                  stats={stats as RunSummaryStats}
                  onSelectCase={handleSelectItem}
                  onFilterCases={setFilterIds}
                />
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* Full-width layout for the single-test-case case (auto-selected, no
           list needed - see loadRunData's `testCaseIds.length === 1` branch). */
        <div className="flex-1 overflow-hidden">
          {displayReport ? (
            <RunDetailsContent
              report={displayReport}
              showViewAllReports={true}
              onViewAllReports={handleViewAllReports}
              performanceMetrics={experimentContext.experimentRun.results?.[selectedItem]?.performanceMetrics}
            />
          ) : (
            renderCaseDetailPlaceholder(
              experimentContext.experimentRun.results?.[Object.keys(experimentContext.experimentRun.results || {})[0]]?.status
            )
          )}
        </div>
      )}
    </div>
  );
};
