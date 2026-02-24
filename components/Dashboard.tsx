/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Rocket, X, Info, HelpCircle } from 'lucide-react';
import { asyncRunStorage, asyncExperimentStorage } from '@/services/storage';
import { EvaluationReport, Benchmark } from '@/types';
import { fetchBatchMetrics } from '@/services/metrics';
import { AgentTrendChart, TrendMetric } from './charts/AgentTrendChart';
import { MetricsTable } from './dashboard/MetricsTable';
import { WorkflowNavigator } from './dashboard/WorkflowNavigator';
import { FirstRunExperience } from './dashboard/FirstRunExperience';
import { useDataState } from '@/hooks/useDataState';
import { isSampleDataActive } from '@/config/sampleData';
import {
  aggregateMetricsByDate,
  aggregateMetricsByBenchmarkAgent,
  getUniqueAgents,
  getAgentDisplayName,
  DashboardFilter,
  TimeRange,
  TrendDataPoint,
  BenchmarkAgentMetrics,
} from '@/lib/dashboardMetrics';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

// ==================== Skeleton Components ====================

const ChartSkeleton = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-6 w-[180px]" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-[120px]" />
        <Skeleton className="h-9 w-[120px]" />
      </div>
    </div>
    <Skeleton className="h-[300px] w-full" />
  </div>
);

const TableSkeleton = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-6 w-[200px]" />
    </div>
    <div className="space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  </div>
);

const DashboardSkeleton = () => (
  <div className="space-y-8">
    <ChartSkeleton />
    <TableSkeleton />
  </div>
);

// ==================== Empty State ====================

const EmptyState = () => (
  <Alert>
    <Rocket />
    <AlertTitle>Welcome to Leaderboard Overview</AlertTitle>
    <AlertDescription>
      <p className="mb-4">
        Track agent performance across benchmarks with trend analysis and metrics comparison.
      </p>
      <div className="space-y-3 mb-4">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="rounded-full h-6 w-6 p-0 justify-center shrink-0">1</Badge>
          <span className="text-sm">Create a benchmark with test cases</span>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="rounded-full h-6 w-6 p-0 justify-center shrink-0">2</Badge>
          <span className="text-sm">Run benchmark evaluations with different agents</span>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="rounded-full h-6 w-6 p-0 justify-center shrink-0">3</Badge>
          <span className="text-sm">View performance trends and compare metrics here</span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button asChild size="sm">
          <Link to="/benchmarks">Create Benchmark</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/test-cases">Manage Test Cases</Link>
        </Button>
      </div>
    </AlertDescription>
  </Alert>
);

// ==================== Filter Chips ====================

interface FilterChipsProps {
  filters: DashboardFilter;
  benchmarks: Benchmark[];
  onRemoveFilter: (type: 'benchmarkId' | 'agentKey') => void;
  onClearAll: () => void;
}

const FilterChips: React.FC<FilterChipsProps> = ({
  filters,
  benchmarks,
  onRemoveFilter,
  onClearAll,
}) => {
  const hasFilters = filters.benchmarkId || filters.agentKey;

  if (!hasFilters) return null;

  const benchmarkName = filters.benchmarkId
    ? benchmarks.find(b => b.id === filters.benchmarkId)?.name || filters.benchmarkId
    : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-muted-foreground">Active filters:</span>
      {benchmarkName && (
        <Badge variant="secondary" className="gap-1">
          {benchmarkName}
          <button
            onClick={() => onRemoveFilter('benchmarkId')}
            className="ml-1 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      )}
      {filters.agentKey && (
        <Badge variant="secondary" className="gap-1">
          {getAgentDisplayName(filters.agentKey)}
          <button
            onClick={() => onRemoveFilter('agentKey')}
            className="ml-1 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      )}
      <Button variant="ghost" size="sm" onClick={onClearAll} className="text-xs h-6">
        Clear All
      </Button>
    </div>
  );
};

// ==================== Main Dashboard Component ====================

const WORKFLOW_CARD_HIDDEN_KEY = 'agent-health-workflow-card-hidden';

export const Dashboard: React.FC = () => {
  // Check data state for conditional rendering
  const { dataState, isLoading: isCheckingData } = useDataState();

  const [isLoading, setIsLoading] = useState(true);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [metricsMap, setMetricsMap] = useState<Map<string, { costUsd: number; durationMs: number; tokens: number }>>(new Map());
  
  // Workflow card visibility state
  const [isWorkflowCardHidden, setIsWorkflowCardHidden] = useState(false);
  
  // Check if sample data is active
  const isSampleMode = isSampleDataActive();

  // Filter state
  const [filters, setFilters] = useState<DashboardFilter>({});
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [selectedMetric, setSelectedMetric] = useState<TrendMetric>('passRate');

  // Initialize workflow card visibility from localStorage
  useEffect(() => {
    const hidden = localStorage.getItem(WORKFLOW_CARD_HIDDEN_KEY) === 'true';
    setIsWorkflowCardHidden(hidden);

    // Listen for workflow card hidden event
    const handleWorkflowCardHidden = () => {
      setIsWorkflowCardHidden(true);
    };

    window.addEventListener('workflow-card-hidden', handleWorkflowCardHidden);
    return () => {
      window.removeEventListener('workflow-card-hidden', handleWorkflowCardHidden);
    };
  }, []);

  const handleShowWorkflowCard = () => {
    localStorage.setItem(WORKFLOW_CARD_HIDDEN_KEY, 'false');
    setIsWorkflowCardHidden(false);
  };

  useEffect(() => {
    const loadDashboardData = async () => {
      setIsLoading(true);
      try {
        // Load benchmarks
        const allBenchmarks = await asyncExperimentStorage.getAll();
        setBenchmarks(allBenchmarks);

        // Load all reports
        const allReports = await asyncRunStorage.getAllReports({ sortBy: 'timestamp', order: 'desc' });
        setReports(allReports);

        // Fetch metrics for all reports with runIds
        const runIds = allReports.filter(r => r.runId).map(r => r.runId!);
        if (runIds.length > 0) {
          try {
            const { metrics } = await fetchBatchMetrics(runIds);
            const newMetricsMap = new Map<string, { costUsd: number; durationMs: number; tokens: number }>();

            for (const m of metrics) {
              newMetricsMap.set(m.runId, {
                costUsd: m.costUsd,
                durationMs: m.durationMs,
                tokens: m.totalTokens,
              });
            }

            setMetricsMap(newMetricsMap);
          } catch (error) {
            console.warn('[Dashboard] Failed to fetch metrics:', error);
          }
        }
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadDashboardData();
  }, []);

  // Compute aggregated data
  const trendData = useMemo<TrendDataPoint[]>(() => {
    return aggregateMetricsByDate(benchmarks, reports, metricsMap, filters, timeRange);
  }, [benchmarks, reports, metricsMap, filters, timeRange]);

  const tableData = useMemo<BenchmarkAgentMetrics[]>(() => {
    return aggregateMetricsByBenchmarkAgent(benchmarks, reports, metricsMap);
  }, [benchmarks, reports, metricsMap]);

  const agents = useMemo(() => {
    return getUniqueAgents(benchmarks);
  }, [benchmarks]);

  // Filter handlers
  const handleBenchmarkClick = (benchmarkId: string) => {
    setFilters(prev => ({
      ...prev,
      benchmarkId: prev.benchmarkId === benchmarkId ? undefined : benchmarkId,
    }));
  };

  const handleAgentClick = (agentKey: string) => {
    setFilters(prev => ({
      ...prev,
      agentKey: prev.agentKey === agentKey ? undefined : agentKey,
    }));
  };

  const handleRemoveFilter = (type: 'benchmarkId' | 'agentKey') => {
    setFilters(prev => ({
      ...prev,
      [type]: undefined,
    }));
  };

  const handleClearAllFilters = () => {
    setFilters({});
  };

  const hasData = benchmarks.length > 0 && benchmarks.some(b => b.runs && b.runs.length > 0);

  // Show loading skeleton while checking data state
  if (isCheckingData) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-8" data-testid="dashboard-page">
        <div>
          <h2 className="text-2xl font-bold" data-testid="dashboard-title">Leaderboard Overview</h2>
          <p className="text-muted-foreground">Monitor agent performance trends and compare benchmark metrics</p>
        </div>
        <DashboardSkeleton />
      </div>
    );
  }

  // Show FirstRunExperience if no data exists
  if (!dataState.hasData) {
    return <FirstRunExperience />;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8" data-testid="dashboard-page">
      {/* Sample Data Indicator */}
      {isSampleMode && (
        <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
          <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <AlertTitle className="text-blue-900 dark:text-blue-100">You're viewing sample data</AlertTitle>
          <AlertDescription className="text-blue-800 dark:text-blue-200">
            This is demonstration data to help you explore Agent Health.{' '}
            <Link to="/settings/clusters" className="underline font-medium hover:text-blue-600 dark:hover:text-blue-300">
              Connect your own data
            </Link>
            {' '}to start tracking your agents.
          </AlertDescription>
        </Alert>
      )}

      <div>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold" data-testid="dashboard-title">Leaderboard Overview</h2>
            <p className="text-muted-foreground">Monitor agent performance trends and compare benchmark metrics</p>
          </div>
          {isWorkflowCardHidden && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleShowWorkflowCard}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <HelpCircle className="h-3.5 w-3.5" />
              How It Works
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <DashboardSkeleton />
      ) : !hasData ? (
        <EmptyState />
      ) : (
        <>
          {/* Grid Container for Performance Trends and Workflow Navigator */}
          <div className={`grid gap-8 ${isWorkflowCardHidden ? 'lg:grid-cols-1' : 'lg:grid-cols-3'}`}>
            {/* Performance Trends Card - Takes 2/3 width normally, full width when workflow card is hidden */}
            <Card className={`lg:flex lg:flex-col ${isWorkflowCardHidden ? 'lg:min-h-[500px]' : 'lg:col-span-2'}`}>
              <CardHeader className="pb-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle className="text-lg">Performance Trends</CardTitle>
                    <CardDescription>
                      {agents.length > 0
                        ? `Comparing ${agents.length} agent${agents.length > 1 ? 's' : ''} across ${benchmarks.length} benchmark${benchmarks.length > 1 ? 's' : ''}`
                        : 'Agent performance over time'}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedMetric}
                      onValueChange={(v) => setSelectedMetric(v as TrendMetric)}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue placeholder="Metric" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="passRate">Pass Rate</SelectItem>
                        <SelectItem value="cost">Cost</SelectItem>
                        <SelectItem value="tokens">Tokens</SelectItem>
                        <SelectItem value="latency">Latency</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={timeRange}
                      onValueChange={(v) => setTimeRange(v as TimeRange)}
                    >
                      <SelectTrigger className="w-[130px]">
                        <SelectValue placeholder="Time range" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7d">Last 7 days</SelectItem>
                        <SelectItem value="30d">Last 30 days</SelectItem>
                        <SelectItem value="all">All time</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <FilterChips
                  filters={filters}
                  benchmarks={benchmarks}
                  onRemoveFilter={handleRemoveFilter}
                  onClearAll={handleClearAllFilters}
                />
              </CardHeader>
              <CardContent className="lg:flex-1 lg:min-h-0">
                <div className="h-[300px] lg:h-full">
                  <AgentTrendChart
                    data={trendData}
                    metric={selectedMetric}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Workflow Navigator Card - Takes 1/3 width on right, only shown when not hidden */}
            {!isWorkflowCardHidden && <WorkflowNavigator />}
          </div>

          {/* Benchmark Metrics Table Section - Full Width */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Benchmark Metrics by Agent</CardTitle>
                  <CardDescription>
                    Click benchmark or agent name to filter the trend chart
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <MetricsTable
                data={tableData}
                onBenchmarkClick={handleBenchmarkClick}
                onAgentClick={handleAgentClick}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};
