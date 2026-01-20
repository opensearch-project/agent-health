/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, XCircle, Eye, GitCompare, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Benchmark, BenchmarkRun, EvaluationReport, TestCase } from '@/types';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { UseCaseCompareView } from './UseCaseCompareView';
import { BenchmarkSummaryCharts } from './benchmarks/BenchmarkSummaryCharts';
import { formatDate } from '@/lib/utils';

interface BenchmarkResultsViewProps {
  benchmark: Benchmark;
  onBack: () => void;
}

export const BenchmarkResultsView: React.FC<BenchmarkResultsViewProps> = ({
  benchmark,
  onBack,
}) => {
  const navigate = useNavigate();
  const [reports, setReports] = useState<Record<string, EvaluationReport | null>>({});
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [showUseCaseCompare, setShowUseCaseCompare] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Load test cases on mount
  useEffect(() => {
    asyncTestCaseStorage.getAll().then(setTestCases);
  }, []);

  // Load all reports referenced by all runs
  useEffect(() => {
    const loadReports = async () => {
      setIsLoading(true);
      try {
        const reportIds = new Set<string>();
        benchmark.runs?.forEach(run => {
          Object.values(run.results || {}).forEach(result => {
            if (result.reportId) {
              reportIds.add(result.reportId);
            }
          });
        });

        const loadedReports: Record<string, EvaluationReport | null> = {};
        await Promise.all(
          Array.from(reportIds).map(async (reportId) => {
            loadedReports[reportId] = await asyncRunStorage.getReportById(reportId);
          })
        );

        setReports(loadedReports);
      } finally {
        setIsLoading(false);
      }
    };

    loadReports();
  }, [benchmark]);

  const getUseCaseName = useCallback((useCaseId: string) => {
    const tc = testCases.find(t => t.id === useCaseId);
    return tc?.name || useCaseId;
  }, [testCases]);

  // Calculate summary stats per run
  const calculateRunStats = (run: BenchmarkRun) => {
    let totalAccuracy = 0;
    let passCount = 0;
    let totalCount = 0;

    Object.entries(run.results || {}).forEach(([useCaseId, result]) => {
      if (result.reportId && result.status === 'completed') {
        const report = reports[result.reportId];
        if (report && report.status === 'completed') {
          totalAccuracy += report.metrics?.accuracy ?? 0;
          if (report.passFailStatus === 'passed') passCount++;
          totalCount++;
        }
      }
    });

    return {
      avgAccuracy: totalCount > 0 ? Math.round(totalAccuracy / totalCount) : 0,
      passCount,
      failCount: totalCount - passCount,
      totalCount,
      passRate: `${passCount}/${totalCount}`,
      passRatePercent: totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 0,
    };
  };

  const hasMultipleRuns = benchmark.runs && benchmark.runs.length > 1;
  const hasAnyResults = benchmark.runs?.some(run =>
    Object.values(run.results || {}).some(r => r.status === 'completed')
  );

  if (!hasAnyResults) {
    return (
      <div className="p-6 h-full flex flex-col">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-bold">{benchmark.name}</h2>
            <p className="text-xs text-muted-foreground">No results yet</p>
          </div>
        </div>
        <Card className="flex-1">
          <CardContent className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <p className="text-lg">No results available</p>
            <p className="text-sm">Run this benchmark to see results</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get the most recent run with results
  const latestRun = benchmark.runs?.reduce((latest, run) => {
    if (!latest) return run;
    return new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest;
  }, null as BenchmarkRun | null);

  return (
    <>
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-bold">{benchmark.name}</h2>
            <p className="text-xs text-muted-foreground">
              {benchmark.runs?.length || 0} run{benchmark.runs?.length !== 1 ? 's' : ''}
              {latestRun && ` · Latest: ${formatDate(latestRun.createdAt)}`}
            </p>
          </div>
        </div>
        {hasMultipleRuns && (
          <Button variant="outline" onClick={() => navigate(`/compare/${benchmark.id}`)}>
            <GitCompare size={16} className="mr-2" />
            Compare Runs
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-6 pr-4">
          {/* Visual Summary Charts */}
          {benchmark.runs && benchmark.runs.length > 0 && (
            <BenchmarkSummaryCharts
              runs={benchmark.runs}
              reports={reports}
            />
          )}

          {/* Summary Section (only for multiple runs) */}
          {hasMultipleRuns && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Summary by Run</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 pr-4"></th>
                        {benchmark.runs?.map(run => (
                          <th key={run.id} className="text-center py-2 px-4">
                            {run.name}
                          </th>
                        ))}
                        {benchmark.runs?.length === 2 && (
                          <th className="text-center py-2 px-4">Diff</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2 pr-4 text-muted-foreground">Avg Accuracy</td>
                        {benchmark.runs?.map(run => {
                          const stats = calculateRunStats(run);
                          return (
                            <td key={run.id} className="text-center py-2 px-4 font-medium">
                              {stats.avgAccuracy}%
                            </td>
                          );
                        })}
                        {benchmark.runs?.length === 2 && (
                          <td className="text-center py-2 px-4">
                            {(() => {
                              const s1 = calculateRunStats(benchmark.runs[0]);
                              const s2 = calculateRunStats(benchmark.runs[1]);
                              const diff = s2.avgAccuracy - s1.avgAccuracy;
                              return (
                                <span className={diff > 0 ? 'text-opensearch-blue' : diff < 0 ? 'text-red-400' : ''}>
                                  {diff > 0 ? '+' : ''}{diff}%
                                </span>
                              );
                            })()}
                          </td>
                        )}
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 pr-4 text-muted-foreground">Pass Rate</td>
                        {benchmark.runs?.map(run => {
                          const stats = calculateRunStats(run);
                          return (
                            <td key={run.id} className="text-center py-2 px-4 font-medium">
                              {stats.passRatePercent}%
                            </td>
                          );
                        })}
                        {benchmark.runs?.length === 2 && (
                          <td className="text-center py-2 px-4">
                            {(() => {
                              const s1 = calculateRunStats(benchmark.runs[0]);
                              const s2 = calculateRunStats(benchmark.runs[1]);
                              const diff = s2.passRatePercent - s1.passRatePercent;
                              return (
                                <span className={diff > 0 ? 'text-opensearch-blue' : diff < 0 ? 'text-red-400' : ''}>
                                  {diff > 0 ? '+' : ''}{diff}%
                                </span>
                              );
                            })()}
                          </td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Per Use Case Breakdown */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase">
              Per Use Case Breakdown
            </h3>

            {benchmark.testCaseIds.map(useCaseId => {
              const useCase = testCases.find(t => t.id === useCaseId);

              return (
                <Card key={useCaseId}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h4 className="font-medium">{getUseCaseName(useCaseId)}</h4>
                        {useCase && (
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs">
                              {useCase.difficulty}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {useCase.category}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {hasMultipleRuns && (
                          <Button variant="outline" size="sm">
                            <GitCompare size={12} className="mr-1" />
                            Compare Trajectories
                          </Button>
                        )}
                        <Button variant="outline" size="sm">
                          <Eye size={12} className="mr-1" />
                          View Reports
                        </Button>
                      </div>
                    </div>

                    {/* Run Results Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-2 pr-4"></th>
                            {benchmark.runs?.map(run => (
                              <th key={run.id} className="text-center py-2 px-4">
                                {run.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b">
                            <td className="py-2 pr-4 text-muted-foreground">Status</td>
                            {benchmark.runs?.map(run => {
                              const result = run.results?.[useCaseId];
                              const report = result?.reportId ? reports[result.reportId] : null;
                              return (
                                <td key={run.id} className="text-center py-2 px-4">
                                  {report?.passFailStatus === 'passed' ? (
                                    <span className="inline-flex items-center gap-1 text-opensearch-blue">
                                      <CheckCircle2 size={14} /> PASSED
                                    </span>
                                  ) : report?.passFailStatus === 'failed' ? (
                                    <span className="inline-flex items-center gap-1 text-red-400">
                                      <XCircle size={14} /> FAILED
                                    </span>
                                  ) : result?.status === 'running' ? (
                                    <span className="text-muted-foreground">Running...</span>
                                  ) : (
                                    <span className="text-muted-foreground">-</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                          <tr className="border-b">
                            <td className="py-2 pr-4 text-muted-foreground">Accuracy</td>
                            {benchmark.runs?.map(run => {
                              const result = run.results?.[useCaseId];
                              const report = result?.reportId ? reports[result.reportId] : null;
                              return (
                                <td key={run.id} className="text-center py-2 px-4 font-medium">
                                  {report ? `${report.metrics?.accuracy ?? 0}%` : '-'}
                                </td>
                              );
                            })}
                          </tr>
                          <tr>
                            <td className="py-2 pr-4 text-muted-foreground">Steps</td>
                            {benchmark.runs?.map(run => {
                              const result = run.results?.[useCaseId];
                              const report = result?.reportId ? reports[result.reportId] : null;
                              return (
                                <td key={run.id} className="text-center py-2 px-4 font-medium">
                                  {report ? report.trajectory.length : '-'}
                                </td>
                              );
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>

    {/* Use Case Compare Modal */}
    {showUseCaseCompare && (
      <UseCaseCompareView
        benchmark={benchmark}
        onClose={() => setShowUseCaseCompare(false)}
      />
    )}
    </>
  );
};

// Backwards compatibility alias
/** @deprecated Use BenchmarkResultsView instead */
export const ExperimentResultsView = BenchmarkResultsView;
