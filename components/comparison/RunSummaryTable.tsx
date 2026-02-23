/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { RunAggregateMetrics } from '@/types';
import { cn, formatDate } from '@/lib/utils';
import { formatDelta, getDeltaColorClass } from '@/services/comparisonService';
import { formatTokens, formatCost, formatDuration } from '@/services/metrics';
import { DEFAULT_CONFIG } from '@/lib/constants';

// Helper to get agent display name from key
const getAgentName = (agentKey: string): string => {
  const agent = DEFAULT_CONFIG.agents.find(a => a.key === agentKey);
  return agent?.name || agentKey;
};

/**
 * Get color class for pass rate value
 */
export function getPassRateColorClass(passRate: number): string {
  if (passRate >= 80) return 'text-green-700 dark:text-green-400';
  if (passRate >= 50) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-400';
}

/**
 * Returns the value if all runs produce the same string for getValue, null otherwise.
 * Useful for detecting uniform metadata (e.g., all runs use the same agent).
 */
export function getUniformValue(
  runs: RunAggregateMetrics[],
  getValue: (run: RunAggregateMetrics) => string
): string | null {
  if (runs.length === 0) return null;
  const first = getValue(runs[0]);
  for (let i = 1; i < runs.length; i++) {
    if (getValue(runs[i]) !== first) return null;
  }
  return first;
}

/**
 * Returns a Tailwind background class for heat map coloring based on where
 * `value` falls between `min` and `max`.
 *
 * 5 intensity levels:
 *   best  → bg-emerald-500/10
 *   good  → bg-emerald-500/5
 *   mid   → '' (no background)
 *   poor  → bg-red-500/5
 *   worst → bg-red-500/10
 *
 * When min === max (single value or all identical), returns '' (no coloring).
 */
export function getHeatmapClass(
  value: number,
  min: number,
  max: number,
  higherIsBetter: boolean
): string {
  if (min === max) return '';

  // Normalize to 0..1 where 1 = best
  let normalized = (value - min) / (max - min);
  if (!higherIsBetter) normalized = 1 - normalized;

  // 5-level quantization
  if (normalized >= 0.8) return 'bg-emerald-500/10';
  if (normalized >= 0.6) return 'bg-emerald-500/5';
  if (normalized >= 0.4) return '';
  if (normalized >= 0.2) return 'bg-red-500/5';
  return 'bg-red-500/10';
}

interface SummaryRow {
  label: string;
  key: string;
  group: 'config' | 'performance' | 'resource';
  isTraceMetric: boolean;
  higherIsBetter?: boolean;
  getValue: (run: RunAggregateMetrics) => string;
  getNumericValue?: (run: RunAggregateMetrics) => number | undefined;
  showDelta?: boolean;
  collapsible?: boolean;
  useHeatmap?: boolean;
}

const SUMMARY_ROWS: SummaryRow[] = [
  {
    label: 'Agent',
    key: 'agent',
    group: 'config',
    isTraceMetric: false,
    collapsible: true,
    getValue: (r) => getAgentName(r.agentKey),
  },
  {
    label: 'Model',
    key: 'model',
    group: 'config',
    isTraceMetric: false,
    collapsible: true,
    getValue: (r) => r.modelId,
  },
  {
    label: 'Date',
    key: 'date',
    group: 'config',
    isTraceMetric: false,
    getValue: (r) => formatDate(r.createdAt, 'date'),
  },
  {
    label: 'Pass Rate',
    key: 'passRate',
    group: 'performance',
    isTraceMetric: false,
    higherIsBetter: true,
    useHeatmap: true,
    showDelta: true,
    getValue: (r) => {
      const passRate = r.totalTestCases > 0
        ? Math.round((r.passedCount / r.totalTestCases) * 100)
        : 0;
      return `${passRate}%`;
    },
    getNumericValue: (r) => r.passRatePercent,
  },
  {
    label: 'Avg Accuracy',
    key: 'accuracy',
    group: 'performance',
    isTraceMetric: false,
    higherIsBetter: true,
    useHeatmap: true,
    showDelta: true,
    getValue: (r) => `${r.avgAccuracy}%`,
    getNumericValue: (r) => r.avgAccuracy,
  },
  {
    label: 'Tokens',
    key: 'tokens',
    group: 'resource',
    isTraceMetric: true,
    getValue: (r) => r.totalTokens !== undefined ? formatTokens(r.totalTokens) : '-',
    getNumericValue: (r) => r.totalTokens,
  },
  {
    label: 'Cost',
    key: 'cost',
    group: 'resource',
    isTraceMetric: true,
    higherIsBetter: false,
    useHeatmap: true,
    getValue: (r) => r.totalCostUsd !== undefined ? formatCost(r.totalCostUsd) : '-',
    getNumericValue: (r) => r.totalCostUsd,
  },
  {
    label: 'Avg Duration',
    key: 'duration',
    group: 'resource',
    isTraceMetric: true,
    higherIsBetter: false,
    useHeatmap: true,
    getValue: (r) => r.avgDurationMs !== undefined ? formatDuration(r.avgDurationMs) : '-',
    getNumericValue: (r) => r.avgDurationMs,
  },
];

/**
 * Get visible metric rows based on whether any run has trace data
 */
export function getVisibleMetricRows(runs: RunAggregateMetrics[]): SummaryRow[] {
  const hasTraceMetrics = runs.some(r => r.totalTokens !== undefined);
  if (hasTraceMetrics) return SUMMARY_ROWS;
  return SUMMARY_ROWS.filter(row => !row.isTraceMetric);
}

interface RunSummaryTableProps {
  runs: RunAggregateMetrics[];
  referenceRunId?: string;
}

export const RunSummaryTable: React.FC<RunSummaryTableProps> = ({
  runs,
  referenceRunId,
}) => {
  if (runs.length === 0) return null;

  const visibleRows = getVisibleMetricRows(runs);
  const effectiveReferenceId = referenceRunId || runs[0]?.runId;

  // Detect uniform config values to collapse redundant rows
  const uniformParts: string[] = [];
  const uniformKeys = new Set<string>();

  for (const row of visibleRows) {
    if (!row.collapsible) continue;
    const uniform = getUniformValue(runs, row.getValue);
    if (uniform !== null) {
      uniformParts.push(uniform);
      uniformKeys.add(row.key);
    }
  }

  // Filter out collapsed rows
  const displayRows = visibleRows.filter(row => !uniformKeys.has(row.key));

  // Find best run for a metric row (only for rows with higherIsBetter defined)
  const findBestRunId = (row: SummaryRow): string | undefined => {
    if (row.higherIsBetter === undefined || !row.getNumericValue) return undefined;
    let bestRunId: string | undefined;
    let bestValue: number | undefined;

    for (const run of runs) {
      const value = row.getNumericValue(run);
      if (value === undefined) continue;
      if (bestValue === undefined ||
        (row.higherIsBetter ? value > bestValue : value < bestValue)) {
        bestValue = value;
        bestRunId = run.runId;
      }
    }
    return bestRunId;
  };

  // Compute min/max for heatmap rows
  const getRowMinMax = (row: SummaryRow): { min: number; max: number } | null => {
    if (!row.useHeatmap || !row.getNumericValue || row.higherIsBetter === undefined) return null;
    const values: number[] = [];
    for (const run of runs) {
      const v = row.getNumericValue(run);
      if (v !== undefined) values.push(v);
    }
    if (values.length < 2) return null;
    return { min: Math.min(...values), max: Math.max(...values) };
  };

  return (
    <div>
      {uniformParts.length > 0 && (
        <div className="text-xs text-muted-foreground mb-2">
          All runs: {uniformParts.join(' \u00b7 ')}
        </div>
      )}
      <ScrollArea className="rounded-md border border-border">
        <div className="min-w-max">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36 sticky left-0 bg-background z-10">
                  Metric
                </TableHead>
                {runs.map((run, idx) => {
                  const isReference = run.runId === effectiveReferenceId;
                  return (
                    <TableHead
                      key={run.runId}
                      className={cn(
                        'text-center min-w-36',
                        isReference && 'bg-blue-500/5'
                      )}
                    >
                      <span className="truncate">#{idx + 1} &middot; {run.runName}</span>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((row, rowIdx) => {
                const bestRunId = findBestRunId(row);
                const referenceRun = runs.find(r => r.runId === effectiveReferenceId);
                const minMax = getRowMinMax(row);

                // Determine if this row starts a new group (section separator)
                const prevRow = rowIdx > 0 ? displayRows[rowIdx - 1] : null;
                const isNewGroup = prevRow !== null && prevRow.group !== row.group;

                return (
                  <TableRow
                    key={row.key}
                    className={cn(isNewGroup && 'border-t-2 border-border')}
                  >
                    <TableCell className="font-medium sticky left-0 bg-background z-10">
                      {row.label}
                    </TableCell>
                    {runs.map((run) => {
                      const isReference = run.runId === effectiveReferenceId;
                      const isBest = bestRunId === run.runId && runs.length > 1;
                      const displayValue = row.getValue(run);

                      // Calculate delta for percentage metrics
                      let deltaElement: React.ReactNode = null;
                      if (row.showDelta && !isReference && referenceRun && row.getNumericValue) {
                        const currentVal = row.getNumericValue(run);
                        const referenceVal = row.getNumericValue(referenceRun);
                        if (currentVal !== undefined && referenceVal !== undefined) {
                          const delta = currentVal - referenceVal;
                          if (delta !== 0) {
                            deltaElement = (
                              <span className={cn('text-xs ml-1', getDeltaColorClass(delta))}>
                                {formatDelta(delta)}
                              </span>
                            );
                          }
                        }
                      }

                      // Compute heatmap background
                      let heatmapClass = '';
                      if (minMax && row.getNumericValue && row.higherIsBetter !== undefined) {
                        const val = row.getNumericValue(run);
                        if (val !== undefined) {
                          heatmapClass = getHeatmapClass(val, minMax.min, minMax.max, row.higherIsBetter);
                        }
                      }

                      // Pass rate gets color-coded
                      const isPassRate = row.key === 'passRate';
                      const passRateClass = isPassRate
                        ? getPassRateColorClass(run.passRatePercent)
                        : undefined;

                      // Pass rate shows stacked two-line layout
                      if (isPassRate) {
                        return (
                          <TableCell
                            key={run.runId}
                            className={cn(
                              'text-center',
                              isReference && 'bg-blue-500/5',
                              isBest && 'bg-opensearch-blue/5',
                              heatmapClass
                            )}
                          >
                            <div className="flex flex-col items-center gap-0.5">
                              <div className="flex items-center justify-center">
                                <span className={cn('font-medium', passRateClass)}>
                                  {displayValue}
                                </span>
                                {deltaElement}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                <span className="text-green-700 dark:text-green-400">{run.passedCount}P</span>
                                {' \u00b7 '}
                                <span className="text-red-700 dark:text-red-400">{run.failedCount}F</span>
                                {' / '}{run.totalTestCases}
                              </div>
                            </div>
                          </TableCell>
                        );
                      }

                      return (
                        <TableCell
                          key={run.runId}
                          className={cn(
                            'text-center',
                            isReference && 'bg-blue-500/5',
                            isBest && 'bg-opensearch-blue/5',
                            heatmapClass
                          )}
                        >
                          <div className="flex items-center justify-center flex-wrap">
                            <span className={cn(
                              'font-medium',
                              isBest && 'text-opensearch-blue'
                            )}>
                              {displayValue}
                            </span>
                            {deltaElement}
                          </div>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
};
