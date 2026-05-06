/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * BenchmarkRunsPage V2 — Evals 3: Tabbed layout (Option B)
 *
 * Replaces the confusing two-panel resizable split with two tabs:
 *   - "Runs" (default) — full-width runs list with version filter
 *   - "Test Cases" — full-width test case list with version selector
 *
 * Benchmark summary header stays above both tabs.
 * Same data model + backend as V1 (asyncBenchmarkStorage).
 * Wired to Evals 3 only.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  GitCompare, Calendar, CheckCircle2, XCircle, Play,
  Trash2, Plus, X, Loader2, Circle, Check, ChevronRight, Clock,
  StopCircle, Ban,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { executeBenchmarkRun } from '@/services/client';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';
import { Benchmark, BenchmarkRun, TestCase, BenchmarkProgress, BenchmarkStartedEvent, RunStats } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getLabelColor, formatDate, getModelName } from '@/lib/utils';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import {
  computeVersionData,
  getSelectedVersionData,
  getVersionTestCases,
  filterRunsByVersion,
  VersionData,
} from '@/lib/benchmarkVersionUtils';
import { RunConfigForExecution } from '@/components/BenchmarkEditor';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

const POLL_INTERVAL_MS = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getEffectiveRunStatus = (run: BenchmarkRun): BenchmarkRun['status'] => {
  if (run.status) return run.status;
  const results = Object.values(run.results || {});
  if (results.some(r => r.status === 'running')) return 'running';
  if (results.some(r => r.status === 'pending') &&
      !results.some(r => r.status === 'completed' || r.status === 'failed')) return 'running';
  if (results.some(r => r.status === 'completed') || results.some(r => r.status === 'failed')) return 'completed';
  return 'failed';
};


// ─── Main Component ──────────────────────────────────────────────────────────

export const BenchmarkRunsPage2: React.FC = () => {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const navigate = useNavigate();
  const parentPath = '/evaluations/benchmarks';

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);

  // Run pagination
  const [totalRuns, setTotalRuns] = useState(0);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [isLoadingMoreRuns, setIsLoadingMoreRuns] = useState(false);
  const isInitialLoadDone = useRef(false);
  const cachedVersions = useRef<Benchmark['versions'] | null>(null);

  // Run config dialog
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  const [runConfigValues, setRunConfigValues] = useState<RunConfigForExecution>({
    name: '', description: '', agentKey: '', modelId: '',
  });

  // Running state
  const [isRunning, setIsRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<BenchmarkProgress | null>(null);
  const [useCaseStatuses, setUseCaseStatuses] = useState<UseCaseRunStatus[]>([]);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Selection for comparison
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  // Delete state
  const [deleteState, setDeleteState] = useState<{
    isDeleting: boolean; deletingId: string | null;
    status: 'idle' | 'success' | 'error'; message: string;
  }>({ isDeleting: false, deletingId: null, status: 'idle', message: '' });

  // Version state
  const [testCaseVersion, setTestCaseVersion] = useState<number | null>(null);
  const [runVersionFilter, setRunVersionFilter] = useState<number | 'all'>('all');

  // Tab state
  const [activeTab, setActiveTab] = useState<string>('runs');

  const { isCancelling, handleCancelRun } = useBenchmarkCancellation();

  // ─── Data Loading ────────────────────────────────────────────────────────

  const loadBenchmark = useCallback(async () => {
    if (!benchmarkId) return;
    try {
      const isPolling = isInitialLoadDone.current;
      const options = isPolling
        ? { fields: 'polling' as const, runsSize: 100 }
        : { runsSize: 100 };
      const exp = await asyncBenchmarkStorage.getById(benchmarkId, options);
      if (!exp) { navigate(parentPath); return; }

      const expAny = exp as any;
      if (expAny.totalRuns !== undefined) {
        setTotalRuns(expAny.totalRuns);
        setHasMoreRuns(expAny.hasMoreRuns ?? false);
      }
      if (isPolling && cachedVersions.current) {
        exp.versions = cachedVersions.current;
      } else {
        cachedVersions.current = exp.versions;
      }
      setBenchmark(exp);

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
      navigate(parentPath);
    }
  }, [benchmarkId, navigate, parentPath]);

  const loadMoreRuns = useCallback(async () => {
    if (!benchmarkId || !benchmark || isLoadingMoreRuns) return;
    setIsLoadingMoreRuns(true);
    try {
      const currentRunCount = benchmark.runs?.length || 0;
      const exp = await asyncBenchmarkStorage.getById(benchmarkId, {
        runsSize: 100, runsOffset: currentRunCount,
      });
      if (exp) {
        setBenchmark(prev => {
          if (!prev) return exp;
          return { ...prev, runs: [...(prev.runs || []), ...(exp.runs || [])] };
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

  useEffect(() => { loadBenchmark(); }, [loadBenchmark]);

  // ─── Derived Data ────────────────────────────────────────────────────────

  const benchmarkTestCases = useMemo(() =>
    testCases.filter(tc => benchmark?.testCaseIds.includes(tc.id)),
    [testCases, benchmark]
  );

  const versionData = useMemo<VersionData[]>(
    () => computeVersionData(benchmark), [benchmark]
  );

  const selectedVersionData = useMemo(
    () => getSelectedVersionData(versionData, testCaseVersion), [versionData, testCaseVersion]
  );

  const versionTestCases = useMemo(
    () => getVersionTestCases(testCases, selectedVersionData), [selectedVersionData, testCases]
  );

  const filteredRuns = useMemo(
    () => filterRunsByVersion(benchmark?.runs, runVersionFilter), [benchmark?.runs, runVersionFilter]
  );

  const hasMultipleVersions = versionData.length > 1;

  // ─── Run Stats ───────────────────────────────────────────────────────────

  const getRunStats = useCallback((run: BenchmarkRun): RunStats & { running: number } => {
    let running = 0;
    Object.values(run.results || {}).forEach(r => { if (r.status === 'running') running++; });

    if (run.stats && typeof run.stats.passed === 'number') {
      return {
        passed: run.stats.passed, failed: run.stats.failed,
        pending: Math.max(0, run.stats.pending - running), running,
        total: run.stats.total,
      };
    }
    let passed = 0, failed = 0, pending = 0;
    Object.values(run.results || {}).forEach(r => {
      if (r.status === 'running') return;
      else if (r.status === 'completed') passed++;
      else if (r.status === 'failed' || r.status === 'cancelled') failed++;
      else pending++;
    });
    return { passed, failed, pending, running, total: Object.keys(run.results || {}).length };
  }, []);

  const hasPendingEvaluations = useMemo(() => {
    if (!benchmark?.runs) return false;
    return benchmark.runs.some(run => run.stats?.pending && run.stats.pending > 0);
  }, [benchmark?.runs]);

  const hasServerInProgressRuns = useMemo(() => {
    if (!benchmark?.runs) return false;
    return benchmark.runs.some(run => getEffectiveRunStatus(run) === 'running');
  }, [benchmark?.runs]);

  // Polling
  useEffect(() => {
    const shouldPoll = isRunning || hasPendingEvaluations || hasServerInProgressRuns;
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    if (shouldPoll) {
      const interval = isRunning ? POLL_INTERVAL_MS : 5000;
      pollIntervalRef.current = setInterval(() => { loadBenchmark(); }, interval);
    }
    return () => { if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; } };
  }, [isRunning, hasPendingEvaluations, hasServerInProgressRuns, loadBenchmark]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const getLatestRun = (exp: Benchmark): BenchmarkRun | null => {
    if (!exp.runs || exp.runs.length === 0) return null;
    return exp.runs.reduce((latest, run) =>
      new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest
    );
  };

  const handleAddRun = () => {
    if (!benchmark) return;
    if (isRunning) { alert('A run is already in progress.'); return; }
    const latestRun = getLatestRun(benchmark);
    const runNumber = (benchmark.runs?.length || 0) + 1;
    setRunConfigValues({
      name: `Run ${runNumber}`, description: '',
      agentKey: latestRun?.agentKey || DEFAULT_CONFIG.agents[0]?.key || '',
      modelId: latestRun?.modelId || Object.keys(DEFAULT_CONFIG.models)[0] || '',
      headers: latestRun?.headers,
    });
    setIsRunConfigOpen(true);
  };

  const handleStartRun = async () => {
    if (!benchmark) return;
    setIsRunConfigOpen(false);
    const initialStatuses: UseCaseRunStatus[] = benchmark.testCaseIds.map(id => {
      const testCase = testCases.find(tc => tc.id === id);
      return { id, name: testCase?.name || id, status: 'pending' as const };
    });
    setUseCaseStatuses(initialStatuses);
    setIsRunning(true);
    setRunProgress(null);
    try {
      await executeBenchmarkRun(
        benchmark.id, runConfigValues,
        (progress: BenchmarkProgress) => {
          setRunProgress(progress);
          setUseCaseStatuses(prev => prev.map((uc, index) => {
            if (index < progress.currentTestCaseIndex) return { ...uc, status: 'completed' as const };
            if (index === progress.currentTestCaseIndex) {
              const statusMap: Record<BenchmarkProgress['status'], UseCaseRunStatus['status']> = {
                running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled',
              };
              return { ...uc, status: statusMap[progress.status] };
            }
            return uc;
          }));
        },
        (startedEvent: BenchmarkStartedEvent) => {
          setUseCaseStatuses(prev => prev.map(uc => {
            const serverTc = startedEvent.testCases.find(tc => tc.id === uc.id);
            return serverTc ? { ...uc, name: serverTc.name } : uc;
          }));
        }
      );
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running' ? { ...uc, status: 'completed' as const } : uc
      ));
      loadBenchmark();
    } catch (error) {
      console.error('Error running benchmark:', error);
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running' ? { ...uc, status: 'failed' as const } : uc
      ));
    } finally {
      setIsRunning(false);
      setRunProgress(null);
    }
  };

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
      setDeleteState({ isDeleting: false, deletingId: null, status: 'error',
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` });
    }
  };

  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds(prev => prev.includes(runId) ? prev.filter(id => id !== runId) : [...prev, runId]);
  };

  const handleToggleSelectAll = () => {
    const allRunIds = filteredRuns.map(r => r.id);
    const allSelected = allRunIds.every(id => selectedRunIds.includes(id));
    setSelectedRunIds(allSelected ? [] : allRunIds);
  };

  const handleCompareSelected = () => {
    if (selectedRunIds.length >= 2) navigate(`/compare/${benchmarkId}?runs=${selectedRunIds.join(',')}`);
  };


  // ─── Render ──────────────────────────────────────────────────────────────

  if (!benchmark) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const runs = benchmark.runs || [];
  const hasMultipleRuns = runs.length >= 2;

  return (
    <div className="p-6 h-full flex flex-col">
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/benchmarks' },
          { label: 'Benchmarks', href: '/evaluations/benchmarks' },
          { label: benchmark.name },
        ]}
        actions={<>
          {hasMultipleRuns && (
            <>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleToggleSelectAll}>
                {selectedRunIds.length === runs.length
                  ? <><X size={12} className="mr-1" />Deselect All</>
                  : <><Check size={12} className="mr-1" />Select All</>}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleCompareSelected} disabled={selectedRunIds.length < 2}>
                <GitCompare size={12} className="mr-1" />Compare ({selectedRunIds.length})
              </Button>
            </>
          )}
          <Button size="sm" className="h-7 text-xs bg-opensearch-blue hover:bg-blue-600" onClick={handleAddRun} disabled={isRunning}>
            {isRunning
              ? <><Loader2 size={12} className="mr-1 animate-spin" />Running...</>
              : <><Plus size={12} className="mr-1" />Add Run</>}
          </Button>
        </>}
      />
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold">{benchmark.name}</h2>
          {hasMultipleVersions && (
            <Badge variant="outline" className="text-xs">v{benchmark.currentVersion}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {runs.length} run{runs.length !== 1 ? 's' : ''}
          {hasMultipleVersions && ` · ${versionData.length} versions`}
          {runs.length > 0 && ` · Latest: ${formatDate(filteredRuns[0]?.createdAt || runs[0]?.createdAt)}`}
          {benchmark.description && ` · ${benchmark.description}`}
        </p>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <TabsList>
            <TabsTrigger value="runs" className="text-xs">
              Runs {filteredRuns.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">{filteredRuns.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="test-cases" className="text-xs">
              Test Cases {versionTestCases.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">{versionTestCases.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          {/* Version filter — context-aware per tab */}
          {hasMultipleVersions && activeTab === 'runs' && (
            <Select
              value={runVersionFilter === 'all' ? 'all' : String(runVersionFilter)}
              onValueChange={val => setRunVersionFilter(val === 'all' ? 'all' : Number(val))}
            >
              <SelectTrigger className="w-[160px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Versions ({runs.length})</SelectItem>
                {versionData.map(v => (
                  <SelectItem key={v.version} value={String(v.version)}>
                    v{v.version} ({v.runCount} run{v.runCount !== 1 ? 's' : ''})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {hasMultipleVersions && activeTab === 'test-cases' && (
            <Select
              value={testCaseVersion === null ? 'latest' : String(testCaseVersion)}
              onValueChange={val => setTestCaseVersion(val === 'latest' ? null : Number(val))}
            >
              <SelectTrigger className="w-[140px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versionData.map(v => (
                  <SelectItem key={v.version} value={v.isLatest ? 'latest' : String(v.version)}>
                    v{v.version}{v.isLatest ? ' (latest)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* ── Runs Tab ─────────────────────────────────────────────────── */}
        <TabsContent value="runs" className="flex-1 overflow-y-auto mt-0">
          {/* Running Progress */}
          {isRunning && useCaseStatuses.length > 0 && (
            <Card className="mb-4 border-blue-500/50">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" /> Running...
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
                      {uc.status === 'running' && <Loader2 size={12} className="text-blue-700 dark:text-blue-400 animate-spin" />}
                      {uc.status === 'completed' && <CheckCircle2 size={12} className="text-green-700 dark:text-green-400" />}
                      {uc.status === 'failed' && <XCircle size={12} className="text-red-700 dark:text-red-400" />}
                      {uc.status === 'cancelled' && <Ban size={12} className="text-amber-700 dark:text-amber-400" />}
                      <span className={uc.status === 'running' ? 'text-blue-700 dark:text-blue-400' : uc.status === 'cancelled' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}>
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
                ? 'bg-green-100 text-green-700 border border-green-300 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20'
                : 'bg-red-100 text-red-700 border border-red-300 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20'
            }`}>
              {deleteState.status === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              <span>{deleteState.message}</span>
              {deleteState.status === 'error' && (
                <Button variant="ghost" size="sm" onClick={() => setDeleteState(s => ({ ...s, status: 'idle', message: '' }))} className="ml-auto h-6 px-2">
                  <X size={14} />
                </Button>
              )}
            </div>
          )}

          {/* Runs List — full width */}
          <div className="space-y-3">
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
                      isSelected ? 'border-primary bg-primary/5' : 'hover:border-primary/50'
                    }`}
                    onClick={() => {
                      const runDetailPath = `/evaluations/benchmarks/${benchmarkId}/runs/${run.id}/inspect`;
                      navigate(runDetailPath);
                    }}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 flex-1">
                          {hasMultipleRuns && (
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleRunSelection(run.id)}
                              onClick={e => e.stopPropagation()}
                              className="h-5 w-5"
                            />
                          )}
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold">{run.name}</h3>
                              {getEffectiveRunStatus(run) === 'running' && (
                                <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30 animate-pulse">
                                  <Loader2 size={12} className="mr-1 animate-spin" /> Running
                                </Badge>
                              )}
                              {getEffectiveRunStatus(run) === 'cancelled' && (
                                <Badge className="text-xs bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-500/20 dark:text-gray-400 dark:border-gray-500/30">
                                  <XCircle size={12} className="mr-1" /> Cancelled
                                </Badge>
                              )}
                              {isLatestRun && (
                                <Badge variant="outline" className="text-xs bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/30">
                                  Latest
                                </Badge>
                              )}
                              {run.benchmarkVersion && benchmark && (
                                <Badge
                                  variant="outline"
                                  className={`text-xs ${
                                    run.benchmarkVersion < benchmark.currentVersion
                                      ? 'bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/30'
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
                              <span className="flex items-center gap-1"><Calendar size={12} />{formatDate(run.createdAt)}</span>
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
                                <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400" title="Running">
                                  <Loader2 size={14} className="animate-spin" /> {stats.running}
                                </span>
                              )}
                              {stats.pending > 0 && (
                                <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400" title="Pending">
                                  <Clock size={14} /> {stats.pending}
                                </span>
                              )}
                              <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                                <CheckCircle2 size={14} /> {stats.passed}
                              </span>
                              <span className="flex items-center gap-1 text-red-700 dark:text-red-400">
                                <XCircle size={14} /> {stats.failed}
                              </span>
                              <span className="text-muted-foreground">/ {stats.total}</span>
                            </div>
                          )}
                          {getEffectiveRunStatus(run) === 'running' && (
                            <Button
                              variant="outline" size="sm"
                              disabled={isCancelling(run.id)}
                              onClick={e => { e.stopPropagation(); if (benchmarkId) handleCancelRun(benchmarkId, run.id, loadBenchmark); }}
                              className="text-red-700 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-500/10 border-red-500/30 disabled:opacity-50"
                            >
                              {isCancelling(run.id) ? <Loader2 size={14} className="mr-1 animate-spin" /> : <StopCircle size={14} className="mr-1" />}
                              {isCancelling(run.id) ? 'Cancelling...' : 'Cancel'}
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="icon"
                            onClick={e => { e.stopPropagation(); handleDeleteRun(run); }}
                            disabled={deleteState.isDeleting && deleteState.deletingId === run.id}
                            className="text-red-700 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-500/10"
                            title="Delete run"
                          >
                            {deleteState.isDeleting && deleteState.deletingId === run.id
                              ? <Loader2 size={14} className="animate-spin" />
                              : <Trash2 size={14} />}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>

          {/* Load More */}
          {hasMoreRuns && !isLoadingMoreRuns && (
            <div className="flex justify-center pt-4">
              <Button variant="outline" onClick={loadMoreRuns}>Load More Runs</Button>
            </div>
          )}
          {isLoadingMoreRuns && (
            <div className="flex justify-center pt-4">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          )}
          {runs.length === 1 && (
            <p className="text-xs text-muted-foreground text-center mt-4">Add more runs to enable comparison</p>
          )}
        </TabsContent>


        {/* ── Test Cases Tab ───────────────────────────────────────────── */}
        <TabsContent value="test-cases" className="flex-1 overflow-y-auto mt-0">
          {/* Version Metadata */}
          {selectedVersionData && (
            <div className="mb-4 p-3 rounded-lg border border-border bg-muted/20">
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Calendar size={12} /> Created {formatDate(selectedVersionData.createdAt)}</span>
                <span className="font-medium text-foreground">
                  {versionTestCases.length} test case{versionTestCases.length !== 1 ? 's' : ''}
                </span>
                {(selectedVersionData.added.length > 0 || selectedVersionData.removed.length > 0) && (
                  <>
                    {selectedVersionData.added.length > 0 && (
                      <span className="text-green-700 dark:text-green-400">+{selectedVersionData.added.length} added</span>
                    )}
                    {selectedVersionData.removed.length > 0 && (
                      <span className="text-red-700 dark:text-red-400">-{selectedVersionData.removed.length} removed</span>
                    )}
                    <span>from v{selectedVersionData.version - 1}</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Test Cases List — full width */}
          <div className="space-y-2">
            {versionTestCases.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <p className="text-sm">No test cases in this version</p>
              </div>
            ) : (
              versionTestCases.map(tc => {
                const isAddedInThisVersion = selectedVersionData?.added.includes(tc.id);
                return (
                  <Card
                    key={tc.id}
                    className={`cursor-pointer hover:border-primary/50 transition-colors ${
                      isAddedInThisVersion ? 'border-green-500/30 bg-green-50 dark:bg-green-500/5' : ''
                    }`}
                    onClick={() => {
                      const tcPath = `/evaluations/test-cases/${tc.id}`;
                      navigate(tcPath);
                    }}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{tc.name}</p>
                            {isAddedInThisVersion && (
                              <Badge className="text-xs bg-green-100 text-green-700 border-green-300 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30">
                                new
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {(tc.labels || []).slice(0, 3).map(label => (
                              <Badge key={label} className={`text-xs ${getLabelColor(label)}`}>{label}</Badge>
                            ))}
                            {(tc.labels || []).length > 3 && (
                              <span className="text-xs text-muted-foreground">+{(tc.labels || []).length - 3}</span>
                            )}
                            {tc.category && (
                              <span className="text-xs text-muted-foreground">· {tc.category}</span>
                            )}
                            {tc.difficulty && (
                              <Badge variant="outline" className="text-[10px]">{tc.difficulty}</Badge>
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
        </TabsContent>
      </Tabs>

      {/* ── Run Configuration Dialog ───────────────────────────────────── */}
      {isRunConfigOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg">Configure Run</CardTitle>
              <Button variant="ghost" size="icon" onClick={() => setIsRunConfigOpen(false)}>
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
                  <Select value={runConfigValues.agentKey} onValueChange={val => setRunConfigValues(prev => ({ ...prev, agentKey: val }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DEFAULT_CONFIG.agents.map(agent => (
                        <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Judge Model</Label>
                  <Select value={runConfigValues.modelId} onValueChange={val => setRunConfigValues(prev => ({ ...prev, modelId: val }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(DEFAULT_CONFIG.models).map(([key, model]) => (
                        <SelectItem key={key} value={key}>{model.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setIsRunConfigOpen(false)}>Cancel</Button>
                <Button onClick={handleStartRun} disabled={!runConfigValues.name.trim()} className="bg-opensearch-blue hover:bg-blue-600">
                  <Play size={16} className="mr-1" /> Start Run
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};
