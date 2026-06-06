/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * TestCasesPage4 — Evals 3: Test Cases
 *
 * Agent Traces-style filter bar + sticky table headers + sortable columns.
 * Grouped by benchmark with expand/collapse toggle.
 * Time filter + search + agent filter in header (global, scopes both tabs).
 * Benchmark count as "In N benchmarks" with click-to-expand dropdown.
 * Benchmark name count moved left next to group header.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { usePersistedSet } from '@/hooks/usePersistedSet';
import { PREFS_KEYS } from '@/lib/preferences';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight, ChevronDown, CheckCircle2, XCircle, AlertTriangle,
  Loader2, Clock, Search, RefreshCw, Activity, BarChart3,
  SlidersHorizontal, Layers, List, ChevronsDownUp, ChevronsUpDown, Upload, Plus,
  Pencil, Play, Calendar,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { asyncTestCaseStorage, asyncRunStorage, asyncBenchmarkStorage } from '@/services/storage';
import { TestCase, TestCaseRun, Benchmark } from '@/types';
import { formatRelativeTime } from '@/lib/utils';
import { TestCaseEditor } from '@/components/TestCaseEditor';
import { useClusterContext } from '@/hooks/useClusterContext';
import { ClusterContextBanner } from '@/components/comparison/ClusterContextBanner';
import { QuickRunModal } from '@/components/QuickRunModal';
import { Breadcrumbs } from '@/components/evals3/Breadcrumbs';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

// ─── Time Filter ─────────────────────────────────────────────────────────────

type TimeRange = '1h' | '6h' | '1d' | '7d' | '30d' | 'all';
const TIME_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'Last 1h' }, { value: '6h', label: 'Last 6h' },
  { value: '1d', label: 'Last 1d' }, { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' }, { value: 'all', label: 'All time' },
];
function getTimeThreshold(range: TimeRange): Date | null {
  if (range === 'all') return null;
  const ms: Record<string, number> = { '1h': 3600000, '6h': 21600000, '1d': 86400000, '7d': 604800000, '30d': 2592000000 };
  return new Date(Date.now() - ms[range]);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string | undefined, max: number): string {
  if (!s) return '—';
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function getPassFail(run: TestCaseRun): 'pass' | 'fail' | 'errored' | 'running' | 'unknown' {
  if (run.status === 'running') return 'running';
  // Issue #242: a run whose evaluator could not produce a verdict
  // (`metricsStatus: 'error'`) is bucketed as `errored`, NOT `fail`. The
  // agent may have completed normally; the judge / trace pipeline
  // failed before scoring. Surfacing it as 'fail' here would defeat the
  // distinct bucket the rest of the run-stats pipeline preserves.
  if (run.metricsStatus === 'error') return 'errored';
  if (run.passFailStatus === 'passed') return 'pass';
  if (run.passFailStatus === 'failed') return 'fail';
  // No verdict from the judge — don't fabricate one from a single metric
  // value. The previous fallback of `accuracy >= 50` only worked under the
  // RCA Default evaluator (the only one that emits a metric named
  // `accuracy`), so for runs scored by any other evaluator it always
  // returned 'fail' regardless of how the judge actually scored the run.
  // 'unknown' is the honest answer.
  return 'unknown';
}


function PassFailBadge({ result }: { result: 'pass' | 'fail' | 'errored' | 'running' | 'unknown' }) {
  const c = {
    pass: { icon: <CheckCircle2 size={12} />, label: 'Pass', cls: 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-500/10 border-green-300 dark:border-green-500/20' },
    fail: { icon: <XCircle size={12} />, label: 'Fail', cls: 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-500/10 border-red-300 dark:border-red-500/20' },
    errored: { icon: <AlertTriangle size={12} />, label: 'Errored', cls: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/20' },
    running: { icon: <Loader2 size={12} className="animate-spin" />, label: 'Running', cls: 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-500/10 border-blue-300 dark:border-blue-500/20' },
    unknown: { icon: <Clock size={12} />, label: '—', cls: 'text-muted-foreground bg-muted/50 border-border' },
  }[result];
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium border ${c.cls}`}>{c.icon} {c.label}</span>;
}

type SortField = 'name' | 'created' | 'lastRun' | 'runs' | 'passRate';
type SortDir = 'asc' | 'desc';

function SortHeader({ label, active, dir, onClick, className }: {
  label: string; active: boolean; dir: SortDir; onClick: () => void; className?: string;
}) {
  return (
    <th className={`h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${className || ''}`}
      onClick={onClick}>
      <span className="inline-flex items-center gap-1">{label}{active && <ChevronDown size={10} className={dir === 'asc' ? 'rotate-180' : ''} />}</span>
    </th>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const TestCasesPage4: React.FC = () => {
  const navigate = useNavigate();
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [runCounts, setRunCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = usePersistedState<string>('test-cases:search', '');
  const [viewMode, setViewMode] = usePersistedState<'flat' | 'grouped'>(PREFS_KEYS.viewMode, 'flat');
  const [collapsedGroups, setCollapsedGroups] = usePersistedSet<string>('test-cases:collapsedGroups');
  const [timeRange, setTimeRange] = usePersistedState<TimeRange>(PREFS_KEYS.timeRange, '7d');
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);
  const [selectedBenchmark, setSelectedBenchmark] = usePersistedState<string>(PREFS_KEYS.benchmarkFilter, 'all');
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Import/Editor state
  const [isImporting, setIsImporting] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editingTestCase, setEditingTestCase] = useState<TestCase | null>(null);
  const [runningTestCase, setRunningTestCase] = useState<TestCase | null>(null);
  const [showSampleData, setShowSampleData] = useState<boolean | undefined>(undefined);

  // Cluster context — when present, render a banner + auto-open the New
  // Test Case modal so the user lands in the authoring flow they came
  // here for (e.g. expanding test coverage for a cluster of failures).
  const { context: clusterContext } = useClusterContext();
  const hasOpenedFromCluster = useRef(false);
  useEffect(() => {
    if (!clusterContext) return;
    if (hasOpenedFromCluster.current) return;
    hasOpenedFromCluster.current = true;
    setEditingTestCase(null);
    setShowEditor(true);
  }, [clusterContext]);

  // Sort
  const [sort, setSort] = usePersistedState<{ field: SortField; dir: SortDir }>('test-cases:sort', { field: 'created', dir: 'desc' });

  const loadDefinitions = useCallback(async () => {
    try {
      const [tcs, counts, bms] = await Promise.all([
        asyncTestCaseStorage.getAll({ includeSample: showSampleData === true ? true : undefined }), asyncRunStorage.getRunCountsByTestCase(), asyncBenchmarkStorage.getAll({ includeSample: showSampleData === true ? true : undefined }),
      ]);
      setTestCases(tcs as TestCase[]); setRunCounts(counts); setBenchmarks(bms);
    } catch (err) { console.error('Failed:', err); }
    finally { setLoading(false); }
  }, [showSampleData]);

  useEffect(() => { loadDefinitions(); }, [loadDefinitions]);

  // Scroll shadow
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const h = () => setIsScrolled(el.scrollTop > 10);
    el.addEventListener('scroll', h); return () => el.removeEventListener('scroll', h);
  }, []);

  const tcMap = useMemo(() => new Map(testCases.map(tc => [tc.id, tc])), [testCases]);

  // Reverse map: tcId → benchmarks
  const tcBenchmarkMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const bm of benchmarks) for (const tcId of (bm.testCaseIds || [])) {
      if (!map.has(tcId)) map.set(tcId, []);
      map.get(tcId)!.push({ id: bm.id, name: bm.name });
    }
    return map;
  }, [benchmarks]);

  // Placeholder maps — populated when run data is available
  const latestRunByTc: Record<string, { timestamp: string; passed: boolean | null; id: string }> = {};
  const passRateByTc: Record<string, { passed: number; total: number }> = {};

  // Filtered test cases
  const filteredTcs = useMemo(() => {
    let list = testCases;
    if (search) { const q = search.toLowerCase(); list = list.filter(tc => (tc.name ?? '').toLowerCase().includes(q) || tc.initialPrompt?.toLowerCase().includes(q) || tc.description?.toLowerCase().includes(q)); }
    if (selectedBenchmark !== 'all') {
      const bm = benchmarks.find(b => b.id === selectedBenchmark);
      if (bm) {
        const bmTcIds = new Set(bm.testCaseIds || []);
        list = list.filter(tc => bmTcIds.has(tc.id));
      }
    }
    return list;
  }, [testCases, search, selectedBenchmark, benchmarks]);

  // Sort test cases within groups (lastRun, runs)
  const sortTcsWithinGroup = useCallback((tcs: TestCase[]): TestCase[] => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (sort.field === 'name') {
      return [...tcs].sort((a, b) => dir * (a.name || '').localeCompare(b.name || ''));
    }
    return [...tcs].sort((a, b) => {
      switch (sort.field) {
        case 'lastRun': {
          const aRun = latestRunByTc[a.id]?.timestamp || '';
          const bRun = latestRunByTc[b.id]?.timestamp || '';
          return dir * aRun.localeCompare(bRun);
        }
        case 'runs': return dir * ((runCounts[a.id] || 0) - (runCounts[b.id] || 0));
        case 'passRate': {
          const aRate = passRateByTc[a.id]?.total ? passRateByTc[a.id].passed / passRateByTc[a.id].total : -1;
          const bRate = passRateByTc[b.id]?.total ? passRateByTc[b.id].passed / passRateByTc[b.id].total : -1;
          return dir * (aRate - bRate);
        }
        default: return 0;
      }
    });
  }, [sort, latestRunByTc, runCounts, passRateByTc]);

  // For flat view: sort all test cases by the active sort field
  const sortedTcs = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filteredTcs].sort((a, b) => {
      switch (sort.field) {
        case 'name': return dir * (a.name || '').localeCompare(b.name || '');
        case 'created': return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        case 'lastRun': {
          const aRun = latestRunByTc[a.id]?.timestamp || '';
          const bRun = latestRunByTc[b.id]?.timestamp || '';
          return dir * aRun.localeCompare(bRun);
        }
        case 'runs': return dir * ((runCounts[a.id] || 0) - (runCounts[b.id] || 0));
        case 'passRate': {
          const aRate = passRateByTc[a.id]?.total ? passRateByTc[a.id].passed / passRateByTc[a.id].total : -1;
          const bRate = passRateByTc[b.id]?.total ? passRateByTc[b.id].passed / passRateByTc[b.id].total : -1;
          return dir * (aRate - bRate);
        }
        default: return 0;
      }
    });
  }, [filteredTcs, sort, latestRunByTc, runCounts, passRateByTc]);

  const handleSort = (field: SortField) => {
    setSort(prev => prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' });
  };

  // Grouped data — Name sort applies to group order, other sorts apply within groups
  const groupedData = useMemo(() => {
    const assignedTcIds = new Set<string>();
    const groups: { id: string; name: string; testCases: TestCase[] }[] = [];
    for (const bm of benchmarks) {
      const tcs = (bm.testCaseIds || []).map(id => filteredTcs.find(tc => tc.id === id)).filter((tc): tc is TestCase => !!tc);
      if (tcs.length > 0) {
        groups.push({ id: bm.id, name: bm.name, testCases: sortTcsWithinGroup(tcs) });
        tcs.forEach(tc => assignedTcIds.add(tc.id));
      }
    }
    const unassigned = filteredTcs.filter(tc => !assignedTcIds.has(tc.id));
    if (unassigned.length > 0) groups.push({ id: '__unassigned__', name: 'Unassigned', testCases: sortTcsWithinGroup(unassigned) });

    // Sort groups by benchmark name when Name column is sorted
    if (sort.field === 'name') {
      const dir = sort.dir === 'asc' ? 1 : -1;
      groups.sort((a, b) => {
        if (a.id === '__unassigned__') return 1;
        if (b.id === '__unassigned__') return -1;
        return dir * a.name.localeCompare(b.name);
      });
    }

    return groups;
  }, [benchmarks, filteredTcs, sort, sortTcsWithinGroup]);

  const toggleGroup = (id: string) => setCollapsedGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });


  // Import handler
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

  const handleEditorSave = async () => { setShowEditor(false); setEditingTestCase(null); loadDefinitions(); };

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>;


  // Render a test case row (shared between grouped and flat)
  const renderTcRow = (tc: TestCase, indent: boolean = false) => {
    const bmList = tcBenchmarkMap.get(tc.id) || [];
    return (
      <tr key={tc.id} className="border-b hover:bg-muted/50 cursor-pointer transition-colors"
        onClick={() => navigate(`/evaluations/test-cases/${tc.id}`)}>
        <td className={`px-2 py-1.5 align-middle ${indent ? 'pl-7' : ''}`}>
          <div className="text-xs font-medium truncate max-w-[220px]">{tc.name}</div>
          {tc.labels && tc.labels.length > 0 && (
            <div className="flex items-center gap-0.5 mt-0.5">
              {tc.labels.slice(0, 2).map(l => <Badge key={l} variant="outline" className="text-[8px] px-1 py-0">{l}</Badge>)}
              {tc.labels.length > 2 && <span className="text-[8px] text-muted-foreground">+{tc.labels.length - 2}</span>}
            </div>
          )}
        </td>
        <td className="px-2 py-1.5 align-middle text-[10px] text-muted-foreground truncate max-w-[180px]">
          {tc.description || '—'}
        </td>
        <td className="px-2 py-1.5 align-middle relative">
          {bmList.length > 0 ? (
            <button className="text-[10px] text-purple-600 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300 transition-colors"
              onClick={e => { e.stopPropagation(); setOpenPopoverId(openPopoverId === tc.id ? null : tc.id); }}>
              In {bmList.length} benchmark{bmList.length !== 1 ? 's' : ''}
            </button>
          ) : <span className="text-[9px] text-muted-foreground italic">none</span>}
          {openPopoverId === tc.id && bmList.length > 0 && (
            <div className="absolute top-7 left-2 z-20 bg-popover border border-border rounded-md shadow-lg p-1.5 min-w-[140px]">
              {bmList.map(bm => (
                <div key={bm.id} className="text-[10px] px-1.5 py-1 rounded hover:bg-muted cursor-pointer flex items-center gap-1"
                  onClick={e => { e.stopPropagation(); navigate(`/evaluations/benchmarks/${bm.id}/runs`); }}>
                  <Badge className="text-[7px] px-0.5 py-0 bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/30 shrink-0">BM</Badge>{bm.name}
                </div>
              ))}
            </div>
          )}
        </td>
        <td className="px-2 py-1.5 align-middle text-[10px] text-muted-foreground whitespace-nowrap">
          {formatRelativeTime(tc.createdAt)}
        </td>
        <td className="px-2 py-1.5 align-middle text-right">
          <div className="inline-flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-6 w-6" title="Run"
              data-testid="test-case-run-button"
              onClick={e => { e.stopPropagation(); setRunningTestCase(tc); }}>
              <Play size={11} />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" title="Edit"
              onClick={e => { e.stopPropagation(); setEditingTestCase(tc); setShowEditor(true); }}>
              <Pencil size={11} />
            </Button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="p-4 h-full flex flex-col" data-testid="test-cases-page">
      {clusterContext && (
        <div className="mb-3">
          <ClusterContextBanner context={clusterContext} />
        </div>
      )}
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/benchmarks' },
          { label: 'Test Cases' },
        ]}
        actions={<>
          <div className="w-[200px] relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} className="pl-7 h-7 text-xs md:text-xs" />
          </div>
          {/* Benchmark filter */}
          <Select value={selectedBenchmark} onValueChange={setSelectedBenchmark}>
            <SelectTrigger className="w-[160px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Benchmarks</SelectItem>
              {benchmarks.map(bm => <SelectItem key={bm.id} value={bm.id}>{bm.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* View mode toggle (Grouped first — it's the default mental model) */}
          <div className="flex items-center border border-border rounded-md overflow-hidden h-7" data-testid="viewmode-toggle">
            <button data-testid="viewmode-grouped" onClick={() => setViewMode('grouped')} className={`px-2 h-full text-xs flex items-center gap-1 transition-colors ${viewMode === 'grouped' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <Layers size={12} /> Grouped
            </button>
            <button data-testid="viewmode-flat" onClick={() => setViewMode('flat')} className={`px-2 h-full text-xs flex items-center gap-1 transition-colors ${viewMode === 'flat' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              <List size={12} /> Flat
            </button>
          </div>
          {/* Expand/Collapse All — only in grouped mode */}
          {viewMode === 'grouped' && (
            <div className="flex items-center border border-border rounded-md overflow-hidden h-7">
              <button
                onClick={() => setCollapsedGroups(new Set())}
                className="px-2 h-full text-xs flex items-center gap-1 transition-colors text-muted-foreground hover:text-foreground"
                title="Expand all"
              >
                <ChevronsUpDown size={12} />
              </button>
              <button
                onClick={() => setCollapsedGroups(new Set(groupedData.map(g => g.id)))}
                className="px-2 h-full text-xs flex items-center gap-1 transition-colors text-muted-foreground hover:text-foreground"
                title="Collapse all"
              >
                <ChevronsDownUp size={12} />
              </button>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isImporting} className="h-7 gap-1.5 text-xs font-normal">
            <Upload size={12} /> {isImporting ? 'Importing...' : 'Import JSON'}
          </Button>
          <Button size="sm" onClick={() => { setEditingTestCase(null); setShowEditor(true); }} className="h-7 gap-1.5 text-xs">
            <Plus size={12} /> New Test Case
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
        </>}
      />
      {/* ── Header ────────────────────────────────────── */}
      <div className="mb-4">
        <h2 className="text-xl font-bold" data-testid="test-cases-title">Test Cases</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">{testCases.length} test cases · Define prompts and expected outcomes</p>
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-lg border border-border">
        <table className="w-full caption-bottom text-sm">
          <thead className={`sticky top-0 z-10 bg-background transition-shadow duration-200 ${isScrolled ? 'shadow-sm' : ''}`}>
            <tr className="border-b">
              <th className="h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap cursor-pointer select-none hover:text-foreground transition-colors"
                onClick={() => handleSort('name')}>
                <span className="inline-flex items-center gap-1">
                  Name
                  {sort.field === 'name' && <ChevronDown size={10} className={sort.dir === 'asc' ? 'rotate-180' : ''} />}
                </span>
              </th>
              <th className="h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Description</th>
              <th className="h-7 px-2 text-left align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap"></th>
              <SortHeader label="Created" active={sort.field === 'created'} dir={sort.dir} onClick={() => handleSort('created')} />
              <th className="h-7 px-2 text-right align-middle font-medium text-xs text-muted-foreground bg-background border-b whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {viewMode === 'grouped' ? (
              groupedData.length === 0 ? (
                <tr><td colSpan={5} className="py-16 text-center text-sm text-muted-foreground">No test cases found</td></tr>
              ) : (
                groupedData.map(group => {
                  const isCollapsed = collapsedGroups.has(group.id);
                  const isUnassigned = group.id === '__unassigned__';
                  return (
                    <React.Fragment key={group.id}>
                      <tr className={`border-b cursor-pointer hover:bg-muted/30 transition-colors ${isUnassigned ? 'bg-muted/10' : 'bg-purple-50 dark:bg-purple-500/5'}`}
                        onClick={() => toggleGroup(group.id)}>
                        <td colSpan={5} className="px-2 py-1.5 align-middle">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
                            {!isUnassigned && <Badge className="text-[9px] px-1 py-0 bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/30 font-semibold uppercase tracking-wider">Benchmark</Badge>}
                            <span className="text-xs font-semibold">{group.name}</span>
                            <span className="text-[10px] text-muted-foreground">({group.testCases.length} test case{group.testCases.length !== 1 ? 's' : ''})</span>
                          </div>
                        </td>
                      </tr>
                      {!isCollapsed && group.testCases.map(tc => renderTcRow(tc, true))}
                    </React.Fragment>
                  );
                })
              )
            ) : (
              sortedTcs.length === 0 ? (
                <tr><td colSpan={5} className="py-16 text-center text-sm text-muted-foreground">No test cases found</td></tr>
              ) : sortedTcs.map(tc => renderTcRow(tc, false))
            )}
          </tbody>
        </table>
      </div>
      {/* Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="fixed inset-4 z-50 overflow-auto bg-background border rounded-lg shadow-lg">
            <TestCaseEditor testCase={editingTestCase} onSave={handleEditorSave} onCancel={() => { setShowEditor(false); setEditingTestCase(null); }} />
          </div>
        </div>
      )}
      {/* Quick Run Modal */}
      {runningTestCase && (
        <QuickRunModal testCase={runningTestCase} onClose={() => { setRunningTestCase(null); loadDefinitions(); }} onSaveAsTestCase={() => {}} />
      )}
    </div>
  );
};
