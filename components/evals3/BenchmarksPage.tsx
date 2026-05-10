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
import { useNavigate } from 'react-router-dom';
import {
  Play, CheckCircle2, XCircle, Loader2, Clock, Search, X, RefreshCw,
  Activity, BarChart3, Layers, TrendingUp, TrendingDown, Minus, AlertTriangle,
  SlidersHorizontal, ChevronDown, Upload, Plus,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { Benchmark, BenchmarkRun, TestCase } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatRelativeTime, getModelName } from '@/lib/utils';
import { BenchmarkEditor } from '@/components/BenchmarkEditor';
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

function computeScore(run: BenchmarkRun): number | null {
  if (run.stats && run.stats.total > 0) return Math.round((run.stats.passed / run.stats.total) * 100);
  const results = Object.values(run.results || {});
  if (results.length === 0) return null;
  const completed = results.filter(r => r.status === 'completed').length;
  return Math.round((completed / results.length) * 100);
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-muted-foreground">—</span>;
  const cls = score >= 80 ? 'text-green-700 dark:text-green-400' : score >= 50 ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400';
  return <span className={`text-xs font-semibold tabular-nums ${cls}`}>{score}%</span>;
}

type TrendDir = 'improving' | 'stable' | 'regressing' | 'unknown';

function getTrend(runs: BenchmarkRun[]): TrendDir {
  if (runs.length < 2) return 'unknown';
  const sorted = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const latest = computeScore(sorted[0]);
  const prev = computeScore(sorted[1]);
  if (latest === null || prev === null) return 'unknown';
  const diff = latest - prev;
  if (diff > 5) return 'improving';
  if (diff < -5) return 'regressing';
  return 'stable';
}

function TrendBadge({ trend }: { trend: TrendDir }) {
  const config: Record<TrendDir, { icon: React.ReactNode; label: string; cls: string }> = {
    improving: { icon: <TrendingUp size={12} />, label: 'Improving', cls: 'text-green-600 dark:text-green-400' },
    stable: { icon: <Minus size={12} />, label: 'Stable', cls: 'text-muted-foreground' },
    regressing: { icon: <TrendingDown size={12} />, label: 'Regressing', cls: 'text-red-600 dark:text-red-400' },
    unknown: { icon: <Minus size={12} />, label: '—', cls: 'text-muted-foreground' },
  };
  const c = config[trend];
  return <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${c.cls}`}>{c.icon} {c.label}</span>;
}

interface BenchmarkStats {
  runCount: number; latestRun: BenchmarkRun | null; latestScore: number | null;
  bestScore: number | null; worstScore: number | null; trend: TrendDir;
  passRateHistory: number[]; // pass rates of last N runs, oldest first
}

// Sort types
type BmSortField = 'name' | 'tcs' | 'runs' | 'score' | 'best' | 'worst' | 'trend';
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
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [selectedAgent, setSelectedAgent] = useState<string>(() => DEFAULT_CONFIG.agents.find(a => a.enabled !== false)?.key || 'all');
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Editor/Import state
  const [showEditor, setShowEditor] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showSampleData, setShowSampleData] = useState<boolean | undefined>(undefined);

  // Sort state for Benchmarks tab
  const [bmSort, setBmSort] = useState<{ field: BmSortField; dir: SortDir }>({ field: 'runs', dir: 'desc' });

  const loadData = useCallback(async () => {
    try {
      const [bms, tcs] = await Promise.all([
        asyncBenchmarkStorage.getAll({ includeSample: showSampleData === true ? true : undefined }),
        asyncTestCaseStorage.getAll({ includeSample: showSampleData === true ? true : undefined }),
      ]);
      setBenchmarks(bms);
      setTestCases(tcs as TestCase[]);
    } catch (err) {
      console.error('Failed to load:', err);
    } finally {
      setLoading(false);
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

  const tcMap = useMemo(() => new Map(testCases.map(tc => [tc.id, tc])), [testCases]);

  // Agent options from config
  const agentOptions = useMemo(() => {
    const agents = DEFAULT_CONFIG.agents.filter(a => a.enabled !== false).map(a => ({ value: a.key, label: a.name }));
    return [{ value: 'all', label: 'All Agents' }, ...agents];
  }, []);

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
      const scores = runs.map(r => computeScore(r)).filter((s): s is number => s !== null);
      const sorted = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      map.set(bm.id, {
        runCount: runs.length, latestRun: sorted[0] || null,
        latestScore: sorted[0] ? computeScore(sorted[0]) : null,
        bestScore: scores.length > 0 ? Math.max(...scores) : null,
        worstScore: scores.length > 0 ? Math.min(...scores) : null,
        trend: getTrend(runs),
        passRateHistory: sorted.slice(0, 10).reverse().map(r => computeScore(r) ?? 0),
      });
    }
    return map;
  }, [timeFilteredBenchmarks]);

  // Summary cards
  const totalBenchmarks = benchmarks.length;
  const totalRuns = Array.from(benchmarkStats.values()).reduce((s, bs) => s + bs.runCount, 0);
  const allScores = Array.from(benchmarkStats.values()).map(bs => bs.latestScore).filter((s): s is number => s !== null);
  const avgPassRate = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;

  // Filtered + sorted benchmarks
  const sortedBenchmarks = useMemo(() => {
    let list = timeFilteredBenchmarks;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(b => b.name.toLowerCase().includes(q));
    }
    const dir = bmSort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const sa = benchmarkStats.get(a.id);
      const sb = benchmarkStats.get(b.id);
      switch (bmSort.field) {
        case 'name': return dir * a.name.localeCompare(b.name);
        case 'tcs': return dir * (a.testCaseIds.length - b.testCaseIds.length);
        case 'runs': return dir * ((sa?.runCount || 0) - (sb?.runCount || 0));
        case 'score': return dir * ((sa?.latestScore ?? -1) - (sb?.latestScore ?? -1));
        case 'best': return dir * ((sa?.bestScore ?? -1) - (sb?.bestScore ?? -1));
        case 'worst': return dir * ((sa?.worstScore ?? -1) - (sb?.worstScore ?? -1));
        case 'trend': return dir * ((sa?.trend || '').localeCompare(sb?.trend || ''));
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
        const createdIds = (result as any).ids;
        if (!createdIds || createdIds.length === 0) {
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
        navigate(`/evaluations/benchmarks/${bm.id}/runs`);
      }
    } catch (err) { console.error('Import failed:', err); }
    finally { setIsImporting(false); event.target.value = ''; }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/benchmarks' },
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
          <Button size="sm" onClick={() => setShowEditor(true)} className="h-7 gap-1.5 text-xs">
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
          <h2 className="text-xl font-bold">Benchmarks</h2>
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
          <div className="flex items-center gap-1.5">
            <BarChart3 size={13} className="text-green-500" />
            <span className={`font-semibold ${avgPassRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>{avgPassRate}%</span>
            <span className="text-muted-foreground">avg pass rate</span>
          </div>
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
                  <th className="h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Last Run</th>
                  <SortHeader label="Latest Result" active={bmSort.field === 'score'} dir={bmSort.dir} onClick={() => handleBmSort('score')} className="text-center" />
                  <th className="h-7 px-2 text-center align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Trend</th>
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
                        onClick={() => navigate(`/evaluations/benchmarks/${bm.id}/runs`)}>
                        <td className="px-2 py-1.5 align-middle">
                          <div className="text-xs font-medium truncate max-w-[220px]">{bm.name}</div>
                          {bm.description && <div className="text-[9px] text-muted-foreground truncate max-w-[220px]">{bm.description}</div>}
                        </td>
                        <td className="px-2 py-1.5 align-middle text-center text-[11px]">{bm.testCaseIds.length}</td>
                        <td className="px-2 py-1.5 align-middle text-center text-[11px]">{stats?.runCount || 0}</td>
                        <td className="px-2 py-1.5 align-middle">
                          {lr ? (
                            <button className="text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 hover:underline"
                              onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${bm.id}/runs/${lr.id}`); }}>
                              {formatRelativeTime(lr.createdAt)}
                            </button>
                          ) : <span className="text-[10px] text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-1.5 align-middle text-center">
                          {lr ? (() => {
                            const passed = lr.stats?.passed ?? 0;
                            const failed = lr.stats?.failed ?? 0;
                            const total = lr.stats?.total ?? Object.keys(lr.results || {}).length;
                            return (
                              <div className="inline-flex items-center gap-1.5 text-[11px]">
                                <span className="inline-flex items-center gap-0.5">
                                  <CheckCircle2 size={11} className="text-green-500" />
                                  <span className="text-green-500 font-medium">{passed}</span>
                                </span>
                                <span className="inline-flex items-center gap-0.5">
                                  <XCircle size={11} className="text-red-400" />
                                  <span className="text-red-400 font-medium">{failed}</span>
                                </span>
                                <span className="text-muted-foreground">/ {total}</span>
                              </div>
                            );
                          })() : <span className="text-[11px] text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-1.5 align-middle text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <MiniSparkline values={stats?.passRateHistory || []} />
                            <TrendBadge trend={stats?.trend || 'unknown'} />
                          </div>
                        </td>
                        <td className="px-2 py-1.5 align-middle text-right">
                          <button className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-muted transition-colors"
                            onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${bm.id}/runs`); }}>
                            <Play size={9} /> Run
                          </button>
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
            <BenchmarkEditor
              benchmark={null}
              onSave={(bm) => { setShowEditor(false); navigate(`/evaluations/benchmarks/${bm.id}/runs`); }}
              onCancel={() => setShowEditor(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
