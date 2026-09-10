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
import { CheckCircle2, XCircle, Loader2, Clock, AlertTriangle } from 'lucide-react';
import type { EvaluationReport } from '@/types';
import { getJudgeVerdict } from '@/lib/reportVerdict';

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
  if (runResult.status === 'failed' || runResult.status === 'cancelled') return 'failed';

  // A verdict that already landed is authoritative. In particular, a later
  // trace timeout is diagnostic metadata and must not turn PASS/FAIL into
  // ERRORED (#407). matcherResults also recovers legacy reports whose
  // passFailStatus was accidentally cleared by the timeout patch.
  const verdict = getJudgeVerdict(report);
  if (verdict) return verdict.status;

  // No verdict yet: trace/judge lifecycle state determines the placeholder.
  if (report?.metricsStatus === 'pending') return 'pending_traces';
  if (report?.metricsStatus === 'calculating') return 'pending_judgment';

  // The evaluator genuinely failed before producing any verdict.
  if (report?.metricsStatus === 'error') return 'errored';

  // Agent execution completed and metrics ready — check legacy judgment fields
  if (report?.passFailStatus === 'passed') return 'passed';
  if (report?.passFailStatus === 'failed') return 'failed';
  if (report?.status === 'failed') return 'failed';

  // Completed but no metrics status set yet
  if (runResult.status === 'completed' && !report?.passFailStatus) return 'pending_traces';

  return 'pending';
}

/**
 * Status icon component — consistent across all eval pages.
 */
export function StatusIcon({ status, size = 14 }: { status: ResultStatus; size?: number }) {
  switch (status) {
    case 'passed': return <CheckCircle2 size={size} className="text-green-500" />;
    case 'failed': return <XCircle size={size} className="text-red-500" />;
    case 'errored': return (
      <span
        title="Evaluator could not produce a judge verdict"
        aria-label="Evaluator could not produce a judge verdict"
      >
        <AlertTriangle size={size} className="text-amber-500" />
      </span>
    );
    case 'running': return <Loader2 size={size} className="text-blue-500 animate-spin" />;
    case 'pending_traces': return <Loader2 size={size} className="text-amber-500 animate-spin" />;
    case 'pending_judgment': return <Loader2 size={size} className="text-purple-500 animate-spin" />;
    case 'pending': return <Clock size={size} className="text-muted-foreground" />;
  }
}

/**
 * Status label component — short text badge.
 */
export function StatusLabel({ status }: { status: ResultStatus }) {
  const config: Record<ResultStatus, { label: string; cls: string }> = {
    passed: { label: 'PASSED', cls: 'text-green-500' },
    failed: { label: 'FAILED', cls: 'text-red-500' },
    errored: { label: 'ERRORED', cls: 'text-amber-500' },
    running: { label: 'RUNNING', cls: 'text-blue-500' },
    pending_traces: { label: 'PENDING', cls: 'text-amber-500' },
    pending_judgment: { label: 'JUDGING', cls: 'text-purple-500' },
    pending: { label: 'PENDING', cls: 'text-muted-foreground' },
  };
  const { label, cls } = config[status];
  return <span className={`text-[10px] font-semibold ${cls}`}>{label}</span>;
}

/**
 * Human-readable status description for detail panels.
 */
export function getStatusDescription(status: ResultStatus): string {
  switch (status) {
    case 'running': return 'Running agent...';
    case 'pending_traces': return 'Agent done \u2014 waiting for traces...';
    case 'pending_judgment': return 'Running LLM judge...';
    case 'pending': return 'Pending';
    case 'passed': return 'Passed';
    case 'failed': return 'Failed';
    case 'errored': return 'Evaluator could not run';
  }
}
