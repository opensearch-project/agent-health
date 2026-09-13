/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Benchmark detail — Evals 3
 *
 * Cases is the default master-detail review surface; Runs is a compact table
 * (Run · Agent · Model · Size · Pass % · Judge · J. Model · Date) with a
 * pass-rate-over-time chart (one line per agent) above it. Clicking any
 * categorical cell or chart legend entry filters the table; active filters
 * render as removable pills. Per-run case-verdict heat strips are available
 * as an expandable row. Route state keeps both tabs and selected cases
 * deep-linkable.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { PREFS_KEYS } from '@/lib/preferences';
import { ENV_CONFIG } from '@/lib/config';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  GitCompare, CheckCircle2, XCircle, Play,
  Plus, X, Loader2, Circle, Check,
  Ban, Pencil, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncBenchmarkStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { isRunInProgress, getEffectiveRunStatus } from '@/lib/runStats';
import {
  LaunchedRun, pruneLaunchedRuns, countRunsInFlight, progressFromPolledDoc,
} from '@/lib/runLaunchState';
import { debug } from '@/lib/debug';
import { executeBenchmarkRun, listEvaluationRuns, deleteEvaluationRun, cancelEvaluationRun } from '@/services/client';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';
import { Benchmark, BenchmarkRun, TestCase, BenchmarkProgress, BenchmarkStartedEvent, Evaluator, EvaluationRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getModelName } from '@/lib/utils';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import {
  computeVersionData,
  filterRunsByVersion,
  effectiveRunVersionFilter,
  VersionData,
} from '@/lib/benchmarkVersionUtils';
import { RunConfigDialog, RunConfigValues } from '@/components/evals3/RunConfigDialog';
import type { RunConfigForExecution } from '@/components/BenchmarkEditor';
import { BenchmarkEditor } from '@/components/BenchmarkEditor';
import { BenchmarkCasesTab } from '@/components/evals3/BenchmarkCasesTab';
import { BenchmarkRunsTable, RunFilterPills } from '@/components/evals3/BenchmarkRunsTable';
import { BenchmarkPassRateChart } from '@/components/evals3/BenchmarkPassRateChart';
import {
  buildRunTableRow, applyRunFilters, toggleRunFilter, removeRunFilter,
  sortRunRows, toggleRunSort, buildPassRateSeries, latestRunId, DEFAULT_RUN_SORT,
  RunFilter, RunSort, RunSortField, RunTableRow,
} from '@/lib/benchmarkRunsTable';
import { getRecentCompletedRuns } from '@/lib/benchmarkCaseReview';
import type { EvaluationReport } from '@/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

/** A run launched from this page plus the case list its progress block renders. */
interface LaunchedRunEntry extends LaunchedRun {
  cases: UseCaseRunStatus[];
}

const POLL_INTERVAL_MS = 2000;
/**
 * How long the header waits for the launch POST's `started` event before it
 * gives the button back. The server emits `started` right after creating the
 * run doc (before executing anything), so a stall here is an intermediary or
 * backend problem — without a bound the "launching" disable would be a
 * forever-disable, the very thing this page must never do. A late `started`
 * is still honoured (the run gets its progress block); it just no longer owns
 * the launching window.
 */
const LAUNCH_STARTED_TIMEOUT_MS = 30_000;

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
  const [runConfigValues, setRunConfigValues] = useState<RunConfigValues>({
    name: '', description: '', agentKey: '', modelId: '',
  });

  // Evaluator names for the runs table's "Evaluator" column (id → name).
  // The shared RunConfigDialog loads its own list for the picker; this copy
  // only labels existing rows, so a failed fetch just falls back to raw ids.
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

  // Runs THIS page launched via Add Run — a LIST, because launching several
  // arms (agent/model variants) on one benchmark back-to-back is the normal
  // flow (owner, 2026-09-13). The header button is never disabled by running
  // runs; it only pauses for the ~1 s `isLaunching` window between the POST
  // and the `started` event (no runId yet). Each launched run is tracked by
  // its polled RUN DOCUMENT — not by the SSE connection that launched it,
  // which idle proxies/tunnels close long before `completed` on long runs
  // (owner, 2026-09-09) — and drops out of `launchedRuns` when that doc is
  // terminal. See lib/runLaunchState.ts.
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchedRuns, setLaunchedRuns] = useState<LaunchedRunEntry[]>([]);
  // Per-run rows fed by a LIVE launching SSE stream (keyed by runId). An
  // entry is removed when its stream drops or ends; from then on that run's
  // progress block is rebuilt from the polled doc's `results`.
  const [liveStreamRows, setLiveStreamRows] = useState<Record<string, UseCaseRunStatus[]>>({});
  const [collapsedLaunchedRunIds, setCollapsedLaunchedRunIds] = useState<Set<string>>(new Set());
  // A POST that failed before `started` (nothing is running server-side).
  const [launchError, setLaunchError] = useState<string | null>(null);
  // Synchronous re-entrancy guard for handleStartRun: React state (and the
  // disabled attribute) only catch a second click after the next render, so
  // a fast double-click on "Start Run" could otherwise POST twice. Holds the
  // token of the launch that currently owns the launching window (null when
  // free) so a late callback from an OLDER launch can never release a newer
  // launch's window.
  const launchOwnerRef = useRef<object | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Selection for comparison
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  // Runs-table click-to-filter state (pills), sort, and expanded heat strips.
  // Session-scoped on purpose: a filter is an exploration gesture, not a
  // preference — persisting it caused the same "why is my list empty?"
  // confusion the version filter had (see rawRunVersionFilter below).
  const [runFilters, setRunFilters] = useState<RunFilter[]>([]);
  const [runSort, setRunSort] = useState<RunSort>(DEFAULT_RUN_SORT);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());

  // Cancel-in-flight marker for rows backed by an evaluation-run doc (the
  // benchmark-scoped hook below tracks legacy embedded rows).
  const [cancellingEvalRunId, setCancellingEvalRunId] = useState<string | null>(null);

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

  // Ids of merged-in rows that exist as first-class evaluation-run documents
  // (whether or not a projection is ALSO embedded in benchmark.runs[]). Used
  // to dispatch row-level Delete/Cancel to the right API — evaluation-run docs
  // to /api/storage/evaluation-runs/:id, legacy embedded-only runs to the
  // benchmark nested-run endpoints. This set used to HIDE Delete/Cancel for
  // non-embedded rows instead (owner report: "Delete button should be present
  // for all runs on the benchmark details page") — and since the #399
  // dual-write most runs are not embedded, so most rows had no Delete at all.
  const evalRunDocIds = useMemo(
    () => new Set(associatedEvalRuns.map(er => er.id)),
    [associatedEvalRuns]
  );

  const hasMultipleVersions = versionData.length > 1;

  // ─── Table rows / filters / chart ────────────────────────────────────────

  const evaluatorNames = useMemo(
    () => new Map(evaluators.map(e => [e.id, e.name])), [evaluators]
  );

  // One row per version-filtered run, with pass/fail/errored recomputed from
  // run.results (single source of truth, issue #242) rather than the
  // denormalized run.stats.
  const allRows = useMemo<RunTableRow[]>(() => filteredRuns.map(run => buildRunTableRow(run, {
    agentName: key => DEFAULT_CONFIG.agents.find(a => a.key === key)?.name || key || 'Unknown',
    modelName: id => getModelName(id),
    // Judge model ids share DEFAULT_CONFIG.models with agent model ids; an
    // evaluator that was deleted since the run falls back to its raw id.
    judgeLabel: id => (id ? getModelName(id) : '—'),
    evaluatorLabel: id => (id ? evaluatorNames.get(id) || id : '—'),
  })), [filteredRuns, evaluatorNames]);

  const visibleRows = useMemo(
    () => sortRunRows(applyRunFilters(allRows, runFilters), runSort),
    [allRows, runFilters, runSort]
  );

  // Chart follows every NON-agent filter (so it never disagrees with the table
  // about model/judge/status), but agent filters only dim the other lines —
  // dropping them would make the legend useless as a toggle (you couldn't
  // click a second agent back in once the first was selected).
  const nonAgentFilters = useMemo(() => runFilters.filter(f => f.field !== 'agent'), [runFilters]);
  const passRateSeries = useMemo(
    () => buildPassRateSeries(applyRunFilters(allRows, nonAgentFilters)),
    [allRows, nonAgentFilters]
  );
  const activeAgentKeys = useMemo(
    () => new Set(runFilters.filter(f => f.field === 'agent').map(f => f.value)),
    [runFilters]
  );

  const handleToggleFilter = useCallback((f: RunFilter) => setRunFilters(prev => toggleRunFilter(prev, f)), []);
  const handleSort = useCallback((field: RunSortField) => setRunSort(prev => toggleRunSort(prev, field)), []);
  const handleToggleExpand = useCallback((runId: string) => setExpandedRunIds(prev => {
    const next = new Set(prev);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  }), []);

  const hasPendingEvaluations = useMemo(() => {
    return filteredRuns.some(run => run.stats?.pending && run.stats.pending > 0);
  }, [filteredRuns]);

  const hasServerInProgressRuns = useMemo(() => {
    return filteredRuns.some(run => isRunInProgress(run));
  }, [filteredRuns]);

  // Launched-run bookkeeping against the polled docs (see the comment on
  // `launchedRuns` above). Looked up in the UNFILTERED merged list so a
  // version filter that hides a new run can't make the header lie. A launched
  // run whose doc is terminal — or that never appeared within the grace —
  // drops out, taking its progress block with it.
  useEffect(() => {
    setLaunchedRuns(prev => {
      const next = pruneLaunchedRuns(prev, allMergedRuns);
      if (next !== prev) {
        const dropped = prev.filter(l => !next.includes(l)).map(l => l.runId);
        debug('BenchmarkRunsPage', `Launched run(s) ${dropped.join(', ')} terminal per polled doc — progress block(s) removed`);
      }
      return next;
    });
  }, [allMergedRuns]);

  // Non-blocking header indicator: every in-flight run for this benchmark,
  // launched here or anywhere else.
  const runsInFlightCount = useMemo(() => countRunsInFlight(allMergedRuns), [allMergedRuns]);
  const hasLaunchedRuns = launchedRuns.length > 0;

  // Progress rows per launched run. While its SSE stream is live they come
  // from the per-case events; after it drops they are rebuilt from the polled
  // doc's `results` so the block keeps moving (and finishes) without the stream.
  const launchedRunProgress = useMemo(() => launchedRuns.map(launched => {
    const live = liveStreamRows[launched.runId];
    const doc = allMergedRuns.find(r => r.id === launched.runId) ?? null;
    const rows: UseCaseRunStatus[] = live ?? progressFromPolledDoc(launched.cases, doc);
    const name = doc?.name || launched.name;
    return { launched, name, rows };
  }), [launchedRuns, liveStreamRows, allMergedRuns]);

  // Polling
  useEffect(() => {
    const shouldPoll = isLaunching || hasLaunchedRuns || hasPendingEvaluations || hasServerInProgressRuns;
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    if (shouldPoll) {
      const interval = hasLaunchedRuns ? POLL_INTERVAL_MS : 5000;
      pollIntervalRef.current = setInterval(() => { loadBenchmark(); }, interval);
    }
    return () => { if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; } };
  }, [isLaunching, hasLaunchedRuns, hasPendingEvaluations, hasServerInProgressRuns, loadBenchmark]);

  // `● N running` pill → the Runs table, narrowed to running rows.
  const handleShowRunningRuns = useCallback(() => {
    if (activeTab !== 'runs') navigate(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const running: RunFilter = { field: 'status', value: 'running', label: 'running' };
    setRunFilters(prev => prev.some(f => f.field === running.field && f.value === running.value) ? prev : [...prev, running]);
    // The table may not be mounted yet when switching tabs; best effort.
    setTimeout(() => {
      document.querySelector('[data-testid="benchmark-runs-table"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }, [activeTab, benchmarkId, navigate]);

  const toggleLaunchedRunCollapsed = useCallback((runId: string) => setCollapsedLaunchedRunIds(prev => {
    const next = new Set(prev);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  }), []);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const getLatestRun = (exp: Benchmark): BenchmarkRun | null => {
    if (!exp.runs || exp.runs.length === 0) return null;
    return exp.runs.reduce((latest, run) =>
      new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest
    );
  };

  const handleAddRun = () => {
    if (!benchmark) return;
    // Deliberately NOT gated on running runs: launching the next arm while
    // the previous one runs is the normal flow.
    const latestRun = getLatestRun(benchmark);
    // Number off EVERY run this page knows about (embedded + associated docs,
    // including ones launched seconds ago) so back-to-back arms don't all
    // default to the same "Run N".
    const runNumber = allMergedRuns.length + 1;
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

  const handleStartRun = async (values: RunConfigValues) => {
    if (!benchmark) return;
    if (launchOwnerRef.current) return;
    const owner = {};
    launchOwnerRef.current = owner;
    // Give the launching window back to whoever still owns it — only this
    // launch, and only once (a later launch may own it by the time a stale
    // callback fires).
    const releaseLaunchWindow = () => {
      if (launchOwnerRef.current !== owner) return;
      launchOwnerRef.current = null;
      setIsLaunching(false);
    };
    setRunConfigValues(values);
    setIsRunConfigOpen(false);
    setLaunchError(null);
    const initialCases: UseCaseRunStatus[] = (benchmark.testCaseIds || []).map(id => {
      const testCase = testCases.find(tc => tc.id === id);
      return { id, name: testCase?.name || id, status: 'pending' as const };
    });
    setIsLaunching(true);
    let launchedId: string | null = null;
    const startedTimeout = setTimeout(() => {
      if (launchedId || launchOwnerRef.current !== owner) return;
      debug('BenchmarkRunsPage', `No \`started\` event within ${LAUNCH_STARTED_TIMEOUT_MS} ms — releasing the Add Run button`);
      setLaunchError(`The run did not report starting within ${LAUNCH_STARTED_TIMEOUT_MS / 1000}s. It may still be running — check the runs table.`);
      releaseLaunchWindow();
    }, LAUNCH_STARTED_TIMEOUT_MS);
    const updateLiveRows = (runId: string, update: (rows: UseCaseRunStatus[]) => UseCaseRunStatus[]) =>
      setLiveStreamRows(prev => (prev[runId] ? { ...prev, [runId]: update(prev[runId]) } : prev));
    try {
      await executeBenchmarkRun(
        benchmark.id, values,
        (progress: BenchmarkProgress) => {
          if (!launchedId) return;
          updateLiveRows(launchedId, rows => rows.map((uc, index) => {
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
          // From here on this run is tracked by its DOCUMENT (polled), not by
          // this connection. Poll immediately so the new doc shows up, and
          // free the header for the next launch right away.
          launchedId = startedEvent.runId;
          clearTimeout(startedTimeout);
          const cases = initialCases.map(uc => {
            const serverTc = startedEvent.testCases.find(tc => tc.id === uc.id);
            return serverTc ? { ...uc, name: serverTc.name } : uc;
          });
          setLaunchedRuns(prev => [...prev, { runId: startedEvent.runId, name: values.name, launchedAt: Date.now(), cases }]);
          setLiveStreamRows(prev => ({ ...prev, [startedEvent.runId]: cases }));
          // The launching window is over: the header (and the guard) are free
          // for the next launch even though THIS stream stays open.
          releaseLaunchWindow();
          loadBenchmark();
        }
      );
      // Stream delivered `completed` — the server has already persisted the
      // terminal doc, so drop this run's block now rather than waiting a poll
      // cycle, then refresh the rows.
      if (launchedId) {
        const doneId = launchedId;
        setLaunchedRuns(prev => prev.filter(l => l.runId !== doneId));
      }
      loadBenchmark();
    } catch (error) {
      if (launchedId) {
        // The stream dropped (idle proxy/tunnel/browser) or ended without
        // `completed`, but the run keeps executing server-side by design
        // (the route's sendSSE treats the stream as an observer). Do NOT
        // flip the UI to failed — fall back to polling the run doc, which
        // is what this run's progress block derives from now.
        debug('BenchmarkRunsPage', `SSE stream for run ${launchedId} ended before completion; falling back to polling:`, error);
        loadBenchmark();
      } else {
        // Never got a runId: the POST itself failed (validation, source
        // resolution, benchmark missing). Nothing is running server-side.
        console.error('Error running benchmark:', error);
        setLaunchError(error instanceof Error ? error.message : 'Failed to start run');
      }
    } finally {
      clearTimeout(startedTimeout);
      // No-op if `started` (or the timeout) already released the window.
      releaseLaunchWindow();
      if (launchedId) {
        const endedId = launchedId;
        setLiveStreamRows(prev => {
          if (!(endedId in prev)) return prev;
          const rest = { ...prev };
          delete rest[endedId];
          return rest;
        });
      }
    }
  };

  // Delete is offered on EVERY row. Dispatch on the run's kind: a row backed
  // by a first-class evaluation-run doc goes to the evaluation-runs API
  // (the benchmark nested-run endpoint 404s for a run that isn't embedded —
  // the silent no-op the old gate was avoiding by hiding the button); a
  // legacy embedded-only run goes to the benchmark nested-run endpoint.
  // Removing BOTH persisted forms of a dual-written run is the server's job
  // (either endpoint), not something to reconstruct client-side from a
  // best-effort listing. Reports are intentionally NOT deleted (AGENTS.md
  // policy) and the confirm says so.
  const handleDeleteRun = async (run: BenchmarkRun) => {
    if (!benchmarkId) return;
    const running = getEffectiveRunStatus(run) === 'running';
    const confirmText = `Delete run "${run.name}"?` +
      (running ? ' It is still running.' : '') +
      ' Its per-test-case reports are kept and stay reachable from each test case. This cannot be undone.';
    if (!window.confirm(confirmText)) return;
    setDeleteState({ isDeleting: true, deletingId: run.id, status: 'idle', message: '' });
    try {
      const success = evalRunDocIds.has(run.id)
        ? await deleteEvaluationRun(run.id)
        : await asyncBenchmarkStorage.deleteRun(benchmarkId, run.id);
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

  // Cancel dispatches the same way: evaluation-run docs have their own cancel
  // endpoint (with the zombie fallback); legacy embedded runs keep the
  // benchmark-scoped hook.
  const handleCancelRow = async (run: BenchmarkRun) => {
    if (!benchmarkId) return;
    if (evalRunDocIds.has(run.id)) {
      setCancellingEvalRunId(run.id);
      try {
        await cancelEvaluationRun(run.id);
        await loadBenchmark();
      } catch (error) {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'error',
          message: `Failed to cancel "${run.name}": ${error instanceof Error ? error.message : 'Unknown error'}` });
      } finally {
        setCancellingEvalRunId(null);
      }
    } else {
      await handleCancelRun(benchmarkId, run.id, loadBenchmark);
    }
  };

  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds(prev => prev.includes(runId) ? prev.filter(id => id !== runId) : [...prev, runId]);
  };

  const handleToggleSelectAll = () => {
    const allRunIds = visibleRows.map(r => r.run.id);
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
    <div className="p-3 sm:p-4 h-full max-md:h-auto max-md:min-h-full flex flex-col" data-testid="benchmark-runs-page">
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
                {visibleRows.length > 0 && visibleRows.every(r => selectedRunIds.includes(r.run.id))
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
            disabled={isLaunching || hasLaunchedRuns}
            title={hasLaunchedRuns
              ? 'Edit is available once the runs launched from this page finish'
              : 'Edit benchmark (changing test cases creates a new version)'}
          >
            <Pencil size={12} className="mr-1" />Edit
          </Button>
          {runsInFlightCount > 0 && (
            <button
              type="button"
              data-testid="runs-in-flight-pill"
              onClick={handleShowRunningRuns}
              title="Show running runs in the table"
              className="inline-flex items-center gap-1 h-7 px-2 rounded-full text-[11px] font-medium bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 whitespace-nowrap"
            >
              <span className="animate-pulse">●</span> {runsInFlightCount} running
            </button>
          )}
          <Button
            size="sm"
            className="h-7 text-xs bg-opensearch-blue hover:bg-blue-600"
            onClick={handleAddRun}
            disabled={isLaunching}
            data-testid="add-run-button"
            data-run-state={isLaunching ? 'launching' : 'idle'}
          >
            {isLaunching
              ? <><Loader2 size={12} className="mr-1 animate-spin" />Add Run</>
              : <><Plus size={12} className="mr-1" />Add Run</>}
          </Button>
        </>}
      />
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold leading-tight">{benchmark.name}</h2>
          {hasMultipleVersions && (
            <Badge variant="outline" className="text-xs">v{benchmark.currentVersion}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2" title={benchmark.description || undefined}>
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
          {/* Launch failure (POST failed before `started`; nothing is running server-side) */}
          {launchError && (
            <div className="flex items-center gap-2 text-sm mb-3 p-2 rounded-lg bg-red-100 text-red-700 border border-red-300 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20" data-testid="run-launch-error">
              <XCircle size={16} />
              <span>Failed to start run: {launchError}</span>
              <Button variant="ghost" size="sm" onClick={() => setLaunchError(null)} className="ml-auto h-6 px-2">
                <X size={14} />
              </Button>
            </div>
          )}

          {/* Running Progress — one collapsible block per run launched from this page */}
          {launchedRunProgress.map(({ launched, name, rows }) => {
            const collapsed = collapsedLaunchedRunIds.has(launched.runId);
            const completed = rows.filter(uc => uc.status === 'completed').length;
            const settled = rows.filter(uc => uc.status === 'completed' || uc.status === 'failed' || uc.status === 'cancelled').length;
            return (
              <Card key={launched.runId} className="mb-3 border-blue-500/50" data-testid="run-progress-panel" data-run-id={launched.runId}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      className="text-sm font-medium flex items-center gap-2 text-left"
                      onClick={() => toggleLaunchedRunCollapsed(launched.runId)}
                      aria-expanded={!collapsed}
                      data-testid="run-progress-toggle"
                    >
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <Loader2 size={14} className="animate-spin" />
                      <span data-testid="run-progress-name">{name}</span>
                    </button>
                    <span className="text-xs text-muted-foreground" data-testid="run-progress-count">
                      {completed} / {rows.length}
                    </span>
                  </div>
                  {!collapsed && rows.length > 0 && (
                    <>
                      <Progress value={(settled / rows.length) * 100} className="h-2 mt-2 mb-3" />
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {rows.map(uc => (
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
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* Delete Feedback */}
          {deleteState.message && (
            <div className={`flex items-center gap-2 text-sm mb-3 p-2 rounded-lg ${
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

          {/* Runs — chart + filter pills + compact table */}
          {filteredRuns.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <Play size={40} className="mb-3 opacity-20" />
                <p className="text-base font-medium">
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
            <>
              <div className="mb-2">
                <BenchmarkPassRateChart
                  series={passRateSeries}
                  activeAgentKeys={activeAgentKeys}
                  onToggleAgent={(agentKey, label) => handleToggleFilter({ field: 'agent', value: agentKey, label })}
                />
              </div>
              <RunFilterPills
                filters={runFilters}
                onRemove={f => setRunFilters(prev => removeRunFilter(prev, f))}
                onClear={() => setRunFilters([])}
                shown={visibleRows.length}
                total={allRows.length}
              />
              <BenchmarkRunsTable
                rows={visibleRows}
                filters={runFilters}
                onToggleFilter={handleToggleFilter}
                sort={runSort}
                onSort={handleSort}
                benchmarkId={benchmark.id}
                currentVersion={benchmark.currentVersion}
                latestRunId={runVersionFilter === 'all' ? latestRunId(filteredRuns) : null}
                selectable={hasMultipleRuns}
                selectedRunIds={selectedRunIds}
                onToggleSelect={toggleRunSelection}
                onOpenRun={runId => navigate(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`)}
                onOpenEvaluator={evaluatorId => navigate(`/evaluators/${evaluatorId}`)}
                onDelete={row => handleDeleteRun(row.run)}
                deletingId={deleteState.isDeleting ? deleteState.deletingId : null}
                onCancel={row => handleCancelRow(row.run)}
                isCancelling={runId => isCancelling(runId) || cancellingEvalRunId === runId}
                testCases={benchmarkTestCases}
                reportsById={reportSummaries}
                onSelectCase={testCaseId => navigate(`/evaluations/benchmarks/${benchmark.id}/cases/${testCaseId}`)}
                expandedRunIds={expandedRunIds}
                onToggleExpand={handleToggleExpand}
              />
            </>
          )}

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
            <p className="text-xs text-muted-foreground text-center mt-2">Add more runs to enable comparison</p>
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
            <div className="flex items-center justify-between mb-2 shrink-0">
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
            {/*
              data-[state=inactive]:hidden is load-bearing too: Radix hides the
              inactive panel with the `hidden` attribute, but the `flex` class
              above has higher specificity than the UA `[hidden]{display:none}`
              rule, so without it the inactive Cases panel stayed display:flex
              and its flex-1 pushed the Runs panel ~400px down the page (the
              big blank band above the runs list).
            */}
            <TabsContent value="cases" className="flex-1 min-h-0 mt-0 flex flex-col overflow-hidden max-md:overflow-visible data-[state=inactive]:hidden">{testCasesBody}</TabsContent>
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

      {/* ── Run Configuration Dialog — the shared RunConfigDialog (create
          mode). The SAME component serves Re-run (rerun mode, prepopulated
          from the source run) so the two never drift apart again. */}
      <RunConfigDialog
        mode="create"
        open={isRunConfigOpen}
        onOpenChange={setIsRunConfigOpen}
        initialValues={runConfigValues}
        benchmark={benchmark}
        onStart={handleStartRun}
      />
    </div>
  );
};
