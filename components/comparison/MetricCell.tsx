/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { TrendingUp, TrendingDown, Minus, MessageSquare, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TestCaseRunResult } from '@/types';

/** Which evaluator metrics to show in the cell */
export type EvaluatorType = 'accuracy' | 'faithfulness' | 'trajectory' | 'latency' | 'annotations';

interface MetricCellProps {
  result: TestCaseRunResult;
  isReference?: boolean;
  baselineAccuracy?: number;
  baselineFaithfulness?: number;
  annotationCount?: number;
  visibleEvaluators?: Set<EvaluatorType>;
}

// Metric values arrive as raw JS floats — a 95.5 vs 95.8 subtraction renders
// "-0.29999999999999716" without this. One decimal is all a comparison needs.
const round1 = (n: number): number => Math.round(n * 10) / 10;

function DeltaValue({ value, baseline, label }: { value?: number; baseline?: number; label: string }) {
  if (value === undefined) return null;
  const delta = baseline !== undefined ? round1(value - baseline) : undefined;
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <span>
        <span className="font-medium">{round1(value)}%</span>
        {delta !== undefined && delta !== 0 && (
          <span className={cn('ml-0.5', delta > 0 ? 'text-opensearch-blue' : 'text-red-400')}>
            ({delta > 0 ? '+' : ''}{delta})
          </span>
        )}
      </span>
    </div>
  );
}

export const MetricCell: React.FC<MetricCellProps> = ({
  result,
  isReference = false,
  baselineAccuracy,
  baselineFaithfulness,
  annotationCount = 0,
  visibleEvaluators,
}) => {
  // Default: show only accuracy when visibleEvaluators is not provided
  const show = (type: EvaluatorType) => {
    if (!visibleEvaluators) return type === 'accuracy';
    return visibleEvaluators.has(type);
  };

  if (result.status === 'missing') {
    return (
      <div className="flex items-center justify-center gap-1 py-1 text-muted-foreground">
        <Minus size={12} className="opacity-50" />
        <span className="text-[11px]">Not run</span>
      </div>
    );
  }

  // Issue #242: evaluator-error result — distinct visual from Failed.
  // The result.errored flag is set by comparisonService when the report's
  // `metricsStatus === 'error'` (judge couldn't produce a verdict). Render
  // it as the amber `Errored` chip so misconfigured evaluators don't
  // visually masquerade as agent failures in side-by-side comparisons.
  if (result.errored) {
    return (
      <div
        className="py-2 px-2.5 group relative"
        title="Evaluator could not run (e.g. judge validation error). Excluded from pass-rate aggregation."
      >
        <div className="flex items-center justify-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 bg-amber-500" />
          <span className="text-xs font-medium text-amber-600 dark:text-amber-500">
            <AlertTriangle size={10} className="inline-block mr-0.5 -mt-0.5" />
            Errored
          </span>
        </div>
        {/* Metrics intentionally omitted: an errored run has zeroed metrics
            that the comparison cell would otherwise render as a real 0%
            score, defeating the whole point of the distinct bucket. */}
      </div>
    );
  }

  const isPassed = result.passFailStatus === 'passed';
  // Same fabricated-zero trap as the scoreboard's Avg Accuracy: reports scored
  // by a custom evaluator carry entirely different metric keys (e.g.
  // fact_precision / provenance_verifiability) and no `metrics.accuracy` at
  // all. The old `?? 0` fallback rendered a "0%" accuracy chip on EVERY
  // per-case cell of such a comparison — indistinguishable from a case that
  // genuinely scored zero. When the report carries no numeric accuracy, the
  // chip is omitted entirely; a real accuracy of 0 still renders "0%".
  const accuracy = typeof result.accuracy === 'number' ? result.accuracy : undefined;
  const accDelta = !isReference && accuracy !== undefined && baselineAccuracy !== undefined
    ? round1(accuracy - baselineAccuracy)
    : undefined;
  const rubricEntries = Object.entries(result.rubricValues ?? {});

  return (
    <div className="py-1 px-2.5 group relative">
      {/* Dense primary row: status + accuracy + delta on ONE line — a status
          label and a label-value "Accuracy" pair on separate lines tripled the
          row height for no information gain. */}
      <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
        <span className={cn('w-2 h-2 rounded-full flex-shrink-0', isPassed ? 'bg-green-500' : 'bg-red-400')} />
        <span className={cn('text-[11px] font-medium', isPassed ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400')}>
          {isPassed ? 'Passed' : 'Failed'}
        </span>
        {show('accuracy') && accuracy !== undefined && (
          <>
            <span className="text-[11px] font-medium tabular-nums ml-1" title="Accuracy" data-testid="metric-cell-accuracy">{round1(accuracy)}%</span>
            {accDelta !== undefined && accDelta !== 0 && (
              <span className={cn(
                'inline-flex items-center gap-0.5 px-1 py-0 rounded-full text-[9px] font-medium tabular-nums',
                accDelta > 0
                  ? 'bg-blue-500/10 text-blue-500'
                  : 'bg-red-500/10 text-red-400'
              )}>
                {accDelta > 0 ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                {accDelta > 0 ? '+' : ''}{accDelta}
              </span>
            )}
          </>
        )}
        {/* Snapshot-scored report: the per-case weighted score (the only
            number this cell ever calls "score"). */}
        {show('accuracy') && result.score !== undefined && (
          <span
            className="inline-flex items-center gap-1 ml-1"
            title="Score: weighted mean of this report's rubrics per its scoring snapshot"
            data-testid="metric-cell-score"
          >
            <span className="text-[10px] text-muted-foreground">score</span>
            <span className="text-[11px] font-medium tabular-nums">{round1(result.score)}%</span>
          </span>
        )}
        {/* Legacy report with no accuracy and no snapshot: show the rubric
            values BY NAME (stored order, first two inline, all in the
            tooltip). Never pick one and call it the score. */}
        {show('accuracy') && accuracy === undefined && result.score === undefined && rubricEntries.length > 0 && (
          <span
            className="inline-flex items-center gap-1.5 ml-1 max-w-[150px]"
            title={`Legacy scoring — rubric values by name: ${rubricEntries.map(([k, v]) => `${k} ${round1(v)}%`).join(', ')}`}
            data-testid="metric-cell-rubrics"
          >
            {rubricEntries.slice(0, 2).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-0.5 min-w-0">
                <span className="truncate text-[10px] text-muted-foreground max-w-[60px]">{k}</span>
                <span className="text-[11px] font-medium tabular-nums flex-shrink-0">{round1(v)}%</span>
              </span>
            ))}
            {rubricEntries.length > 2 && (
              <span className="text-[10px] text-muted-foreground">+{rubricEntries.length - 2}</span>
            )}
          </span>
        )}
      </div>

      {/* Secondary metrics — only when explicitly toggled visible */}
      <div className="space-y-0.5">
        {/* Faithfulness — show if available and visible */}
        {show('faithfulness') && (
        <DeltaValue
          value={result.faithfulness}
          baseline={!isReference ? baselineFaithfulness : undefined}
          label="Faithfulness"
        />
        )}

        {/* Trajectory Alignment — show if available and visible */}
        {show('trajectory') && result.trajectoryAlignment !== undefined && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground" title="Trajectory alignment">Trajectory</span>
            <span className="font-medium">{round1(result.trajectoryAlignment)}%</span>
          </div>
        )}

        {/* Latency Score — show if available and visible */}
        {show('latency') && result.latencyScore !== undefined && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground" title="Latency score">Latency</span>
            <span className="font-medium">{round1(result.latencyScore)}%</span>
          </div>
        )}
      </div>

      {/* Annotation indicator */}
      {show('annotations') && annotationCount > 0 && (
        <div className="flex items-center justify-center gap-1 mt-1.5 text-[9px] text-amber-500">
          <MessageSquare size={10} />
          <span>{annotationCount} annotation{annotationCount > 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
};
