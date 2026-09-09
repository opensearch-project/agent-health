/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process trace-judge tools for the agent judge (RFC 004 §4.4, #244).
 *
 * These are the same read-only `query_spans` / `query_logs` tools the agent
 * judge uses to verify claims against the run's real OTel spans/logs — but
 * registered as an **in-process** pi extension factory (no spawned CLI, no
 * extension file, no env-var scoping). `runId` and `agents` are both captured
 * by closure (so the judging model still cannot pivot to other runs/other
 * scopes), and the tools reuse the server's existing read endpoints over
 * localhost.
 *
 * Scoping handle: `runId` (Strategy B) OR `agents` hints (Strategy C/D —
 * serviceName+window / sessionId, from `buildJudgeAgentsHints`, #264). REST-
 * connector agents never mint a `runId` outside trace-mode polling, so
 * requiring `runId` unconditionally here would silently disable the tools
 * for every such request even when the route (`server/routes/judge.ts`,
 * `hasTraceCorrelation`) already accepted it on the strength of `agents`
 * alone — see `services/traces/judgeAgentsHints.ts`'s `hasTraceCorrelation`
 * doc comment for the full story. Both tools below are disabled only when
 * NEITHER `runId` nor a usable `agents` hint is present.
 */

import type { PiExtensionAPI, PiExtensionFactory } from './piSdkTypes';
import { Type } from 'typebox';
import { hasTraceCorrelation } from '@/services/traces/judgeAgentsHints';

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], details: obj };
}

type TraceAgentHint = { serviceName: string; startedAt: number; endedAt: number; sessionId?: string };

/**
 * Build an extension factory that registers the trace-scoped tools.
 * @param runId   the single run the tools scope to (closure, not a tool param) — may
 *                be `undefined` when the caller only has `agents` hints (see above).
 * @param serverUrl base URL of this Agent Health server (reuses /api/traces, /api/logs)
 * @param agents  optional Strategy C/D correlation hints (service.name + time-window,
 *                and/or sessionId). When the agent's instrumentation doesn't share
 *                `gen_ai.request.id` with agent-health's runId (e.g. claude-code emits
 *                its own session ids), or there is no runId at all (REST connectors
 *                outside trace-mode polling), these hints are what the tools scope to.
 *                Forwarding `agents` to `/api/traces` unions Strategy B (runIds) with
 *                Strategy C (service.name within the run's wall-clock window) so the
 *                judge actually sees the agent's emitted spans. See #264.
 */
export function createTraceJudgeExtension(
  runId: string | undefined,
  serverUrl: string,
  agents?: TraceAgentHint[]
): PiExtensionFactory {
  const hasHints = Array.isArray(agents) && agents.length > 0;
  const scoped = hasTraceCorrelation(runId, agents);
  // Widest [min(startedAt), max(endedAt)] across all hints — used by
  // query_logs (which has no serviceName filter of its own) as a time-window
  // fallback when there's no runId to filter on directly.
  const hintWindow = hasHints
    ? {
        startTime: Math.min(...agents!.map((a) => a.startedAt)),
        endTime: Math.max(...agents!.map((a) => a.endedAt)),
      }
    : undefined;
  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: 'query_spans',
      label: 'Query OTel spans for the run under evaluation',
      description:
        "Fetch the OpenTelemetry spans the agent emitted during THIS run (the one " +
        "you're judging). Read-only and hard-scoped to this run — you cannot query " +
        'other runs. Use it to verify claims: which tools were actually invoked and ' +
        'with what arguments, token usage, span durations/latency, and span ' +
        'attributes (gen_ai.*). Prefer this over trusting the trajectory text alone.',
      promptSnippet: 'Query the real OTel spans for the run being judged',
      promptGuidelines: [
        'Use query_spans to confirm a claimed tool call actually happened in the trace',
        'Use query_spans to check real token usage / latency before judging budget claims',
        'Pass nameFilter to narrow to spans whose name contains a substring',
      ],
      parameters: Type.Object({
        nameFilter: Type.Optional(
          Type.String({ description: 'Only return spans whose name contains this substring' })
        ),
      }),
      async execute(_toolCallId: string, params: { nameFilter?: string }) {
        if (!scoped) {
          return textResult({ error: 'No run id or trace correlation hints available — trace tools are disabled for this judge invocation.' });
        }
        try {
          // Send Strategy B (runIds) AND Strategy C (agents: service.name +
          // time-window) together — whichever are actually present. The
          // /api/traces route unions them via bool.should so a span matching
          // EITHER comes back without duplication. When there's no runId at
          // all (REST connectors outside trace-mode polling), `agents` alone
          // is enough — /api/traces treats it as a first-class id filter, not
          // just an add-on to runIds. Without `agents`, claude-code's
          // instrumentation (which doesn't stamp gen_ai.request.id with
          // agent-health's runId) is invisible to the judge — leaving the
          // judge to reason from the trajectory text alone.
          const body: Record<string, unknown> = { size: 500 };
          if (runId) {
            body.runIds = [runId];
          }
          if (hasHints) {
            body.agents = agents;
          }
          const res = await fetch(`${serverUrl}/api/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            return textResult({ error: `traces query failed: HTTP ${res.status}` });
          }
          const data: any = await res.json();
          let spans: any[] = Array.isArray(data?.spans) ? data.spans : [];
          if (params.nameFilter) {
            const f = params.nameFilter.toLowerCase();
            spans = spans.filter((s) => String(s?.name ?? '').toLowerCase().includes(f));
          }
          const summary = spans.map((s) => ({
            spanId: s.spanId,
            traceId: s.traceId,
            name: s.name,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            attributes: s.attributes,
          }));
          return textResult({
            runId: runId ?? null,
            scope: runId ? 'runId' : 'agents-hints',
            spanCount: summary.length,
            spans: summary,
            warning: data?.warning,
          });
        } catch (err: any) {
          return textResult({ error: `traces query error: ${err?.message ?? String(err)}` });
        }
      },
    });

    pi.registerTool({
      name: 'query_logs',
      label: 'Query logs for the run under evaluation',
      description:
        'Fetch application/OTel logs correlated to THIS run. Read-only and ' +
        'hard-scoped to this run. Use it to find evidence for or against a ' +
        'root-cause claim (error messages, stack traces, status codes).',
      promptSnippet: 'Query the logs for the run being judged',
      promptGuidelines: [
        'Use query_logs to verify a claimed root cause is actually supported by log evidence',
        'Pass a query substring to filter the log lines',
      ],
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: 'Optional substring/text filter for log lines' })),
      }),
      async execute(_toolCallId: string, params: { query?: string }) {
        if (!scoped) {
          return textResult({ error: 'No run id or trace correlation hints available — trace tools are disabled for this judge invocation.' });
        }
        try {
          // /api/logs has no serviceName filter of its own — when there's a
          // runId, filter on it directly (existing behavior, unbounded by
          // time: "searching by runId, we want to find logs regardless of
          // age" — see server/services/logsService.ts). When there's ONLY
          // `agents` hints (no runId at all — REST connectors outside
          // trace-mode polling), fall back to the widest time window across
          // the hints so the query is still scoped rather than defaulting to
          // /api/logs's unscoped last-60-minutes fallback.
          const body: Record<string, unknown> = { query: params.query, size: 200 };
          if (runId) {
            body.runId = runId;
          } else if (hintWindow) {
            body.startTime = hintWindow.startTime;
            body.endTime = hintWindow.endTime;
          }
          const res = await fetch(`${serverUrl}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            return textResult({ error: `logs query failed: HTTP ${res.status}` });
          }
          const data: any = await res.json();
          return textResult({
            runId: runId ?? null,
            scope: runId ? 'runId' : 'time-window',
            logs: data?.logs ?? data,
          });
        } catch (err: any) {
          return textResult({ error: `logs query error: ${err?.message ?? String(err)}` });
        }
      },
    });
  };
}

/** Shared run-scoped fetch used for canonical evidence discovery. */
export async function fetchTraceJudgeSpans(runId: string, serverUrl: string, agents?: any[]): Promise<any> {
  const body: Record<string, unknown> = { runIds: [runId], size: 500 };
  if (agents?.length) body.agents = agents;
  const res = await fetch(`${serverUrl}/api/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`traces query failed: HTTP ${res.status}`);
  return res.json();
}

/** Shared run-scoped log fetch used for canonical evidence discovery. */
export async function fetchTraceJudgeLogs(runId: string, serverUrl: string, query?: string): Promise<any> {
  const res = await fetch(`${serverUrl}/api/logs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, query, size: 200 }) });
  if (!res.ok) throw new Error(`logs query failed: HTTP ${res.status}`);
  return res.json();
}
