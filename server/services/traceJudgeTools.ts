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

/** Above this size, skip pretty-printing — the indentation alone is ~30% more chars in the model's context. */
const PRETTY_PRINT_MAX_CHARS = 20_000;

function textResult(obj: unknown) {
  const pretty = JSON.stringify(obj, null, 2);
  const text = pretty.length > PRETTY_PRINT_MAX_CHARS ? JSON.stringify(obj) : pretty;
  return { content: [{ type: 'text' as const, text }], details: obj };
}

/**
 * Character cap for a single trace-tool result. The pi SDK appends tool
 * results to the SAME model context as the evaluation prompt, and the raw
 * span dump of one run has been measured at 400k–970k chars (~130k–320k
 * tokens at the ~3 chars/token JSON tokenizes to) — by itself past a
 * 200k-token window. Sending that back to the
 * model turned a judgeable case into a deterministic "Input is too long for
 * requested model" failure on the judge's SECOND turn. Env override:
 * `AH_JUDGE_TOOL_RESULT_CAP` (chars).
 */
export const DEFAULT_TOOL_RESULT_CAP_CHARS = 100_000;
/** Long attribute values (tool inputs/outputs echoed into span attrs) are cut to this first. */
const ATTRIBUTE_VALUE_CAP_CHARS = 2_000;

export function resolveToolResultCap(): number {
  const n = Number.parseInt(process.env.AH_JUDGE_TOOL_RESULT_CAP ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOOL_RESULT_CAP_CHARS;
}

function capAttributeValues(attrs: unknown, cap: number): unknown {
  if (!attrs || typeof attrs !== 'object') return attrs;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    const s = typeof v === 'string' ? v : v != null && typeof v === 'object' ? JSON.stringify(v) : undefined;
    out[k] = s !== undefined && s.length > cap ? `${s.slice(0, cap)}…[truncated ${s.length - cap} chars]` : v;
  }
  return out;
}

/**
 * Bound a `query_spans` payload to `capChars` when serialized:
 *   1. cut long attribute values (the usual culprit: tool call inputs/outputs
 *      echoed into span attributes) to ATTRIBUTE_VALUE_CAP_CHARS, then to a
 *      quarter of that if still too big;
 *   2. if still too big, drop spans from the MIDDLE — the first spans carry
 *      the run's setup/intent and the last ones carry the outcome/failure
 *      evidence, which is what a judge needs most — and say how many.
 * Returns the (possibly) reduced span list plus a `truncation` note the
 * model can act on (narrow with `nameFilter`).
 */
export function boundSpansPayload<T extends { attributes?: unknown }>(
  spans: T[],
  capChars: number,
): { spans: T[]; truncation?: { attributeValuesCapped: boolean; droppedSpans: number; note: string } } {
  const size = (s: T[]) => JSON.stringify(s).length;
  if (size(spans) <= capChars) return { spans };
  let attrCap = ATTRIBUTE_VALUE_CAP_CHARS;
  let reduced = spans.map((s) => ({ ...s, attributes: capAttributeValues(s.attributes, attrCap) }));
  if (size(reduced) > capChars) {
    attrCap = Math.floor(ATTRIBUTE_VALUE_CAP_CHARS / 4);
    reduced = spans.map((s) => ({ ...s, attributes: capAttributeValues(s.attributes, attrCap) }));
  }
  let dropped = 0;
  while (reduced.length > 1 && size(reduced) > capChars) {
    // Remove a middle slice proportional to the overshoot so we don't loop
    // hundreds of times; keep the head and the tail.
    const overshoot = size(reduced) / capChars;
    const drop = Math.min(reduced.length - 1, Math.max(1, Math.floor(reduced.length * (1 - 1 / overshoot))));
    const keep = reduced.length - drop;
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    reduced = [...reduced.slice(0, head), ...(tail > 0 ? reduced.slice(reduced.length - tail) : [])];
    dropped += drop;
  }
  return {
    spans: reduced,
    truncation: {
      attributeValuesCapped: true,
      droppedSpans: dropped,
      note:
        `Result exceeded the ${capChars}-char tool budget: long attribute values were cut to ${attrCap} chars` +
        (dropped > 0 ? ` and ${dropped} of ${spans.length} spans were dropped from the middle (first and last spans kept)` : '') +
        '. Pass nameFilter to narrow the query if you need the rest.',
    },
  };
}

/** Bound a `query_logs` payload by dropping trailing log lines. */
export function boundLogsPayload<T>(logs: T[], capChars: number): { logs: T[]; truncation?: { droppedLogs: number; note: string } } {
  const size = (l: T[]) => JSON.stringify(l).length;
  if (size(logs) <= capChars) return { logs };
  let reduced = logs;
  while (reduced.length > 0 && size(reduced) > capChars) {
    const overshoot = size(reduced) / capChars;
    const drop = Math.max(1, Math.floor(reduced.length * (1 - 1 / overshoot)));
    reduced = reduced.slice(0, Math.max(0, reduced.length - drop));
  }
  const dropped = logs.length - reduced.length;
  return {
    logs: reduced,
    truncation: {
      droppedLogs: dropped,
      note: `Result exceeded the ${capChars}-char tool budget: the last ${dropped} of ${logs.length} log lines were dropped. Pass a query substring to narrow.`,
    },
  };
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
          const bounded = boundSpansPayload(summary, resolveToolResultCap());
          return textResult({
            runId: runId ?? null,
            scope: runId ? 'runId' : 'agents-hints',
            spanCount: summary.length,
            returnedSpanCount: bounded.spans.length,
            spans: bounded.spans,
            ...(bounded.truncation ? { truncation: bounded.truncation } : {}),
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
          const rawLogs = data?.logs ?? data;
          const boundedLogs: { logs: unknown; truncation?: { droppedLogs: number; note: string } } =
            Array.isArray(rawLogs) ? boundLogsPayload(rawLogs, resolveToolResultCap()) : { logs: rawLogs };
          return textResult({
            runId: runId ?? null,
            scope: runId ? 'runId' : 'time-window',
            logs: boundedLogs.logs,
            ...(boundedLogs.truncation ? { truncation: boundedLogs.truncation } : {}),
          });
        } catch (err: any) {
          return textResult({ error: `logs query error: ${err?.message ?? String(err)}` });
        }
      },
    });
  };
}
