/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunInspectorPage — Eval Run Inspector
 *
 * Layout: Top bar (run metadata) | Left (test case list) | Right (test case detail)
 * Route: /evaluations/benchmarks/:benchmarkId/runs/:runId/inspect
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, Clock, XCircle, Calendar, GitCompare } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { asyncBenchmarkStorage, asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { Benchmark, BenchmarkRun, TestCase, EvaluationReport } from '@/types';
import { ResultStatus, getResultStatus, StatusIcon, StatusLabel } from './ResultStatus';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getModelName } from '@/lib/utils';
import { TestCaseInspectorPanel } from './TestCaseInspectorPanel';
import { Breadcrumbs } from './Breadcrumbs';

interface TestCaseResult {
  testCaseId: string;
  testCase: TestCase | null;
  reportId: string | null;
  status: ResultStatus;
}


export const RunInspectorPage: React.FC = () => {
  const { benchmarkId, runId } = useParams<{ benchmarkId: string; runId: string }>();
  const navigate = useNavigate();

  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTcId, setSelectedTcId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<EvaluationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const initialSelectionDone = React.useRef(false);

  // Load data — fetch reports to get real pass/fail status
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

      const tcIds = Object.keys(bmRun.results || {});
      const testCases = await asyncTestCaseStorage.getByIds(tcIds);
      const tcMap = new Map(testCases.map(tc => [tc.id, tc]));

      // Load each report to get the real pass/fail/pending status
      const resultRows: TestCaseResult[] = await Promise.all(tcIds.map(async (tcId) => {
        const runResult = bmRun.results[tcId];
        let report: EvaluationReport | null = null;
        if (runResult?.reportId) {
          try {
            report = await asyncRunStorage.getReportById(runResult.reportId) || null;
          } catch { /* fallback to execution status */ }
        }
        const status = getResultStatus(runResult, report);
        return { testCaseId: tcId, testCase: tcMap.get(tcId) || null, reportId: runResult?.reportId || null, status };
      }));

      setResults(resultRows);
      if (resultRows.length > 0 && !initialSelectionDone.current) {
        setSelectedTcId(resultRows[0].testCaseId);
        initialSelectionDone.current = true;
      }
    } catch (error) {
      console.error('Failed to load:', error);
    } finally {
      setLoading(false);
    }
  }, [benchmarkId, runId, navigate]);

  useEffect(() => { loadData(); }, [loadData]);

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
  const totalCount = results.length;
  const judgedCount = passCount + failCount;
  const passRate = judgedCount > 0 ? Math.round((passCount / judgedCount) * 100) : 0;
  const selectedResult = results.find(r => r.testCaseId === selectedTcId) || null;

  if (loading || !benchmark || !run) {
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
          items={[
            { label: 'Evaluations', href: '/evaluations/benchmarks' },
            { label: benchmark.name, href: `/evaluations/benchmarks/${benchmarkId}/runs` },
            { label: run.name },
          ]}
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
              <span>/ {totalCount}</span>
            </span>
            <span className={`font-semibold ${passRate >= 80 ? 'text-green-500' : passRate >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
              {passRate}%
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs ml-2"
              onClick={() => navigate(`/compare/${benchmarkId}?runs=${runId}`)}
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
