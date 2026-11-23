/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * BenchmarksPage4 — Evals 3: Benchmarks
 *
 * Two tabs:
 *   Tab 1 "Benchmarks" — leaderboard with trend columns, summary cards, last run link
 *   Tab 2 "Runs" — flattened test case results (click → run detail)
 *
 * Agent Traces-style filter bar + sticky table headers + sortable columns.
 * Global time filter in header scopes everything.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { PREFS_KEYS } from '@/lib/preferences';
import { markPageReady } from '@/lib/pageLatency';
import { useNavigate } from 'react-router-dom';
import {
  Play, CheckCircle2, XCircle, Loader2, Clock, Search, X, RefreshCw,
  Activity, BarChart3, Layers, TrendingUp, TrendingDown, Minus, AlertTriangle,
  SlidersHorizontal, ChevronDown, Upload, Plus, Pencil,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { executeBenchmarkRun } from '@/services/client';
import { Benchmark, BenchmarkRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/utils';
import { summarizeRunsByAgent, AgentRunSummary, TrendDir } from '@/lib/benchmarkAgentSummary';
import { BenchmarkEditor, RunConfigForExecution } from '@/components/BenchmarkEditor';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

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
  const now = new Date();
  const ms: Record<string, number> = { '1h': 3600000, '6h': 21600000, '1d': 86400000, '7d': 604800000, '30d': 2592000000 };
  return new Date(now.getTime() - ms[range]);
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

function TrendBadge({ trend }: { trend: TrendDir }) {
  const config: Record<TrendDir, { icon: React.ReactNode; label: string; cls: string }> = {
    improving: { icon: <TrendingUp size={12} />, label: 'Improving', cls: 'text-green-600 dark:text-green-400' },
    stable: { icon: <Minus size={12} />, label: 'Stable', cls: 'text-muted-foreground' },
    regressing: { icon: <TrendingDown size={12} />, label: 'Regressing', cls: 'text-red-600 dark:text-red-400' },
    unknown: { icon: <Minus size={12} />, label: '—', cls: 'text-muted-foreground' },
  };
  const c = config[trend];
  return <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${c.cls}`} data-testid="agent-trend">{c.icon} {c.label}</span>;
}

/** Agents shown per row before the "+N more" toggle. */
const AGENT_LINES_COLLAPSED = 3;

interface BenchmarkStats {
  runCount: number;
  /** Newest run of ANY agent — drives "Last Activity" only, never a score. */
  latestRun: BenchmarkRun | null;
  /**
   * One entry per agent (agentKey + endpoint override) that ran this
   * benchmark, most recently active first. Latest result, trend and
   * sparkline are per agent — a run is only ever compared with a run of the
   * same agent (owner bug 11-18: two agents on one benchmark rendered as one
   * "latest" with a trend against the other agent's score).
   */
  agents: AgentRunSummary[];
  /** Best per-agent latest score — the "Latest Result" sort key. */
  bestLatestScore: number | null;
  /**
   * Epoch ms of the most recent activity, defined as
   * `max(latestRun.createdAt, benchmark.updatedAt)`.
   * Used for the default "Last Activity" sort so that newly created/updated
   * benchmarks (with no completed run yet) don't sink to the bottom.
   */
  lastTouched: number;
  /** Whether the most recent activity was a run completion or a benchmark mutation. */
  lastTouchedKind: 'run' | 'updated';
}

// Sort types
type BmSortField = 'name' | 'tcs' | 'runs' | 'lastTouched' | 'score';
type SortDir = 'asc' | 'desc';

/** Tiny inline sparkline for pass rate trend */
function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-[9px] text-muted-foreground">—</span>;
  const max = 100;
  const w = 48;
  const h = 16;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  const lastVal = values[values.length - 1];
  const prevVal = values[values.length - 2];
  const color = lastVal >= prevVal ? '#22c55e' : '#ef4444';
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SortHeader({ label, active, dir, onClick, className }: {
  label: string; active: boolean; dir: SortDir; onClick: () => void; className?: string;
}) {
  return (
    <th
      className={`h-8 px-3 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${className || ''}`}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <ChevronDown size={10} className={dir === 'asc' ? 'rotate-180' : ''} />}
      </span>
    </th>
  );
}


// ─── Main Component ──────────────────────────────────────────────────────────

export const BenchmarksPage4: React.FC = () => {
  const navigate = useNavigate();
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = usePersistedState<string>('benchmarks:search', '');
  const [timeRange, setTimeRange] = usePersistedState<TimeRange>(PREFS_KEYS.timeRange, 'all');
  const [selectedAgent, setSelectedAgent] = usePersistedState<string>(PREFS_KEYS.agentFilter, 'all');
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Editor/Import state — the editor opens in *create* mode when
  // editingBenchmark === null and *edit* mode otherwise. Edit is exposed BOTH
  // on the list page (row pencil) AND on the benchmark detail page (header
  // button) so users have parity wherever they happen to be looking; the row
  // pencil is for power-users who want to bulk-curate without navigating into
  // each benchmark, the detail-page button is for users already viewing a
  // specific benchmark's runs.
  const [showEditor, setShowEditor] = useState(false);
  const [editingBenchmark, setEditingBenchmark] = useState<Benchmark | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [showSampleData, setShowSampleData] = useState<boolean | undefined>(undefined);

  // Sort state for Benchmarks tab
  // NOTE: storage key bumped from 'benchmarks:sort' to 'benchmarks:sort:v2' so that
  //       users with a saved 'runs'-desc preference pick up the new "Last Activity"
  //       default. Existing manual choices (e.g. sort by Name) are reset; this is an
  //       intentional one-time migration tied to the bug fix that introduced lastTouched.
  const [bmSort, setBmSort] = usePersistedState<{ field: BmSortField; dir: SortDir }>('benchmarks:sort:v2', { field: 'lastTouched', dir: 'desc' });

  const loadData = useCallback(async () => {
    try {
      // Only the benchmark list is needed here. This used to ALSO fetch every
      // test case in full (`asyncTestCaseStorage.getAll()` without `summary`)
      // into a `tcMap` nobody read — on a corpus with a few hundred
      // ~400 KB `sourceCode` cases that was a 200+ MB response the page's
      // loading state waited on, so Benchmarks "never opened" over a slow
      // link (#591). Anything that needs test-case details for a benchmark
      // fetches them per benchmark on the detail pages.
      const bms = await asyncBenchmarkStorage.getAll({ includeSample: showSampleData === true ? true : undefined });
      setBenchmarks(bms);
    } catch (err) {
      console.error('Failed to load:', err);
    } finally {
      setLoading(false);
      markPageReady('benchmarks');
    }
  }, [showSampleData]);

  useEffect(() => { loadData(); }, [loadData]);

  // Scroll detection for sticky header shadow
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => setIsScrolled(el.scrollTop > 10);
    el.addEventListener('scroll', handler);
    return () => el.removeEventListener('scroll', handler);
  }, []);

  // Agent options: configured agents + any agentKey seen in a run (runs from
  // agents since removed from the config, or from another server's config,
  // used to be unfilterable). Value stays the bare agentKey because this
  // preference is shared with the Runs and Traces pages.
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of DEFAULT_CONFIG.agents) if (a.enabled !== false) seen.set(a.key, a.name);
    for (const bm of benchmarks) for (const r of bm.runs || []) {
      if (r.agentKey && !seen.has(r.agentKey)) seen.set(r.agentKey, r.agentKey);
    }
    const agents = [...seen].map(([value, label]) => ({ value, label }));
    return [{ value: 'all', label: 'All Agents' }, ...agents];
  }, [benchmarks]);
  const agentNameFor = useCallback(
    (key: string) => DEFAULT_CONFIG.agents.find(a => a.key === key)?.name || key || 'Unknown', []);

  // Time-filter + agent-filter runs
  const timeFilteredBenchmarks = useMemo(() => {
    const threshold = getTimeThreshold(timeRange);
    return benchmarks.map(bm => {
      let runs = bm.runs || [];
      if (threshold) runs = runs.filter(r => new Date(r.createdAt) >= threshold);
      if (selectedAgent !== 'all') runs = runs.filter(r => r.agentKey === selectedAgent);
      return { ...bm, runs };
    });
  }, [benchmarks, timeRange, selectedAgent]);

  // Per-benchmark stats
  const benchmarkStats = useMemo(() => {
    const map = new Map<string, BenchmarkStats>();
    for (const bm of timeFilteredBenchmarks) {
      const runs = bm.runs || [];
      const agents = summarizeRunsByAgent(runs, agentNameFor);
      const latestRun = agents[0]?.latestRun ?? null;
      // "Last Activity" = whichever is more recent: the latest run's createdAt or the
      // benchmark's own updatedAt (test cases changed, renamed, etc.). Explicitly NOT
      // createdAt — a brand-new benchmark with no runs is still "touched now" via updatedAt.
      const latestRunMs = agents[0]?.latestAt ?? 0;
      const updatedMs = bm.updatedAt ? new Date(bm.updatedAt).getTime() : 0;
      const lastTouched = Math.max(latestRunMs, updatedMs);
      const lastTouchedKind: 'run' | 'updated' = latestRunMs > updatedMs ? 'run' : 'updated';
      const latestScores = agents.map(a => a.latestScore).filter((x): x is number => x !== null);
      map.set(bm.id, {
        runCount: runs.length, latestRun, agents,
        bestLatestScore: latestScores.length > 0 ? Math.max(...latestScores) : null,
        lastTouched,
        lastTouchedKind,
      });
    }
    return map;
  }, [timeFilteredBenchmarks, agentNameFor]);

  // Summary cards. The pass-rate card averages each benchmark's latest score
  // ONLY when every run shown belongs to one agent (a single configured agent,
  // or the agent filter is set) — averaging across agents hid which agent a
  // number belonged to. With several agents it shows the agent count instead.
  const totalBenchmarks = benchmarks.length;
  const totalRuns = Array.from(benchmarkStats.values()).reduce((s, bs) => s + bs.runCount, 0);
  const distinctAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const bs of benchmarkStats.values()) for (const a of bs.agents) ids.add(a.agentId);
    return ids.size;
  }, [benchmarkStats]);
  const singleAgentView = distinctAgents <= 1;
  const allScores = Array.from(benchmarkStats.values()).map(bs => bs.bestLatestScore).filter((x): x is number => x !== null);
  const avgPassRate = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;

  // Rows whose per-agent list is expanded past AGENT_LINES_COLLAPSED.
  const [expandedAgentRows, setExpandedAgentRows] = useState<Set<string>>(() => new Set());
  const toggleAgentRows = (bmId: string) => setExpandedAgentRows(prev => {
    const next = new Set(prev);
    if (next.has(bmId)) next.delete(bmId); else next.add(bmId);
    return next;
  });

  // Filtered + sorted benchmarks
  const sortedBenchmarks = useMemo(() => {
    let list = timeFilteredBenchmarks;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(b => (b.name ?? '').toLowerCase().includes(q));
    }
    const dir = bmSort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const sa = benchmarkStats.get(a.id);
      const sb = benchmarkStats.get(b.id);
      switch (bmSort.field) {
        case 'name': return dir * a.name.localeCompare(b.name);
        case 'tcs': return dir * ((a.testCaseIds || []).length - (b.testCaseIds || []).length);
        case 'runs': return dir * ((sa?.runCount || 0) - (sb?.runCount || 0));
        case 'lastTouched': return dir * ((sa?.lastTouched || 0) - (sb?.lastTouched || 0));
        case 'score': return dir * ((sa?.bestLatestScore ?? -1) - (sb?.bestLatestScore ?? -1));
        default: return 0;
      }
    });
  }, [timeFilteredBenchmarks, search, bmSort, benchmarkStats]);

  const handleBmSort = (field: BmSortField) => {
    setBmSort(prev => prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'desc' });
  };


  // Import JSON handler
  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsImporting(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const validation = validateTestCasesArrayJson(json);
      if (!validation.valid || !validation.data) return;
      const result = await asyncTestCaseStorage.bulkCreate(validation.data);
      if (result.created > 0) {
        // Take ids directly from the bulk-create response (which now
        // includes the created records) instead of the non-existent
        // `.ids` property this used to read (always undefined — import
        // silently failed with "created IDs are unavailable" every time).
        const createdIds = result.testCases.map((tc) => tc.id);
        if (createdIds.length === 0) {
          console.error('Import succeeded but created IDs are unavailable');
          return;
        }
        const bm = await asyncBenchmarkStorage.create({
          name: file.name.replace(/\.json$/i, '') || 'Imported Benchmark',
          description: `Auto-created from import of ${result.created} test case(s)`,
          currentVersion: 1,
          versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: createdIds }],
          testCaseIds: createdIds, runs: [],
        });
        navigate(`/evaluations/benchmarks/${bm.id}`);
      }
    } catch (err) { console.error('Import failed:', err); }
    finally { setIsImporting(false); event.target.value = ''; }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="p-4 h-full flex flex-col" data-testid="benchmarks-page">
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/runs' },
          { label: 'Benchmarks' },
        ]}
        actions={<>
          {/* Search */}
          <div className="w-[200px] relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search" value={search} onChange={e => setSearch(e.target.value)}
              className="pl-7 h-7 text-xs md:text-xs" />
          </div>
          {/* Agent filter */}
          <Select value={selectedAgent} onValueChange={setSelectedAgent}>
            <SelectTrigger className="w-[120px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {agentOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* Time filter */}
          <Select value={timeRange} onValueChange={v => setTimeRange(v as TimeRange)}>
            <SelectTrigger className="w-[85px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIME_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* Import JSON */}
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isImporting} className="h-7 gap-1.5 text-xs font-normal">
            <Upload size={12} /> {isImporting ? 'Importing...' : 'Import JSON'}
          </Button>
          {/* New Benchmark */}
          <Button size="sm" onClick={() => { setEditingBenchmark(null); setEditorError(null); setShowEditor(true); }} className="h-7 gap-1.5 text-xs">
            <Plus size={12} /> New Benchmark
          </Button>
          {/* Sample data toggle */}
          {showSampleData === true ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSampleData(false)}
              className="h-7 text-xs text-muted-foreground"
            >
              Hide sample data
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSampleData(true)}
              className="h-7 text-xs text-muted-foreground"
            >
              Show sample data
            </Button>
          )}
          {/* Refresh */}
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="h-7">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        </>}
      />
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold" data-testid="benchmarks-title">Benchmarks</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">Collections of test cases to run evaluations against your agents</p>
        </div>
        <div className="flex items-center gap-6 text-xs">
          <div className="flex items-center gap-1.5">
            <Layers size={13} className="text-purple-500" />
            <span className="font-semibold">{totalBenchmarks}</span>
            <span className="text-muted-foreground">benchmarks</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Activity size={13} className="text-blue-500" />
            <span className="font-semibold">{totalRuns}</span>
            <span className="text-muted-foreground">runs</span>
          </div>
          {singleAgentView ? (
            <div className="flex items-center gap-1.5" data-testid="summary-avg-pass-rate">
              <BarChart3 size={13} className="text-green-500" />
              <span className={`font-semibold ${avgPassRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>{avgPassRate}%</span>
              <span className="text-muted-foreground">avg pass rate</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5" data-testid="summary-agent-count"
              title="Pass rates are per agent — pick an agent in the filter to see its average">
              <BarChart3 size={13} className="text-green-500" />
              <span className="font-semibold">{distinctAgents}</span>
              <span className="text-muted-foreground">agents</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Benchmarks Table ──────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
          <div ref={scrollRef} className="h-full overflow-y-auto rounded-lg border border-border">
            <table className="w-full caption-bottom text-sm">
              <thead className={`sticky top-0 z-10 bg-background transition-shadow duration-200 ${isScrolled ? 'shadow-sm' : ''}`}>
                <tr className="border-b">
                  <SortHeader label="Name" active={bmSort.field === 'name'} dir={bmSort.dir} onClick={() => handleBmSort('name')} />
                  <SortHeader label="# TCs" active={bmSort.field === 'tcs'} dir={bmSort.dir} onClick={() => handleBmSort('tcs')} className="text-center" />
                  <SortHeader label="Runs" active={bmSort.field === 'runs'} dir={bmSort.dir} onClick={() => handleBmSort('runs')} className="text-center" />
                  <SortHeader label="Last Activity" active={bmSort.field === 'lastTouched'} dir={bmSort.dir} onClick={() => handleBmSort('lastTouched')} />
                  <SortHeader label="Latest Result" active={bmSort.field === 'score'} dir={bmSort.dir} onClick={() => handleBmSort('score')} />
                  <th className="h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Trend</th>
                  <th className="h-7 px-2 text-right align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {sortedBenchmarks.length === 0 ? (
                  <tr><td colSpan={8} className="py-12 text-center text-sm text-muted-foreground">No benchmarks found</td></tr>
                ) : (
                  sortedBenchmarks.map(bm => {
                    const stats = benchmarkStats.get(bm.id);
                    const lr = stats?.latestRun;
                    return (
                      <tr key={bm.id} className="border-b hover:bg-muted/50 cursor-pointer transition-colors"
                        onClick={() => navigate(`/evaluations/benchmarks/${bm.id}`)}>
                        <td className="px-2 py-1.5 align-middle">
                          <div className="flex items-center gap-1.5">
                            <div className="text-xs font-medium truncate max-w-[220px]">{bm.name}</div>
                            {/* Version badge — mirrors the legacy /benchmarks page so users
                                can see when a benchmark has been edited (v2, v3, ...). */}
                            <span
                              data-testid="benchmark-version-badge"
                              className="inline-flex items-center px-1 rounded border border-border text-[9px] text-muted-foreground leading-4"
                              title={`Benchmark version v${bm.currentVersion || 1}`}
                            >
                              v{bm.currentVersion || 1}
                            </span>
                          </div>
                          {bm.description && <div className="text-[9px] text-muted-foreground truncate max-w-[220px]">{bm.description}</div>}
                        </td>
                        <td className="px-2 py-1.5 align-middle text-center text-[11px]">{(bm.testCaseIds || []).length}</td>
                        <td className="px-2 py-1.5 align-middle text-center text-[11px]">{stats?.runCount || 0}</td>
                        <td className="px-2 py-1.5 align-middle">
                          {(() => {
                            // "Last Activity" cell: show whichever signal is more recent.
                            //  - If the benchmark itself was updated more recently than its last
                            //    run finished (e.g. just created, or a new test-case version),
                            //    show "Updated <relative>" so users see why it sorted to the top.
                            //  - Otherwise behave like before — a clickable link to the latest run.
                            const kind = stats?.lastTouchedKind ?? (lr ? 'run' : 'updated');
                            if (kind === 'run' && lr) {
                              return (
                                <button className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 hover:underline"
                                  onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${bm.id}/runs/${lr.id}`); }}>
                                  {formatRelativeTime(lr.createdAt)}
                                </button>
                              );
                            }
                            if (bm.updatedAt) {
                              return (
                                <span className="text-[10px] text-muted-foreground" title={new Date(bm.updatedAt).toLocaleString()}>
                                  Updated {formatRelativeTime(bm.updatedAt)}
                                </span>
                              );
                            }
                            return <span className="text-[10px] text-muted-foreground">—</span>;
                          })()}
                        </td>
                        {(() => {
                          // One line per agent in BOTH cells, same order and a fixed
                          // line height so result and trend stay side by side.
                          const agents = stats?.agents ?? [];
                          const expanded = expandedAgentRows.has(bm.id);
                          const shown = expanded ? agents : agents.slice(0, AGENT_LINES_COLLAPSED);
                          const hidden = agents.length - shown.length;
                          const line = 'h-5 flex items-center gap-1.5 text-[11px]';
                          return (<>
                            <td className="px-2 py-1.5 align-middle" data-testid="latest-result-cell">
                              {agents.length === 0 ? <span className="text-[11px] text-muted-foreground">—</span> : (
                                <div className="flex flex-col">
                                  {shown.map(a => (
                                    <div key={a.agentId} className={line} data-testid="agent-latest-line" data-agent-id={a.agentId}>
                                      <span className="text-muted-foreground truncate max-w-[160px]" title={a.agentEndpoint ? `${a.label} — ${a.agentEndpoint}` : a.label} data-testid="agent-label">{a.label}</span>
                                      <span className="inline-flex items-center gap-0.5">
                                        <CheckCircle2 size={11} className="text-green-500" />
                                        <span className="text-green-500 font-medium">{a.passed}</span>
                                      </span>
                                      <span className="inline-flex items-center gap-0.5">
                                        <XCircle size={11} className="text-red-400" />
                                        <span className="text-red-400 font-medium">{a.failed}</span>
                                      </span>
                                      <span className="text-muted-foreground">/ {a.total}</span>
                                    </div>
                                  ))}
                                  {agents.length > AGENT_LINES_COLLAPSED && (
                                    <button
                                      data-testid="agent-lines-toggle"
                                      className="h-5 text-left text-[10px] text-blue-600 hover:underline dark:text-blue-400"
                                      onClick={e => { e.stopPropagation(); toggleAgentRows(bm.id); }}
                                    >
                                      {expanded ? 'Show less' : `+${hidden} more`}
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1.5 align-middle" data-testid="trend-cell">
                              <div className="flex flex-col">
                                {shown.map(a => (
                                  <div key={a.agentId} className={line} data-testid="agent-trend-line" data-agent-id={a.agentId}>
                                    <MiniSparkline values={a.passRateHistory} />
                                    <TrendBadge trend={a.trend} />
                                  </div>
                                ))}
                                {agents.length === 0 && <TrendBadge trend="unknown" />}
                              </div>
                            </td>
                          </>);
                        })()}
                        <td className="px-2 py-1.5 align-middle text-right">
                          <div className="inline-flex items-center gap-1">
                            {/* Edit benchmark — opens BenchmarkEditor in edit mode.
                                Changing the test-case selection here is one of the
                                two UI paths that increment currentVersion (the
                                other is the Edit button on the detail page). See
                                server/routes/storage/benchmarks.ts version-bump logic. */}
                            <button
                              data-testid="edit-benchmark-button-row"
                              aria-label="Edit benchmark"
                              title="Edit benchmark"
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-muted transition-colors"
                              onClick={e => {
                                e.stopPropagation();
                                setEditorError(null);
                                setEditingBenchmark(bm);
                                setShowEditor(true);
                              }}
                            >
                              <Pencil size={9} />
                            </button>
                            <button className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-muted transition-colors"
                              onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${bm.id}/runs`); }}>
                              <Play size={9} /> Run
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

      {/* Benchmark Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="fixed inset-4 z-50 overflow-auto bg-background border rounded-lg shadow-lg">
            {editorError && (
              <div
                role="alert"
                data-testid="benchmark-editor-error"
                className="sticky top-0 z-10 bg-red-500/10 border-b border-red-500/30 text-red-400 px-4 py-2 text-sm flex items-center justify-between"
              >
                <span>{editingBenchmark ? 'Failed to save benchmark:' : 'Failed to create benchmark:'} {editorError}</span>
                <button
                  onClick={() => setEditorError(null)}
                  className="ml-4 text-red-400 hover:text-red-300"
                  aria-label="dismiss error"
                >×</button>
              </div>
            )}
            <BenchmarkEditor
              benchmark={editingBenchmark}
              onSave={async (bm) => {
                try {
                  await asyncBenchmarkStorage.save(bm);
                } catch (err: any) {
                  setEditorError(err?.message || String(err));
                  return;
                }
                setEditorError(null);
                setShowEditor(false);
                const wasEditing = editingBenchmark !== null;
                setEditingBenchmark(null);
                loadData();
                // Editing in place: stay on the list so the user can confirm
                // the version bump landed in the row badge. Only navigate
                // away on a brand-new create.
                if (!wasEditing) {
                  navigate(`/evaluations/benchmarks/${bm.id}`);
                }
              }}
              onSaveAndRun={async (bm: Benchmark, runConfigs: RunConfigForExecution[]) => {
                // 1. Save the benchmark first. On failure, keep the editor open so the form is preserved.
                try {
                  await asyncBenchmarkStorage.save(bm);
                } catch (err: any) {
                  setEditorError(err?.message || String(err));
                  return;
                }
                setEditorError(null);
                setShowEditor(false);
                setEditingBenchmark(null);
                loadData();
                // 2. Navigate to the runs page so the user sees in-progress runs as they start.
                navigate(`/evaluations/benchmarks/${bm.id}/runs`);
                // 3. Fire all configured runs in the background (server streams via SSE; runs page polls).
                //    Failures here are surfaced on the runs page — we don't block navigation.
                for (const rc of runConfigs) {
                  executeBenchmarkRun(bm.id, rc, () => { /* progress shown on runs page */ })
                    .catch(e => console.error('[BenchmarksPage4] background run failed:', e));
                }
              }}
              onCancel={() => { setEditorError(null); setShowEditor(false); setEditingBenchmark(null); }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
