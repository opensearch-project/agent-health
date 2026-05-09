/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * BenchmarkRunDetailPage — Evals 3: Benchmark Run drill-down
 *
 * Layout (Option A: Entity Card + Dense Results Table):
 *   1. Purple-accent entity card: "BENCHMARK RUN" badge, run name, benchmark name,
 *      agent/model/timestamp metadata, pass/fail/rate stats
 *   2. Collapsible "Run Config" section
 *   3. Full-width test case results table — click row → /runs/:reportId
 *
 * Route: /evaluations/benchmarks/:benchmarkId/runs/:runId
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Loader2, ChevronDown, ChevronRight, Calendar, Ban,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { asyncBenchmarkStorage, asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { Benchmark, BenchmarkRun, TestCase, EvaluationReport } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getLabelColor, formatDate, getModelName } from '@/lib/utils';
import { RunDetailsFlyout } from './RunDetailsFlyout';
import { ResultStatus, getResultStatus, StatusIcon, StatusLabel } from './ResultStatus';
import { Breadcrumbs } from './Breadcrumbs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TestCaseResult {
  testCaseId: string;
  testCase: TestCase | null;
  reportId: string | null;
  report: EvaluationReport | null;
  status: ResultStatus;
  accuracy: number | null;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const BenchmarkRunDetailPage: React.FC = () => {
  const { benchmarkId, runId } = useParams<{ benchmarkId: string; runId: string }>();
  const navigate = useNavigate();

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);

  // Flyout state
  const [flyoutResult, setFlyoutResult] = useState<TestCaseResult | null>(null);

  const loadData = useCallback(async () => {
    if (!benchmarkId || !runId) return;
    setLoading(true);
    try {
      const bm = await asyncBenchmarkStorage.getById(benchmarkId);
      if (!bm) { navigate('/evaluations/benchmarks'); return; }
      setBenchmark(bm);

      const bmRun = bm.runs?.find(r => r.id === runId);
      if (!bmRun) { navigate(`/evaluations/benchmarks/${benchmarkId}/runs`); return; }
      setRun(bmRun);

      // Load test cases and reports for this run
      const tcIds = Object.keys(bmRun.results || {});
      const [testCases, reports] = await Promise.all([
        asyncTestCaseStorage.getByIds(tcIds),
        asyncRunStorage.getByBenchmarkRun(benchmarkId, runId),
      ]);

      const tcMap = new Map(testCases.map(tc => [tc.id, tc]));
      const reportMap = new Map(reports.map(r => [r.id, r]));

      const resultRows: TestCaseResult[] = tcIds.map(tcId => {
        const runResult = bmRun.results[tcId];
        const report = runResult?.reportId ? (reportMap.get(runResult.reportId) || null) : null;
        return {
          testCaseId: tcId,
          testCase: tcMap.get(tcId) || null,
          reportId: runResult?.reportId || null,
          report,
          status: getResultStatus(runResult, report),
          accuracy: report?.metrics?.accuracy ?? null,
        };
      });

      setResults(resultRows);
    } catch (error) {
      console.error('Failed to load benchmark run:', error);
    } finally {
      setLoading(false);
    }
  }, [benchmarkId, runId, navigate]);

  useEffect(() => { loadData(); }, [loadData]);

  // Stats
  const passCount = results.filter(r => r.status === 'passed').length;
  const failCount = results.filter(r => r.status === 'failed').length;
  const totalCount = results.length;
  const judgedCount = passCount + failCount;
  const passRate = judgedCount > 0 ? Math.round((passCount / judgedCount) * 100) : 0;
  const avgAccuracy = results.filter(r => r.accuracy !== null).length > 0
    ? Math.round(results.reduce((s, r) => s + (r.accuracy ?? 0), 0) / results.filter(r => r.accuracy !== null).length)
    : null;

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!benchmark || !run) return null;

  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey;
  const modelName = getModelName(run.modelId);


  return (
    <div className="p-6 h-full overflow-y-auto">
      <Breadcrumbs
        items={[
          { label: 'Evaluations', href: '/evaluations/benchmarks' },
          { label: 'Benchmarks', href: '/evaluations/benchmarks' },
          { label: benchmark.name, href: `/evaluations/benchmarks/${benchmark.id}/runs` },
          { label: run.name },
        ]}
      />

      {/* ── Entity Card ────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card overflow-hidden mb-6">
        <div className="flex">
          <div className="w-1.5 bg-purple-500 shrink-0" />
          <div className="flex-1 p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <Badge className="text-[10px] px-2 py-0.5 bg-muted text-muted-foreground border-border font-medium uppercase tracking-widest rounded">
                    Benchmark Run
                  </Badge>
                  {run.benchmarkVersion && (
                    <span className="text-[10px] text-muted-foreground">v{run.benchmarkVersion}</span>
                  )}
                  {run.status === 'running' && (
                    <Badge className="text-[10px] px-1.5 py-0 bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/30 animate-pulse">
                      <Loader2 size={10} className="mr-1 animate-spin" /> Running
                    </Badge>
                  )}
                </div>
                <h1 className="text-xl font-bold mb-1">{run.name}</h1>
                <p className="text-sm text-muted-foreground mb-2">{benchmark.name}</p>
                {run.description && (
                  <p className="text-xs text-muted-foreground mb-3">{run.description}</p>
                )}
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1"><Calendar size={11} /> {formatDate(run.createdAt)}</span>
                  <span>Agent: {agentName}</span>
                  <span>Model: {modelName}</span>
                  <span>{totalCount} test case{totalCount !== 1 ? 's' : ''}</span>
                </div>
              </div>
              {/* Stats */}
              <div className="flex items-center gap-5 ml-4 shrink-0">
                <div className="text-center">
                  <div className="text-lg font-bold text-green-500">{passCount}</div>
                  <div className="text-[10px] text-muted-foreground">Passed</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-red-500">{failCount}</div>
                  <div className="text-[10px] text-muted-foreground">Failed</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold">{passRate}%</div>
                  <div className="text-[10px] text-muted-foreground">Pass Rate</div>
                </div>
                {avgAccuracy !== null && (
                  <div className="text-center">
                    <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{avgAccuracy}%</div>
                    <div className="text-[10px] text-muted-foreground">Avg Accuracy</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>


      {/* ── Collapsible Run Config ─────────────────────────────────── */}
      <div className="mb-6">
        <button
          onClick={() => setConfigOpen(!configOpen)}
          className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          {configOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="uppercase tracking-wider">Run Configuration</span>
        </button>
        {configOpen && (
          <div className="grid grid-cols-2 gap-3 pl-5 border-l-2 border-border ml-1">
            <div className="bg-muted/30 rounded-md p-3 border border-border">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Agent</div>
              <div className="text-sm font-medium">{agentName}</div>
              {run.agentEndpoint && <div className="text-[10px] text-muted-foreground mt-0.5">{run.agentEndpoint}</div>}
            </div>
            <div className="bg-muted/30 rounded-md p-3 border border-border">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Judge Model</div>
              <div className="text-sm font-medium">{modelName}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{run.modelId}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Test Case Results Table ────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Test Case Results ({totalCount})
        </h3>
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground font-medium sticky top-0 z-10">
            <span className="w-8 shrink-0" />
            <span className="flex-1 min-w-0">Test Case</span>
            <span className="w-24 shrink-0">Labels</span>
            <span className="w-20 shrink-0 text-right">Accuracy</span>
            <span className="w-16 shrink-0 text-right">Result</span>
          </div>

          {results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <p className="text-sm">No test case results</p>
            </div>
          ) : (
            results.map(r => (
              <div
                key={r.testCaseId}
                className="flex items-center gap-2 px-3 py-3 border-b border-border/40 hover:bg-muted/20 cursor-pointer transition-colors"
                onClick={() => r.report && setFlyoutResult(r)}
              >
                <div className="w-8 shrink-0 flex justify-center">
                  <StatusIcon status={r.status} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{r.testCase?.name || r.testCaseId}</div>
                  {r.testCase?.difficulty && (
                    <span className="text-[10px] text-muted-foreground">{r.testCase.difficulty}</span>
                  )}
                </div>
                <div className="w-24 shrink-0 flex flex-wrap gap-1">
                  {r.testCase?.labels?.slice(0, 2).map(l => (
                    <Badge key={l} variant="outline" className={`text-[9px] px-1 py-0 ${getLabelColor(l)}`}>{l}</Badge>
                  ))}
                </div>
                <div className="w-20 shrink-0 text-right">
                  {r.accuracy !== null
                    ? <span className={`text-sm font-semibold tabular-nums ${r.accuracy >= 50 ? 'text-green-500' : 'text-red-500'}`}>{r.accuracy}%</span>
                    : <span className="text-xs text-muted-foreground">—</span>}
                </div>
                <div className="w-16 shrink-0 text-right">
                  <StatusLabel status={r.status} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Run Details Flyout ─────────────────────────────────────── */}
      {flyoutResult?.report && (
        <RunDetailsFlyout
          report={flyoutResult.report}
          testCase={flyoutResult.testCase}
          onClose={() => setFlyoutResult(null)}
        />
      )}
    </div>
  );
};
