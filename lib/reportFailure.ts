/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derive WHICH stage of a test-case run failed from a persisted report.
 *
 * Prefers the explicit `failureStage` written by
 * `buildEvaluatorErrorPatch()` (post agent-error-surfacing); falls back to the
 * `kind=…` token in `traceError` for reports persisted before the field
 * existed, and finally to the legacy "status:'failed' + no metricsStatus"
 * shape (a pre-#481 agent/connector failure). Returns `undefined` for a
 * healthy (passed/failed-verdict/pending) report.
 *
 * Pure + dependency-free so both the browser bundle and the server can use it.
 */

import type { AgentErrorInfo, EvaluationReport, FailureStage } from '@/types';

const KIND_TOKEN_RE = /\(kind=([a-z_]+)\)/;

export function getFailureStage(report: Pick<EvaluationReport, 'status' | 'metricsStatus' | 'traceError' | 'failureStage' | 'llmJudgeReasoning' | 'passFailStatus'> | null | undefined): FailureStage | undefined {
  if (!report) return undefined;
  if (report.failureStage === 'agent' || report.failureStage === 'judge' || report.failureStage === 'trace') {
    return report.failureStage;
  }
  const kind = (report.traceError || '').match(KIND_TOKEN_RE)?.[1];
  if (kind) {
    if (kind === 'agent_failed') return 'agent';
    if (kind === 'judge_failed') return 'judge';
    if (kind.startsWith('trace_')) return 'trace';
    return 'judge';
  }
  // Legacy outer-catch shapes (pre-#481 connector failure: `Evaluation failed:
  // <msg>`; executor crash: `Evaluation error: <msg>`): status 'failed', no
  // verdict. These are AGENT/execution failures unless the message itself
  // names the judge — checked BEFORE the generic metricsStatus fallback so a
  // crash that also carries metricsStatus:'error' isn't mislabelled as a
  // judge failure (codex review).
  if (report.status === 'failed' && !report.passFailStatus && /^Evaluation (failed|error):/.test(report.llmJudgeReasoning || '')) {
    return /\bjudge\b/i.test(report.llmJudgeReasoning || '') ? 'judge' : 'agent';
  }
  // Pre-kind-token #242 evaluator-error patches (metricsStatus 'error', free-
  // text traceError): trace-pipeline wording → trace, otherwise judge.
  if (report.metricsStatus === 'error') {
    return /\b(trace|traces|span|spans|poll|polling)\b/i.test(report.traceError || '') ? 'trace' : 'judge';
  }
  return undefined;
}

/** True when the agent produced no output at all (nothing to judge). */
export function agentProducedNoOutput(report: Pick<EvaluationReport, 'trajectory' | 'rawEvents'> | null | undefined): boolean {
  if (!report) return true;
  const traj = Array.isArray(report.trajectory) ? report.trajectory.length : 0;
  const raw = Array.isArray(report.rawEvents) ? report.rawEvents.length : 0;
  return traj === 0 && raw === 0;
}

/**
 * The one-line cause to show a human for a failed report: prefers the
 * structured `error`, then the text after `): ` in `traceError`, then the
 * legacy `Evaluation failed: …` reasoning.
 */
export function getFailureCause(report: Pick<EvaluationReport, 'error' | 'traceError' | 'llmJudgeReasoning' | 'agentError'> | null | undefined): string | undefined {
  if (!report) return undefined;
  if (report.agentError?.message) return report.agentError.message;
  if (report.error) return report.error;
  const te = report.traceError;
  if (te) {
    const idx = te.indexOf('): ');
    return idx >= 0 ? te.slice(idx + 3) : te;
  }
  const m = (report.llmJudgeReasoning || '').match(/^Evaluation (?:failed|error):\s*(.+)$/s);
  return m ? m[1].trim() : undefined;
}

/** Human label for an agent-error kind. */
export function describeAgentErrorKind(kind: AgentErrorInfo['kind'] | undefined): string {
  if (!kind) return 'Agent request failed';
  if (kind === 'timeout') return 'Agent request timed out';
  if (kind === 'connection') return 'Could not connect to the agent';
  if (kind.startsWith('http_')) return `Agent returned HTTP ${kind.slice(5)}`;
  return 'Agent request failed';
}

/** Format ms as a compact human duration. */
export function formatMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return rs ? `${m} min ${rs} s` : `${m} min`;
}
