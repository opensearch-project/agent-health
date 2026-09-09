/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared result status primitives for evaluation runs.
 *
 * Used by: RunInspectorPage, BenchmarkRunDetailPage, RunDetailsPage
 *
 * Status progression:
 *   pending → running → pending_traces → pending_judgment → passed/failed
 */

import React from 'react';
import { CheckCircle2, XCircle, Loader2, Clock, AlertTriangle, PlugZap } from 'lucide-react';
import type { EvaluationReport, FailureStage } from '@/types';
import { getFailureStage } from '@/lib/reportFailure';

export type ResultStatus = 'passed' | 'failed' | 'errored' | 'running' | 'pending' | 'pending_traces' | 'pending_judgment';

/**
 * Derive the display status from execution status + report state.
 */
export function getResultStatus(
  runResult: { status: string },
  report: EvaluationReport | null | undefined,
): ResultStatus {
  if (runResult.status === 'running') return 'running';
  if (runResult.status === 'pending') return 'pending';
  // Agent-request failure (timeout / connection / non-2xx): the runner
  // persists status:'failed' + metricsStatus:'error' + failureStage:'agent'.
  // Surface as `errored` (amber, excluded from pass-rate) — the agent never
  // ran to completion, so it is NOT a failed verdict. The badge text
  // distinguishes it ("AGENT ERROR") via getErrorStage() below.
  if (report?.failureStage === 'agent') return 'errored';
  if (runResult.status === 'failed' || runResult.status === 'cancelled') return 'failed';

  // Metrics still in progress — show granular pending state regardless of passFailStatus
  if (report?.metricsStatus === 'pending') return 'pending_traces';
  if (report?.metricsStatus === 'calculating') return 'pending_judgment';

  // Issue #242: judge/trace evaluation failed before producing a verdict.
  // Surface as a distinct 'errored' status so users don't conflate
  // "evaluator misconfigured" with "agent answered wrong".
  if (report?.metricsStatus === 'error') return 'errored';

  // Agent execution completed and metrics ready — check judgment result
  if (report?.passFailStatus === 'passed') return 'passed';
  if (report?.passFailStatus === 'failed') return 'failed';
  if (report?.status === 'failed') return 'failed';

  // Completed but no metrics status set yet
  if (runResult.status === 'completed' && !report?.passFailStatus) return 'pending_traces';

  return 'pending';
}

/**
 * For an `errored` status, WHICH stage failed — drives the badge wording
 * ("AGENT ERROR" vs "JUDGE ERROR" vs generic "ERRORED"). Returns undefined
 * for non-errored statuses or when the report doesn't say.
 */
export function getErrorStage(status: ResultStatus, report: EvaluationReport | null | undefined): FailureStage | undefined {
  if (status !== 'errored') return undefined;
  return getFailureStage(report);
}

/**
 * Status icon component — consistent across all eval pages.
 */
export function StatusIcon({ status, size = 14, stage }: { status: ResultStatus; size?: number; stage?: FailureStage }) {
  switch (status) {
    case 'passed': return <CheckCircle2 size={size} className="text-green-500" />;
    case 'failed': return <XCircle size={size} className="text-red-500" />;
    case 'errored':
      return stage === 'agent'
        ? <PlugZap size={size} className="text-orange-500" data-testid="status-icon-agent-error" />
        : <AlertTriangle size={size} className="text-amber-500" />;
    case 'running': return <Loader2 size={size} className="text-blue-500 animate-spin" />;
    case 'pending_traces': return <Loader2 size={size} className="text-amber-500 animate-spin" />;
    case 'pending_judgment': return <Loader2 size={size} className="text-purple-500 animate-spin" />;
    case 'pending': return <Clock size={size} className="text-muted-foreground" />;
  }
}

/**
 * Status label component — short text badge. Pass `stage` (from
 * {@link getErrorStage}) to read "AGENT ERROR" / "JUDGE ERROR" instead of
 * the generic "ERRORED" so users can tell "the agent never answered" from
 * "the evaluator couldn't score it" at a glance.
 */
export function StatusLabel({ status, stage }: { status: ResultStatus; stage?: FailureStage }) {
  const config: Record<ResultStatus, { label: string; cls: string }> = {
    passed: { label: 'PASSED', cls: 'text-green-500' },
    failed: { label: 'FAILED', cls: 'text-red-500' },
    errored: { label: 'ERRORED', cls: 'text-amber-500' },
    running: { label: 'RUNNING', cls: 'text-blue-500' },
    pending_traces: { label: 'PENDING', cls: 'text-amber-500' },
    pending_judgment: { label: 'JUDGING', cls: 'text-purple-500' },
    pending: { label: 'PENDING', cls: 'text-muted-foreground' },
  };
  let { label, cls } = config[status];
  if (status === 'errored' && stage === 'agent') { label = 'AGENT ERROR'; cls = 'text-orange-500'; }
  else if (status === 'errored' && stage === 'judge') { label = 'JUDGE ERROR'; }
  else if (status === 'errored' && stage === 'trace') { label = 'TRACE ERROR'; }
  return <span className={`text-[10px] font-semibold ${cls}`} data-testid="status-label" data-stage={stage}>{label}</span>;
}

/**
 * Human-readable status description for detail panels.
 */
export function getStatusDescription(status: ResultStatus, stage?: FailureStage): string {
  switch (status) {
    case 'running': return 'Running agent...';
    case 'pending_traces': return 'Agent done \u2014 waiting for traces...';
    case 'pending_judgment': return 'Running LLM judge...';
    case 'pending': return 'Pending';
    case 'passed': return 'Passed';
    case 'failed': return 'Failed';
    case 'errored':
      if (stage === 'agent') return 'Agent request failed \u2014 not judged';
      if (stage === 'judge') return 'Judge could not produce a verdict';
      if (stage === 'trace') return 'Trace pipeline failed';
      return 'Evaluator could not run';
  }
}
