/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Clock, Target, BarChart3, Coins, Timer, Hash } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { EvaluationReport, ExperimentRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getModelName } from '@/lib/utils';
import { fetchBatchMetrics, formatTokens, formatCost, formatDuration } from '@/services/metrics';

interface RunSummaryPanelProps {
  run: ExperimentRun;
  reports: Record<string, EvaluationReport | null>;
  className?: string;
}

export const RunSummaryPanel: React.FC<RunSummaryPanelProps> = ({
  run,
  reports,
  className = '',
}) => {
  const getAgentName = (agentKey: string) => {
    const agent = DEFAULT_CONFIG.agents[agentKey];
    return agent?.name || agentKey;
  };

  // Calculate aggregate metrics
  const calculateStats = () => {
    let passed = 0;
    let failed = 0;
    let totalAccuracy = 0;
    let reportCount = 0;

    Object.values(run.results || {}).forEach(result => {
      if (result.status === 'completed' && result.reportId) {
        const report = reports[result.reportId];
        if (report) {
          reportCount++;
          totalAccuracy += report.metrics?.accuracy ?? 0;

          if (report.passFailStatus === 'passed') {
            passed++;
          } else {
            failed++;
          }
        }
      } else if (result.status === 'failed') {
        failed++;
      }
    });

    const total = Object.keys(run.results || {}).length;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const avgAccuracy = reportCount > 0 ? Math.round(totalAccuracy / reportCount) : 0;

    return {
      passed,
      failed,
      total,
      passRate,
      avgAccuracy,
    };
  };

  const stats = calculateStats();

  // State for trace metrics
  const [traceMetrics, setTraceMetrics] = useState<{
    totalCostUsd: number;
    avgDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  } | null>(null);

  // Fetch trace metrics if reports have runIds
  useEffect(() => {
    const runIds = Object.values(reports)
      .filter((r): r is EvaluationReport => r !== null && !!r.runId)
      .map(r => r.runId!);

    if (runIds.length > 0) {
      fetchBatchMetrics(runIds)
        .then(data => setTraceMetrics(data.aggregate))
        .catch(() => setTraceMetrics(null));
    }
  }, [reports]);

  // Donut chart data
  const pieData = [
    { name: 'Passed', value: stats.passed, color: '#015aa3' },
    { name: 'Failed', value: stats.failed, color: '#ef4444' },
  ].filter(d => d.value > 0);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="bg-card border-b p-4">
        <h2 className="text-xl font-semibold">Run Summary</h2>
        <p className="text-sm text-muted-foreground mt-1">{run.name}</p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Pass Rate with Donut Chart */}
        <div>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Target size={18} />
            Pass Rate
          </h3>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-6">
                {/* Donut Chart */}
                <div className="relative w-24 h-24 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={28}
                        outerRadius={40}
                        dataKey="value"
                        strokeWidth={0}
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center Label */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-bold">{stats.passRate}%</span>
                  </div>
                </div>
                {/* Stats */}
                <div className="flex-1">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 size={16} className="text-opensearch-blue" />
                      <span className="text-opensearch-blue font-medium">{stats.passed} passed</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle size={16} className="text-red-400" />
                      <span className="text-red-400 font-medium">{stats.failed} failed</span>
                    </div>
                    <span className="text-sm text-muted-foreground">{stats.total} total test cases</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Average Metrics */}
        <div>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <BarChart3 size={18} />
            Judge Metrics
          </h3>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Accuracy</span>
                <span className="text-lg font-bold text-opensearch-blue">{stats.avgAccuracy}%</span>
              </div>
              <Progress value={stats.avgAccuracy} className="h-2 [&>div]:bg-opensearch-blue" />
            </CardContent>
          </Card>
        </div>

        {/* Trace Metrics (if available) */}
        {traceMetrics && (
          <div>
            <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <BarChart3 size={18} />
              Trace Metrics
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="p-4 text-center">
                  <Hash size={16} className="mx-auto text-blue-400 mb-2" />
                  <div className="text-xs text-muted-foreground mb-1">Total Tokens</div>
                  <div className="text-lg font-bold text-blue-400">
                    {formatTokens(traceMetrics.totalInputTokens + traceMetrics.totalOutputTokens)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <Coins size={16} className="mx-auto text-amber-400 mb-2" />
                  <div className="text-xs text-muted-foreground mb-1">Total Cost</div>
                  <div className="text-lg font-bold text-amber-400">
                    {formatCost(traceMetrics.totalCostUsd)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <Timer size={16} className="mx-auto text-purple-700 dark:text-purple-400 mb-2" />
                  <div className="text-xs text-muted-foreground mb-1">Avg Duration</div>
                  <div className="text-lg font-bold text-purple-700 dark:text-purple-400">
                    {formatDuration(traceMetrics.avgDurationMs)}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* Run Details */}
        <div>
          <h3 className="text-lg font-semibold mb-3">Run Details</h3>
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1">Agent</div>
                <div className="text-sm">{getAgentName(run.agentKey)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1">Model</div>
                <div className="text-sm">{getModelName(run.modelId)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1">Created</div>
                <div className="text-sm flex items-center gap-1">
                  <Clock size={12} className="text-muted-foreground" />
                  {formatDate(run.createdAt)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1">Test Cases</div>
                <div className="text-sm">{stats.total} total</div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Description */}
        {run.description && (
          <div>
            <h3 className="text-lg font-semibold mb-3">Description</h3>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{run.description}</p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
};
