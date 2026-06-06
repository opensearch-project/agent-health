/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process trace-judge tools for the agent judge (RFC 004 §4.4, #244).
 *
 * These are the same read-only, run-scoped `query_spans` / `query_logs` tools
 * the agent judge uses to verify claims against the run's real OTel spans/logs
 * — but registered as an **in-process** pi extension factory (no spawned CLI,
 * no extension file, no env-var scoping). The `runId` is captured by closure
 * (so the judging model still cannot pivot to other runs), and the tools reuse
 * the server's existing read endpoints over localhost.
 */

import type { PiExtensionAPI, PiExtensionFactory } from './piSdkTypes';
import { Type } from 'typebox';

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], details: obj };
}

/**
 * Build an extension factory that registers the run-scoped trace tools.
 * @param runId   the single run the tools are hard-scoped to (closure, not a tool param)
 * @param serverUrl base URL of this Agent Health server (reuses /api/traces, /api/logs)
 */
export function createTraceJudgeExtension(runId: string | undefined, serverUrl: string): PiExtensionFactory {
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
        if (!runId) {
          return textResult({ error: 'No run id available — trace tools are disabled for this judge invocation.' });
        }
        try {
          const res = await fetch(`${serverUrl}/api/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runIds: [runId], size: 500 }),
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
            name: s.name,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            attributes: s.attributes,
          }));
          return textResult({ runId, spanCount: summary.length, spans: summary, warning: data?.warning });
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
        if (!runId) {
          return textResult({ error: 'No run id available — trace tools are disabled for this judge invocation.' });
        }
        try {
          const res = await fetch(`${serverUrl}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId, query: params.query, size: 200 }),
          });
          if (!res.ok) {
            return textResult({ error: `logs query failed: HTTP ${res.status}` });
          }
          const data: any = await res.json();
          return textResult({ runId, logs: data?.logs ?? data });
        } catch (err: any) {
          return textResult({ error: `logs query error: ${err?.message ?? String(err)}` });
        }
      },
    });
  };
}
