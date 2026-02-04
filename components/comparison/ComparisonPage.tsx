/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { GitCompare, ArrowLeft } from 'lucide-react';
import { RunSummaryCards } from './RunSummaryCards';
import { AggregateMetricsChart } from './AggregateMetricsChart';
import { MetricsTimeSeriesChart } from './MetricsTimeSeriesChart';
import { UseCaseComparisonTable } from './UseCaseComparisonTable';
import { ComparisonSummaryBanner } from './ComparisonSummaryBanner';
import { asyncBenchmarkStorage, asyncRunStorage } from '@/services/storage';
import {
  calculateRunAggregates,
  buildTestCaseComparisonRows,
  filterRowsByCategory,
  filterRowsByStatus,
  getRealTestCaseMeta,
  countRowsByStatus,
  calculateRowStatus,
  collectRunIdsFromReports,
  RowStatus,
} from '@/services/comparisonService';
import { fetchBatchMetrics } from '@/services/metrics';
import { Category, Benchmark, BenchmarkRun, EvaluationReport, RunAggregateMetrics, TestCaseComparisonRow, TraceMetrics } from '@/types';

type StatusFilter = 'all' | 'passed' | 'failed' | 'mixed';

export const ComparisonPage: React.FC = () => {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // State for benchmark and data
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [allRuns, setAllRuns] = useState<BenchmarkRun[]>([]);
  const [reports, setReports] = useState<Record<string, EvaluationReport>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [traceMetricsMap, setTraceMetricsMap] = useState<Map<string, TraceMetrics>>(new Map());

  // State for selected runs (initialized from URL)
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  // State for filters
  const [categoryFilter, setCategoryFilter] = useState<Category | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [rowStatusFilter, setRowStatusFilter] = useState<RowStatus | 'all'>('all');

  // State for baseline selection
  const [baselineRunId, setBaselineRunId] = useState<string>('');

  // Load benchmark data
  useEffect(() => {
    const loadBenchmark = async () => {
      if (!benchmarkId) {
        navigate('/benchmarks');
        return;
      }

      const bench = await asyncBenchmarkStorage.getById(benchmarkId);
      if (!bench) {
        navigate('/benchmarks');
        return;
      }

      const runs = bench.runs || [];

      // Build reports map BEFORE setting state to avoid intermediate render
      // where benchmark is set but reports are still empty
      const reportIds = new Set<string>();
      runs.forEach(run => {
        Object.values(run.results || {}).forEach(result => {
          if (result.reportId) {
            reportIds.add(result.reportId);
          }
        });
      });

      const reportsMap: Record<string, EvaluationReport> = {};
      await Promise.all(
        Array.from(reportIds).map(async (reportId) => {
          const report = await asyncRunStorage.getReportById(reportId);
          if (report) {
            reportsMap[reportId] = report;
          }
        })
      );

      // Set all states together - React 18+ batches these automatically
      setBenchmark(bench);
      setAllRuns(runs);
      setReports(reportsMap);

      // Initialize selected runs from URL or default to all
      const urlRunIds = searchParams.get('runs')?.split(',').filter(Boolean) || [];
      if (urlRunIds.length > 0) {
        // Filter to only valid run IDs
        const validRunIds = urlRunIds.filter(id => runs.some(r => r.id === id));
        setSelectedRunIds(validRunIds.length > 0 ? validRunIds : runs.map(r => r.id));
      } else {
        // Default: select all runs
        setSelectedRunIds(runs.map(r => r.id));
      }

      setIsLoading(false);
    };

    loadBenchmark();
  }, [benchmarkId, navigate]); // Note: removed searchParams from deps to avoid re-running on URL update

  // Sync selectedRunIds when URL changes externally (e.g., browser back/forward navigation)
  useEffect(() => {
    const urlRunIds = searchParams.get('runs')?.split(',').filter(Boolean) || [];
    if (urlRunIds.length > 0 && allRuns.length > 0) {
      const validRunIds = urlRunIds.filter(id => allRuns.some(r => r.id === id));
      if (validRunIds.length > 0 && validRunIds.join(',') !== selectedRunIds.join(',')) {
        setSelectedRunIds(validRunIds);
      }
    }
  }, [searchParams, allRuns, selectedRunIds]);

  // Fetch trace metrics for all reports
  useEffect(() => {
    const loadTraceMetrics = async () => {
      const runIds = collectRunIdsFromReports(allRuns, reports);
      if (runIds.length === 0) {
        setTraceMetricsMap(new Map());
        return;
      }

      try {
        const { metrics } = await fetchBatchMetrics(runIds);
        const map = new Map<string, TraceMetrics>();
        metrics.forEach(m => {
          if (m.runId && !('error' in m)) {
            map.set(m.runId, m as TraceMetrics);
          }
        });
        setTraceMetricsMap(map);
      } catch (error) {
        console.warn('[ComparisonPage] Failed to fetch trace metrics:', error);
      }
    };

    if (allRuns.length > 0 && Object.keys(reports).length > 0) {
      loadTraceMetrics();
    }
  }, [allRuns, reports]);

  // Update URL when selection changes
  const updateSelection = (runIds: string[]) => {
    setSelectedRunIds(runIds);
    if (runIds.length > 0 && runIds.length < allRuns.length) {
      // Only update URL if not all runs are selected
      setSearchParams({ runs: runIds.join(',') }, { replace: true });
    } else if (runIds.length === allRuns.length) {
      // Clear URL param if all are selected (default state)
      setSearchParams({}, { replace: true });
    }
  };

  // Get selected runs
  const selectedRuns = useMemo((): BenchmarkRun[] => {
    return allRuns.filter(r => selectedRunIds.includes(r.id));
  }, [allRuns, selectedRunIds]);

  // Calculate aggregate metrics for selected runs (with trace metrics)
  const runAggregates = useMemo((): RunAggregateMetrics[] => {
    return selectedRuns.map(run => {
      const baseAggregates = calculateRunAggregates(run, reports);

      // Aggregate trace metrics from all reports in this run
      let totalTokens = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostUsd = 0;
      let totalDurationMs = 0;
      let totalLlmCalls = 0;
      let totalToolCalls = 0;
      let metricsCount = 0;

      for (const result of Object.values(run.results)) {
        const report = reports[result.reportId];
        if (report?.runId) {
          const traceMetrics = traceMetricsMap.get(report.runId);
          if (traceMetrics) {
            totalTokens += traceMetrics.totalTokens || 0;
            totalInputTokens += traceMetrics.inputTokens || 0;
            totalOutputTokens += traceMetrics.outputTokens || 0;
            totalCostUsd += traceMetrics.costUsd || 0;
            totalDurationMs += traceMetrics.durationMs || 0;
            totalLlmCalls += traceMetrics.llmCalls || 0;
            totalToolCalls += traceMetrics.toolCalls || 0;
            metricsCount++;
          }
        }
      }

      return {
        ...baseAggregates,
        totalTokens: metricsCount > 0 ? totalTokens : undefined,
        totalInputTokens: metricsCount > 0 ? totalInputTokens : undefined,
        totalOutputTokens: metricsCount > 0 ? totalOutputTokens : undefined,
        totalCostUsd: metricsCount > 0 ? totalCostUsd : undefined,
        avgDurationMs: metricsCount > 0 ? Math.round(totalDurationMs / metricsCount) : undefined,
        totalLlmCalls: metricsCount > 0 ? totalLlmCalls : undefined,
        totalToolCalls: metricsCount > 0 ? totalToolCalls : undefined,
      };
    });
  }, [selectedRuns, reports, traceMetricsMap]);

  // Build comparison rows
  const allComparisonRows = useMemo((): TestCaseComparisonRow[] => {
    return buildTestCaseComparisonRows(selectedRuns, reports, getRealTestCaseMeta);
  }, [selectedRuns, reports]);

  // Initialize baseline to first selected run if not set or invalid
  useEffect(() => {
    if (selectedRunIds.length > 0 && (!baselineRunId || !selectedRunIds.includes(baselineRunId))) {
      setBaselineRunId(selectedRunIds[0]);
    }
  }, [selectedRunIds, baselineRunId]);

  // Count rows by status for summary banner
  const rowStatusCounts = useMemo(() => {
    return countRowsByStatus(allComparisonRows, baselineRunId);
  }, [allComparisonRows, baselineRunId]);

  // Apply filters
  const filteredRows = useMemo((): TestCaseComparisonRow[] => {
    let rows = allComparisonRows;
    rows = filterRowsByCategory(rows, categoryFilter);
    rows = filterRowsByStatus(rows, statusFilter, selectedRunIds);

    // Apply row status filter (regression/improvement/mixed/neutral)
    if (rowStatusFilter !== 'all') {
      rows = rows.filter(row => calculateRowStatus(row, baselineRunId) === rowStatusFilter);
    }

    return rows;
  }, [allComparisonRows, categoryFilter, statusFilter, selectedRunIds, rowStatusFilter, baselineRunId]);

  // Get unique categories from rows
  const categories = useMemo(() => {
    const cats = new Set(allComparisonRows.map(r => r.category));
    return Array.from(cats).sort();
  }, [allComparisonRows]);

  // Toggle run selection
  const toggleRun = (runId: string) => {
    const newSelection = selectedRunIds.includes(runId)
      ? selectedRunIds.filter(id => id !== runId)
      : [...selectedRunIds, runId];

    // Don't allow less than 2 runs
    if (newSelection.length >= 2 || newSelection.length > selectedRunIds.length) {
      updateSelection(newSelection);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!benchmark) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-muted-foreground">Benchmark not found</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="comparison-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(`/benchmarks/${benchmarkId}/runs`)}
            data-testid="back-button"
          >
            <ArrowLeft size={18} />
          </Button>
          <GitCompare className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold" data-testid="comparison-title">Compare Runs</h1>
            <p className="text-xs text-muted-foreground">{benchmark.name}</p>
          </div>
        </div>
        <Badge variant="outline" className="text-xs">
          {selectedRunIds.length} of {allRuns.length} runs selected
        </Badge>
      </div>

      {/* Run Selector */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Select Runs to Compare</CardTitle>
            {selectedRunIds.length >= 2 && (
              <div className="flex items-center gap-2">
                <Label className="text-sm text-muted-foreground">Baseline:</Label>
                <Select value={baselineRunId} onValueChange={setBaselineRunId}>
                  <SelectTrigger className="w-40 h-8">
                    <SelectValue placeholder="Select baseline" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedRuns.map((run) => (
                      <SelectItem key={run.id} value={run.id}>
                        {run.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            {allRuns.map((run) => {
              const isSelected = selectedRunIds.includes(run.id);
              const canDeselect = selectedRunIds.length > 2;

              return (
                <div key={run.id} className="flex items-center gap-2">
                  <Checkbox
                    id={run.id}
                    checked={isSelected}
                    onCheckedChange={() => toggleRun(run.id)}
                    disabled={isSelected && !canDeselect}
                  />
                  <Label
                    htmlFor={run.id}
                    className="text-sm cursor-pointer"
                  >
                    {run.name}
                  </Label>
                </div>
              );
            })}
          </div>
          {selectedRunIds.length <= 2 && (
            <p className="text-xs text-muted-foreground mt-2">
              At least 2 runs must be selected for comparison
            </p>
          )}
        </CardContent>
      </Card>

      {/* Run Summary Cards */}
      {selectedRuns.length >= 2 && (
        <>
          <section>
            <h2 className="text-lg font-medium mb-4">Run Summary</h2>
            <RunSummaryCards runs={runAggregates} baselineRunId={baselineRunId} />
          </section>

          {/* Metrics Section - Side by Side */}
          <section>
            <h2 className="text-lg font-medium mb-4">Metrics</h2>
            <div className="flex flex-col md:flex-row gap-6">
              <div className="w-full md:w-[420px] flex-shrink-0">
                <AggregateMetricsChart runs={runAggregates} height={300} baselineRunId={baselineRunId} />
              </div>
              <div className="flex-1 min-w-0">
                <MetricsTimeSeriesChart runs={runAggregates} height={300} />
              </div>
            </div>
          </section>

          {/* Summary Banner with regression/improvement counts */}
          <ComparisonSummaryBanner
            counts={rowStatusCounts}
            onFilterClick={(status) => setRowStatusFilter(status)}
            activeFilter={rowStatusFilter}
          />

          {/* Per Use Case Comparison */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium">Per Use Case Comparison</h2>
              <div className="flex items-center gap-4">
                <Select
                  value={categoryFilter}
                  onValueChange={(v) => setCategoryFilter(v as Category | 'all')}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Filter by category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map(cat => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as StatusFilter)}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue placeholder="Filter by status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="passed">All Passed</SelectItem>
                    <SelectItem value="failed">Has Failed</SelectItem>
                    <SelectItem value="mixed">Mixed Results</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <UseCaseComparisonTable rows={filteredRows} runs={selectedRuns} reports={reports} baselineRunId={baselineRunId} />
            {filteredRows.length === 0 && allComparisonRows.length > 0 && (
              <p className="text-sm text-muted-foreground text-center mt-4">
                No use cases match the current filters
              </p>
            )}
          </section>
        </>
      )}

      {selectedRuns.length < 2 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-muted-foreground">
            <GitCompare className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Select at least 2 runs to compare</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
