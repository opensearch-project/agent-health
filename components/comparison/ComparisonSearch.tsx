/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Search, ChevronDown, Check, Database, Play, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Benchmark, BenchmarkRun } from '@/types';
import { getRunModelLabel } from '@/lib/utils';
import { recordUiEvent } from '@/lib/uiTelemetry';

export type SearchScope = 'benchmark' | 'run' | 'testCase';

const SCOPES: { value: SearchScope; label: string; icon: React.ReactNode }[] = [
  { value: 'benchmark', label: 'Benchmark', icon: <Database size={12} /> },
  { value: 'run', label: 'Run', icon: <Play size={12} /> },
  { value: 'testCase', label: 'Test Case', icon: <FileText size={12} /> },
];

interface Props {
  benchmarks: Benchmark[];
  runs: BenchmarkRun[];
  selectedRunIds: string[];
  testCases: { id: string; name: string }[];
  activeTestCaseId: string | null;
  onSelectBenchmark: (id: string) => void;
  onToggleRun: (id: string) => void;
  onSelectAllRuns: (ids: string[]) => void;
  onSelectTestCase: (id: string | null) => void;
}

/**
 * ComparisonSearch — one search bar for the whole page. Pick a scope
 * (Benchmark / Run / Test Case) then search within it; selecting routes to the
 * right action (load a benchmark, toggle a run into the comparison, or filter
 * the table to a test case). Replaces the standalone benchmark dropdown.
 * Emits lightweight telemetry on scope switch + selection so we can understand
 * which scopes are actually used and how big the result sets are.
 */
export const ComparisonSearch: React.FC<Props> = ({
  benchmarks,
  runs,
  selectedRunIds,
  testCases,
  activeTestCaseId,
  onSelectBenchmark,
  onToggleRun,
  onSelectAllRuns,
  onSelectTestCase,
}) => {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SearchScope>('run');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (scope === 'benchmark') {
      return benchmarks
        .filter(b => !q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q))
        .map(b => ({ id: b.id, primary: b.name, secondary: `${b.runs?.length ?? 0} runs`, selected: false }));
    }
    if (scope === 'run') {
      return runs
        .filter(r => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map(r => ({ id: r.id, primary: r.name, secondary: getRunModelLabel(r) ? `${r.agentKey} · ${getRunModelLabel(r)}` : r.agentKey, selected: selectedRunIds.includes(r.id) }));
    }
    return testCases
      .filter(t => !q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
      .map(t => ({ id: t.id, primary: t.name, secondary: t.id, selected: t.id === activeTestCaseId }));
  }, [scope, q, benchmarks, runs, selectedRunIds, testCases, activeTestCaseId]);

  const placeholder = scope === 'benchmark' ? 'Search benchmarks…' : scope === 'run' ? 'Search runs…' : 'Search test cases…';

  const switchScope = (next: SearchScope) => {
    setScope(next);
    setQuery('');
    recordUiEvent('comparison_search_scope', { scope: next });
  };

  const choose = (id: string) => {
    recordUiEvent('comparison_search_select', { scope, queryLen: q.length, resultCount: results.length });
    if (scope === 'benchmark') { onSelectBenchmark(id); setOpen(false); }
    else if (scope === 'run') { onToggleRun(id); }
    else { onSelectTestCase(activeTestCaseId === id ? null : id); setOpen(false); }
  };

  // Trigger label: a launcher that reflects the current scope + selection —
  // NOT a second search box (the only search input lives inside the popover).
  const triggerLabel =
    scope === 'run' ? `${selectedRunIds.length} of ${runs.length} runs`
    : scope === 'benchmark' ? 'Benchmarks'
    : activeTestCaseId ? '1 test case' : 'Test cases';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-2 text-xs font-normal w-[200px] justify-between" data-testid="comparison-search">
          <span className="flex items-center gap-1.5">
            {SCOPES.find(s => s.value === scope)!.icon}
            {triggerLabel}
          </span>
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start" data-testid="comparison-search-panel">
        {/* Step 1: scope */}
        <div className="flex items-center gap-1 p-2 border-b">
          {SCOPES.map(s => (
            <button
              key={s.value}
              onClick={() => switchScope(s.value)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                scope === s.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
              }`}
              data-testid={`comparison-search-scope-${s.value}`}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </div>
        {/* Step 2: search within scope */}
        <div className="p-2 border-b">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus placeholder={placeholder} value={query} onChange={e => setQuery(e.target.value)} className="pl-7 h-7 text-xs" />
          </div>
        </div>
        {/* Run scope doubles as the selection manager (count + select all). */}
        {scope === 'run' && (
          <div className="px-2 py-1.5 border-b flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{selectedRunIds.length} selected{q ? ` · ${results.length} match` : ''}</span>
            <button
              onClick={() => onSelectAllRuns(results.map(r => r.id))}
              className="text-[10px] text-primary hover:underline"
            >
              {q ? 'Select matches' : 'Select all'}
            </button>
          </div>
        )}
        <div className="max-h-[260px] overflow-y-auto p-1">
          {results.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">No matches</div>
          ) : (
            results.map(r => (
              <button
                key={r.id}
                onClick={() => choose(r.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/50 transition-colors text-left ${r.selected ? 'bg-primary/5' : ''}`}
              >
                {(scope === 'run' || scope === 'testCase') && (
                  <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${r.selected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'}`}>
                    {r.selected && <Check size={10} />}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{r.primary}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{r.secondary}</div>
                </div>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
