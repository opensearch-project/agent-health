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

function DeltaValue({ value, baseline, label }: { value?: number; baseline?: number; label: string }) {
  if (value === undefined) return null;
  const delta = baseline !== undefined ? value - baseline : undefined;
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <span>
        <span className="font-medium">{value}%</span>
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
      <div className="text-center py-2 text-muted-foreground">
        <Minus size={16} className="mx-auto mb-1 opacity-50" />
        <span className="text-xs">Not run</span>
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
  const accuracy = result.accuracy ?? 0;
  const accDelta = !isReference && baselineAccuracy !== undefined ? accuracy - baselineAccuracy : undefined;

  return (
    <div className="py-2 px-2.5 group relative">
      {/* Pass/Fail status dot + label */}
      <div className="flex items-center justify-center gap-1.5">
        <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', isPassed ? 'bg-green-500' : 'bg-red-400')} />
        <span className={cn('text-xs font-medium', isPassed ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400')}>
          {isPassed ? 'Passed' : 'Failed'}
        </span>
      </div>

      {/* Metrics grid */}
      <div className="mt-1 space-y-0.5">
        {/* Accuracy — always shown */}
        {show('accuracy') && (
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">Acc</span>
          <div className="flex items-center gap-1">
            <span className="font-medium">{accuracy}%</span>
            {accDelta !== undefined && accDelta !== 0 && (
              <span className={cn(
                'inline-flex items-center gap-0.5 px-1.5 py-0 rounded-full text-[9px] font-medium',
                accDelta > 0
                  ? 'bg-blue-500/10 text-blue-500'
                  : 'bg-red-500/10 text-red-400'
              )}>
                {accDelta > 0 ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                {accDelta > 0 ? '+' : ''}{accDelta}
              </span>
            )}
          </div>
        </div>
        )}

        {/* Faithfulness — show if available and visible */}
        {show('faithfulness') && (
        <DeltaValue
          value={result.faithfulness}
          baseline={!isReference ? baselineFaithfulness : undefined}
          label="Faith"
        />
        )}

        {/* Trajectory Alignment — show if available and visible */}
        {show('trajectory') && result.trajectoryAlignment !== undefined && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Traj</span>
            <span className="font-medium">{result.trajectoryAlignment}%</span>
          </div>
        )}

        {/* Latency Score — show if available and visible */}
        {show('latency') && result.latencyScore !== undefined && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Lat</span>
            <span className="font-medium">{result.latencyScore}%</span>
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
