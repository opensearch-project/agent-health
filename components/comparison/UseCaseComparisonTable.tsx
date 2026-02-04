/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { TestCaseComparisonRow, BenchmarkRun, EvaluationReport } from '@/types';
import { MetricCell } from './MetricCell';
import { VersionIndicator } from './VersionIndicator';
import { UseCaseExpandedRow } from './UseCaseExpandedRow';
import { cn, getLabelColor } from '@/lib/utils';
import { calculateRowStatus, RowStatus } from '@/services/comparisonService';
import { DEFAULT_CONFIG } from '@/lib/constants';

// Helper to get agent display name from key
const getAgentName = (agentKey: string): string => {
  const agent = DEFAULT_CONFIG.agents.find(a => a.key === agentKey);
  return agent?.name || agentKey;
};

interface UseCaseComparisonTableProps {
  rows: TestCaseComparisonRow[];
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  baselineRunId?: string;
}

const rowStatusStyles: Record<RowStatus, string> = {
  regression: 'border-l-4 border-l-red-500/50 bg-red-500/5',
  improvement: 'border-l-4 border-l-opensearch-blue/50 bg-opensearch-blue/5',
  mixed: 'border-l-4 border-l-amber-500/50 bg-amber-500/5',
  neutral: '',
};

export const UseCaseComparisonTable: React.FC<UseCaseComparisonTableProps> = ({
  rows,
  runs,
  reports,
  baselineRunId: propBaselineRunId,
}) => {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Use prop if provided, otherwise fall back to first run
  const baselineRunId = propBaselineRunId || runs[0]?.id;

  const toggleRow = (useCaseId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(useCaseId)) {
        next.delete(useCaseId);
      } else {
        next.add(useCaseId);
      }
      return next;
    });
  };

  if (rows.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No test cases to compare
      </div>
    );
  }

  const columnCount = runs.length + 1; // +1 for the use case column

  return (
    <ScrollArea className="rounded-md border border-border">
      <div className="min-w-max">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-72 sticky left-0 bg-background z-10">
                Use Case
              </TableHead>
              {runs.map((run) => (
                <TableHead key={run.id} className="text-center min-w-32">
                  <div className="truncate">{run.name}</div>
                  <div className="text-xs text-muted-foreground font-normal truncate">
                    {getAgentName(run.agentKey)}
                  </div>
                  {run.id === baselineRunId && (
                    <div className="text-xs text-muted-foreground font-normal">(baseline)</div>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const baselineResult = row.results[baselineRunId];
              const baselineAccuracy = baselineResult?.accuracy;
              const isExpanded = expandedRows.has(row.testCaseId);
              const rowStatus = calculateRowStatus(row, baselineRunId);

              return (
                <React.Fragment key={row.testCaseId}>
                  <TableRow
                    className={cn(
                      'cursor-pointer hover:bg-muted/50 transition-colors',
                      isExpanded && 'bg-muted/30',
                      rowStatusStyles[rowStatus]
                    )}
                    onClick={() => toggleRow(row.testCaseId)}
                  >
                    <TableCell className="sticky left-0 bg-background z-10">
                      <div className="flex items-center gap-2">
                        <div className="flex-shrink-0 text-muted-foreground">
                          {isExpanded ? (
                            <ChevronDown size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </div>
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate max-w-40">
                              {row.testCaseName}
                            </span>
                            {row.hasVersionDifference && (
                              <VersionIndicator versions={row.versions} />
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            {(row.labels || []).slice(0, 2).map((label) => (
                              <Badge
                                key={label}
                                variant="outline"
                                className={cn('text-xs', getLabelColor(label))}
                              >
                                {label}
                              </Badge>
                            ))}
                            {(row.labels || []).length > 2 && (
                              <span className="text-xs text-muted-foreground">
                                +{(row.labels || []).length - 2}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    {runs.map((run) => {
                      const result = row.results[run.id] || { status: 'missing' as const };
                      const isBaseline = run.id === baselineRunId;

                      return (
                        <TableCell key={run.id} className="p-0">
                          <MetricCell
                            result={result}
                            isBaseline={isBaseline}
                            baselineAccuracy={baselineAccuracy}
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                  {isExpanded && (
                    <TableRow>
                      <TableCell
                        colSpan={columnCount}
                        className="p-0 bg-background"
                      >
                        <UseCaseExpandedRow
                          useCaseId={row.testCaseId}
                          runs={runs}
                          reports={reports}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
};
