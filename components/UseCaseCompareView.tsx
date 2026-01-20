/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { X, CheckCircle2, XCircle, GitCompare, Lightbulb } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Benchmark, BenchmarkRun, EvaluationReport, TestCase } from '@/types';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { TrajectoryCompareView } from './TrajectoryCompareView';

interface UseCaseCompareViewProps {
  benchmark: Benchmark;
  onClose: () => void;
}

export const UseCaseCompareView: React.FC<UseCaseCompareViewProps> = ({
  benchmark,
  onClose,
}) => {
  const [reports, setReports] = useState<Record<string, EvaluationReport | null>>({});
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [selectedUseCases, setSelectedUseCases] = useState<[string, string] | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string>(
    benchmark.runs?.[0]?.id || ''
  );
  const [showTrajectoryCompare, setShowTrajectoryCompare] = useState(false);

  // Load test cases on mount
  useEffect(() => {
    asyncTestCaseStorage.getAll().then(setTestCases);
  }, []);

  // Load all reports referenced by all runs
  useEffect(() => {
    const loadReports = async () => {
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
    };

    loadReports();
  }, [benchmark]);

  const getUseCase = useCallback((useCaseId: string): TestCase | undefined => {
    return testCases.find(tc => tc.id === useCaseId);
  }, [testCases]);

  const getReportForUseCase = (useCaseId: string, runId: string): EvaluationReport | null => {
    const run = benchmark.runs?.find(r => r.id === runId);
    if (!run) return null;

    const result = run.results?.[useCaseId];
    if (!result?.reportId) return null;

    return reports[result.reportId] || null;
  };

  const handleToggleUseCase = (useCaseId: string) => {
    setSelectedUseCases(prev => {
      if (!prev) return [useCaseId, ''] as [string, string];
      if (prev[0] === useCaseId) return [prev[1], ''] as [string, string];
      if (prev[1] === useCaseId) return [prev[0], ''] as [string, string];
      if (!prev[0]) return [useCaseId, prev[1]] as [string, string];
      if (!prev[1]) return [prev[0], useCaseId] as [string, string];
      // Replace the second one
      return [prev[0], useCaseId] as [string, string];
    });
  };

  const selectedUseCaseA = selectedUseCases?.[0] ? getUseCase(selectedUseCases[0]) : null;
  const selectedUseCaseB = selectedUseCases?.[1] ? getUseCase(selectedUseCases[1]) : null;
  const reportA = selectedUseCases?.[0] ? getReportForUseCase(selectedUseCases[0], selectedRunId) : null;
  const reportB = selectedUseCases?.[1] ? getReportForUseCase(selectedUseCases[1], selectedRunId) : null;

  const canCompare = selectedUseCases && selectedUseCases[0] && selectedUseCases[1] && reportA && reportB;

  // Generate insight based on comparison
  const generateInsight = (): string | null => {
    if (!reportA || !reportB || !selectedUseCaseA || !selectedUseCaseB) return null;

    const accDiff = reportA.metrics.accuracy - reportB.metrics.accuracy;

    if (Math.abs(accDiff) < 5) {
      return 'Both use cases show similar accuracy levels, suggesting consistent agent performance.';
    }

    const higherCase = accDiff > 0 ? selectedUseCaseA : selectedUseCaseB;
    const lowerCase = accDiff > 0 ? selectedUseCaseB : selectedUseCaseA;

    if (higherCase.subcategory?.toLowerCase().includes('with') && lowerCase.subcategory?.toLowerCase().includes('without')) {
      return `Providing additional context improves accuracy by ${Math.abs(accDiff)}%.`;
    }

    if (higherCase.difficulty === 'Easy' && lowerCase.difficulty === 'Hard') {
      return `Difficulty level significantly impacts performance (${Math.abs(accDiff)}% difference).`;
    }

    return `There is a ${Math.abs(accDiff)}% accuracy difference between these use cases.`;
  };

  const selectedRun = benchmark.runs?.find(r => r.id === selectedRunId);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <Card className="w-full max-w-4xl max-h-[90vh] flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle>Compare Use Cases</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Benchmark: {benchmark.name}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X size={18} />
            </Button>
          </CardHeader>

          {/* Run Selector */}
          {benchmark.runs && benchmark.runs.length > 1 && (
            <div className="px-6 pb-4 border-b">
              <label className="text-xs text-muted-foreground uppercase font-semibold block mb-2">
                Comparing for Run:
              </label>
              <div className="flex gap-2">
                {benchmark.runs.map(run => (
                  <Button
                    key={run.id}
                    variant={selectedRunId === run.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    {run.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <CardContent className="flex-1 overflow-hidden p-0">
            <div className="grid grid-cols-2 h-full">
              {/* Left: Use Case Selection */}
              <div className="border-r p-4">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase mb-4">
                  Select two use cases to compare
                </h4>
                <ScrollArea className="h-[50vh]">
                  <div className="space-y-2 pr-4">
                    {benchmark.testCaseIds.map(useCaseId => {
                      const useCase = getUseCase(useCaseId);
                      const report = getReportForUseCase(useCaseId, selectedRunId);
                      const isSelected = selectedUseCases?.includes(useCaseId);

                      return (
                        <div
                          key={useCaseId}
                          className={`p-3 rounded border cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-blue-500/10 border-blue-500/50'
                              : 'bg-muted/30 border-border hover:border-muted-foreground/30'
                          }`}
                          onClick={() => handleToggleUseCase(useCaseId)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                                isSelected ? 'border-blue-500 bg-blue-500' : 'border-muted-foreground'
                              }`}>
                                {isSelected && <CheckCircle2 size={10} className="text-white" />}
                              </div>
                              <span className="font-medium text-sm">{useCase?.name || useCaseId}</span>
                            </div>
                            {report?.passFailStatus === 'passed' ? (
                              <Badge className="bg-opensearch-blue/20 text-opensearch-blue text-xs">PASSED</Badge>
                            ) : report?.passFailStatus === 'failed' ? (
                              <Badge className="bg-red-500/20 text-red-400 text-xs">FAILED</Badge>
                            ) : null}
                          </div>
                          {useCase && (
                            <div className="flex items-center gap-2 mt-1 ml-6">
                              <Badge variant="outline" className="text-xs">
                                {useCase.difficulty}
                              </Badge>
                              {useCase.subcategory && (
                                <span className="text-xs text-muted-foreground">
                                  {useCase.subcategory}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>

              {/* Right: Comparison Results */}
              <div className="p-4">
                {canCompare ? (
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase">
                      Comparison Results
                      {selectedRun && <span className="normal-case font-normal"> ({selectedRun.name})</span>}
                    </h4>

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-2 pr-4"></th>
                            <th className="text-center py-2 px-2 text-xs">{selectedUseCaseA?.name?.split(' - ')[1] || 'Use Case A'}</th>
                            <th className="text-center py-2 px-2 text-xs">{selectedUseCaseB?.name?.split(' - ')[1] || 'Use Case B'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b">
                            <td className="py-2 pr-4 text-muted-foreground">Status</td>
                            <td className="text-center py-2 px-2">
                              {reportA.passFailStatus === 'passed' ? (
                                <span className="inline-flex items-center gap-1 text-opensearch-blue">
                                  <CheckCircle2 size={12} /> PASSED
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-red-400">
                                  <XCircle size={12} /> FAILED
                                </span>
                              )}
                            </td>
                            <td className="text-center py-2 px-2">
                              {reportB.passFailStatus === 'passed' ? (
                                <span className="inline-flex items-center gap-1 text-opensearch-blue">
                                  <CheckCircle2 size={12} /> PASSED
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-red-400">
                                  <XCircle size={12} /> FAILED
                                </span>
                              )}
                            </td>
                          </tr>
                          <tr className="border-b">
                            <td className="py-2 pr-4 text-muted-foreground">Accuracy</td>
                            <td className="text-center py-2 px-2 font-medium">{reportA.metrics.accuracy}%</td>
                            <td className="text-center py-2 px-2 font-medium">{reportB.metrics.accuracy}%</td>
                          </tr>
                          <tr className="border-b">
                            <td className="py-2 pr-4 text-muted-foreground">Faithfulness</td>
                            <td className="text-center py-2 px-2 font-medium">{reportA.metrics.faithfulness}%</td>
                            <td className="text-center py-2 px-2 font-medium">{reportB.metrics.faithfulness}%</td>
                          </tr>
                          <tr>
                            <td className="py-2 pr-4 text-muted-foreground">Steps</td>
                            <td className="text-center py-2 px-2 font-medium">{reportA.trajectory.length}</td>
                            <td className="text-center py-2 px-2 font-medium">{reportB.trajectory.length}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Insight */}
                    {generateInsight() && (
                      <Card className="bg-amber-500/10 border-amber-500/30">
                        <CardContent className="p-3">
                          <div className="flex items-start gap-2">
                            <Lightbulb size={16} className="text-amber-400 mt-0.5" />
                            <p className="text-sm">{generateInsight()}</p>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    <Button
                      className="w-full"
                      onClick={() => setShowTrajectoryCompare(true)}
                    >
                      <GitCompare size={16} className="mr-2" />
                      Compare Trajectories
                    </Button>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                    <GitCompare size={48} className="mb-4 opacity-20" />
                    <p>Select two use cases to compare</p>
                    <p className="text-sm">Click on use cases from the list</p>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Trajectory Compare Modal */}
      {showTrajectoryCompare && reportA && reportB && selectedUseCaseA && selectedUseCaseB && (
        <TrajectoryCompareView
          leftReport={reportA}
          rightReport={reportB}
          leftLabel={selectedUseCaseA.name}
          rightLabel={selectedUseCaseB.name}
          title={`Compare: ${selectedUseCaseA.name} vs ${selectedUseCaseB.name}`}
          onClose={() => setShowTrajectoryCompare(false)}
        />
      )}
    </>
  );
};
