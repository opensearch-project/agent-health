/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunTelemetryStrip — compact one-line telemetry read-out for a single run:
 *   Tokens · Cost · LLM calls · Tool calls · median Time/case · spans N/M cases
 *
 * Rendered under the run inspector's header (the benchmark run detail
 * surface). Values come from useRunTelemetry (one batch metrics request);
 * this component is presentational so the three states — loading skeleton,
 * "—" with a reason tooltip, real values — are unit-testable in isolation.
 */

import React from 'react';
import { Activity } from 'lucide-react';
import {
  RunTelemetry, formatTokensCompact, formatCostUsd, formatDurationCompact,
} from '@/lib/runTelemetry';

export const STRIP_NO_SPANS_TITLE = 'No spans found for this run yet';
export const STRIP_UNAVAILABLE_TITLE = 'Metrics unavailable';

export interface RunTelemetryStripProps {
  telemetry: RunTelemetry | undefined;
  loading: boolean;
  /** Shown as a "Retry" link when the run's metrics request failed. */
  onRetry?: () => void;
  className?: string;
}

function Stat({ label, value, title, testId, muted }: {
  label: string; value: string; title?: string; testId: string; muted?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" data-testid={testId} title={title}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${muted ? 'text-muted-foreground font-normal' : ''}`}>{value}</span>
    </span>
  );
}

export const RunTelemetryStrip: React.FC<RunTelemetryStripProps> = ({ telemetry, loading, onRetry, className }) => {
  const wrap = `flex flex-wrap items-center gap-x-4 gap-y-1 text-xs ${className || ''}`;

  if (loading && !telemetry) {
    return (
      <div className={wrap} data-testid="run-telemetry-strip" data-state="loading">
        <Activity size={11} className="text-muted-foreground shrink-0" />
        {['Tokens', 'Cost', 'LLM calls', 'Tool calls', 'Time/case'].map(l => (
          <span key={l} className="inline-flex items-baseline gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{l}</span>
            <span className="inline-block h-3 w-10 rounded bg-muted animate-pulse" aria-label="Loading" />
          </span>
        ))}
      </div>
    );
  }

  // Nothing to say at all (no reports loaded for this run) — stay out of the way.
  if (!telemetry) return null;

  const unavailable = telemetry.unavailable;
  const dashTitle = unavailable ? STRIP_UNAVAILABLE_TITLE : STRIP_NO_SPANS_TITLE;
  const hasSpans = telemetry.hasSpans;
  const prefix = telemetry.partial ? '≥' : '';
  const cost = formatCostUsd(telemetry.costUsd);

  return (
    <div className={wrap} data-testid="run-telemetry-strip" data-state={hasSpans ? 'value' : 'empty'}>
      <Activity size={11} className="text-muted-foreground shrink-0" />
      <Stat label="Tokens" testId="strip-tokens" muted={!hasSpans}
        value={hasSpans ? `${prefix}${formatTokensCompact(telemetry.totalTokens)}` : '—'}
        title={hasSpans ? `${telemetry.totalTokens.toLocaleString()} tokens` : dashTitle} />
      <Stat label="Cost" testId="strip-cost" muted={!hasSpans || cost === null}
        value={hasSpans && cost ? `${prefix}${cost}` : '—'}
        title={hasSpans ? (cost ? `$${telemetry.costUsd.toFixed(4)}` : 'Spans carried no cost') : dashTitle} />
      <Stat label="LLM calls" testId="strip-llmcalls" muted={!hasSpans}
        value={hasSpans ? `${prefix}${telemetry.llmCalls}` : '—'} title={hasSpans ? undefined : dashTitle} />
      <Stat label="Tool calls" testId="strip-toolcalls" muted={!hasSpans}
        value={hasSpans ? `${prefix}${telemetry.toolCalls}` : '—'} title={hasSpans ? undefined : dashTitle} />
      {/* Wall-clock comes from the reports, not the trace store — valid even
          when spans were not found or the metrics request failed. */}
      <Stat label="Time/case" testId="strip-timepercase" muted={telemetry.medianDurationMs === null}
        value={formatDurationCompact(telemetry.medianDurationMs)}
        title="Median wall-clock per test case (agent + judge)" />
      <span
        className="text-[10px] text-muted-foreground whitespace-nowrap"
        data-testid="strip-spans"
        title={unavailable ? STRIP_UNAVAILABLE_TITLE : (hasSpans ? 'Cases whose agent spans were found in the trace store' : STRIP_NO_SPANS_TITLE)}
      >
        spans: {unavailable ? '—' : `${telemetry.spansCases}/${telemetry.totalCases}`} cases
      </span>
      {unavailable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          data-testid="strip-retry"
          className="text-[10px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
        >
          Retry
        </button>
      )}
    </div>
  );
};
