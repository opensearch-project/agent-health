/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { Loader2, Coins, Clock, Cpu, Wrench } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BenchmarkRun, EvaluationReport } from '@/types';
import { fetchBatchMetrics, formatCost, formatTokens, formatDuration } from '@/services/metrics';

interface BenchmarkSummaryChartsProps {
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport | null>;
}

interface RunStats {
  runId: string;
  runName: string;
  passCount: number;
  failCount: number;
  totalCount: number;
  avgAccuracy: number;
  passRatePercent: number;
}

interface AggregateTraceMetrics {
  totalTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
  totalToolCalls: number;
  isLoading: boolean;
  error: string | null;
}

// Colors for the charts
const COLORS = {
  pass: '#015aa3', // opensearch-blue
  fail: '#ef4444', // red-500
  bars: ['#3b82f6', '#015aa3', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'],
};

export const BenchmarkSummaryCharts: React.FC<BenchmarkSummaryChartsProps> = ({
  runs,
  reports,
}) => {
  const [traceMetrics, setTraceMetrics] = useState<AggregateTraceMetrics>({
    totalTokens: 0,
    totalCostUsd: 0,
    avgDurationMs: 0,
    totalToolCalls: 0,
    isLoading: true,
    error: null,
  });

  // Calculate stats for each run from stored report metrics
  const runStats: RunStats[] = useMemo(() => {
    return (runs || []).map(run => {
      let totalAccuracy = 0;
      let passCount = 0;
      let completedCount = 0;
      const totalCount = Object.keys(run.results || {}).length;

      Object.entries(run.results || {}).forEach(([, result]) => {
        if (result.reportId && result.status === 'completed') {
          const report = reports[result.reportId];
          if (report && report.status === 'completed') {
            totalAccuracy += report.metrics?.accuracy ?? 0;
            if (report.passFailStatus === 'passed') passCount++;
            completedCount++;
          }
        }
      });

      return {
        runId: run.id,
        runName: run.name,
        passCount,
        failCount: completedCount - passCount,
        totalCount,
        avgAccuracy: completedCount > 0 ? Math.round(totalAccuracy / completedCount) : 0,
        passRatePercent: totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 0,
      };
    });
  }, [runs, reports]);

  // Calculate overall aggregates
  const overallStats = useMemo(() => {
    const totalPass = runStats.reduce((sum, r) => sum + r.passCount, 0);
    const totalFail = runStats.reduce((sum, r) => sum + r.failCount, 0);
    const total = totalPass + totalFail;
    const avgAccuracy = runStats.length > 0
      ? Math.round(runStats.reduce((sum, r) => sum + r.avgAccuracy, 0) / runStats.length)
      : 0;

    return {
      totalPass,
      totalFail,
      total,
      passRatePercent: total > 0 ? Math.round((totalPass / total) * 100) : 0,
      avgAccuracy,
    };
  }, [runStats]);

  // Fetch trace metrics for all runs
  useEffect(() => {
    const fetchMetrics = async () => {
      // Collect all runIds from reports
      const runIds: string[] = [];
      Object.values(reports).forEach(report => {
        if (report?.runId) {
          runIds.push(report.runId);
        }
      });

      if (runIds.length === 0) {
        setTraceMetrics(prev => ({ ...prev, isLoading: false }));
        return;
      }

      try {
        const result = await fetchBatchMetrics(runIds);
        setTraceMetrics({
          totalTokens: result.aggregate.totalInputTokens + result.aggregate.totalOutputTokens,
          totalCostUsd: result.aggregate.totalCostUsd,
          avgDurationMs: result.aggregate.avgDurationMs,
          totalToolCalls: result.aggregate.avgToolCalls * runIds.length,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        console.warn('[BenchmarkSummaryCharts] Failed to fetch trace metrics:', error);
        setTraceMetrics(prev => ({
          ...prev,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load metrics',
        }));
      }
    };

    fetchMetrics();
  }, [reports]);

  // Data for accuracy bar chart
  const accuracyChartData = runStats.map((stat, index) => ({
    name: stat.runName,
    accuracy: stat.avgAccuracy,
    fill: COLORS.bars[index % COLORS.bars.length],
  }));

  // Check if we have any trace metrics
  const hasTraceMetrics = !traceMetrics.isLoading && !traceMetrics.error && traceMetrics.totalTokens > 0;

  return (
    <div className="space-y-6">
      {/* Overall Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-muted/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Pass Rate</div>
            <div className="text-2xl font-bold text-opensearch-blue">
              {overallStats.passRatePercent}%
            </div>
            <div className="text-xs text-muted-foreground">
              {overallStats.totalPass}/{overallStats.total} passed
            </div>
          </CardContent>
        </Card>

        <Card className="bg-muted/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Avg Accuracy</div>
            <div className="text-2xl font-bold text-blue-400">
              {overallStats.avgAccuracy}%
            </div>
            <div className="text-xs text-muted-foreground">
              across {runs.length} run{runs.length !== 1 ? 's' : ''}
            </div>
          </CardContent>
        </Card>

        {/* Trace metrics cards */}
        {traceMetrics.isLoading ? (
          <>
            <Card className="bg-muted/50">
              <CardContent className="p-4 flex items-center justify-center">
                <Loader2 className="animate-spin text-muted-foreground" size={20} />
              </CardContent>
            </Card>
            <Card className="bg-muted/50">
              <CardContent className="p-4 flex items-center justify-center">
                <Loader2 className="animate-spin text-muted-foreground" size={20} />
              </CardContent>
            </Card>
          </>
        ) : hasTraceMetrics ? (
          <>
            <Card className="bg-muted/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Cpu size={12} />
                  Total Tokens
                </div>
                <div className="text-2xl font-bold text-cyan-400">
                  {formatTokens(traceMetrics.totalTokens)}
                </div>
                <div className="text-xs text-muted-foreground">
                  ${formatCost(traceMetrics.totalCostUsd).replace('$', '')} total
                </div>
              </CardContent>
            </Card>

            <Card className="bg-muted/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Clock size={12} />
                  Avg Duration
                </div>
                <div className="text-2xl font-bold text-purple-700 dark:text-purple-400">
                  {formatDuration(traceMetrics.avgDurationMs)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {Math.round(traceMetrics.totalToolCalls)} tool calls
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <>
            <Card className="bg-muted/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Cpu size={12} />
                  Tokens
                </div>
                <div className="text-lg font-medium text-muted-foreground">
                  --
                </div>
              </CardContent>
            </Card>
            <Card className="bg-muted/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Clock size={12} />
                  Duration
                </div>
                <div className="text-lg font-medium text-muted-foreground">
                  --
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pass/Fail Donut Charts */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pass/Fail by Run</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap justify-center gap-6">
              {runStats.map((stat, index) => (
                <div key={stat.runId} className="text-center">
                  <div className="h-24 w-24">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'Passed', value: stat.passCount },
                            { name: 'Failed', value: stat.failCount },
                          ]}
                          cx="50%"
                          cy="50%"
                          innerRadius={25}
                          outerRadius={40}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          <Cell fill={COLORS.pass} />
                          <Cell fill={COLORS.fail} />
                        </Pie>
                        <Tooltip
                          formatter={(value: number, name: string) => [value, name]}
                          contentStyle={{
                            backgroundColor: 'hsl(var(--card))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '6px',
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="text-xs font-medium mt-1">{stat.runName}</div>
                  <div className="text-xs text-muted-foreground">
                    {stat.passCount}/{stat.totalCount}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Accuracy Bar Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Accuracy by Run</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart
                data={accuracyChartData}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 80, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                <XAxis
                  type="number"
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                  width={70}
                />
                <Tooltip
                  formatter={(value: number) => [`${value}%`, 'Accuracy']}
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                  }}
                />
                <Bar dataKey="accuracy" radius={[0, 4, 4, 0]}>
                  {accuracyChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

// Backwards compatibility alias
/** @deprecated Use BenchmarkSummaryCharts instead */
export const ExperimentSummaryCharts = BenchmarkSummaryCharts;
