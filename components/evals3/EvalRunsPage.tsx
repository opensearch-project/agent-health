/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * EvalRunsPage — Evals 3: Evaluation Runs (Option C — Run-Centric)
 *
 * Primary entity = benchmark run (not individual test case results).
 * Two view modes: Flat table or Grouped by Benchmark.
 * Default: Grouped by Benchmark.
 * Click a run row → navigates to BenchmarkRunDetailPage.
 * Agent Traces-style filter bar.
 * Route: /evaluations/runs
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { usePersistedSet } from '@/hooks/usePersistedSet';
import { PREFS_KEYS } from '@/lib/preferences';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2, XCircle, Loader2, Clock, Search, RefreshCw,
  Activity, BarChart3, SlidersHorizontal, ChevronDown, ChevronRight,
  Layers, List, GitCompare, AlertTriangle, TrendingDown, Target, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { asyncBenchmarkStorage, asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { Benchmark, TestCase, BenchmarkRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatRelativeTime, getModelName } from '@/lib/utils';
import { Breadcrumbs } from './Breadcrumbs';

// ─── Time Filter ─────────────────────────────────────────────────────────────

type TimeRange = '1h' | '6h' | '1d' | '7d' | '30d' | 'all';
const TIME_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'Last 1h' },
  { value: '6h', label: 'Last 6h' },
  { value: '1d', label: 'Last 1d' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
  { value: 'all', label: 'All time' },
];
function getTimeThreshold(range: TimeRange): Date | null {
  if (range === 'all') return null;
  const ms: Record<string, number> = { '1h': 3600000, '6h': 21600000, '1d': 86400000, '7d': 604800000, '30d': 2592000000 };
  return new Date(Date.now() - ms[range]);
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ViewMode = 'flat' | 'grouped';

/** One benchmark run with its parent benchmark context */
interface RunRow {
  run: BenchmarkRun;
  benchmarkId: string;
  benchmarkName: string;
  agentName: string;
  passed: number;
  failed: number;
  total: number;
}

function SortHeader({ label, active, dir, onClick, className }: {
  label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; className?: string;
}) {
  return (
    <th
      className={`h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${className || ''}`}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <ChevronDown size={10} className={dir === 'asc' ? 'rotate-180' : ''} />}
      </span>
    </th>
  );
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeRunStats(run: BenchmarkRun): { passed: number; failed: number; total: number } {
  if (run.stats && run.stats.total > 0) {
    return { passed: run.stats.passed, failed: run.stats.failed, total: run.stats.total };
  }
  const results = Object.values(run.results || {});
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'completed') passed++;
    else if (r.status === 'failed' || r.status === 'cancelled') failed++;
  }
  const total = results.length;
  return { passed, failed, total };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const EvalRunsPage: React.FC = () => {
  const navigate = useNavigate();

  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters (persisted)
  const [search, setSearch] = usePersistedState<string>('eval-runs:search', '');
  const [timeRange, setTimeRange] = usePersistedState<TimeRange>(PREFS_KEYS.timeRange, '30d');
  const [selectedAgent, setSelectedAgent] = usePersistedState(PREFS_KEYS.agentFilter, 'all');

  // View (persisted)
  const [viewMode, setViewMode] = usePersistedState<ViewMode>(PREFS_KEYS.viewMode, 'flat');
  const [collapsedGroups, setCollapsedGroups] = usePersistedSet<string>('eval-runs:collapsedGroups');
  const [sort, setSort] = usePersistedState<{ field: string; dir: 'asc' | 'desc' }>('eval-runs:sort', { field: 'timestamp', dir: 'desc' });
  const [showRegressionsOnly, setShowRegressionsOnly] = usePersistedState('eval-runs:showRegressionsOnly', false);

  // Advanced filters (persisted)
  const [filterStatus, setFilterStatus] = usePersistedState<'all' | 'passed' | 'failed' | 'mixed'>('eval-runs:filterStatus', 'all');
  const [filterBenchmarks, setFilterBenchmarks] = usePersistedSet<string>('eval-runs:filterBenchmarks');
  const [filterModels, setFilterModels] = usePersistedSet<string>('eval-runs:filterModels');
  const [filterPassRateMin, setFilterPassRateMin] = usePersistedState<number>('eval-runs:filterPassRateMin', 0);
  const [filterPassRateMax, setFilterPassRateMax] = usePersistedState<number>('eval-runs:filterPassRateMax', 100);
  const [filterOpen, setFilterOpen] = useState(false);

  // Scroll
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Compare selection
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());

  // Annotation counts: runId → { totalAnnotations, testCasesWithAnnotations, firstTestCaseId }
  const [annotationMap, setAnnotationMap] = useState<Map<string, { total: number; tcCount: number; firstTcId: string }>>(new Map());

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const bms = await asyncBenchmarkStorage.getAll();
      setBenchmarks(bms);
    } catch (err) {
      console.error('Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = () => setIsScrolled(el.scrollTop > 10);
    el.addEventListener('scroll', h);
    return () => el.removeEventListener('scroll', h);
  }, []);

  // Agent options
  const agentOptions = useMemo(() => {
    const agents = DEFAULT_CONFIG.agents.filter(a => a.enabled !== false).map(a => ({ value: a.key, label: a.name }));
    return [{ value: 'all', label: 'All Agents' }, ...agents];
  }, []);

  // Derive flat run rows from benchmark data
  const allRunRows = useMemo<RunRow[]>(() => {
    const threshold = getTimeThreshold(timeRange);
    const rows: RunRow[] = [];

    for (const bm of benchmarks) {
      for (const run of bm.runs || []) {
        if (threshold && new Date(run.createdAt) < threshold) continue;
        if (selectedAgent !== 'all' && run.agentKey !== selectedAgent) continue;

        const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey || 'Unknown';

        if (search) {
          const q = search.toLowerCase();
          if (
            !(run.name ?? '').toLowerCase().includes(q) &&
            !(run.id ?? '').toLowerCase().includes(q) &&
            !(bm.name ?? '').toLowerCase().includes(q) &&
            !agentName.toLowerCase().includes(q)
          ) continue;
        }

        const stats = computeRunStats(run);
        rows.push({
          run,
          benchmarkId: bm.id,
          benchmarkName: bm.name,
          agentName,
          ...stats,
        });
      }
    }

    return rows;
  }, [benchmarks, timeRange, selectedAgent, search]);

  // Available filter options (derived from data)
  const availableBenchmarks = useMemo(() => {
    const bms = new Map<string, string>();
    for (const rr of allRunRows) bms.set(rr.benchmarkId, rr.benchmarkName);
    return Array.from(bms.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allRunRows]);

  const availableModels = useMemo(() => {
    const models = new Set<string>();
    for (const rr of allRunRows) models.add(getModelName(rr.run.modelId));
    return Array.from(models).sort();
  }, [allRunRows]);

  // Apply advanced filters
  const filteredRunRows = useMemo(() => {
    let rows = allRunRows;

    // Status filter
    if (filterStatus !== 'all') {
      rows = rows.filter(rr => {
        const allPassed = rr.failed === 0 && rr.passed > 0;
        const allFailed = rr.passed === 0 && rr.failed > 0;
        if (filterStatus === 'passed') return allPassed;
        if (filterStatus === 'failed') return rr.failed > 0;
        if (filterStatus === 'mixed') return rr.passed > 0 && rr.failed > 0;
        return true;
      });
    }

    // Benchmark filter
    if (filterBenchmarks.size > 0) {
      rows = rows.filter(rr => filterBenchmarks.has(rr.benchmarkId));
    }

    // Model filter
    if (filterModels.size > 0) {
      rows = rows.filter(rr => filterModels.has(getModelName(rr.run.modelId)));
    }

    // Pass rate range
    if (filterPassRateMin > 0 || filterPassRateMax < 100) {
      rows = rows.filter(rr => {
        const rate = rr.total > 0 ? Math.round((rr.passed / rr.total) * 100) : 0;
        return rate >= filterPassRateMin && rate <= filterPassRateMax;
      });
    }

    // Regression filter applied separately in table rendering

    return rows;
  }, [allRunRows, filterStatus, filterBenchmarks, filterModels, filterPassRateMin, filterPassRateMax]);

  const activeFilterCount = (filterStatus !== 'all' ? 1 : 0) + (filterBenchmarks.size > 0 ? 1 : 0) + (filterModels.size > 0 ? 1 : 0) + ((filterPassRateMin > 0 || filterPassRateMax < 100) ? 1 : 0);

  const clearAllFilters = () => {
    setFilterStatus('all');
    setFilterBenchmarks(new Set());
    setFilterModels(new Set());
    setFilterPassRateMin(0);
    setFilterPassRateMax(100);
    setShowRegressionsOnly(false);
  };

  // Summary metrics (use filteredRunRows for display)
  const totalRuns = filteredRunRows.length;
  const totalTestCases = filteredRunRows.reduce((sum, r) => sum + r.total, 0);
  const totalPassed = filteredRunRows.reduce((sum, r) => sum + r.passed, 0);
  const overallPassRate = totalTestCases > 0 ? Math.round((totalPassed / totalTestCases) * 100) : 0;

  // Avg accuracy — placeholder (would need report-level accuracy data)
  // For now, compute from pass rate per run as a proxy
  const avgAccuracy = totalRuns > 0
    ? Math.round(filteredRunRows.reduce((sum, r) => sum + (r.total > 0 ? (r.passed / r.total) * 100 : 0), 0) / totalRuns)
    : 0;

  // Load annotation counts lazily for visible runs only (avoids N+1 on mount)
  const loadedAnnotationRuns = useRef(new Set<string>());

  useEffect(() => {
    if (benchmarks.length === 0) return;

    const toLoad: { runId: string; run: any; bmId: string }[] = [];
    for (const rr of filteredRunRows.slice(0, 100)) {
      if (loadedAnnotationRuns.current.has(rr.run.id)) continue;
      toLoad.push({ runId: rr.run.id, run: rr.run, bmId: rr.benchmarkId });
    }
    if (toLoad.length === 0) return;

    let cancelled = false;

    // Load in batches of 10 to limit concurrency
    (async () => {
      const BATCH_SIZE = 10;
      for (let i = 0; i < toLoad.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = toLoad.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async ({ runId, run }) => {
          let totalAnnotations = 0;
          let tcWithAnnotations = 0;
          let firstTcId = '';
          for (const [tcId, result] of Object.entries(run.results || {} as Record<string, any>)) {
            if (!(result as any).reportId) continue;
            try {
              const report = await asyncRunStorage.getReportById((result as any).reportId);
              if (report?.annotations && report.annotations.length > 0) {
                totalAnnotations += report.annotations.length;
                tcWithAnnotations++;
                if (!firstTcId) firstTcId = tcId;
              }
            } catch { /* skip */ }
          }
          return { runId, total: totalAnnotations, tcCount: tcWithAnnotations, firstTcId };
        }));

        if (cancelled) return;
        setAnnotationMap(prev => {
          const next = new Map(prev);
          for (const r of batchResults) {
            loadedAnnotationRuns.current.add(r.runId);
            if (r.total > 0) next.set(r.runId, { total: r.total, tcCount: r.tcCount, firstTcId: r.firstTcId });
          }
          return next;
        });
      }
    })();

    return () => { cancelled = true; };
  }, [filteredRunRows, benchmarks]);

  // Regressions — computed after groupedByBenchmark

  // Sort
  const sortRows = useCallback((rows: RunRow[]) => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sort.field) {
        case 'runId': return dir * a.run.name.localeCompare(b.run.name);
        case 'benchmark': return dir * a.benchmarkName.localeCompare(b.benchmarkName);
        case 'agent': return dir * a.agentName.localeCompare(b.agentName);
        case 'timestamp': return dir * (new Date(a.run.createdAt).getTime() - new Date(b.run.createdAt).getTime());
        case 'results': return dir * (a.total - b.total);
        default: return 0;
      }
    });
  }, [sort]);

  const handleSort = (field: string) => {
    setSort(prev => prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'desc' });
  };

  const toggleGroup = (id: string) => {
    setCollapsedGroups(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  // Compare selection helpers
  const MAX_COMPARE = 10;

  const toggleRunSelection = (runId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedRuns(prev => {
      const n = new Set(prev);
      if (n.has(runId)) {
        n.delete(runId);
      } else {
        if (n.size >= MAX_COMPARE) return prev; // cap at 10
        n.add(runId);
      }
      return n;
    });
  };

  const atLimit = selectedRuns.size >= MAX_COMPARE;

  // Check if selected runs span multiple benchmarks
  const isMultiBenchmark = useMemo(() => {
    if (selectedRuns.size < 2) return false;
    const benchmarkIds = new Set(allRunRows.filter(rr => selectedRuns.has(rr.run.id)).map(rr => rr.benchmarkId));
    return benchmarkIds.size > 1;
  }, [selectedRuns, allRunRows]);

  // Toggle all runs in a benchmark group (bypasses individual limit)
  const toggleBenchmarkSelection = (groupRunIds: string[], e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedRuns(prev => {
      const n = new Set(prev);
      const allSelected = groupRunIds.every(id => n.has(id));
      if (allSelected) {
        groupRunIds.forEach(id => n.delete(id));
      } else {
        groupRunIds.forEach(id => n.add(id));
      }
      return n;
    });
  };

  // Grouped by benchmark
  const groupedByBenchmark = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; rows: RunRow[] }>();
    for (const rr of filteredRunRows) {
      if (!groups.has(rr.benchmarkId)) groups.set(rr.benchmarkId, { id: rr.benchmarkId, name: rr.benchmarkName, rows: [] });
      groups.get(rr.benchmarkId)!.rows.push(rr);
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredRunRows]);

  // Regressions — count benchmarks where latest run is worse than previous
  const regressionData = useMemo(() => {
    const regressionRunIds = new Set<string>();
    for (const group of groupedByBenchmark) {
      if (group.rows.length < 2) continue;
      const sorted = [...group.rows].sort((a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime());
      const latest = sorted[0];
      const previous = sorted[1];
      const latestRate = latest.total > 0 ? latest.passed / latest.total : 0;
      const prevRate = previous.total > 0 ? previous.passed / previous.total : 0;
      if (latestRate < prevRate) regressionRunIds.add(latest.run.id);
    }
    return { count: regressionRunIds.size, runIds: regressionRunIds };
  }, [groupedByBenchmark]);
  const regressionCountReal = regressionData.count;

  // Render a run row
  const renderRunRow = (rr: RunRow, showBenchmark: boolean) => {
    const isAllPassed = rr.failed === 0 && rr.passed > 0;
    const isChecked = selectedRuns.has(rr.run.id);
    return (
      <tr
        key={`${rr.benchmarkId}-${rr.run.id}`}
        className={`border-b hover:bg-muted/50 cursor-pointer transition-colors ${isChecked ? 'bg-primary/5' : ''}`}
        onClick={() => navigate(`/evaluations/benchmarks/${rr.benchmarkId}/runs/${rr.run.id}/inspect`)}
      >
        <td className="px-2 py-1.5 align-middle text-center w-8" onClick={e => e.stopPropagation()}>
          <button
            onClick={e => toggleRunSelection(rr.run.id, e)}
            disabled={!isChecked && atLimit}
            className={`h-4 w-4 rounded border-2 flex items-center justify-center transition-colors shrink-0
              ${isChecked
                ? 'bg-primary border-primary text-primary-foreground'
                : atLimit
                  ? 'border-muted-foreground/20 bg-muted/30 cursor-not-allowed'
                  : 'border-muted-foreground/40 hover:border-muted-foreground/70 bg-transparent cursor-pointer'
              }`}
            aria-label={isChecked ? 'Deselect run' : 'Select run for comparison'}
          >
            {isChecked && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0">
                <path d="M2 5L4.5 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </td>
        <td className="px-2 py-1.5 align-middle text-center w-8">
          {isAllPassed
            ? <CheckCircle2 size={12} className="text-green-500" />
            : rr.failed > 0
              ? <XCircle size={12} className="text-red-500" />
              : <Clock size={12} className="text-muted-foreground" />}
        </td>
        <td className="px-2 py-1.5 align-middle">
          <div className="text-xs font-medium">{rr.run.name}</div>
          <div className="text-[9px] text-muted-foreground font-mono">{rr.run.id.slice(0, 8)}</div>
        </td>
        {showBenchmark && (
          <td className="px-2 py-1.5 align-middle">
            <button
              className="text-[10px] text-purple-600 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300 hover:underline transition-colors"
              onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${rr.benchmarkId}/runs`); }}
            >
              {rr.benchmarkName}
            </button>
          </td>
        )}
        <td className="px-2 py-1.5 align-middle text-[11px]">{rr.agentName}</td>
        <td className="px-2 py-1.5 align-middle text-[11px]">{getModelName(rr.run.modelId)}</td>
        <td className="px-2 py-1.5 align-middle text-[10px] text-muted-foreground whitespace-nowrap">{formatRelativeTime(rr.run.createdAt)}</td>
        <td className="px-2 py-1.5 align-middle text-center">
          {(() => {
            const ann = annotationMap.get(rr.run.id);
            if (ann && ann.total > 0) {
              return (
                <button
                  className="text-[10px] text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 hover:underline"
                  onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${rr.benchmarkId}/runs/${rr.run.id}/inspect`); }}
                >
                  {ann.total} in {ann.tcCount} TC{ann.tcCount !== 1 ? 's' : ''}
                </button>
              );
            }
            return <span className="text-[10px] text-muted-foreground">—</span>;
          })()}
        </td>
        <td className="px-2 py-1.5 align-middle text-right">
          <div className="inline-flex items-center gap-1 text-[11px]">
            <span className="text-green-500 font-medium">{rr.passed}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-red-500 font-medium">{rr.failed}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">{rr.total}</span>
          </div>
        </td>
      </tr>
    );
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/benchmarks' },
          { label: 'Runs' },
        ]}
        actions={<>
          <div className="w-[200px] relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search runs..." value={search} onChange={e => setSearch(e.target.value)} className="pl-7 h-7 text-xs md:text-xs" />
          </div>
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={`h-7 gap-1.5 text-xs font-normal ${activeFilterCount > 0 ? 'border-primary/50 text-foreground' : ''}`}>
                <SlidersHorizontal size={12} /> Filter{activeFilterCount > 0 && ` (${activeFilterCount})`}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-3" align="start">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Filters</span>
                  {activeFilterCount > 0 && (
                    <button className="text-[10px] text-muted-foreground hover:text-foreground underline" onClick={clearAllFilters}>Clear all</button>
                  )}
                </div>

                {/* Status */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">Status</label>
                  <div className="flex gap-1 flex-wrap">
                    {(['all', 'passed', 'failed', 'mixed'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setFilterStatus(s)}
                        className={`px-2 py-1 text-[10px] rounded-md border transition-colors ${
                          filterStatus === s ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'
                        }`}
                      >
                        {s === 'all' ? 'All' : s === 'passed' ? '✓ Passed' : s === 'failed' ? '✗ Failed' : '◐ Mixed'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Benchmark */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">Benchmark</label>
                  <div className="max-h-24 overflow-y-auto space-y-0.5">
                    {availableBenchmarks.map(bm => (
                      <label key={bm.id} className="flex items-center gap-1.5 text-[11px] cursor-pointer hover:bg-muted/50 px-1 py-0.5 rounded">
                        <input
                          type="checkbox"
                          checked={filterBenchmarks.has(bm.id)}
                          onChange={() => {
                            setFilterBenchmarks(prev => {
                              const n = new Set(prev);
                              n.has(bm.id) ? n.delete(bm.id) : n.add(bm.id);
                              return n;
                            });
                          }}
                          className="h-3 w-3 rounded"
                        />
                        <span className="truncate">{bm.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Model */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">Model</label>
                  <div className="max-h-24 overflow-y-auto space-y-0.5">
                    {availableModels.map(model => (
                      <label key={model} className="flex items-center gap-1.5 text-[11px] cursor-pointer hover:bg-muted/50 px-1 py-0.5 rounded">
                        <input
                          type="checkbox"
                          checked={filterModels.has(model)}
                          onChange={() => {
                            setFilterModels(prev => {
                              const n = new Set(prev);
                              n.has(model) ? n.delete(model) : n.add(model);
                              return n;
                            });
                          }}
                          className="h-3 w-3 rounded"
                        />
                        <span className="truncate">{model}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Pass Rate Range */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">Pass Rate Range</label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number" min={0} max={100} value={filterPassRateMin}
                      onChange={e => setFilterPassRateMin(Math.max(0, Math.min(100, Number(e.target.value))))}
                      className="h-6 w-16 text-[10px] text-center"
                    />
                    <span className="text-[10px] text-muted-foreground">to</span>
                    <Input
                      type="number" min={0} max={100} value={filterPassRateMax}
                      onChange={e => setFilterPassRateMax(Math.max(0, Math.min(100, Number(e.target.value))))}
                      className="h-6 w-16 text-[10px] text-center"
                    />
                    <span className="text-[10px] text-muted-foreground">%</span>
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Select value={selectedAgent} onValueChange={setSelectedAgent}>
            <SelectTrigger className="w-[120px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {agentOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={timeRange} onValueChange={v => setTimeRange(v as TimeRange)}>
            <SelectTrigger className="w-[85px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* View mode toggle (Grouped first — default mental model) */}
          <div className="flex items-center border border-border rounded-md overflow-hidden h-7" data-testid="viewmode-toggle">
            <button data-testid="viewmode-grouped" onClick={() => setViewMode('grouped')} className={`px-2 h-full text-xs flex items-center gap-1 transition-colors ${viewMode === 'grouped' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <Layers size={11} /> Grouped
            </button>
            <button data-testid="viewmode-flat" onClick={() => setViewMode('flat')} className={`px-2 h-full text-xs flex items-center gap-1 transition-colors ${viewMode === 'flat' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <List size={11} /> Flat
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="h-7">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
          {(() => {
            const selectedRows = allRunRows.filter(rr => selectedRuns.has(rr.run.id));
            const benchmarkIds = new Set(selectedRows.map(rr => rr.benchmarkId));
            const multiBenchmark = benchmarkIds.size > 1;
            return (
              <Button
                variant="outline"
                size="sm"
                className={`h-7 gap-1.5 text-xs ${selectedRuns.size > 0 ? 'border-primary/50' : ''}`}
                disabled={multiBenchmark || selectedRuns.size < 1}
                onClick={() => {
                  if (multiBenchmark || selectedRuns.size < 1) return;
                  const bmId = [...benchmarkIds][0];
                  const ids = selectedRows.map(rr => rr.run.id).join(',');
                  navigate(`/compare/${bmId}?runs=${ids}`);
                }}
                title={multiBenchmark ? 'Select runs from a single benchmark to compare' : selectedRuns.size < 1 ? 'Select at least one run to compare' : 'Compare runs'}
              >
                <GitCompare size={12} />
                Compare
                {multiBenchmark && <span className="text-amber-500 text-[9px]">⚠</span>}
              </Button>
            );
          })()}
        </>}
      />
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">Evaluation Runs</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">Benchmark runs across all evaluations</p>
        </div>
        <TooltipProvider delayDuration={200}>
        <div className="flex items-center gap-6 text-xs">
          <div className="flex items-center gap-1.5">
            <Activity size={13} className="text-blue-500" />
            <span className="font-semibold">{totalRuns}</span>
            <span className="text-muted-foreground">runs</span>
          </div>
          <div className="flex items-center gap-1.5">
            <CheckCircle2 size={13} className="text-green-500" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-semibold border-b border-dotted border-muted-foreground/50 cursor-default">{overallPassRate}%</span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Passed {totalPassed}/{totalTestCases} test cases</TooltipContent>
            </Tooltip>
            <span className="text-muted-foreground">pass rate</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Target size={13} className="text-purple-500" />
            <span className="font-semibold">{avgAccuracy}%</span>
            <span className="text-muted-foreground">avg accuracy</span>
          </div>
          <button
            className={`flex items-center gap-1.5 ${regressionCountReal > 0 ? 'cursor-pointer' : ''}`}
            onClick={() => regressionCountReal > 0 && setShowRegressionsOnly(!showRegressionsOnly)}
          >
            <TrendingDown size={13} className={regressionCountReal > 0 ? 'text-red-500' : 'text-green-500'} />
            <span className={`font-semibold ${regressionCountReal > 0 ? 'text-red-500' : 'text-green-500'}`}>
              {regressionCountReal}
            </span>
            <span className={`text-muted-foreground ${regressionCountReal > 0 ? 'underline decoration-dotted' : ''}`}>
              regressions{showRegressionsOnly ? ' (filtered)' : ''}
            </span>
          </button>
        </div>
        </TooltipProvider>
      </div>

      {/* ── Multi-benchmark warning banner ──────────────────────────── */}
      {isMultiBenchmark && (
        <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 text-xs">
          <AlertTriangle size={14} className="shrink-0" />
          <span>Compare requires runs from the same benchmark. Deselect runs from other benchmarks or use "Group by Benchmark" to select within one.</span>
          <button
            className="ml-auto text-[10px] underline text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 shrink-0"
            onClick={() => setSelectedRuns(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* ── Active Filter Pills ──────────────────────────────────── */}
      {activeFilterCount > 0 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          <span className="text-[10px] text-muted-foreground">Active filters:</span>
          {filterStatus !== 'all' && (
            <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
              Status: {filterStatus}
              <button onClick={() => setFilterStatus('all')} className="hover:text-foreground"><X size={10} /></button>
            </Badge>
          )}
          {filterBenchmarks.size > 0 && (
            <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
              {filterBenchmarks.size} benchmark{filterBenchmarks.size > 1 ? 's' : ''}
              <button onClick={() => setFilterBenchmarks(new Set())} className="hover:text-foreground"><X size={10} /></button>
            </Badge>
          )}
          {filterModels.size > 0 && (
            <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
              {filterModels.size} model{filterModels.size > 1 ? 's' : ''}
              <button onClick={() => setFilterModels(new Set())} className="hover:text-foreground"><X size={10} /></button>
            </Badge>
          )}
          {(filterPassRateMin > 0 || filterPassRateMax < 100) && (
            <Badge variant="secondary" className="text-[9px] gap-1 px-1.5 py-0">
              Pass rate: {filterPassRateMin}–{filterPassRateMax}%
              <button onClick={() => { setFilterPassRateMin(0); setFilterPassRateMax(100); }} className="hover:text-foreground"><X size={10} /></button>
            </Badge>
          )}
          <button className="text-[9px] text-muted-foreground hover:text-foreground underline ml-1" onClick={clearAllFilters}>Clear all</button>
        </div>
      )}

      {/* ── Inline Metrics Bar (view toggle moved into header) ── */}
      <div className="flex items-center justify-end mb-2">
        <span className="text-[10px] text-muted-foreground">{totalRuns} run{totalRuns !== 1 ? 's' : ''}</span>
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-lg border border-border">
        <table className="w-full caption-bottom text-sm">
          <thead className={`sticky top-0 z-10 bg-background transition-shadow duration-200 ${isScrolled ? 'shadow-sm' : ''}`}>
            <tr className="border-b">
              <th className="h-7 w-8 px-2 align-middle bg-background border-b" />
              <th className="h-7 w-8 px-2 align-middle bg-background border-b" />
              <SortHeader label="Run" active={sort.field === 'runId'} dir={sort.dir} onClick={() => handleSort('runId')} />
              {viewMode === 'flat' && (
                <SortHeader label="Benchmark" active={sort.field === 'benchmark'} dir={sort.dir} onClick={() => handleSort('benchmark')} />
              )}
              <SortHeader label="Agent" active={sort.field === 'agent'} dir={sort.dir} onClick={() => handleSort('agent')} />
              <th className="h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Model</th>
              <SortHeader label="Timestamp" active={sort.field === 'timestamp'} dir={sort.dir} onClick={() => handleSort('timestamp')} />
              <th className="h-7 px-2 text-center align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Annotations</th>
              <SortHeader label="Pass/Fail/Total" active={sort.field === 'results'} dir={sort.dir} onClick={() => handleSort('results')} className="text-right" />
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {filteredRunRows.length === 0 ? (
              <tr>
                <td colSpan={viewMode === 'flat' ? 9 : 8} className="py-16 text-center text-sm text-muted-foreground">
                  {activeFilterCount > 0 ? 'No runs match the current filters' : timeRange === 'all' ? 'No evaluation runs found' : `No runs in ${TIME_OPTIONS.find(o => o.value === timeRange)?.label}`}
                </td>
              </tr>
            ) : viewMode === 'flat' ? (
              sortRows(showRegressionsOnly ? filteredRunRows.filter(rr => regressionData.runIds.has(rr.run.id)) : filteredRunRows).map(rr => renderRunRow(rr, true))
            ) : (
              groupedByBenchmark.map(group => {
                const isCollapsed = collapsedGroups.has(group.id);
                const sorted = sortRows(group.rows);
                const groupPassed = group.rows.filter(r => r.failed === 0 && r.passed > 0).length;
                const groupRunIds = group.rows.map(r => r.run.id);
                const allGroupSelected = groupRunIds.length > 0 && groupRunIds.every(id => selectedRuns.has(id));
                const someGroupSelected = groupRunIds.some(id => selectedRuns.has(id));
                return (
                  <React.Fragment key={group.id}>
                    <tr
                      className="border-b cursor-pointer hover:bg-muted/30 transition-colors bg-purple-50 dark:bg-purple-500/5"
                      onClick={() => toggleGroup(group.id)}
                    >
                      {/* Checkbox cell — aligns with run row checkboxes */}
                      <td className="px-2 py-1.5 align-middle text-center w-8" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={e => toggleBenchmarkSelection(groupRunIds, e)}
                          className={`h-4 w-4 rounded border-2 flex items-center justify-center transition-colors shrink-0
                            ${allGroupSelected
                              ? 'bg-primary border-primary text-primary-foreground'
                              : someGroupSelected
                                ? 'bg-primary/40 border-primary/60 text-primary-foreground'
                                : 'border-muted-foreground/40 hover:border-muted-foreground/70 bg-transparent cursor-pointer'
                            }`}
                          aria-label={allGroupSelected ? 'Deselect all runs in benchmark' : 'Select all runs in benchmark'}
                        >
                          {allGroupSelected ? (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0">
                              <path d="M2 5L4.5 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : someGroupSelected ? (
                            <div className="w-2 h-0.5 bg-current rounded-full" />
                          ) : null}
                        </button>
                      </td>
                      {/* Rest of group header content */}
                      <td colSpan={7} className="px-1 py-1.5 align-middle">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                          </span>
                          <Badge className="text-[9px] px-1 py-0 bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/30 font-semibold uppercase tracking-wider">
                            Benchmark
                          </Badge>
                          <span className="text-xs font-semibold">{group.name}</span>
                          <span className="text-[10px] text-muted-foreground">({group.rows.length} run{group.rows.length !== 1 ? 's' : ''})</span>
                          <span className="text-[10px] text-muted-foreground">{groupPassed}/{group.rows.length} all passed</span>
                        </div>
                      </td>
                    </tr>
                    {!isCollapsed && sorted.map(rr => renderRunRow(rr, false))}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
