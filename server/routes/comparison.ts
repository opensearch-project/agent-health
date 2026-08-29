/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Routes — agentic deep-dive over two runs.
 *
 * POST /api/comparison/deep-dive
 *   body: { reportIds: [reportIdA, reportIdB], modelId? }
 *   resp: { markdown, modelId, durationMs,
 *           runs: [{ key, reportId, runId, serviceName, startedAt, endedAt }] }
 *
 * Resolves each run's trace identity SERVER-SIDE (serviceName from the live
 * agent config, wall-clock window from the saved report) — the frontend
 * DEFAULT_CONFIG is static and wouldn't know dynamically-added agents — then
 * runs the in-process comparison agent (pi SDK + run-scoped trace tools).
 * The returned `runs[]` give the frontend exactly the window-agent hints it
 * needs to deep-link span citations into the Traces tab.
 */

import { Router, Request, Response } from 'express';
import { loadConfigSync } from '@/lib/config/index';
import { getStorageModule } from '@/server/adapters';
import {
  generateComparisonDeepDive,
  type ComparisonRunInput,
} from '@/server/services/comparisonDeepDiveService';
import { debug } from '@/lib/debug';
import { getJudgeVerdict } from '@/lib/reportVerdict';

const router = Router();

const PROTOCOL_TO_SERVICE: Record<string, string> = {
  'claude-code': 'claude-code-agent',
  kiro: 'kiro-agent',
  pi: 'pi-agent',
  'agui-streaming': 'observio-sample-agent',
};

const SLACK_MS = 60_000;
const FALLBACK_LOOKBACK_MS = 30 * 60_000;

/** Resolve the OTel service.name an agent emits spans under. */
function resolveServiceName(report: any): string | undefined {
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

/** Derive the Strategy-C window + serviceName hint for a run (mirrors RunDetailsContent). */
function resolveWindow(report: any): {
  serviceName?: string;
  startedAt: number;
  endedAt: number;
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
} {
  const serviceName = resolveServiceName(report);
  // `report.timestamp` is NOT reliably the run END — trace-mode / subprocess
  // reports (Claude Code) are persisted at run START, so an end-anchored
  // backward window lands BEFORE the run and matches no spans (deep-dive then
  // reports "no traces"). Anchor SYMMETRICALLY around the timestamp by
  // ±(duration + slack) so the window covers the run whether the timestamp is
  // its start or end. Mirrors services/traces/judgeAgentsHints.ts.
  const ts = Date.parse(report?.timestamp || '') || Date.now();
  const durationMs = report?.performanceMetrics?.durationMs ?? 0;
  const span = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
  const startedAt = ts - span;
  const endedAt = ts + span;
  const agents = serviceName
    ? [{ serviceName, startedAt, endedAt }]
    : undefined;
  return { serviceName, startedAt, endedAt, agents };
}

function extractToolNames(report: any): string[] {
  const traj = Array.isArray(report?.trajectory) ? report.trajectory : [];
  return traj
    .filter((s: any) => s?.type === 'action' && s?.toolName)
    .map((s: any) => s.toolName as string);
}

function extractFinalOutput(report: any): string | undefined {
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

router.post('/api/comparison/deep-dive', async (req: Request, res: Response) => {
  const { reportIds, modelId } = (req.body || {}) as { reportIds?: unknown; modelId?: string };
  if (!Array.isArray(reportIds) || reportIds.length !== 2 || !reportIds.every((x) => typeof x === 'string')) {
    return res.status(400).json({ error: 'reportIds must be an array of exactly 2 report id strings' });
  }

  try {
    const storage = getStorageModule();
    const reports = await Promise.all((reportIds as string[]).map((id) => storage.runs.getById(id)));
    const missing = reportIds.filter((_, i) => !reports[i]);
    if (missing.length) {
      return res.status(404).json({ error: `report(s) not found: ${missing.join(', ')}` });
    }

    const keys = ['A', 'B'];
    const runInputs: ComparisonRunInput[] = [];
    const runMeta: Array<{ key: string; reportId: string; runId?: string; serviceName?: string; startedAt: number; endedAt: number }> = [];

    reports.forEach((report: any, i) => {
      const win = resolveWindow(report);
      const verdict = getJudgeVerdict(report);
      runInputs.push({
        key: keys[i],
        label: report.agentName || report.agentKey || `Run ${keys[i]}`,
        runId: report.runId,
        agents: win.agents,
        passFailStatus: verdict?.status,
        accuracy: verdict?.score ?? undefined,
        toolNames: extractToolNames(report),
        durationMs: report?.performanceMetrics?.durationMs,
        finalOutput: extractFinalOutput(report),
      });
      runMeta.push({
        key: keys[i],
        reportId: reportIds[i] as string,
        runId: report.runId,
        serviceName: win.serviceName,
        startedAt: win.startedAt,
        endedAt: win.endedAt,
      });
    });

    debug('CompareDeepDiveAPI', 'reports:', reportIds.join(','), 'services:', runMeta.map((m) => m.serviceName).join(','));

    const result = await generateComparisonDeepDive({ runs: runInputs, modelId });
    return res.json({ ...result, runs: runMeta });
  } catch (err: any) {
    console.error('[CompareDeepDiveAPI] error:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
