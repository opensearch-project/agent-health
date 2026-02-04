/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, Calendar, Cpu, Bot } from 'lucide-react';
import { RunAggregateMetrics } from '@/types';
import { cn, formatDate } from '@/lib/utils';
import { formatTokens, formatCost, formatDuration } from '@/services/metrics';
import { DEFAULT_CONFIG } from '@/lib/constants';

// Helper to get agent display name from key
const getAgentName = (agentKey: string): string => {
  const agent = DEFAULT_CONFIG.agents.find(a => a.key === agentKey);
  return agent?.name || agentKey;
};

interface RunSummaryCardsProps {
  runs: RunAggregateMetrics[];
  baselineRunId?: string;
}

// Progress bar component for metric visualization
const MetricProgressBar = ({
  label,
  value,
  maxValue,
  formatter,
  color,
}: {
  label: string;
  value: number;
  maxValue: number;
  formatter: (v: number) => string;
  color: string;
}) => {
  const percent = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-16 shrink-0">{label}</span>
      <div className="flex-1 bg-muted rounded h-1.5">
        <div
          className={cn('h-1.5 rounded', color)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs font-medium w-14 text-right">{formatter(value)}</span>
    </div>
  );
};

export const RunSummaryCards: React.FC<RunSummaryCardsProps> = ({
  runs,
  baselineRunId,
}) => {
  // Calculate max values for progress bar scaling
  const maxTokens = Math.max(...runs.map(r => r.totalTokens || 0), 1);
  const maxCost = Math.max(...runs.map(r => r.totalCostUsd || 0), 0.01);
  const maxDuration = Math.max(...runs.map(r => r.avgDurationMs || 0), 1);

  // Check if any run has trace metrics
  const hasTraceMetrics = runs.some(r => r.totalTokens !== undefined);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {runs.map((run, index) => {
        const isBaseline = baselineRunId ? run.runId === baselineRunId : index === 0;
        const passRate = run.totalTestCases > 0
          ? Math.round((run.passedCount / run.totalTestCases) * 100)
          : 0;

        return (
          <Card
            key={run.runId}
            className={cn(
              'relative',
              isBaseline && 'ring-1 ring-blue-500/30'
            )}
          >
            {isBaseline && (
              <Badge
                variant="outline"
                className="absolute -top-2 -right-2 bg-blue-500/10 text-blue-400 border-blue-500/30 text-xs"
              >
                Baseline
              </Badge>
            )}
            <CardHeader className="pb-2 pt-3">
              <CardTitle className="text-sm font-medium truncate">
                {run.runName}
              </CardTitle>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Bot size={10} />
                <span className="truncate">{getAgentName(run.agentKey)}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Cpu size={10} />
                <span className="truncate">{run.modelId}</span>
                <span className="mx-1">·</span>
                <Calendar size={10} />
                <span>{formatDate(run.createdAt)}</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {/* Pass Rate with counts inline */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Pass Rate</span>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-sm font-bold',
                    passRate >= 80 ? 'text-opensearch-blue' : passRate >= 50 ? 'text-amber-400' : 'text-red-400'
                  )}>
                    {passRate}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    (<span className="text-opensearch-blue">{run.passedCount}</span>
                    <span className="text-red-400 ml-0.5">{run.failedCount}</span>
                    /{run.totalTestCases})
                  </span>
                </div>
              </div>

              {/* Avg Accuracy */}
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Avg Accuracy</span>
                <span className="font-medium">{run.avgAccuracy}%</span>
              </div>

              {/* Trace metrics with progress bars */}
              {hasTraceMetrics && run.totalTokens !== undefined && (
                <div className="pt-2 border-t border-border space-y-1.5">
                  <MetricProgressBar
                    label="Tokens"
                    value={run.totalTokens || 0}
                    maxValue={maxTokens}
                    formatter={formatTokens}
                    color="bg-blue-500"
                  />
                  <MetricProgressBar
                    label="Cost"
                    value={run.totalCostUsd || 0}
                    maxValue={maxCost}
                    formatter={formatCost}
                    color="bg-amber-500"
                  />
                  <MetricProgressBar
                    label="Duration"
                    value={run.avgDurationMs || 0}
                    maxValue={maxDuration}
                    formatter={formatDuration}
                    color="bg-purple-500"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
