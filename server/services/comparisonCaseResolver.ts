/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared report -> trace-identity resolution for the comparison deep-dive.
 *
 * Extracted from server/routes/comparison.ts so the SAME resolution logic
 * (Strategy C service.name + wall-clock window, Strategy D session.id) is
 * used both:
 *   - eagerly, for the two DEFAULT-case reports the route resolves up front, and
 *   - lazily, one report at a time, inside the trace tools' `query_spans` /
 *     `query_logs` execute() when the agent asks about a DIFFERENT case (see
 *     comparisonTraceTools.ts) — the whole point of comparison-wide tracing is
 *     to NOT prefetch every report for every case up front.
 */

import { loadConfigSync } from '@/lib/config/index';

export const PROTOCOL_TO_SERVICE: Record<string, string> = {
  'claude-code': 'claude-code-agent',
  kiro: 'kiro-agent',
  pi: 'pi-agent',
  'agui-streaming': 'observio-sample-agent',
};

const SLACK_MS = 60_000;
const FALLBACK_LOOKBACK_MS = 30 * 60_000;

/** Resolve the OTel service.name an agent emits spans under. */
export function resolveServiceName(report: any): string | undefined {
  const agent = report?.agentKey
    ? loadConfigSync().agents.find((a) => a.key === report.agentKey)
    : undefined;
  return (
    agent?.traceServiceName ||
    agent?.connectorConfig?.env?.OTEL_SERVICE_NAME ||
    (report?.connectorProtocol && PROTOCOL_TO_SERVICE[report.connectorProtocol]) ||
    (report?.agentKey ? `${report.agentKey}-agent` : undefined)
  );
}

export interface ReportTraceContext {
  /** Strategy B (Agent-Health run id) — set on `report.runId`. */
  runId?: string;
  /** Strategy D (precise per-run correlator, e.g. Claude Code `session.id`). */
  sessionId?: string;
  serviceName?: string;
  startedAt: number;
  endedAt: number;
  /** Strategy-C window-agent hint shape the trace tools/API already expect. */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>;
  /** Human-readable agent label for prompt context. */
  label?: string;
}

/**
 * Derive the full trace identity (Strategy B/C/D) for one report. Mirrors
 * RunDetailsContent / services/traces/judgeAgentsHints.ts.
 */
export function resolveReportTraceContext(report: any): ReportTraceContext {
  const serviceName = resolveServiceName(report);
  const sessionId = typeof report?.sessionId === 'string' ? report.sessionId : undefined;
  // `report.timestamp` is NOT reliably the run END — trace-mode / subprocess
  // reports (Claude Code) are persisted at run START, so an end-anchored
  // backward window lands BEFORE the run and matches no spans (deep-dive then
  // reports "no traces"). Anchor SYMMETRICALLY around the timestamp by
  // ±(duration + slack) so the window covers the run whether the timestamp is
  // its start or end.
  const ts = Date.parse(report?.timestamp || '') || Date.now();
  const durationMs = report?.performanceMetrics?.durationMs ?? 0;
  const span = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  const startedAt = ts - span;
  const endedAt = ts + span;
  const agents = serviceName
    ? [{ serviceName, startedAt, endedAt, sessionId }]
    : undefined;
  return {
    runId: report?.runId,
    sessionId,
    serviceName,
    startedAt,
    endedAt,
    agents,
    label: report?.agentName || report?.agentKey,
  };
}

export function extractToolNames(report: any): string[] {
  const traj = Array.isArray(report?.trajectory) ? report.trajectory : [];
  return traj
    .filter((s: any) => s?.type === 'action' && s?.toolName)
    .map((s: any) => s.toolName as string);
}

export function extractFinalOutput(report: any): string | undefined {
  if (typeof report?.finalOutput === 'string' && report.finalOutput.trim()) return report.finalOutput;
  if (typeof report?.output === 'string' && report.output.trim()) return report.output;
  const traj = Array.isArray(report?.trajectory) ? report.trajectory : [];
  for (let i = traj.length - 1; i >= 0; i--) {
    const s = traj[i];
    const text = s?.content ?? s?.text ?? s?.output;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  return undefined;
}
