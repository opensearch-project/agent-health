/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunInspectorPage — Eval Run Inspector (handles both benchmark and SDK runs)
 *
 * Layout: Top bar (run metadata) | Left (test case list) | Right (test case detail)
 * Routes (one component, two routes):
 *   • /evaluations/benchmarks/:benchmarkId/runs/:runId/inspect  — benchmark run mode
 *   • /evaluations/runs/:runId/inspect                          — SDK eval run mode (no benchmark)
 *
 * The two surfaces used to live in separate inspect pages, which led to
 * the SDK "Run" link in EvalRunDetailPage / EvalRunsPage navigating to a
 * route that didn't exist (#247 review feedback). They share a component
 * now — same left-list + right-detail UI, same matcher panel, same
 * trace-polling recovery; only the data fetcher differs.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Clock, XCircle, Calendar, GitCompare, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncBenchmarkStorage, asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { getEvaluationRun } from '@/services/client';
import { Benchmark, BenchmarkRun, EvaluationRun, TestCase, EvaluationReport } from '@/types';
import { ResultStatus, getResultStatus, StatusIcon, StatusLabel } from './ResultStatus';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getModelName } from '@/lib/utils';
import { TestCaseInspectorPanel } from './TestCaseInspectorPanel';
import { Breadcrumbs } from './Breadcrumbs';
import { ensureTracePollingForReport } from '@/services/traces/browserRecovery';

interface TestCaseResult {
  testCaseId: string;
  testCase: TestCase | null;
  reportId: string | null;
  status: ResultStatus;
  // Populated when the report could be fetched. Used by the inspect-page-wide
  // trace-polling recovery so we don't have to re-fetch in a second effect.
  report?: EvaluationReport | null;
}


export const RunInspectorPage: React.FC = () => {
  // Either route shape resolves into one of two modes. `benchmarkId` is
  // optional — absent on the SDK eval-run route at /evaluations/runs/:runId/inspect.
  const { benchmarkId, runId } = useParams<{ benchmarkId?: string; runId: string }>();
  const navigate = useNavigate();
  // The eval-run detail page deep-links into the inspector with
  // `?reportId=<id>` so the user lands directly on the report they
  // clicked. Resolve to a testCaseId once results are loaded.
  const [searchParams] = useSearchParams();
  const targetReportId = searchParams.get('reportId');

  // `mode` is derived from the route. Benchmark mode reads from
  // asyncBenchmarkStorage and finds the run inside benchmark.runs[];
  // eval-run mode hits /api/storage/evaluation-runs/:id directly. Both
  // modes feed the same `run.results` shape into the rest of the page.
  const mode: 'benchmark' | 'evalRun' = benchmarkId ? 'benchmark' : 'evalRun';

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [run, setRun] = useState<BenchmarkRun | EvaluationRun | null>(null);
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTcId, setSelectedTcId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<EvaluationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const initialSelectionDone = React.useRef(false);

  // Load data — fetch reports to get real pass/fail status
  const loadData = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      let runData: BenchmarkRun | EvaluationRun;

      if (mode === 'benchmark') {
        if (!benchmarkId) { navigate('/evaluations/benchmarks'); return; }
        const bm = await asyncBenchmarkStorage.getById(benchmarkId);
        if (!bm) { navigate('/evaluations/benchmarks'); return; }
        setBenchmark(bm);

        const bmRun = bm.runs?.find(r => r.id === runId);
        if (!bmRun) { navigate(`/evaluations/benchmarks/${benchmarkId}/runs`); return; }
        runData = bmRun;
      } else {
        // SDK eval-run mode — no benchmark.
        try {
          runData = await getEvaluationRun(runId);
        } catch {
          navigate('/evaluations/runs');
          return;
        }
        setBenchmark(null);
      }
      setRun(runData);

      const tcIds = Object.keys(runData.results || {});
      const testCases = await asyncTestCaseStorage.getByIds(tcIds);
      const tcMap = new Map(testCases.map(tc => [tc.id, tc]));

      // Load each report to get the real pass/fail/pending status
      const resultRows: TestCaseResult[] = await Promise.all(tcIds.map(async (tcId) => {
        const runResult = runData.results[tcId];
        let report: EvaluationReport | null = null;
        if (runResult?.reportId) {
          try {
            report = await asyncRunStorage.getReportById(runResult.reportId) || null;
          } catch { /* fallback to execution status */ }
        }
        const status = getResultStatus(runResult, report);
        return { testCaseId: tcId, testCase: tcMap.get(tcId) || null, reportId: runResult?.reportId || null, status, report };
      }));

      setResults(resultRows);
      if (resultRows.length > 0 && !initialSelectionDone.current) {
        // Honor `?reportId=<id>` first — if the user arrived via a deep
        // link (e.g. "View" button on EvalRunDetailPage), select that
        // report's row. Fall back to the first row otherwise.
        const targeted = targetReportId
          ? resultRows.find(r => r.reportId === targetReportId)
          : null;
        setSelectedTcId((targeted ?? resultRows[0]).testCaseId);
        initialSelectionDone.current = true;
      }

      // Fan out trace-polling recovery for *every* pending result.
      // Without this, the user previously had to manually click each pending
      // row to mount RunDetailsContent and trigger its inline recovery — so
      // the second/third pending rows could remain stuck for hours.
      // ensureTracePollingForReport() is idempotent and a no-op for non-pending
      // reports, so this is safe to call unconditionally.
      for (const row of resultRows) {
        if (!row.report || !row.testCase) continue;
        if (row.report.metricsStatus !== 'pending' || !row.report.runId) continue;
        ensureTracePollingForReport(row.report, row.testCase, {
          onUpdated: (updated) => {
            setResults(prev => prev.map(r => r.testCaseId === row.testCaseId
              ? { ...r, report: updated, status: getResultStatus({ status: 'completed' }, updated) }
              : r
            ));
          },
        });
      }
    } catch (error) {
      console.error('Failed to load:', error);
    } finally {
      setLoading(false);
    }
  }, [benchmarkId, runId, mode, navigate, targetReportId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Sidebar collapse for run URLs is owned globally by Layout (it collapses on
  // landing on a /runs/<id> URL and persists the preset), so this page no
  // longer manages it locally.

  // Load report when selection changes
  useEffect(() => {
    if (!selectedTcId) { setSelectedReport(null); return; }
    const result = results.find(r => r.testCaseId === selectedTcId);
    if (!result?.reportId) { setSelectedReport(null); return; }
    setReportLoading(true);
    let cancelled = false;
    asyncRunStorage.getReportById(result.reportId)
      .then(report => { if (!cancelled) setSelectedReport(report || null); })
      .catch(() => { if (!cancelled) setSelectedReport(null); })
      .finally(() => { if (!cancelled) setReportLoading(false); });
    return () => { cancelled = true; };
  }, [selectedTcId, results]);

  const passCount = results.filter(r => r.status === 'passed').length;
  const failCount = results.filter(r => r.status === 'failed').length;
  // Issue #242: errored runs are evaluator failures and must be displayed
  // as their own bucket. Excluded from the pass-rate denominator below so a
  // misconfigured evaluator can't drag the score to 0%.
  const erroredCount = results.filter(r => r.status === 'errored').length;
  const totalCount = results.length;
  const judgedCount = passCount + failCount;
  const passRate = judgedCount > 0 ? Math.round((passCount / judgedCount) * 100) : 0;
  const selectedResult = results.find(r => r.testCaseId === selectedTcId) || null;

  // Loading: in benchmark mode we need both `benchmark` and `run`; in
  // eval-run mode we only need `run` (no benchmark to fetch).
  if (loading || !run || (mode === 'benchmark' && !benchmark)) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-[calc(100vh-200px)] w-full" />
      </div>
    );
  }

  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey;
  const modelName = getModelName(run.modelId);

  return (
    <div className="h-full flex flex-col">
      {/* ── Top Bar ──────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b bg-card shrink-0">
        <Breadcrumbs
          items={
            mode === 'benchmark' && benchmark
              ? [
                  { label: 'Evaluations', href: '/evaluations/benchmarks' },
                  { label: benchmark.name, href: `/evaluations/benchmarks/${benchmarkId}/runs` },
                  { label: run.name },
                ]
              : [
                  // SDK eval-run mode: no parent benchmark; root the breadcrumb
                  // at the eval-runs index so users can navigate back to the
                  // list of all runs.
                  { label: 'Evaluation Runs', href: '/evaluations/runs' },
                  { label: run.name },
                ]
          }
        />
        <div className="flex items-center justify-between mt-1">
          <h2 className="text-lg font-bold truncate">{run.name}</h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <span className="flex items-center gap-1"><Calendar size={11} /> {formatDate(run.createdAt)}</span>
            <span>{agentName}</span>
            <span>{modelName}</span>
            <span className="flex items-center gap-1">
              <span className="text-green-500 font-semibold">{passCount}✓</span>
              <span className="text-red-500 font-semibold">{failCount}✗</span>
              {erroredCount > 0 && (
                <span
                  className="flex items-center gap-0.5 text-amber-500 font-semibold ml-1"
                  title="Evaluator could not run (e.g. judge validation error). Excluded from pass-rate aggregation."
                >
                  <AlertTriangle size={11} className="shrink-0" />
                  {erroredCount}
                </span>
              )}
              <span>/ {totalCount}</span>
            </span>
            <span className={`font-semibold ${passRate >= 80 ? 'text-green-500' : passRate >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
              {passRate}%
            </span>
            {/* Compare is a test-case-level primitive and no longer requires a
                benchmark — benchmark runs deep-link with their benchmark for
                context; ad-hoc SDK/eval runs use the benchmark-free
                `/compare?runs=…` view. */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs ml-2"
              onClick={() => navigate(
                mode === 'benchmark' && benchmarkId
                  ? `/compare/${benchmarkId}?runs=${runId}`
                  : `/compare?runs=${runId}`
              )}
            >
              <GitCompare size={12} />
              Compare
            </Button>
          </div>
        </div>
      </div>

      {/* ── Left + Right Panels ──────────────────────────────────── */}
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left: Test Case List */}
        <ResizablePanel defaultSize={30} minSize={20} maxSize={45} className="border-r">
          <ScrollArea className="h-full">
            <div className="px-3 py-2 border-b">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Test Cases · {totalCount}
              </span>
            </div>
            <div className="p-1.5 space-y-0.5">
              {results.map(r => {
                const isSelected = r.testCaseId === selectedTcId;
                const tc = r.testCase;
                return (
                  <div
                    key={r.testCaseId}
                    data-testid="test-case-row"
                    data-test-case-id={r.testCaseId}
                    data-status={r.status}
                    className={`flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-blue-500/10 border-l-2 border-l-blue-500 text-foreground'
                        : 'hover:bg-muted/50 border-l-2 border-l-transparent'
                    }`}
                    onClick={() => setSelectedTcId(r.testCaseId)}
                  >
                    <StatusIcon status={r.status} size={14} />
                    <span className={`text-xs flex-1 min-w-0 truncate ${isSelected ? 'font-semibold' : 'font-medium'}`}>
                      {tc?.name || r.testCaseId}
                    </span>
                    <StatusLabel status={r.status} />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: Test Case Detail */}
        <ResizablePanel defaultSize={70} minSize={50}>
          {selectedResult ? (
            reportLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : selectedReport ? (
              <TestCaseInspectorPanel
                report={selectedReport}
                testCase={selectedResult.testCase}
                status={selectedResult.status}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  {selectedResult.status === 'running' ? (
                    <><Loader2 size={32} className="mx-auto mb-3 text-blue-500 animate-spin" /><p className="text-sm">Running agent...</p></>
                  ) : selectedResult.status === 'pending_traces' ? (
                    <><Loader2 size={32} className="mx-auto mb-3 text-amber-500 animate-spin" /><p className="text-sm">Agent done — waiting for traces...</p></>
                  ) : selectedResult.status === 'pending_judgment' ? (
                    <><Loader2 size={32} className="mx-auto mb-3 text-purple-500 animate-spin" /><p className="text-sm">Running LLM judge...</p></>
                  ) : selectedResult.status === 'pending' ? (
                    <><Clock size={32} className="mx-auto mb-3 text-muted-foreground" /><p className="text-sm">Pending</p></>
                  ) : (
                    <><XCircle size={32} className="mx-auto mb-3 opacity-20" /><p className="text-sm">No report available</p></>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">Select a test case</p>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
