/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dashboard Metrics Aggregation Utilities
 *
 * Provides functions to aggregate benchmark run data for dashboard visualization.
 */

import { Benchmark, BenchmarkRun, EvaluationReport } from '@/types';

/**
 * Pre-index reports by experimentRunId for O(1) lookup
 * Replaces O(runs × reports) filter pattern with O(runs + reports)
 *
 * @param reports - Array of evaluation reports
 * @returns Map of experimentRunId -> reports array
 */
function indexReportsByRunId(reports: EvaluationReport[]): Map<string, EvaluationReport[]> {
  const index = new Map<string, EvaluationReport[]>();

  for (const report of reports) {
    if (!report.experimentRunId) continue;

    const existing = index.get(report.experimentRunId) || [];
    existing.push(report);
    index.set(report.experimentRunId, existing);
  }

  return index;
}

/**
 * A single data point for the trend chart, representing metrics at a point in time
 */
export interface TrendDataPoint {
  date: string;           // ISO date string (YYYY-MM-DD)
  agentKey: string;       // 'mlcommons' | 'langgraph' | 'holmesgpt' | etc.
  agentName: string;      // Display name for the agent
  avgCostUsd: number;
  avgDurationMs: number;
  avgTokens: number;
  passRate: number;       // 0-100
  runCount: number;
}

/**
 * Aggregated metrics for a benchmark × agent combination
 */
export interface BenchmarkAgentMetrics {
  benchmarkId: string;
  benchmarkName: string;
  agentKey: string;
  agentName: string;
  runCount: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  avgTokens: number;
  avgPassRate: number;    // 0-100
  lastRunDate: string;
}

/**
 * Filter configuration for dashboard
 */
export interface DashboardFilter {
  benchmarkId?: string;
  agentKey?: string;
}

/**
 * Time range options for filtering
 */
export type TimeRange = '7d' | '30d' | 'all';

/**
 * Calculate the date cutoff for a given time range
 */
export function getDateCutoff(timeRange: TimeRange): Date | null {
  if (timeRange === 'all') return null;

  const now = new Date();
  const days = timeRange === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Get display name for an agent key
 */
export function getAgentDisplayName(agentKey: string): string {
  const agentNames: Record<string, string> = {
    'demo': 'Demo Agent',
    'travel-planner': 'Travel Planner',
  };
  return agentNames[agentKey] || agentKey;
}

/**
 * Extract date string (YYYY-MM-DD) from ISO timestamp
 */
function toDateString(timestamp: string): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

/**
 * Calculate pass rate from a set of reports
 */
function calculatePassRate(reports: EvaluationReport[]): number {
  if (reports.length === 0) return 0;
  const passed = reports.filter(r => r.passFailStatus === 'passed').length;
  return (passed / reports.length) * 100;
}

/**
 * Aggregate metrics by date and agent for trend chart.
 * Groups runs by date and agent, calculating average metrics for each group.
 */
export function aggregateMetricsByDate(
  benchmarks: Benchmark[],
  reports: EvaluationReport[],
  metricsMap: Map<string, { costUsd: number; durationMs: number; tokens: number }>,
  filters?: DashboardFilter,
  timeRange: TimeRange = '7d'
): TrendDataPoint[] {
  const cutoffDate = getDateCutoff(timeRange);

  // Pre-index reports for O(1) lookup
  const reportsByRunId = indexReportsByRunId(reports);

  // Group data by date + agentKey
  const groupedData = new Map<string, {
    costs: number[];
    durations: number[];
    tokens: number[];
    passRates: number[];
    agentName: string;
  }>();

  for (const benchmark of benchmarks) {
    // Apply benchmark filter
    if (filters?.benchmarkId && benchmark.id !== filters.benchmarkId) continue;

    for (const run of benchmark.runs || []) {
      // Apply agent filter
      if (filters?.agentKey && run.agentKey !== filters.agentKey) continue;

      const runDate = new Date(run.createdAt);

      // Apply time range filter
      if (cutoffDate && runDate < cutoffDate) continue;

      const dateStr = toDateString(run.createdAt);
      const groupKey = `${dateStr}|${run.agentKey}`;

      // Get reports for this run using pre-indexed lookup
      const runReports = reportsByRunId.get(run.id) || [];
      if (runReports.length === 0) continue;

      // Calculate metrics from metricsMap
      let totalCost = 0;
      let totalDuration = 0;
      let totalTokens = 0;
      let metricsCount = 0;

      for (const report of runReports) {
        if (report.runId && metricsMap.has(report.runId)) {
          const metrics = metricsMap.get(report.runId)!;
          totalCost += metrics.costUsd;
          totalDuration += metrics.durationMs;
          totalTokens += metrics.tokens;
          metricsCount++;
        }
      }

      const passRate = calculatePassRate(runReports);

      if (!groupedData.has(groupKey)) {
        groupedData.set(groupKey, {
          costs: [],
          durations: [],
          tokens: [],
          passRates: [],
          agentName: getAgentDisplayName(run.agentKey),
        });
      }

      const group = groupedData.get(groupKey)!;
      if (metricsCount > 0) {
        group.costs.push(totalCost / metricsCount);
        group.durations.push(totalDuration / metricsCount);
        group.tokens.push(totalTokens / metricsCount);
      }
      group.passRates.push(passRate);
    }
  }

  // Convert grouped data to trend points
  const trendPoints: TrendDataPoint[] = [];

  for (const [groupKey, data] of groupedData) {
    const [date, agentKey] = groupKey.split('|');

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    trendPoints.push({
      date,
      agentKey,
      agentName: data.agentName,
      avgCostUsd: avg(data.costs),
      avgDurationMs: avg(data.durations),
      avgTokens: avg(data.tokens),
      passRate: avg(data.passRates),
      runCount: data.passRates.length,
    });
  }

  // Sort by date ascending
  trendPoints.sort((a, b) => a.date.localeCompare(b.date));

  return trendPoints;
}

/**
 * Aggregate metrics by benchmark × agent combination for the metrics table.
 * Creates one row per unique benchmark-agent pair.
 */
export function aggregateMetricsByBenchmarkAgent(
  benchmarks: Benchmark[],
  reports: EvaluationReport[],
  metricsMap: Map<string, { costUsd: number; durationMs: number; tokens: number }>
): BenchmarkAgentMetrics[] {
  // Pre-index reports for O(1) lookup
  const reportsByRunId = indexReportsByRunId(reports);

  // Group by benchmark × agent
  const groupedData = new Map<string, {
    benchmarkId: string;
    benchmarkName: string;
    agentKey: string;
    costs: number[];
    durations: number[];
    tokens: number[];
    passRates: number[];
    lastRunDate: string;
  }>();

  for (const benchmark of benchmarks) {
    for (const run of benchmark.runs || []) {
      const groupKey = `${benchmark.id}|${run.agentKey}`;

      // Get reports for this run using pre-indexed lookup
      const runReports = reportsByRunId.get(run.id) || [];

      // Calculate metrics
      let totalCost = 0;
      let totalDuration = 0;
      let totalTokens = 0;
      let metricsCount = 0;

      for (const report of runReports) {
        if (report.runId && metricsMap.has(report.runId)) {
          const metrics = metricsMap.get(report.runId)!;
          totalCost += metrics.costUsd;
          totalDuration += metrics.durationMs;
          totalTokens += metrics.tokens;
          metricsCount++;
        }
      }

      const passRate = calculatePassRate(runReports);

      if (!groupedData.has(groupKey)) {
        groupedData.set(groupKey, {
          benchmarkId: benchmark.id,
          benchmarkName: benchmark.name,
          agentKey: run.agentKey,
          costs: [],
          durations: [],
          tokens: [],
          passRates: [],
          lastRunDate: run.createdAt,
        });
      }

      const group = groupedData.get(groupKey)!;
      if (metricsCount > 0) {
        group.costs.push(totalCost / metricsCount);
        group.durations.push(totalDuration / metricsCount);
        group.tokens.push(totalTokens / metricsCount);
      }
      if (runReports.length > 0) {
        group.passRates.push(passRate);
      }

      // Track latest run date
      if (run.createdAt > group.lastRunDate) {
        group.lastRunDate = run.createdAt;
      }
    }
  }

  // Convert to metrics array
  const metrics: BenchmarkAgentMetrics[] = [];

  for (const data of groupedData.values()) {
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    metrics.push({
      benchmarkId: data.benchmarkId,
      benchmarkName: data.benchmarkName,
      agentKey: data.agentKey,
      agentName: getAgentDisplayName(data.agentKey),
      runCount: data.passRates.length,
      avgLatencyMs: avg(data.durations),
      avgCostUsd: avg(data.costs),
      avgTokens: avg(data.tokens),
      avgPassRate: avg(data.passRates),
      lastRunDate: data.lastRunDate,
    });
  }

  // Sort by run count descending (most active first)
  metrics.sort((a, b) => b.runCount - a.runCount);

  return metrics;
}

/**
 * Get unique agent keys from benchmarks for chart legend/filtering
 */
export function getUniqueAgents(benchmarks: Benchmark[]): Array<{ key: string; name: string }> {
  const agents = new Set<string>();

  for (const benchmark of benchmarks) {
    for (const run of benchmark.runs || []) {
      agents.add(run.agentKey);
    }
  }

  return Array.from(agents).map(key => ({
    key,
    name: getAgentDisplayName(key),
  }));
}

/**
 * Color palette for agents (matches existing chart patterns)
 */
export const AGENT_COLORS: Record<string, string> = {
  'demo': '#6b7280',            // gray-500
  'travel-planner': '#10b981',  // emerald-500 (teal)
};

/**
 * Get color for an agent key
 */
export function getAgentColor(agentKey: string): string {
  return AGENT_COLORS[agentKey] || '#3b82f6';
}
