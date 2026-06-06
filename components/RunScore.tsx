/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunScore — single source of truth for displaying an evaluation run's score.
 *
 * Why this exists
 * ---------------
 * Until now, ~10 different components rendered `{report.metrics.accuracy}%`
 * inline. That had three problems:
 *
 *   1. **Hardcoded metric name.** Only the *RCA Default* system evaluator
 *      emits a metric called `accuracy`. Every other evaluator (Factuality,
 *      Tool Use, Reasoning, Safety, and any custom one) emits its own metric
 *      names like `tool_selection_accuracy`, `reasoning_coherence`,
 *      `bias_detection`, etc. Reading `metrics.accuracy` for those runs
 *      yields `undefined`, which was being silently shown as `0%`.
 *
 *   2. **No label.** A bare `80%` next to a run is meaningless to the user
 *      — is that an accuracy? a weighted aggregate? a tool-selection score?
 *
 *   3. **No tooltip.** Even when the number was correct, the user had no way
 *      to see *what metrics* contributed to it.
 *
 * This component fixes all three by:
 *   - Computing a single percentage as the rounded mean of every populated
 *     numeric metric on the run (via `getRunOverallScore`), so it works for
 *     any evaluator without per-evaluator config lookup.
 *   - Always showing the word "Score" next to the number, so the meaning is
 *     unambiguous at a glance.
 *   - Attaching a tooltip that lists the underlying metric name(s) and
 *     individual values, so a user who wants to know what "Score: 84%"
 *     actually represents can hover and read.
 *   - Rendering `—` (with an explanatory tooltip) when the run hasn't been
 *     scored yet, instead of fabricating a `0%`.
 */

import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getRunOverallScore } from '@/lib/utils';

export interface RunScoreProps {
  /** The metrics object straight off a TestCaseRun / EvaluationReport. */
  metrics: Record<string, number | undefined> | undefined | null;
  /**
   * Optional class name applied to the visible label. Each call site uses a
   * different size / color (xs muted in lists, lg in detail headers, etc.),
   * so we don't bake one in.
   */
  className?: string;
  /**
   * Show the literal word "Score" before the percentage. Defaults to true —
   * dropping the label is only sensible inside a column header that already
   * says "Score". Use `compact` to hide it everywhere else.
   */
  showLabel?: boolean;
  /**
   * Render `—` without a tooltip when the run has no metrics yet. Useful in
   * very dense tables where a tooltip on every empty cell is noisy. Defaults
   * to false (we *do* show the explanatory tooltip).
   */
  silentWhenMissing?: boolean;
}

/**
 * Format the per-metric breakdown shown inside the tooltip. We keep this on
 * a separate function so unit tests can assert the exact shape without
 * mounting React.
 */
export function formatMetricsBreakdown(
  metrics: Record<string, number | undefined> | undefined | null,
): string[] {
  if (!metrics) return [];
  const entries: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === 'number' && Number.isFinite(v)) entries.push([k, v]);
  }
  // Stable alphabetical order so the breakdown is deterministic across
  // renders and matches the order users see in the evaluator config.
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}: ${Math.round(v)}%`);
}

export const RunScore: React.FC<RunScoreProps> = ({
  metrics,
  className,
  showLabel = true,
  silentWhenMissing = false,
}) => {
  const score = getRunOverallScore(metrics);
  const breakdown = formatMetricsBreakdown(metrics);
  const metricCount = breakdown.length;

  // No metrics yet — render `—` so the user knows the run hasn't been
  // scored, distinct from a real `0%`. Optionally suppress the tooltip in
  // very dense layouts.
  if (score === null) {
    const dash = <span className={className}>—</span>;
    if (silentWhenMissing) return dash;
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{dash}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-[11px]">
            No score yet — the LLM judge hasn&apos;t produced metrics for this run.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Tooltip body. For single-metric evaluators (the RCA Default emits only
  // `accuracy`), we show the metric name verbatim instead of a redundant
  // "average of 1 metric". For multi-metric evaluators we list each metric
  // and its individual value so the aggregate is auditable.
  const tooltipBody =
    metricCount === 1
      ? `Metric "${breakdown[0]}" emitted by the run's evaluator.`
      : `Average of ${metricCount} metrics emitted by the run's evaluator:\n${breakdown.join('\n')}`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={className}>
            {showLabel ? 'Score: ' : ''}
            {score}%
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-[11px] whitespace-pre-line">
          {tooltipBody}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
