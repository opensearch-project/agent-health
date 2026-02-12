/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, GitCompare, Calendar, CheckCircle2, XCircle, Play, Trash2, Plus, X, Loader2, Circle, Check, ChevronRight, Clock, StopCircle, Ban } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { executeBenchmarkRun } from '@/services/client';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';
import { Benchmark, BenchmarkRun, TestCase, BenchmarkProgress, BenchmarkStartedEvent, RunStats } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getLabelColor, formatDate, getModelName } from '@/lib/utils';
import {
  computeVersionData,
  getSelectedVersionData,
  getVersionTestCases,
  filterRunsByVersion,
  VersionData,
} from '@/lib/benchmarkVersionUtils';
import { RunConfigForExecution } from './BenchmarkEditor';

// Track individual use case status during run
interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

const POLL_INTERVAL_MS = 2000;

/**
 * Get effective run status - normalizes legacy data (status: undefined) to proper enum values.
 * Returns: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
 */
const getEffectiveRunStatus = (run: BenchmarkRun): BenchmarkRun['status'] => {
  // If status is explicitly set, use it (modern data - backend always sets this now)
  if (run.status) {
    return run.status;
  }

  // Legacy/fallback: derive status from child results
  const results = Object.values(run.results || {});

  // If any result is running, run is running
  if (results.some(r => r.status === 'running')) {
    return 'running';
  }

  // If any result is pending (and none running/completed/failed), treat as running
  // This handles the edge case where run.status wasn't persisted yet
  if (results.some(r => r.status === 'pending') &&
      !results.some(r => r.status === 'completed' || r.status === 'failed')) {
    return 'running';
  }

  const hasAnyCompleted = results.some(r => r.status === 'completed');
  const hasAnyFailed = results.some(r => r.status === 'failed');

  if (hasAnyCompleted || hasAnyFailed) {
    return 'completed';
  }

  // Truly legacy data with no results - treat as failed (stuck)
  return 'failed';
};

export const BenchmarkRunsPage: React.FC = () => {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const navigate = useNavigate();

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);

  // Run pagination state
  const [totalRuns, setTotalRuns] = useState<number>(0);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [isLoadingMoreRuns, setIsLoadingMoreRuns] = useState(false);
  const isInitialLoadDone = useRef(false);

  // Cache for static fields excluded during polling
  const cachedVersions = useRef<Benchmark['versions'] | null>(null);

  // Run configuration dialog state
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  const [runConfigValues, setRunConfigValues] = useState<RunConfigForExecution>({
    name: '',
    description: '',
    agentKey: '',
    modelId: '',
  });

  // Running state
  const [isRunning, setIsRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<BenchmarkProgress | null>(null);
  const [useCaseStatuses, setUseCaseStatuses] = useState<UseCaseRunStatus[]>([]);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Selected runs for comparison
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  // Delete operation state
  const [deleteState, setDeleteState] = useState<{
    isDeleting: boolean;
    deletingId: string | null;
    status: 'idle' | 'success' | 'error';
    message: string;
  }>({ isDeleting: false, deletingId: null, status: 'idle', message: '' });

  // Version panel state
  const [testCaseVersion, setTestCaseVersion] = useState<number | null>(null); // null = latest
  const [runVersionFilter, setRunVersionFilter] = useState<number | 'all'>('all');

  // Cancellation hook
  const { isCancelling, handleCancelRun } = useBenchmarkCancellation();

  const loadBenchmark = useCallback(async () => {
    if (!benchmarkId) return;

    try {
      // Use lightweight polling mode after initial load
      const isPolling = isInitialLoadDone.current;
      const options = isPolling
        ? { fields: 'polling' as const, runsSize: 100 }
        : { runsSize: 100 };

      const exp = await asyncBenchmarkStorage.getById(benchmarkId, options);
      if (!exp) {
        navigate('/benchmarks');
        return;
      }

      // Track run pagination metadata
      const expAny = exp as any;
      if (expAny.totalRuns !== undefined) {
        setTotalRuns(expAny.totalRuns);
        setHasMoreRuns(expAny.hasMoreRuns ?? false);
      }

      // In polling mode, restore cached static fields
      if (isPolling && cachedVersions.current) {
        exp.versions = cachedVersions.current;
      } else {
        // Cache static fields on initial load
        cachedVersions.current = exp.versions;
      }

      setBenchmark(exp);

      // Only fetch test cases on initial load
      if (!isPolling) {
        try {
          const benchmarkTcs = await asyncTestCaseStorage.getByIds(exp.testCaseIds);
          setTestCases(benchmarkTcs);
        } catch (error) {
          console.error('Failed to load test cases:', error);
        }
        isInitialLoadDone.current = true;
      }
    } catch (error) {
      console.error('Failed to load benchmark:', error);
      navigate('/benchmarks');
    }
  }, [benchmarkId, navigate]);

  // Load more (older) runs
  const loadMoreRuns = useCallback(async () => {
    if (!benchmarkId || !benchmark || isLoadingMoreRuns) return;
    setIsLoadingMoreRuns(true);
    try {
      const currentRunCount = benchmark.runs?.length || 0;
      const exp = await asyncBenchmarkStorage.getById(benchmarkId, {
        runsSize: 100,
        runsOffset: currentRunCount,
      });
      if (exp) {
        setBenchmark(prev => {
          if (!prev) return exp;
          return {
            ...prev,
            runs: [...(prev.runs || []), ...(exp.runs || [])],
          };
        });
        const expAny = exp as any;
        if (expAny.totalRuns !== undefined) {
          setTotalRuns(expAny.totalRuns);
          setHasMoreRuns(expAny.hasMoreRuns ?? false);
        }
      }
    } catch (error) {
      console.error('Failed to load more runs:', error);
    } finally {
      setIsLoadingMoreRuns(false);
    }
  }, [benchmarkId, benchmark, isLoadingMoreRuns]);

  useEffect(() => {
    loadBenchmark();
  }, [loadBenchmark]);

  // Filter test cases to only those in this benchmark (current version)
  const benchmarkTestCases = useMemo(() =>
    testCases.filter(tc => benchmark?.testCaseIds.includes(tc.id)),
    [testCases, benchmark]
  );

  // Compute version data with diff information using utility function
  const versionData = useMemo<VersionData[]>(
    () => computeVersionData(benchmark),
    [benchmark]
  );

  // Get selected version data for left panel
  const selectedVersionData = useMemo(
    () => getSelectedVersionData(versionData, testCaseVersion),
    [versionData, testCaseVersion]
  );

  // Get test cases for the selected version
  const versionTestCases = useMemo(
    () => getVersionTestCases(testCases, selectedVersionData),
    [selectedVersionData, testCases]
  );

  // Filter runs by selected version
  const filteredRuns = useMemo(
    () => filterRunsByVersion(benchmark?.runs, runVersionFilter),
    [benchmark?.runs, runVersionFilter]
  );

  // Check if benchmark has multiple versions
  const hasMultipleVersions = versionData.length > 1;

  const handleDeleteRun = async (run: BenchmarkRun) => {
    if (!benchmarkId) return;
    if (!window.confirm(`Delete run "${run.name}"? This cannot be undone.`)) return;

    setDeleteState({ isDeleting: true, deletingId: run.id, status: 'idle', message: '' });

    try {
      const success = await asyncBenchmarkStorage.deleteRun(benchmarkId, run.id);
      if (success) {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'success', message: `"${run.name}" deleted` });
        setTimeout(() => setDeleteState(s => ({ ...s, status: 'idle', message: '' })), 3000);
        loadBenchmark();
      } else {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'error', message: `Failed to delete "${run.name}"` });
      }
    } catch (error) {
      setDeleteState({
        isDeleting: false,
        deletingId: null,
        status: 'error',
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  // Get run stats - use denormalized run.stats if available (fast path),
  // otherwise compute from result statuses (fallback for old data)
  const getRunStats = useCallback((run: BenchmarkRun): RunStats & { running: number } => {
    // Count running separately (always needed for UI display)
    let running = 0;
    Object.values(run.results || {}).forEach((result) => {
      if (result.status === 'running') {
        running++;
      }
    });

    // Fast path: use denormalized stats if available
    if (run.stats && typeof run.stats.passed === 'number') {
      return {
        passed: run.stats.passed,
        failed: run.stats.failed,
        pending: run.stats.pending - running, // Adjust pending to exclude running
        running,
        total: run.stats.total,
      };
    }

    // Fallback: compute from result statuses (for old data before migration)
    let passed = 0;
    let failed = 0;
    let pending = 0;

    Object.values(run.results || {}).forEach((result) => {
      if (result.status === 'running') {
        // Already counted in 'running'
        return;
      } else if (result.status === 'completed') {
        // Without the full report, we can't know if it passed or failed
        // Count as pending until migration runs
        pending++;
      } else if (result.status === 'failed' || result.status === 'cancelled') {
        failed++;
      } else {
        pending++;
      }
    });

    return {
      passed,
      failed,
      pending,
      running,
      total: Object.keys(run.results || {}).length,
    };
  }, []);

  // Check if any runs have pending stats (stats.pending > 0)
  // This replaces the old report-based pending evaluation check
  const hasPendingEvaluations = useMemo(() => {
    if (!benchmark?.runs) return false;
    return benchmark.runs.some(run =>
      run.stats?.pending && run.stats.pending > 0
    );
  }, [benchmark?.runs]);

  // Check if any runs are still executing on the server
  // This catches runs that are in-progress even if our SSE connection was lost
  const hasServerInProgressRuns = useMemo(() => {
    if (!benchmark?.runs) return false;
    return benchmark.runs.some(run => getEffectiveRunStatus(run) === 'running');
  }, [benchmark?.runs]);

  // Polling effect: refresh benchmark data when running OR when there are pending evaluations/in-progress runs
  useEffect(() => {
    const shouldPoll = isRunning || hasPendingEvaluations || hasServerInProgressRuns;

    // Always clear existing interval first to prevent stacking
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (shouldPoll) {
      // Use 5s polling for background sync scenarios (SSE disconnected, pending evaluations)
      // Use faster polling (2s) only when actively running with SSE connected
      const interval = isRunning ? POLL_INTERVAL_MS : 5000;

      pollIntervalRef.current = setInterval(() => {
        loadBenchmark();
      }, interval);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isRunning, hasPendingEvaluations, hasServerInProgressRuns, loadBenchmark]);

  const getLatestRun = (exp: Benchmark): BenchmarkRun | null => {
    if (!exp.runs || exp.runs.length === 0) return null;
    return exp.runs.reduce((latest, run) =>
      new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest
    );
  };

  // Open run configuration dialog
  const handleAddRun = () => {
    if (!benchmark) return;
    if (isRunning) {
      alert('A run is already in progress. Please wait for it to complete.');
      return;
    }

    const latestRun = getLatestRun(benchmark);
    const runNumber = (benchmark.runs?.length || 0) + 1;

    // Pre-fill with latest run config if available, otherwise use defaults
    setRunConfigValues({
      name: `Run ${runNumber}`,
      description: '',
      agentKey: latestRun?.agentKey || DEFAULT_CONFIG.agents[0]?.key || '',
      modelId: latestRun?.modelId || Object.keys(DEFAULT_CONFIG.models)[0] || '',
      headers: latestRun?.headers,
    });
    setIsRunConfigOpen(true);
  };

  // Execute the run with configured values
  const handleStartRun = async () => {
    if (!benchmark) return;

    setIsRunConfigOpen(false);

    // Initialize use case statuses
    const initialStatuses: UseCaseRunStatus[] = benchmark.testCaseIds.map(id => {
      const testCase = testCases.find(tc => tc.id === id);
      return {
        id,
        name: testCase?.name || id,
        status: 'pending' as const,
      };
    });
    setUseCaseStatuses(initialStatuses);

    setIsRunning(true);
    setRunProgress(null);

    try {
      const completedRun = await executeBenchmarkRun(
        benchmark.id,
        runConfigValues,
        (progress: BenchmarkProgress) => {
          setRunProgress(progress);
          // Update use case statuses based on progress
          setUseCaseStatuses(prev => prev.map((uc, index) => {
            if (index < progress.currentTestCaseIndex) {
              return { ...uc, status: 'completed' as const };
            } else if (index === progress.currentTestCaseIndex) {
              // Map progress status to use case status
              const statusMap: Record<BenchmarkProgress['status'], UseCaseRunStatus['status']> = {
                'running': 'running',
                'completed': 'completed',
                'failed': 'failed',
                'cancelled': 'cancelled',
              };
              return { ...uc, status: statusMap[progress.status] };
            }
            return uc;
          }));
        },
        (startedEvent: BenchmarkStartedEvent) => {
          // Update use case names from server response (without resetting status to avoid race condition)
          setUseCaseStatuses(prev => prev.map(uc => {
            const serverTc = startedEvent.testCases.find(tc => tc.id === uc.id);
            return serverTc ? { ...uc, name: serverTc.name } : uc;
          }));
        }
      );

      // Mark all as completed when done (server already saved the run)
      setUseCaseStatuses(prev => prev.map(uc => ({ ...uc, status: 'completed' as const })));
      loadBenchmark();
    } catch (error) {
      console.error('Error running benchmark:', error);
      // Mark current and remaining as failed
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running'
          ? { ...uc, status: 'failed' as const }
          : uc
      ));
    } finally {
      setIsRunning(false);
      setRunProgress(null);
    }
  };

  // Toggle run selection for comparison
  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds(prev =>
      prev.includes(runId)
        ? prev.filter(id => id !== runId)
        : [...prev, runId]
    );
  };

  // Toggle select all / deselect all
  const handleToggleSelectAll = () => {
    const allRunIds = (benchmark?.runs || []).map(r => r.id);
    if (selectedRunIds.length === allRunIds.length) {
      setSelectedRunIds([]);
    } else {
      setSelectedRunIds(allRunIds);
    }
  };

  // Navigate to comparison with selected runs
  const handleCompareSelected = () => {
    if (selectedRunIds.length >= 2) {
      navigate(`/compare/${benchmarkId}?runs=${selectedRunIds.join(',')}`);
    }
  };

  if (!benchmark) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const runs = benchmark.runs || [];
  const hasMultipleRuns = runs.length >= 2;

  return (
    <div className="p-6 h-full flex flex-col" data-testid="benchmark-runs-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/benchmarks')} data-testid="back-button">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold" data-testid="benchmark-name">{benchmark.name}</h2>
              {hasMultipleVersions && (
                <Badge variant="outline" className="text-xs">
                  v{benchmark.currentVersion}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {runs.length} run{runs.length !== 1 ? 's' : ''}
              {hasMultipleVersions && ` · ${versionData.length} versions`}
              {runs.length > 0 && ` · Latest: ${formatDate(filteredRuns[0]?.createdAt || runs[0]?.createdAt)}`}
              {benchmark.description && ` · ${benchmark.description}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasMultipleRuns && (
            <>
              <Button
                variant="outline"
                onClick={handleToggleSelectAll}
              >
                {selectedRunIds.length === runs.length ? (
                  <>
                    <X size={16} className="mr-2" />
                    Deselect All
                  </>
                ) : (
                  <>
                    <Check size={16} className="mr-2" />
                    Select All
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleCompareSelected}
                disabled={selectedRunIds.length < 2}
              >
                <GitCompare size={16} className="mr-2" />
                Compare ({selectedRunIds.length})
              </Button>
            </>
          )}
          <Button
            onClick={handleAddRun}
            disabled={isRunning}
            className="bg-opensearch-blue hover:bg-blue-600"
          >
            {isRunning ? (
              <>
                <Loader2 size={16} className="mr-2 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Plus size={16} className="mr-2" />
                Add Run
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Main Content - Two-Panel Resizable Layout */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        {/* Left Panel - Test Cases (Version-Aware) */}
        <ResizablePanel defaultSize={35} minSize={25} maxSize={50}>
          <div className="h-full overflow-y-auto pr-4">
            {/* Panel Header with Version Dropdown */}
            <div className="sticky top-0 bg-background pb-3 border-b border-border mb-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Test Cases
                </h3>
                {hasMultipleVersions && (
                  <Select
                    value={testCaseVersion === null ? 'latest' : String(testCaseVersion)}
                    onValueChange={(val) => setTestCaseVersion(val === 'latest' ? null : Number(val))}
                  >
                    <SelectTrigger className="w-[140px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {versionData.map((v) => (
                        <SelectItem key={v.version} value={v.isLatest ? 'latest' : String(v.version)}>
                          v{v.version}{v.isLatest ? ' (latest)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Version Metadata */}
              {selectedVersionData && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Calendar size={12} />
                    <span>Created {formatDate(selectedVersionData.createdAt)}</span>
                  </div>
                  <div className="text-sm font-medium">
                    {versionTestCases.length} test case{versionTestCases.length !== 1 ? 's' : ''}
                  </div>
                  {/* Diff from previous version */}
                  {(selectedVersionData.added.length > 0 || selectedVersionData.removed.length > 0) && (
                    <div className="flex items-center gap-2 text-xs">
                      {selectedVersionData.added.length > 0 && (
                        <span className="text-green-400">+{selectedVersionData.added.length} added</span>
                      )}
                      {selectedVersionData.removed.length > 0 && (
                        <span className="text-red-400">-{selectedVersionData.removed.length} removed</span>
                      )}
                      <span className="text-muted-foreground">from v{selectedVersionData.version - 1}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Test Cases List */}
            <div className="space-y-2">
              {versionTestCases.length === 0 ? (
                <p className="text-sm text-muted-foreground">No test cases in this version</p>
              ) : (
                versionTestCases.map(tc => {
                  const isAddedInThisVersion = selectedVersionData?.added.includes(tc.id);
                  return (
                    <Card
                      key={tc.id}
                      className={`cursor-pointer hover:border-primary/50 transition-colors ${
                        isAddedInThisVersion ? 'border-green-500/30 bg-green-500/5' : ''
                      }`}
                      onClick={() => navigate(`/test-cases/${tc.id}/runs`)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate">{tc.name}</p>
                              {isAddedInThisVersion && (
                                <Badge className="text-xs bg-green-500/20 text-green-400 border-green-500/30">
                                  new
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {(tc.labels || []).slice(0, 2).map((label) => (
                                <Badge key={label} className={`text-xs ${getLabelColor(label)}`}>
                                  {label}
                                </Badge>
                              ))}
                              {(tc.labels || []).length > 2 && (
                                <span className="text-xs text-muted-foreground">
                                  +{(tc.labels || []).length - 2}
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight size={16} className="text-muted-foreground flex-shrink-0" />
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel - Runs (Filterable by Version) */}
        <ResizablePanel defaultSize={65} minSize={40}>
          <div className="h-full overflow-y-auto pl-4 flex flex-col">
            {/* Panel Header with Version Filter */}
            <div className="sticky top-0 bg-background pb-3 border-b border-border mb-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Runs
                </h3>
                {hasMultipleVersions && (
                  <Select
                    value={runVersionFilter === 'all' ? 'all' : String(runVersionFilter)}
                    onValueChange={(val) => setRunVersionFilter(val === 'all' ? 'all' : Number(val))}
                  >
                    <SelectTrigger className="w-[160px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        All Versions ({runs.length})
                      </SelectItem>
                      {versionData.map((v) => (
                        <SelectItem key={v.version} value={String(v.version)}>
                          v{v.version} ({v.runCount} run{v.runCount !== 1 ? 's' : ''})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Running Progress */}
            {isRunning && useCaseStatuses.length > 0 && (
              <Card className="mb-4 border-blue-500/50 flex-shrink-0">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin" />
                      Running...
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {useCaseStatuses.filter(uc => uc.status === 'completed').length} / {useCaseStatuses.length}
                    </span>
                  </div>
                  <Progress
                    value={(useCaseStatuses.filter(uc => uc.status === 'completed' || uc.status === 'failed' || uc.status === 'cancelled').length / useCaseStatuses.length) * 100}
                    className="h-2 mb-3"
                  />
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {useCaseStatuses.map(uc => (
                      <div key={uc.id} className="flex items-center gap-2 text-xs">
                        {uc.status === 'pending' && <Circle size={12} className="text-muted-foreground" />}
                        {uc.status === 'running' && <Loader2 size={12} className="text-blue-400 animate-spin" />}
                        {uc.status === 'completed' && <CheckCircle2 size={12} className="text-opensearch-blue" />}
                        {uc.status === 'failed' && <XCircle size={12} className="text-red-400" />}
                        {uc.status === 'cancelled' && <Ban size={12} className="text-orange-400" />}
                        <span className={uc.status === 'running' ? 'text-blue-400' : uc.status === 'cancelled' ? 'text-orange-400' : 'text-muted-foreground'}>
                          {uc.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Delete Feedback */}
            {deleteState.message && (
              <div className={`flex items-center gap-2 text-sm mb-4 p-3 rounded-lg ${
                deleteState.status === 'success'
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
              }`}>
                {deleteState.status === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span>{deleteState.message}</span>
                {deleteState.status === 'error' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteState(s => ({ ...s, status: 'idle', message: '' }))}
                    className="ml-auto h-6 px-2"
                  >
                    <X size={14} />
                  </Button>
                )}
              </div>
            )}

            {/* Runs List */}
            <div className="flex-1 space-y-3">
              {filteredRuns.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Play size={48} className="mb-4 opacity-20" />
                    <p className="text-lg font-medium">
                      {runVersionFilter === 'all' ? 'No runs yet' : `No runs for v${runVersionFilter}`}
                    </p>
                    <p className="text-sm">
                      {runVersionFilter === 'all'
                        ? 'Run this benchmark to see results here'
                        : 'Try selecting a different version or "All Versions"'}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                filteredRuns.map((run, index) => {
                  const stats = getRunStats(run);
                  const isLatestRun = index === 0 && runVersionFilter === 'all';
                  const isSelected = selectedRunIds.includes(run.id);

                  return (
                    <Card
                      key={run.id}
                      className={`transition-colors cursor-pointer ${
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'hover:border-primary/50'
                      }`}
                      onClick={() => {
                        navigate(`/benchmarks/${benchmarkId}/runs/${run.id}`);
                      }}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 flex-1">
                            {hasMultipleRuns && (
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleRunSelection(run.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-5 w-5"
                              />
                            )}
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-semibold">{run.name}</h3>
                                {getEffectiveRunStatus(run) === 'running' && (
                                  <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse">
                                    <Loader2 size={12} className="mr-1 animate-spin" />
                                    Running
                                  </Badge>
                                )}
                                {getEffectiveRunStatus(run) === 'cancelled' && (
                                  <Badge className="text-xs bg-gray-500/20 text-gray-400 border-gray-500/30">
                                    <XCircle size={12} className="mr-1" />
                                    Cancelled
                                  </Badge>
                                )}
                                {isLatestRun && (
                                  <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                                    Latest
                                  </Badge>
                                )}
                                {/* Version badge */}
                                {run.benchmarkVersion && benchmark && (
                                  <Badge
                                    variant="outline"
                                    className={`text-xs ${
                                      run.benchmarkVersion < benchmark.currentVersion
                                        ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
                                        : 'text-muted-foreground'
                                    }`}
                                    title={run.benchmarkVersion < (benchmark.currentVersion || 1)
                                      ? `Run used v${run.benchmarkVersion}, current is v${benchmark.currentVersion}`
                                      : `Run used v${run.benchmarkVersion}`}
                                  >
                                    v{run.benchmarkVersion}
                                    {run.benchmarkVersion < (benchmark.currentVersion || 1) && ' (outdated)'}
                                  </Badge>
                                )}
                              </div>
                              {run.description && (
                                <p className="text-sm text-muted-foreground mb-2">{run.description}</p>
                              )}
                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Calendar size={12} />
                                  {formatDate(run.createdAt)}
                                </span>
                                <span>Agent: {DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey}</span>
                                <span>Model: {getModelName(run.modelId)}</span>
                              </div>
                            </div>
                          </div>

                          {/* Stats and Actions */}
                          <div className="flex items-center gap-4">
                            {(stats.total > 0 || getEffectiveRunStatus(run) === 'running') && (
                              <div className="flex items-center gap-4 text-sm">
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
                                <span className="flex items-center gap-1 text-opensearch-blue">
                                  <CheckCircle2 size={14} />
                                  {stats.passed}
                                </span>
                                <span className="flex items-center gap-1 text-red-400">
                                  <XCircle size={14} />
                                  {stats.failed}
                                </span>
                                <span className="text-muted-foreground">
                                  / {stats.total}
                                </span>
                              </div>
                            )}
                            {getEffectiveRunStatus(run) === 'running' && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isCancelling(run.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!benchmarkId) return;
                                  handleCancelRun(benchmarkId, run.id, loadBenchmark);
                                }}
                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/30 disabled:opacity-50"
                              >
                                {isCancelling(run.id) ? (
                                  <Loader2 size={14} className="mr-1 animate-spin" />
                                ) : (
                                  <StopCircle size={14} className="mr-1" />
                                )}
                                {isCancelling(run.id) ? 'Cancelling...' : 'Cancel'}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteRun(run);
                              }}
                              disabled={deleteState.isDeleting && deleteState.deletingId === run.id}
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                              title="Delete run"
                            >
                              {deleteState.isDeleting && deleteState.deletingId === run.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Trash2 size={14} />
                              )}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>

            {/* Load More Runs button */}
            {hasMoreRuns && !isLoadingMoreRuns && (
              <div className="flex justify-center pt-4 flex-shrink-0">
                <Button variant="outline" onClick={loadMoreRuns}>
                  Load More Runs
                </Button>
              </div>
            )}
            {isLoadingMoreRuns && (
              <div className="flex justify-center pt-4 flex-shrink-0">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Footer hint */}
            {runs.length === 1 && (
              <p className="text-xs text-muted-foreground text-center mt-4 flex-shrink-0">
                Add more runs to enable comparison
              </p>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Run Configuration Dialog */}
      {isRunConfigOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg">Configure Run</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsRunConfigOpen(false)}
              >
                <X size={18} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="run-name">Run Name</Label>
                <Input
                  id="run-name"
                  value={runConfigValues.name}
                  onChange={e => setRunConfigValues(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Baseline, With Fix, Claude 4 Test"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="run-description">Description (optional)</Label>
                <Textarea
                  id="run-description"
                  value={runConfigValues.description || ''}
                  onChange={e => setRunConfigValues(prev => ({ ...prev, description: e.target.value || undefined }))}
                  placeholder="Describe what this run tests or changes..."
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Agent</Label>
                  <Select
                    value={runConfigValues.agentKey}
                    onValueChange={val => setRunConfigValues(prev => ({ ...prev, agentKey: val }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEFAULT_CONFIG.agents.map(agent => (
                        <SelectItem
                          key={agent.key}
                          value={agent.key}
                        >
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Judge Model</Label>
                  <Select
                    value={runConfigValues.modelId}
                    onValueChange={val => setRunConfigValues(prev => ({ ...prev, modelId: val }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(DEFAULT_CONFIG.models).map(([key, model]) => (
                        <SelectItem key={key} value={key}>
                          {model.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setIsRunConfigOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleStartRun}
                  disabled={!runConfigValues.name.trim()}
                  className="bg-opensearch-blue hover:bg-blue-600"
                >
                  <Play size={16} className="mr-1" />
                  Start Run
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

    </div>
  );
};
