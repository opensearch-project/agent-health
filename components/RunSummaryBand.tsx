/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunSummaryBand — compact "at a glance" header for the legacy run-report
 * page (RunDetailsPage.tsx), rendered directly on the bare
 * `/benchmarks/:benchmarkId/runs/:runId` route (no click-through, no
 * "Select a test case" empty pane).
 *
 * Styled to match the evals3 pages (RunInspectorPage / BenchmarkRunsPage):
 * compact stat chips, Tailwind theme classes only (no hardcoded hex —
 * that was the RunSummaryPanel donut chart's approach, which this band
 * replaces for the bare-route view).
 */

import React from 'react';
import { Calendar, CheckCircle2, XCircle, AlertTriangle, Clock, Loader2, Timer, Coins } from 'lucide-react';
import { JudgeModelLabel } from '@/components/JudgeModelLabel';
import { formatDate } from '@/lib/utils';
import { formatDuration, formatCost } from '@/services/metrics';

export interface RunSummaryStats {
  passed: number;
  failed: number;
  errored: number;
  pending: number;
  running: number;
  total: number;
}

export interface RunSummaryBandProps {
  runName: string;
  description?: string;
  benchmarkName?: string;
  agentName: string;
  modelName: string;
  /**
   * @deprecated Pass `judgeRun` (the run's `judgeModel` + `judgeModelId`) so
   * the band shows "judge kind · underlying LLM". Kept for callers that only
   * have a pre-formatted string.
   */
  judgeModelLabel?: string;
  /** The run's judge identity; rendered via JudgeModelLabel when provided. */
  judgeRun?: { judgeModel?: string | null; judgeModelId?: string | null } | null;
  evaluatorLabel: string;
  startedAt?: string;
  durationMs?: number;
  concurrency?: number;
  costUsd?: number;
  stats: RunSummaryStats;
  className?: string;
}

export const RunSummaryBand: React.FC<RunSummaryBandProps> = ({
  runName,
  description,
  benchmarkName,
  agentName,
  modelName,
  judgeModelLabel,
  judgeRun,
  evaluatorLabel,
  startedAt,
  durationMs,
  concurrency,
  costUsd,
  stats,
  className = '',
}) => {
  return (
    <div
      className={`border-b bg-card px-4 py-3 shrink-0 ${className}`}
      data-testid="run-summary-band"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold truncate" data-testid="run-title">{runName}</h2>
            {benchmarkName && (
              <span className="text-xs text-muted-foreground">· {benchmarkName}</span>
            )}
          </div>

          {description && (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          )}

          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground"
            data-testid="run-summary-band-meta"
          >
            <span>Agent: <span className="text-foreground font-medium">{agentName}</span></span>
            <span className="text-muted-foreground/50">·</span>
            <span>Model: <span className="text-foreground font-medium">{modelName}</span></span>
            <span className="text-muted-foreground/50">·</span>
            <span data-testid="run-summary-band-judge">
              Judge:{' '}
              {judgeRun !== undefined ? (
                <JudgeModelLabel run={judgeRun} className="text-foreground font-medium" />
              ) : (
                <span className="text-foreground font-medium">{judgeModelLabel ?? '—'}</span>
              )}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span data-testid="run-summary-band-evaluator">
              Evaluator: <span className="text-foreground font-medium">{evaluatorLabel}</span>
            </span>
            {startedAt && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span className="flex items-center gap-1">
                  <Calendar size={11} />
                  {formatDate(startedAt)}
                </span>
              </>
            )}
            {durationMs != null && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span
                  className="flex items-center gap-1"
                  title="Total wall-clock time for the complete run"
                >
                  <Timer size={11} />
                  Run duration: {formatDuration(durationMs)}
                </span>
              </>
            )}
            {concurrency != null && concurrency > 1 && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span>Concurrency: {concurrency}</span>
              </>
            )}
            {costUsd != null && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span
                  className="flex items-center gap-1"
                  title="Total judged cost across all test cases in this run"
                  data-testid="run-summary-band-cost"
                >
                  <Coins size={11} />
                  {formatCost(costUsd)}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Verdict stat chips — same token classes as RunInspectorPage's top bar */}
        <div className="flex items-center gap-2 text-sm shrink-0" data-testid="run-summary-band-verdicts">
          {stats.running > 0 && (
            <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400" title="Running">
              <Loader2 size={14} className="animate-spin" />
              {stats.running}
            </span>
          )}
          {stats.pending > 0 && (
            <span className="flex items-center gap-1 text-yellow-700 dark:text-yellow-400" title="Pending">
              <Clock size={14} />
              {stats.pending}
            </span>
          )}
          <span className="flex items-center gap-1 text-green-700 dark:text-green-400" title="Passed">
            <CheckCircle2 size={16} />
            {stats.passed}
          </span>
          <span className="flex items-center gap-1 text-red-700 dark:text-red-400" title="Failed">
            <XCircle size={16} />
            {stats.failed}
          </span>
          {stats.errored > 0 && (
            <span
              className="flex items-center gap-1 text-amber-600 dark:text-amber-500"
              title="Evaluator could not run (e.g. judge validation error). Excluded from pass-rate aggregation."
            >
              <AlertTriangle size={16} />
              {stats.errored}
            </span>
          )}
          <span className="text-muted-foreground">/ {stats.total}</span>
        </div>
      </div>
    </div>
  );
};
