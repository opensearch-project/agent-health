/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Benchmark detail — Evals 3
 *
 * Cases is the default master-detail review surface; Runs retains the existing
 * execution/comparison actions and adds an aligned case-verdict heat strip.
 * Route state keeps both tabs and selected cases deep-linkable.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { PREFS_KEYS } from '@/lib/preferences';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  GitCompare, Calendar, CheckCircle2, XCircle, Play,
  Trash2, Plus, X, Loader2, Circle, Check, Clock,
  StopCircle, Ban, Pencil, AlertTriangle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { JudgeModelSelect } from '@/components/JudgeModelSelect';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncBenchmarkStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { computeRunStats, getEffectiveRunStatus, isRunInProgress } from '@/lib/runStats';
import { executeBenchmarkRun, listEvaluationRuns } from '@/services/client';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';
import { Benchmark, BenchmarkRun, TestCase, BenchmarkProgress, BenchmarkStartedEvent, RunStats, Evaluator, EvaluationRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';
import { formatDate, getModelName } from '@/lib/utils';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import {
  computeVersionData,
  filterRunsByVersion,
  effectiveRunVersionFilter,
  VersionData,
} from '@/lib/benchmarkVersionUtils';
import { RunConfigForExecution } from '@/components/BenchmarkEditor';
import { BenchmarkEditor } from '@/components/BenchmarkEditor';
import { BenchmarkCasesTab, CaseHeatStrip } from '@/components/evals3/BenchmarkCasesTab';
import { getRecentCompletedRuns } from '@/lib/benchmarkCaseReview';
import type { EvaluationReport } from '@/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

const POLL_INTERVAL_MS = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
// getEffectiveRunStatus moved to @/lib/runStats (shared with EvalRunsPage.tsx
// — both runs-list surfaces must agree on what counts as "running").


// ─── Main Component ──────────────────────────────────────────────────────────

export const BenchmarkRunsPage2: React.FC = () => {
  const { benchmarkId, caseId } = useParams<{ benchmarkId: string; caseId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const parentPath = '/evaluations/benchmarks';
  const activeTab = /\/runs(?:\/|$)/.test(location.pathname) ? 'runs' : 'cases';

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);

  // Runs associated with this benchmark via `evaluationRun.benchmarkId` but
  // NOT embedded in `benchmark.runs[]` (bug #6, 2026-09-01: eval-runs created
  // outside the "Add Run" embedded-run path — e.g. CLI/API/scheduled runs —
  // are standalone `evaluation-run` docs and never show up on this page at
  // all, even once completed, because nothing here ever queried them).
  const [associatedEvalRuns, setAssociatedEvalRuns] = useState<EvaluationRun[]>([]);

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

  // Evaluators for the run config dialog. Loaded once on mount so the
  // "Evaluator" dropdown can show human-readable names. Mirrors
  // TestCaseDetailPage so both "Configure Run" entry points expose the
  // same evaluator selection.
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setEvaluators(data.evaluators || []);
      } catch (error) {
        console.error('Failed to load evaluators:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  // Version state for the Runs tab. Cases always reflect the benchmark's
  // current canonical case order; historical run cells remain aligned to it
  // (heat-strip click-through surfaces a per-run version notice instead —
  // see caseVersionNotice below).
  // Persisted PER BENCHMARK — a single global key leaked a version filter set
  // on one benchmark (e.g. v8) onto every other benchmark, where it matched
  // nothing and rendered a bogus "No runs for v8" empty state that looked
  // like data loss (hit on EnterpriseRAG-Bench, 2026-08-24).
  const [rawRunVersionFilter, setRunVersionFilter] = usePersistedState<number | 'all'>(
    `benchmark-runs:runVersionFilter:${benchmarkId ?? 'unknown'}`, 'all'
  );
  // Self-heal any stale persisted value: a version the benchmark doesn't have
  // behaves as 'all' instead of filtering everything out.
  const runVersionFilter = effectiveRunVersionFilter(
    rawRunVersionFilter,
    benchmark ? (benchmark.versions ?? []).map(v => v.version) : undefined
  );
  // Repair the persisted value too (not just mask it at render time), so
  // localStorage doesn't keep serving a corrupt filter to every consumer.
  useEffect(() => {
    if (benchmark && runVersionFilter !== rawRunVersionFilter) {
      setRunVersionFilter(runVersionFilter);
    }
  }, [benchmark, runVersionFilter, rawRunVersionFilter, setRunVersionFilter]);

  // Lightweight report summaries power both the five-run case sparklines and
  // the per-run heat strips without adding a server endpoint.
  const [reportSummaries, setReportSummaries] = useState<Record<string, EvaluationReport>>({});

  // Editor state — Edit Benchmark lives on this page (per user feedback the
  // pencil button on the list page was unexpected; users land on the benchmark
  // detail page when they want to add/remove test cases).
  const [showEditor, setShowEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const { isCancelling, handleCancelRun } = useBenchmarkCancellation();

  // ─── Data Loading ────────────────────────────────────────────────────────

  const loadBenchmark = useCallback(async () => {
    if (!benchmarkId) return;
    try {
      const isPolling = isInitialLoadDone.current;
      const options = isPolling
        ? { fields: 'polling' as const, runsSize: 100 }
        : { runsSize: 100 };
      const [exp, evalRunsResult] = await Promise.all([
        asyncBenchmarkStorage.getById(benchmarkId, options),
        // Best-effort: a failure here still leaves the embedded benchmark.runs
        // working, same fallback pattern as EvalRunsPage.tsx.
        listEvaluationRuns({ benchmarkId, size: 100 }).then(r => r.evaluationRuns).catch(err => {
          console.error('Failed to load associated evaluation-runs:', err);
          return [] as EvaluationRun[];
        }),
      ]);
      if (!exp) { navigate(parentPath); return; }
      setAssociatedEvalRuns(evalRunsResult);

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
          const benchmarkTcs = await asyncTestCaseStorage.getByIds(exp.testCaseIds || []);
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

  // Infinite scroll: auto-click "Load More Runs" when its sentinel container
  // scrolls into view. The button stays as an explicit fallback.
  const loadMoreRunsSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = loadMoreRunsSentinelRef.current;
    if (!el || !hasMoreRuns || isLoadingMoreRuns) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadMoreRuns();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMoreRuns, isLoadingMoreRuns, loadMoreRuns]);

  // ─── Derived Data ────────────────────────────────────────────────────────

  // Preserve benchmark.testCaseIds order: every heat-strip row must use the
  // same canonical columns even when async storage returns definitions in a
  // different order.
  const benchmarkTestCases = useMemo(() => {
    const byId = new Map(testCases.map(testCase => [testCase.id, testCase]));
    return (benchmark?.testCaseIds || []).map(id => byId.get(id)).filter((testCase): testCase is TestCase => !!testCase);
  }, [testCases, benchmark?.testCaseIds]);

  const versionData = useMemo<VersionData[]>(
    () => computeVersionData(benchmark), [benchmark]
  );

  const allMergedRuns = useMemo(() => {
    // Merge embedded runs with associated-but-not-embedded eval-runs, deduped
    // by id (an eval-run migrated into benchmark.runs would otherwise be
    // double-counted). EvaluationRun is shape-compatible with BenchmarkRun for
    // every field this page reads (id, status, results, testCaseSnapshots,
    // createdAt, agentKey, modelId) — same convergence as EvalRunsPage.tsx.
    const embeddedIds = new Set((benchmark?.runs || []).map(r => r.id));
    const extra = associatedEvalRuns
      .filter(er => !embeddedIds.has(er.id))
      .map(er => er as unknown as BenchmarkRun);
    return [...(benchmark?.runs || []), ...extra];
  }, [benchmark?.runs, associatedEvalRuns]);

  const filteredRuns = useMemo(
    () => filterRunsByVersion(allMergedRuns, runVersionFilter),
    [allMergedRuns, runVersionFilter]
  );

  const recentCompletedRuns = useMemo(
    () => getRecentCompletedRuns(benchmark?.runs || [], 5),
    [benchmark?.runs],
  );

  // Cases need only five runs, while the Runs tab needs every currently loaded
  // row. The existing chunked summaries API works in both file and OpenSearch
  // modes and omits trajectories/raw events from these requests.
  const reportIdsForView = useMemo(() => {
    const sourceRuns = activeTab === 'runs' ? filteredRuns : recentCompletedRuns;
    return [...new Set(sourceRuns.flatMap(run =>
      Object.values(run.results || {}).map(result => result.reportId).filter(Boolean)
    ))];
  }, [activeTab, filteredRuns, recentCompletedRuns]);
  const reportIdsKey = reportIdsForView.join(',');

  useEffect(() => {
    let cancelled = false;
    if (reportIdsForView.length === 0) {
      setReportSummaries({});
      return () => { cancelled = true; };
    }
    asyncRunStorage.getReportSummariesByIds(reportIdsForView)
      .then(summaries => { if (!cancelled) setReportSummaries(summaries); })
      .catch(error => {
        console.error('Failed to load benchmark verdict summaries:', error);
        if (!cancelled) setReportSummaries({});
      });
    return () => { cancelled = true; };
    // reportIdsKey is the stable semantic dependency; the array is rebuilt by
    // memo whenever the selected tab/run set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportIdsKey]);

  // Ids of merged-in rows that are standalone evaluation-run docs, not
  // embedded in benchmark.runs[]. Row-level Delete/Cancel call
  // benchmark-embedded-run-specific APIs (asyncBenchmarkStorage.deleteRun /
  // cancelBenchmarkRun scoped by benchmarkId+runId) that don't apply to
  // these — gate those actions off for this set rather than risk a wrong-API
  // 404 or silent no-op.
  const evalRunOnlyIds = useMemo(() => {
    const embeddedIds = new Set((benchmark?.runs || []).map(r => r.id));
    return new Set(associatedEvalRuns.filter(er => !embeddedIds.has(er.id)).map(er => er.id));
  }, [benchmark?.runs, associatedEvalRuns]);

  const hasMultipleVersions = versionData.length > 1;

  // ─── Run Stats ───────────────────────────────────────────────────────────

  const getRunStats = useCallback((run: BenchmarkRun): RunStats & { running: number; errored: number } => {
    let running = 0;
    Object.values(run.results || {}).forEach(r => { if (r.status === 'running') running++; });

    // Recompute from run.results (single source of truth, issue #242) rather
    // than trusting the denormalized run.stats, which historically counted
    // errored cases as passed. Falls back to run.stats only when per-case
    // results aren't present (e.g. very old runs).
    const { passed, failed, errored, total } = computeRunStats(run);
    const pending = Math.max(0, total - passed - failed - errored - running);
    return { passed, failed, pending, running, errored, total };
  }, []);

  const hasPendingEvaluations = useMemo(() => {
    return filteredRuns.some(run => run.stats?.pending && run.stats.pending > 0);
  }, [filteredRuns]);

  const hasServerInProgressRuns = useMemo(() => {
    return filteredRuns.some(run => isRunInProgress(run));
  }, [filteredRuns]);

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
    // Use latest run's config, fall back to persisted preferences, then defaults
    let defaultAgent = DEFAULT_CONFIG.agents[0]?.key || '';
    let defaultModel = Object.keys(DEFAULT_CONFIG.models)[0] || '';
    try {
      const storedAgent = localStorage.getItem('agent-health:' + PREFS_KEYS.agentKey);
      const storedModel = localStorage.getItem('agent-health:' + PREFS_KEYS.modelId);
      if (storedAgent) defaultAgent = JSON.parse(storedAgent);
      if (storedModel) defaultModel = JSON.parse(storedModel);
    } catch { /* use defaults */ }
    setRunConfigValues({
      name: `Run ${runNumber}`, description: '',
      agentKey: latestRun?.agentKey || defaultAgent,
      modelId: latestRun?.modelId || defaultModel,
      // Carry over the customer-supplied judge model + evaluator from the
      // latest run so iterative runs default to the same evaluation setup
      // (matches TestCaseDetailPage's seeding). Both are optional — the
      // server resolves judgeModelId via
      // evaluator.inferenceConfig.modelId → BEDROCK_MODEL_ID when undefined,
      // and undefined evaluatorId means "RCA Default".
      judgeModelId: latestRun?.judgeModelId,
      evaluatorId: latestRun?.evaluatorId,
      headers: latestRun?.headers,
    });
    setIsRunConfigOpen(true);
  };

  const handleStartRun = async () => {
    if (!benchmark) return;
    setIsRunConfigOpen(false);
    const initialStatuses: UseCaseRunStatus[] = (benchmark.testCaseIds || []).map(id => {
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

  const runs = allMergedRuns;
  const hasMultipleRuns = runs.length >= 2;

  return (
    <div className="p-4 sm:p-6 h-full max-md:h-auto max-md:min-h-full flex flex-col">
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/runs' },
          { label: 'Benchmarks', href: '/evaluations/benchmarks' },
          { label: benchmark.name },
        ]}
        actions={<>
          {activeTab === 'runs' && hasMultipleRuns && (
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
          <Button
            data-testid="edit-benchmark-button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => { setEditorError(null); setShowEditor(true); }}
            disabled={isRunning}
            title="Edit benchmark (changing test cases creates a new version)"
          >
            <Pencil size={12} className="mr-1" />Edit
          </Button>
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

      {/* Cases (default) and Runs are route-backed tabs. */}
      {(() => {
        // ── Reusable body fragments — identical in both layouts ──────────
        const runsBody = (
          <>
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
                    {runVersionFilter === 'all' || runs.length === 0
                      ? 'No runs yet'
                      : `0 of ${runs.length} run${runs.length !== 1 ? 's' : ''} match v${runVersionFilter}`}
                  </p>
                  <p className="text-sm">
                    {runVersionFilter === 'all' || runs.length === 0
                      ? 'Run this benchmark to see results here'
                      : 'Runs exist on other versions of this benchmark'}
                  </p>
                  {runVersionFilter !== 'all' && runs.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      data-testid="show-all-versions-btn"
                      onClick={() => setRunVersionFilter('all')}
                    >
                      Show all versions ({runs.length})
                    </Button>
                  )}
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
                      <div className="flex items-center justify-between max-md:flex-col max-md:items-stretch max-md:gap-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {hasMultipleRuns && (
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleRunSelection(run.id)}
                              onClick={e => e.stopPropagation()}
                              className="h-5 w-5"
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
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
                            <div className="flex items-center gap-x-4 gap-y-1 text-xs text-muted-foreground flex-wrap">
                              <span className="flex items-center gap-1"><Calendar size={12} />{formatDate(run.createdAt)}</span>
                              <span>Agent: {DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey}</span>
                              <span>Model: {getModelName(run.modelId)}</span>
                            </div>
                          </div>
                        </div>

                        {/* Stats and Actions */}
                        <div className="flex items-center gap-4 max-md:justify-between max-md:pl-8 max-md:flex-wrap">
                          {(stats.total > 0 || getEffectiveRunStatus(run) === 'running') && (
                            <div className="flex items-center gap-4 text-sm flex-wrap">
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
                              {stats.errored > 0 && (
                                <span
                                  className="flex items-center gap-1 text-amber-600 dark:text-amber-500"
                                  title="Evaluator could not run (e.g. judge validation error). Excluded from pass-rate aggregation."
                                >
                                  <AlertTriangle size={14} /> {stats.errored}
                                </span>
                              )}
                              <span className="text-muted-foreground">/ {stats.total}</span>
                            </div>
                          )}
                          {getEffectiveRunStatus(run) === 'running' && !evalRunOnlyIds.has(run.id) && (
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
                          {!evalRunOnlyIds.has(run.id) && (
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
                          )}
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t">
                        <div className="text-[10px] text-muted-foreground mb-1.5">Case verdicts · click a cell to review</div>
                        <CaseHeatStrip
                          benchmarkId={benchmark.id}
                          run={run}
                          testCases={benchmarkTestCases}
                          reportsById={reportSummaries}
                          onSelectCase={testCaseId => navigate(`/evaluations/benchmarks/${benchmark.id}/cases/${testCaseId}`)}
                        />
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>

          {/* Load More — auto-triggers via infinite scroll; button kept as a
              no-JS/observer fallback */}
          {hasMoreRuns && !isLoadingMoreRuns && (
            <div ref={loadMoreRunsSentinelRef} data-testid="load-more-runs-sentinel" className="flex justify-center pt-4">
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
          </>
        );

        const testCasesBody = (
          <BenchmarkCasesTab
            benchmarkId={benchmark.id}
            testCases={benchmarkTestCases}
            recentRuns={recentCompletedRuns}
            allRuns={runs}
            totalRuns={totalRuns || runs.length}
            reportsById={reportSummaries}
            selectedCaseId={caseId}
            onSelectCase={testCaseId => navigate(`/evaluations/benchmarks/${benchmark.id}/cases/${testCaseId}`)}
            onClearCase={() => navigate(`/evaluations/benchmarks/${benchmark.id}`)}
            onOpenRuns={() => navigate(`/evaluations/benchmarks/${benchmark.id}/runs`)}
          />
        );

        const runsVersionSelect = hasMultipleVersions ? (
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
                  v{v.version}{v.isLatest ? ' (latest)' : ''} · {v.runCount === 0 ? 'no runs' : `${v.runCount} run${v.runCount !== 1 ? 's' : ''}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null;

        return (
          <Tabs
            value={activeTab}
            onValueChange={value => navigate(value === 'runs'
              ? `/evaluations/benchmarks/${benchmark.id}/runs`
              : caseId
                ? `/evaluations/benchmarks/${benchmark.id}/cases/${caseId}`
                : `/evaluations/benchmarks/${benchmark.id}`
            )}
            className="flex-1 min-h-0 flex flex-col overflow-hidden max-md:overflow-visible"
          >
            <div className="flex items-center justify-between mb-3 shrink-0">
              <TabsList>
                <TabsTrigger value="cases" className="text-xs">
                  Cases {benchmarkTestCases.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">{benchmarkTestCases.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="runs" className="text-xs">
                  Runs {filteredRuns.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">{filteredRuns.length}</Badge>}
                </TabsTrigger>
              </TabsList>
              {activeTab === 'runs' && runsVersionSelect}
            </div>
            {/*
              flex + flex-col here is required, not cosmetic: BenchmarkCasesTab's
              root renders "flex-1 min-h-0" panes expecting a flex parent. Without
              `display: flex` on this TabsContent, those classes are no-ops (they
              only affect flex items), so the whole subtree grows to its natural
              content height instead of being clamped to the tab's available
              height — the aside's own `overflow-y-auto` never gets a bounded
              box to scroll within, so nothing below the fold is reachable on
              large benchmarks. See PR #447 review: "scrolling doesn't work".
            */}
            <TabsContent value="cases" className="flex-1 min-h-0 mt-0 flex flex-col overflow-hidden max-md:overflow-visible">{testCasesBody}</TabsContent>
            <TabsContent value="runs" className="flex-1 min-h-0 overflow-y-auto mt-0">{runsBody}</TabsContent>
          </Tabs>
        );
      })()}

      {/* Edit Benchmark Modal
           Lives on the detail page (not the list page) per user feedback.
           Save flow:
             - asyncBenchmarkStorage.save() persists
             - if test cases changed, the backend bumps currentVersion (v2, v3, ...)
             - we reload the benchmark in place so the version badge in the
               header and the version dropdowns flip immediately. */}
      {showEditor && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="fixed inset-4 z-50 overflow-auto bg-background border rounded-lg shadow-lg">
            {editorError && (
              <div
                role="alert"
                data-testid="benchmark-editor-error"
                className="sticky top-0 z-10 bg-red-500/10 border-b border-red-500/30 text-red-400 px-4 py-2 text-sm flex items-center justify-between"
              >
                <span>Failed to save benchmark: {editorError}</span>
                <button
                  onClick={() => setEditorError(null)}
                  className="ml-4 text-red-400 hover:text-red-300"
                  aria-label="dismiss error"
                >×</button>
              </div>
            )}
            <BenchmarkEditor
              benchmark={benchmark}
              onSave={async (bm) => {
                try {
                  await asyncBenchmarkStorage.save(bm);
                } catch (err: any) {
                  setEditorError(err?.message || String(err));
                  return;
                }
                setEditorError(null);
                setShowEditor(false);
                await loadBenchmark();
              }}
              onSaveAndRun={async (bm, runConfigs: RunConfigForExecution[]) => {
                try {
                  await asyncBenchmarkStorage.save(bm);
                } catch (err: any) {
                  setEditorError(err?.message || String(err));
                  return;
                }
                setEditorError(null);
                setShowEditor(false);
                await loadBenchmark();
                // Fire each configured run in the background; the runs list polls
                // and surfaces in-progress runs as they start.
                for (const rc of runConfigs) {
                  executeBenchmarkRun(bm.id, rc, () => { /* progress shown on this page */ })
                    .catch(e => console.error('[BenchmarkRunsPage] background run failed:', e));
                }
              }}
              onCancel={() => { setEditorError(null); setShowEditor(false); }}
            />
          </div>
        </div>
      )}

      {/* ── Run Configuration Dialog ───────────────────────────────────── */}
      {isRunConfigOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md" data-testid="run-config-dialog">
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
              <div className="space-y-2">
                <Label>Agent</Label>
                {/* The agent's LLM is owned by its agent-health.config.ts
                    connectorConfig — there is no agent-model picker. */}
                <Select
                  value={runConfigValues.agentKey}
                  onValueChange={val => setRunConfigValues(prev => ({ ...prev, agentKey: val }))}
                >
                  <SelectTrigger data-testid="run-config-agent-trigger"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DEFAULT_CONFIG.agents.map(agent => (
                      <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  {/* Evaluator — picks the scoring config + (default)
                      judge prompt and judge model. "RCA Default" maps to
                      undefined; the server resolves the built-in default. */}
                  <Label>Evaluator</Label>
                  <Select
                    value={runConfigValues.evaluatorId || '__default__'}
                    onValueChange={val => setRunConfigValues(prev => ({
                      ...prev,
                      evaluatorId: val === '__default__' ? undefined : val,
                    }))}
                  >
                    <SelectTrigger data-testid="run-config-evaluator-trigger">
                      <SelectValue placeholder="RCA Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">RCA Default</SelectItem>
                      {evaluators.map(evaluator => (
                        <SelectItem key={evaluator.id} value={evaluator.id}>
                          {evaluator.name} {evaluator.isSystem ? '(System)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  {/* Judge Model — customer-supplied LLM for the judge,
                      distinct from the agent's model. "Use evaluator
                      default" maps to undefined; the server resolves
                      from evaluator.inferenceConfig.modelId then
                      BEDROCK_MODEL_ID. Includes ALL providers since
                      this dropdown controls the judge LLM only. */}
                  <Label>Judge Model</Label>
                  <JudgeModelSelect
                    value={runConfigValues.judgeModelId ?? ''}
                    onValueChange={val => setRunConfigValues(prev => ({
                      ...prev,
                      judgeModelId: val || undefined,
                    }))}
                    allowDefault={true}
                  />
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
