/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Calendar, CheckCircle2, XCircle, BarChart3, PanelLeftClose, PanelLeft, Clock, Loader2, StopCircle, Ban } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { useSidebar } from '@/components/ui/sidebar';
import { asyncExperimentStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { cancelExperimentRun } from '@/services/client';
import { Experiment, ExperimentRun, EvaluationReport, TestCase } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getDifficultyColor, formatDate, getModelName } from '@/lib/utils';
import { RunDetailsContent } from './RunDetailsContent';
import { RunSummaryPanel } from './RunSummaryPanel';

// ==================== Skeleton Components ====================

const PageSkeleton = () => (
  <div className="h-full flex flex-col">
    <div className="flex items-center justify-between p-4 border-b">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10 rounded" />
        <div>
          <Skeleton className="h-6 w-[200px] mb-2" />
          <Skeleton className="h-4 w-[300px]" />
        </div>
      </div>
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

// ==================== Sidebar Component ====================

interface SidebarProps {
  context: ExperimentContext;
  selectedItem: string;
  onSelectItem: (item: string) => void;
  onToggleCollapse: () => void;
  isCollapsed: boolean;
}

const Sidebar = ({ context, selectedItem, onSelectItem, onToggleCollapse, isCollapsed }: SidebarProps) => {
  const { experimentRun, siblingReports, testCases, reportsMap } = context;

  const getTestCase = (testCaseId: string) => testCases.find(tc => tc.id === testCaseId);

  const testCaseIds = Object.keys(experimentRun.results || {});

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-2">
        {/* Summary Entry with collapse toggle */}
        <Card
          className={`cursor-pointer transition-colors ${
            selectedItem === 'summary'
              ? 'border-opensearch-blue bg-opensearch-blue/5'
              : 'hover:border-muted-foreground/30'
          }`}
          onClick={() => onSelectItem('summary')}
        >
          <CardContent className="p-3">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse();
                }}
                title={isCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              >
                {isCollapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
              </Button>
              <div className={`p-1.5 rounded ${
                selectedItem === 'summary' ? 'bg-opensearch-blue/20' : 'bg-muted'
              }`}>
                <BarChart3 size={16} className={
                  selectedItem === 'summary' ? 'text-opensearch-blue' : 'text-muted-foreground'
                } />
              </div>
              <span className={`font-medium ${
                selectedItem === 'summary' ? 'text-opensearch-blue' : ''
              }`}>
                Summary
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Runs Header with count */}
        <div className="flex items-center justify-between px-1 pt-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Runs
          </span>
          <Badge variant="secondary" className="text-xs">
            {testCaseIds.length}
          </Badge>
        </div>

        {/* Test Cases */}
        {testCaseIds.map(testCaseId => {
          const result = experimentRun.results[testCaseId];
          const report = result.reportId ? reportsMap[result.reportId] : null;
          const testCase = getTestCase(testCaseId);
          const isSelected = selectedItem === testCaseId;

          const isPassed = report?.passFailStatus === 'passed';
          const isFailed = report?.passFailStatus === 'failed' || result.status === 'failed';

          return (
            <Card
              key={testCaseId}
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
                    {isPassed && <CheckCircle2 size={18} className="text-green-700 dark:text-green-400" />}
                    {isFailed && <XCircle size={18} className="text-red-700 dark:text-red-400" />}
                    {!isPassed && !isFailed && result.status === 'running' && (
                      <Loader2 size={18} className="text-blue-400 animate-spin" />
                    )}
                    {!isPassed && !isFailed && result.status === 'pending' && (
                      <Clock size={18} className="text-yellow-400" />
                    )}
                    {!isPassed && !isFailed && result.status === 'cancelled' && (
                      <Ban size={18} className="text-orange-400" />
                    )}
                    {!isPassed && !isFailed && result.status !== 'running' && result.status !== 'pending' && result.status !== 'cancelled' && (
                      <div className="w-[18px] h-[18px] rounded-full border-2 border-muted-foreground/30" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className={`text-sm font-medium truncate ${
                      isSelected ? 'text-opensearch-blue' : ''
                    }`}>
                      {testCase?.name || testCaseId}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {testCase && (
                        <Badge
                          variant="outline"
                          className={`text-xs ${getDifficultyColor(testCase.difficulty)}`}
                        >
                          {testCase.difficulty}
                        </Badge>
                      )}
                      {/* Metrics */}
                      {report && (
                        <span className="text-xs text-muted-foreground">
                          {report.metrics.accuracy}%
                        </span>
                      )}
                    </div>

                    {result.status === 'failed' && (
                      <p className="text-xs text-red-400 mt-1">
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

  // Main app sidebar control
  const { setOpen: setMainSidebarOpen } = useSidebar();

  // Core state
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [testCase, setTestCase] = useState<TestCase | null>(null);

  // Experiment context (only set if run is part of an experiment)
  const [experimentContext, setExperimentContext] = useState<ExperimentContext | null>(null);

  // UI state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedItem, setSelectedItem] = useState<string>(''); // testCaseId or 'summary'
  const [isCancelling, setIsCancelling] = useState(false);

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

    try {
      // Case 1: Benchmark/Experiment run (with benchmarkId or experimentId)
      if (routeExperimentId) {
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

        // Load all reports for this experiment run
        const siblingReports = await asyncRunStorage.getByExperimentRun(routeExperimentId, runId);

        // Load all test cases referenced in this run
        const allTestCases = await asyncTestCaseStorage.getAll();
        const relevantTestCases = allTestCases.filter(tc =>
          Object.keys(expRun.results || {}).includes(tc.id)
        );

        // Build reports map by reportId
        const reportsMap: Record<string, EvaluationReport | null> = {};
        Object.values(expRun.results || {}).forEach(result => {
          if (result.reportId) {
            const found = siblingReports.find(r => r.id === result.reportId);
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
        const testCaseIds = Object.keys(expRun.results || {});
        if (testCaseFromUrl && testCaseIds.includes(testCaseFromUrl)) {
          setSelectedItem(testCaseFromUrl);
          // Collapse main sidebar when loading with a test case selected
          setMainSidebarOpen(false);
        } else {
          setSelectedItem('summary');
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
      console.error('Failed to load run:', error);
      navigate('/test-cases');
    } finally {
      setIsLoading(false);
    }
  }, [runId, routeExperimentId, navigate, searchParams, setMainSidebarOpen]);

  useEffect(() => {
    loadRunData();
  }, [loadRunData]);

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
    } else if (report) {
      navigate(`/test-cases/${report.testCaseId}/runs`);
    } else {
      navigate(-1);
    }
  };

  const handleSelectItem = (item: string) => {
    setSelectedItem(item);

    // Update URL with selected test case
    if (item && item !== 'summary') {
      searchParams.set('testCase', item);
      setSearchParams(searchParams, { replace: true });
      // Collapse main sidebar when selecting a specific test case run
      setMainSidebarOpen(false);
    } else {
      searchParams.delete('testCase');
      setSearchParams(searchParams, { replace: true });
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
    let pending = 0;
    let running = 0;
    let total = 0;

    Object.values(experimentRun.results || {}).forEach(result => {
      total++;

      if (result.status === 'pending') {
        pending++;
      } else if (result.status === 'running') {
        running++;
      } else if (result.status === 'completed' && result.reportId) {
        const rep = reportsMap[result.reportId];
        if (rep) {
          if (rep.passFailStatus === 'passed') {
            passed++;
          } else {
            failed++;
          }
        } else {
          pending++; // Report not loaded yet
        }
      } else if (result.status === 'failed') {
        failed++;
      }
    });

    return { passed, failed, pending, running, total };
  };

  // Determine if we should show the sidebar
  const hasSidebar = experimentContext && Object.keys(experimentContext.experimentRun.results || {}).length > 1;

  if (isLoading) {
    return <PageSkeleton />;
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
      if (selectedItem === 'summary') {
        return null;
      }

      const result = experimentContext.experimentRun.results?.[selectedItem];
      if (result?.reportId) {
        return experimentContext.reportsMap[result.reportId] || null;
      }
    }

    return null;
  };

  const displayReport = getDisplayReport();

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

  return (
    <div className="h-full flex flex-col" data-testid="run-details-page">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleBack} data-testid="back-button">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-xl font-bold" data-testid="run-title">
              {experimentContext ? experimentContext.experimentRun.name : testCase?.name || 'Run Details'}
            </h2>
            {/* Show run description if available */}
            {experimentContext?.experimentRun.description && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {experimentContext.experimentRun.description}
              </p>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
              <span>{experimentContext.experiment.name}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="flex items-center gap-1">
                <Calendar size={12} />
                {formatDate(report?.timestamp || experimentContext.experimentRun.createdAt)}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>Model: {getModelName(report?.modelName || experimentContext.experimentRun.modelId)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Stats Badge (experiment runs only) */}
          {stats && (
            <div className="flex items-center gap-2 text-sm">
              {stats.running > 0 && (
                <span className="flex items-center gap-1 text-blue-400" title="Running">
                  <Loader2 size={14} className="animate-spin" />
                  {stats.running}
                </span>
              )}
              {stats.pending > 0 && (
                <span className="flex items-center gap-1 text-yellow-400" title="Pending">
                  <Clock size={14} />
                  {stats.pending}
                </span>
              )}
              <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                <CheckCircle2 size={16} />
                {stats.passed}
              </span>
              <span className="flex items-center gap-1 text-red-400">
                <XCircle size={16} />
                {stats.failed}
              </span>
              <span className="text-muted-foreground">/ {stats.total}</span>
            </div>
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
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/30"
            >
              <StopCircle size={14} className="mr-1" />
              {isCancelling ? 'Cancelling...' : 'Cancel'}
            </Button>
          )}

        </div>
      </div>

      {/* Content */}
      {hasSidebar && !sidebarCollapsed ? (
        /* Resizable layout for experiment runs */
        <ResizablePanelGroup direction="horizontal" className="flex-1">
          {/* Sidebar Panel */}
          <ResizablePanel
            defaultSize={25}
            minSize={15}
            maxSize={40}
            className="border-r"
          >
            <Sidebar
              context={experimentContext!}
              selectedItem={selectedItem}
              onSelectItem={handleSelectItem}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              isCollapsed={sidebarCollapsed}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Main Content Panel */}
          <ResizablePanel defaultSize={75}>
            <div className="h-full overflow-hidden">
              {selectedItem === 'summary' ? (
                <RunSummaryPanel
                  run={experimentContext!.experimentRun}
                  reports={experimentContext!.reportsMap}
                />
              ) : displayReport ? (
                <RunDetailsContent
                  report={displayReport}
                  showViewAllReports={true}
                  onViewAllReports={handleViewAllReports}
                />
              ) : (
                // Show pending/running state based on result status
                (() => {
                  const resultStatus = experimentContext?.experimentRun.results?.[selectedItem]?.status;
                  const isRunning = resultStatus === 'running';
                  const isPending = resultStatus === 'pending';

                  return (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground h-full">
                      <div className="text-center">
                        {isRunning ? (
                          <>
                            <Loader2 size={48} className="mx-auto mb-4 text-blue-400 animate-spin" />
                            <p className="text-lg font-medium">Test case running</p>
                            <p className="text-sm mt-1">Executing test case...</p>
                          </>
                        ) : isPending ? (
                          <>
                            <Clock size={48} className="mx-auto mb-4 text-yellow-400 animate-pulse" />
                            <p className="text-lg font-medium">Test case pending</p>
                            <p className="text-sm mt-1">Waiting for execution...</p>
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
                })()
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* Full-width layout for single test case or collapsed sidebar */
        <div className="flex-1 overflow-hidden">
          {displayReport ? (
            <RunDetailsContent
              report={displayReport}
              showViewAllReports={true}
              onViewAllReports={handleViewAllReports}
            />
          ) : (
            // Show pending/running state when no report available
            (() => {
              const firstTestCaseId = Object.keys(experimentContext.experimentRun.results || {})[0];
              const resultStatus = experimentContext.experimentRun.results?.[firstTestCaseId]?.status;
              const isRunning = resultStatus === 'running';
              const isPending = resultStatus === 'pending';

              return (
                <div className="flex-1 flex items-center justify-center text-muted-foreground h-full">
                  <div className="text-center">
                    {isRunning ? (
                      <>
                        <Loader2 size={48} className="mx-auto mb-4 text-blue-400 animate-spin" />
                        <p className="text-lg font-medium">Test case running</p>
                        <p className="text-sm mt-1">Executing test case...</p>
                      </>
                    ) : isPending ? (
                      <>
                        <Clock size={48} className="mx-auto mb-4 text-yellow-400 animate-pulse" />
                        <p className="text-lg font-medium">Test case pending</p>
                        <p className="text-sm mt-1">Waiting for execution...</p>
                      </>
                    ) : (
                      <>
                        <XCircle size={48} className="mx-auto mb-4 opacity-20" />
                        <p>No report available</p>
                        <p className="text-sm mt-1">The test may have failed to execute</p>
                      </>
                    )}
                  </div>
                </div>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
};
