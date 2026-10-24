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
  TELEMETRY_EMPTY_LABEL,
  describeNoTraces,
  describeUnavailable,
} from '@/lib/runTelemetry';

/** Leading phrases of the empty-state tooltips (full text: describeNoTraces / describeUnavailable). */
export { TELEMETRY_NO_SPANS_TITLE as STRIP_NO_SPANS_TITLE, TELEMETRY_UNAVAILABLE_TITLE as STRIP_UNAVAILABLE_TITLE } from '@/lib/runTelemetry';

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
  const hasSpans = telemetry.hasSpans;
  // Trace metrics still in flight with nothing reported yet: a skeleton for
  // the trace-derived stats, never a premature "no traces" (the roll-up
  // exists as soon as the reports load, before any metrics answer).
  const settling = !hasSpans && telemetry.pendingCases > 0;
  // The empty state SAYS WHY: "no traces" (agent not traced — tooltip tells
  // how to enable it) vs "unavailable" (query failed — Retry).
  const emptyLabel = unavailable ? TELEMETRY_EMPTY_LABEL.unavailable : TELEMETRY_EMPTY_LABEL.noTraces;
  const dashTitle = unavailable ? describeUnavailable(telemetry) : describeNoTraces(telemetry);
  const prefix = telemetry.partial ? '≥' : '';
  const cost = formatCostUsd(telemetry.costUsd);
  const skeleton = <span className="inline-block h-3 w-10 rounded bg-muted animate-pulse" aria-label="Loading" />;
  const traceStat = (label: string, testId: string, value: string, title?: string, muted?: boolean) => settling
    ? <span className="inline-flex items-baseline gap-1" data-testid={testId} data-state="loading"><span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>{skeleton}</span>
    : <Stat label={label} testId={testId} muted={muted} value={value} title={title} />;

  return (
    <div className={wrap} data-testid="run-telemetry-strip" data-state={hasSpans ? 'value' : (settling ? 'loading' : 'empty')} data-empty-kind={hasSpans || settling ? undefined : (unavailable ? 'unavailable' : 'no-traces')}>
      <Activity size={11} className="text-muted-foreground shrink-0" />
      {traceStat('Tokens', 'strip-tokens',
        hasSpans ? `${prefix}${formatTokensCompact(telemetry.totalTokens)}` : emptyLabel,
        hasSpans ? `${telemetry.totalTokens.toLocaleString()} tokens` : dashTitle, !hasSpans)}
      {traceStat('Cost', 'strip-cost',
        hasSpans && cost ? `${prefix}${cost}` : (hasSpans ? '—' : emptyLabel),
        hasSpans ? (cost ? `$${telemetry.costUsd.toFixed(4)}` : 'Spans carried no cost') : dashTitle, !hasSpans || cost === null)}
      {traceStat('LLM calls', 'strip-llmcalls',
        hasSpans ? `${prefix}${telemetry.llmCalls}` : emptyLabel, hasSpans ? undefined : dashTitle, !hasSpans)}
      {traceStat('Tool calls', 'strip-toolcalls',
        hasSpans ? `${prefix}${telemetry.toolCalls}` : emptyLabel, hasSpans ? undefined : dashTitle, !hasSpans)}
      {/* Wall-clock comes from the reports, not the trace store — valid even
          when spans were not found or the metrics request failed. */}
      <Stat label="Time/case" testId="strip-timepercase" muted={telemetry.medianDurationMs === null}
        value={formatDurationCompact(telemetry.medianDurationMs)}
        title="Median wall-clock per test case (agent + judge)" />
      <span
        className="text-[10px] text-muted-foreground whitespace-nowrap"
        data-testid="strip-spans"
        title={unavailable ? dashTitle : (hasSpans ? 'Cases whose agent spans were found in the trace store' : (settling ? 'Trace metrics still loading' : dashTitle))}
      >
        spans: {unavailable ? '—' : `${telemetry.spansCases}/${telemetry.totalCases}`} cases{settling ? ' (loading…)' : ''}
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
