/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
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
import { ChevronDown, ChevronRight, GitCompare } from 'lucide-react';
import { TestCaseComparisonRow, BenchmarkRun, EvaluationReport } from '@/types';
import { MetricCell, EvaluatorType } from './MetricCell';
import { VersionIndicator } from './VersionIndicator';
import { UseCaseExpandedRow } from './UseCaseExpandedRow';
import { cn, getLabelColor } from '@/lib/utils';
import { calculateRowStatus, calculateCombinedScore, RowStatus } from '@/services/comparisonService';
import { extractFirstDivergence } from '@/services/trajectoryDiffService';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { ArrowRightLeft, Plus, Minus } from 'lucide-react';
import { getClusterDotColor } from './FailureClusterPanel';

// Helper to get agent display name from key
const getAgentName = (agentKey: string): string => {
  const agent = DEFAULT_CONFIG.agents.find(a => a.key === agentKey);
  return agent?.name || agentKey;
};

interface DivergencePreviewRowProps {
  row: TestCaseComparisonRow;
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
}

/**
 * Inline one-liner showing the first step where the loser and winner diverged
 * for this test case. Only meaningful when at least one run got it right and
 * one got it wrong. Renders nothing if a sensible winner/loser pair can't be
 * established or trajectories are missing.
 */
const DivergencePreviewRow: React.FC<DivergencePreviewRowProps> = ({ row, runs, reports }) => {
  const completedRuns = runs.filter(r => {
    const result = row.results[r.id];
    return result && result.status === 'completed';
  });
  if (completedRuns.length < 2) return null;

  // Winner = highest combined score on this row; loser = lowest.
  let winnerRun = completedRuns[0];
  let loserRun = completedRuns[0];
  let winnerScore = -Infinity;
  let loserScore = Infinity;
  for (const r of completedRuns) {
    const result = row.results[r.id];
    if (!result) continue;
    const score = calculateCombinedScore(result);
    if (score > winnerScore) { winnerScore = score; winnerRun = r; }
    if (score < loserScore) { loserScore = score; loserRun = r; }
  }
  if (winnerRun.id === loserRun.id) return null;

  const winnerReport = reports[row.results[winnerRun.id]?.reportId ?? ''];
  const loserReport = reports[row.results[loserRun.id]?.reportId ?? ''];
  if (!winnerReport?.trajectory || !loserReport?.trajectory) return null;

  // Baseline = loser, comparison = winner — so 'added' means winner did
  // something the loser didn't, 'removed' means loser did something the
  // winner didn't, 'modified' means they did the same thing differently.
  const divergence = extractFirstDivergence(loserReport.trajectory, winnerReport.trajectory);
  if (!divergence) {
    // Trajectories are identical (or both empty) but outcomes still
    // diverged — e.g. one judge passed and the other failed on the same
    // sequence of tool calls. Rendering nothing here used to hide the
    // most interesting case from the user ("why did identical work get
    // different verdicts?"). Surface a short note so they know the
    // divergence is in interpretation, not behavior, and can click into
    // the row for the full judge reasoning.
    return (
      <div className="flex items-start gap-1.5 mt-1 text-[10px] text-muted-foreground italic">
        <span>Same trajectory, different outcome — see judge reasoning.</span>
      </div>
    );
  }

  const Icon =
    divergence.type === 'added' ? Plus :
    divergence.type === 'removed' ? Minus :
    ArrowRightLeft;
  const iconColor =
    divergence.type === 'added' ? 'text-opensearch-blue' :
    divergence.type === 'removed' ? 'text-red-400' :
    'text-amber-400';

  const stepLabel = `Step ${divergence.index + 1}`;
  const winnerName = getAgentName(winnerRun.agentKey);
  const loserName = getAgentName(loserRun.agentKey);
  const sameAgent = winnerRun.agentKey === loserRun.agentKey;
  const winnerSide = sameAgent ? winnerRun.name : winnerName;
  const loserSide = sameAgent ? loserRun.name : loserName;

  let summary: React.ReactNode;
  if (divergence.type === 'added') {
    summary = (
      <>
        <span className="font-medium">{winnerSide}</span> called{' '}
        <code className="text-foreground bg-muted/50 px-1 rounded">{divergence.comparisonSummary ?? '(unknown)'}</code>
        {' · '}
        <span className="font-medium">{loserSide}</span> skipped this step
      </>
    );
  } else if (divergence.type === 'removed') {
    summary = (
      <>
        <span className="font-medium">{loserSide}</span> called{' '}
        <code className="text-foreground bg-muted/50 px-1 rounded">{divergence.baselineSummary ?? '(unknown)'}</code>
        {' · '}
        <span className="font-medium">{winnerSide}</span> skipped this step
      </>
    );
  } else {
    summary = (
      <>
        <span className="font-medium">{loserSide}</span>:{' '}
        <code className="text-foreground bg-muted/50 px-1 rounded">{divergence.baselineSummary ?? '(unknown)'}</code>
        {' · '}
        <span className="font-medium">{winnerSide}</span>:{' '}
        <code className="text-foreground bg-muted/50 px-1 rounded">{divergence.comparisonSummary ?? '(unknown)'}</code>
      </>
    );
  }

  return (
    <div
      className="flex items-start gap-1.5 mt-1 text-[10px] text-muted-foreground"
      title="First step where the trajectories diverge"
    >
      <Icon size={11} className={cn('shrink-0 mt-0.5', iconColor)} />
      <span className="leading-snug">
        <span className="font-medium text-foreground">{stepLabel}:</span> {summary}
      </span>
    </div>
  );
};

interface UseCaseComparisonTableProps {
  rows: TestCaseComparisonRow[];
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
  referenceRunId?: string;
  visibleEvaluators?: Set<EvaluatorType>;
  /** Map of testCaseId → cluster index, used to draw a colored dot per row */
  clusterByCaseId?: Map<string, number>;
  trajectoryRunPair?: [string, string] | null;
  trajectoryTargetTestCase?: string | null;
  onTrajectoryRequest?: (testCaseId: string) => void;
  /** A clicked span citation from the deep-dive: expand this row + open Traces. */
  spanDeepLink?: { testCaseId: string; runId: string; spanId: string; nonce: number } | null;
  /** Trace-window hints (serviceName + window) per agent runId, for span fetch. */
  windowAgentsByRunId?: Map<string, { serviceName?: string; startedAt: number; endedAt: number }>;
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
  referenceRunId: propReferenceRunId,
  visibleEvaluators,
  clusterByCaseId,
  onTrajectoryRequest,
  spanDeepLink,
  windowAgentsByRunId,
}) => {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // A span citation was clicked in the deep-dive → auto-expand that test case
  // so its Traces tab (and the highlighted span) becomes visible.
  React.useEffect(() => {
    if (spanDeepLink?.testCaseId) {
      setExpandedRows((prev) => new Set(prev).add(spanDeepLink.testCaseId));
    }
  }, [spanDeepLink?.nonce, spanDeepLink?.testCaseId]);

  // Use prop if provided, otherwise fall back to first run
  const referenceRunId = propReferenceRunId || runs[0]?.id;

  // Per-row coverage: how many of the selected runs actually ran a given case
  // (status !== 'missing'). Used to render a coverage chip so a partial-overlap
  // comparison (e.g. cross-benchmark / ad-hoc runs) is never misread as "both
  // runs ran all these tests" — the chip + the per-cell "Not run" make the
  // "N in common" banner self-evident in the table.
  const ranCountFor = (row: TestCaseComparisonRow) =>
    runs.reduce((n, r) => n + ((row.results[r.id]?.status ?? 'missing') !== 'missing' ? 1 : 0), 0);

  // Only surface coverage chips when the selection actually has mixed coverage
  // (some row isn't run by every selected run). Same-set comparisons (the common
  // iterate case) stay chip-free to avoid noise.
  const hasMixedCoverage = useMemo(
    () => runs.length >= 2 && rows.some(row => { const c = ranCountFor(row); return c > 0 && c < runs.length; }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, runs]
  );

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

  const columnCount = runs.length + 1; // +1 for the test case column

  return (
    <ScrollArea className="rounded-md border border-border">
      <div className="min-w-full">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-72 sticky left-0 bg-background z-10">
                Test Case
              </TableHead>
              {runs.map((run) => (
                <TableHead key={run.id} className="text-center min-w-32">
                  <div className="truncate">{getAgentName(run.agentKey)}</div>
                  <div className="text-[10px] text-muted-foreground font-normal truncate">
                    {run.name}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const referenceResult = row.results[referenceRunId];
              const referenceAccuracy = referenceResult?.accuracy;
              const isExpanded = expandedRows.has(row.testCaseId);
              const rowStatus = calculateRowStatus(row, referenceRunId);
              const ranRuns = runs.filter(r => (row.results[r.id]?.status ?? 'missing') !== 'missing');
              const isPartialRow = hasMixedCoverage && ranRuns.length > 0 && ranRuns.length < runs.length;

              return (
                <React.Fragment key={row.testCaseId}>
                  <TableRow
                    className={cn(
                      'cursor-pointer hover:bg-muted/50 transition-colors',
                      isExpanded && 'bg-muted/30',
                      isPartialRow && 'bg-amber-500/[0.04]',
                      rowStatusStyles[rowStatus]
                    )}
                    onClick={() => {
                      toggleRow(row.testCaseId);
                    }}
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
                            {clusterByCaseId?.has(row.testCaseId) && (
                              <span
                                className="inline-block h-2 w-2 rounded-full shrink-0"
                                style={{ backgroundColor: getClusterDotColor(clusterByCaseId.get(row.testCaseId) ?? 0) }}
                                title="Part of a failure pattern cluster"
                                aria-hidden
                              />
                            )}
                            <Link
                              to={`/evals3/test-cases/${row.testCaseId}`}
                              className="font-medium truncate max-w-48 hover:underline text-foreground"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {row.testCaseName}
                            </Link>
                            {row.hasVersionDifference && (
                              <VersionIndicator versions={row.versions} />
                            )}
                            {hasMixedCoverage && (
                              ranRuns.length === runs.length ? (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1.5 py-0 border-green-500/40 text-green-600 dark:text-green-400 shrink-0"
                                  title="Ran by every selected run — directly comparable"
                                >
                                  {runs.length === 2 ? 'In both' : `In all ${runs.length}`}
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1.5 py-0 border-amber-500/40 text-amber-600 dark:text-amber-400 shrink-0"
                                  title={`Only run by: ${ranRuns.map(r => r.name).join(', ')} — the other run(s) show “Not run”`}
                                >
                                  {ranRuns.length === 1 ? `Only ${ranRuns[0].name}` : `${ranRuns.length}/${runs.length} runs`}
                                </Badge>
                              )
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground font-mono truncate max-w-48">
                            {row.testCaseId}
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
                          {(rowStatus === 'regression' || rowStatus === 'mixed') && (
                            <DivergencePreviewRow row={row} runs={runs} reports={reports} />
                          )}
                        </div>
                      </div>
                    </TableCell>
                    {runs.map((run) => {
                      const result = row.results[run.id] || { status: 'missing' as const };
                      const isReference = run.id === referenceRunId;

                      // Look up annotation count from report
                      const reportId = result.reportId;
                      const report = reportId ? reports[reportId] : undefined;
                      const annotationCount = report?.annotations?.length ?? 0;

                      return (
                        <TableCell key={run.id} className="p-0">
                          <MetricCell
                            result={result}
                            isReference={isReference}
                            baselineAccuracy={referenceAccuracy}
                            baselineFaithfulness={referenceResult?.faithfulness}
                            annotationCount={annotationCount}
                            visibleEvaluators={visibleEvaluators}
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
                          windowAgentsByRunId={windowAgentsByRunId}
                          spanDeepLink={spanDeepLink?.testCaseId === row.testCaseId ? spanDeepLink : null}
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
