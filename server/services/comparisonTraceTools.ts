/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process trace tools for the comparison deep-dive agent.
 *
 * COMPARISON-WIDE tracing (this round): earlier versions scoped `query_spans`/
 * `query_logs` to exactly ONE pre-resolved "representative" case pair. Owner
 * feedback: "we don't want the data only limited to a single test... I want
 * the wide one" — the agent can now pass an optional `caseId` (any
 * `testCaseId` from the results table it's given) to inspect THAT case's real
 * spans/logs on either side, in addition to a sensible default when caseId is
 * omitted. Each case's report (and therefore its runId/session.id/service-
 * name window) is resolved LAZILY, one report at a time, via the injected
 * `getReport` callback — NOT prefetched for every row up front, which would
 * mean fetching up to 500×2 reports for a single generation.
 *
 * Span/log summaries include `caseId` + `runId` so the agent can emit
 * `[label](span:<caseId>:<runId>:<spanId>)` citations the UI deep-links into
 * the Traces tab of the RIGHT row. See comparisonDeepDiveService.ts.
 */

import type { PiExtensionAPI, PiExtensionFactory } from './piSdkTypes';
import type { ComparisonRunInput } from './comparisonDeepDiveService';
import { resolveReportTraceContext, type ReportTraceContext } from './comparisonCaseResolver';
import { Type } from 'typebox';

function textResult(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }], details: obj };
}

/** One A-vs-B numeric dimension the deep-dive agent found worth charting. */
export interface DeepDiveChartSeriesPoint {
  label: string;
  a: number;
  b: number;
  unit?: string;
}

/** The small A-vs-B compare-bars chart, recorded as part of `record_deepdive_extras`. */
export interface DeepDiveChartSpec {
  title: string;
  series: DeepDiveChartSeriesPoint[];
}

/** One follow-up experiment idea recorded by `record_deepdive_extras`. */
export interface DeepDiveExperimentSuggestion {
  title: string;
  rationale: string;
}

/** One (case, side) the agent actually queried — becomes a window-agent hint the client can deep-link span citations into. */
export interface VisitedCaseRef {
  key: 'A' | 'B';
  caseId: string;
  reportId: string;
  runId?: string;
  serviceName?: string;
  startedAt: number;
  endedAt: number;
}

/**
 * Mutable sink the tools below write into as a SIDE EFFECT of the agent's
 * investigation — read back by the caller after `session.prompt()` resolves.
 * `record_deepdive_extras` populates `chart`/`experiments` (at most once);
 * `query_spans`/`query_logs` append to `visitedCases` (deduped by reportId)
 * every time they successfully resolve a report, regardless of whether any
 * spans were found — so the client gets an accurate window hint for every
 * case the agent looked at, not just the ones with spans.
 */
export interface DeepDiveCapture {
  chart?: DeepDiveChartSpec;
  experiments?: DeepDiveExperimentSuggestion[];
  visitedCases?: VisitedCaseRef[];
}

/** Per-side reportId for one case in the results table. */
export interface CaseReportRef {
  a?: string;
  b?: string;
}

function recordVisited(capture: DeepDiveCapture, ref: VisitedCaseRef): void {
  capture.visitedCases = capture.visitedCases || [];
  if (capture.visitedCases.some((v) => v.reportId === ref.reportId)) return;
  capture.visitedCases.push(ref);
}

/**
 * Amplification guards for a single deep-dive generation (hardening round,
 * codex review of PR #460). Without these, a runaway or adversarially-
 * prompted agent could turn one HTTP request into an unbounded number of
 * report fetches + outbound /api/traces or /api/logs calls — the comparison
 * results table can carry up to 500 rows, and the agent is explicitly told
 * it can trace ANY of them by caseId.
 *
 *   - DEEP_DIVE_MAX_DISTINCT_CASES: caps how many DISTINCT cases (beyond the
 *     already-resolved default) the agent can lazily fetch a report for.
 *     The default case itself doesn't count — its report was already
 *     resolved eagerly by the route before the agent ever ran.
 *   - DEEP_DIVE_MAX_TOOL_CALLS: an overall ceiling on query_spans/query_logs
 *     invocations (successful or not) per generation, independent of the
 *     pi session's own tool-loop limits (defense in depth if the session
 *     doesn't already enforce one, or enforces a much looser one).
 *
 * Both budgets are scoped to ONE createComparisonTraceExtension() call —
 * i.e. one generation/job — since generateComparisonDeepDive() constructs a
 * fresh extension (and therefore fresh closures below) per call.
 */
export const DEEP_DIVE_MAX_DISTINCT_CASES = 12;
export const DEEP_DIVE_MAX_TOOL_CALLS = 40;

export function createComparisonTraceExtension(
  /** Default/fallback case (used when the agent omits `caseId`) — same shape as before. */
  defaultRuns: ComparisonRunInput[],
  /** testCaseId of the default/fallback case (same for both sides). */
  defaultCaseId: string,
  /** `testCaseId -> per-side reportId`, for every case in the results table (not just the default). */
  caseReports: Map<string, CaseReportRef>,
  /** Lazy, memoized report fetch — only called for cases the agent actually asks about. */
  getReport: (reportId: string) => Promise<any | null>,
  serverUrl: string,
  capture: DeepDiveCapture = {}
): PiExtensionFactory {
  const byKey = new Map(defaultRuns.map((r) => [r.key.toUpperCase(), r]));
  const keys = defaultRuns.map((r) => `"${r.key.toUpperCase()}"`).join(' or ');

  // Amplification-guard state — scoped to this one generation (see the doc
  // comment above createComparisonTraceExtension).
  const lazilyFetchedCaseIds = new Set<string>();
  let toolCallCount = 0;

  /** Call at the very top of query_spans/query_logs.execute, before any real work. Returns an error object to short-circuit the tool call once the overall budget is exhausted, else undefined. */
  function checkToolCallBudget(): { error: string } | undefined {
    toolCallCount++;
    if (toolCallCount > DEEP_DIVE_MAX_TOOL_CALLS) {
      return {
        error: `Tool-call budget exhausted (max ${DEEP_DIVE_MAX_TOOL_CALLS} query_spans/query_logs calls per generation) — stop querying and write your narrative now with what you've already found.`,
      };
    }
    return undefined;
  }

  /** Call from resolveSide right before a NON-default case would trigger a lazy report fetch. Returns an error object once the distinct-case budget is exhausted for a genuinely NEW case, else undefined (and records the case as visited). Re-visiting an already-counted case is always free. */
  function checkCaseFetchBudget(caseId: string): { error: string } | undefined {
    if (!lazilyFetchedCaseIds.has(caseId) && lazilyFetchedCaseIds.size >= DEEP_DIVE_MAX_DISTINCT_CASES) {
      return {
        error: `Case budget exhausted (already inspected ${lazilyFetchedCaseIds.size} distinct case${lazilyFetchedCaseIds.size === 1 ? '' : 's'}, max ${DEEP_DIVE_MAX_DISTINCT_CASES} per generation) — analyze with what you have and write your narrative now.`,
      };
    }
    lazilyFetchedCaseIds.add(caseId);
    return undefined;
  }

  const resolveDefault = (run: unknown): ComparisonRunInput | undefined =>
    byKey.get(String(run ?? '').trim().toUpperCase());

  /**
   * Resolve which report (and therefore trace identity) a tool call should
   * use: the case named by `caseId` on the given side when provided, else the
   * default/fallback case for that side. Returns `error` (and no `ctx`) when
   * resolution fails for any reason — unknown side, unknown case, or a case
   * whose report has no trace identity.
   */
  async function resolveSide(
    sideKey: string,
    caseId: string | undefined
  ): Promise<{
    error?: string;
    caseId?: string;
    reportId?: string;
    label?: string;
    ctx?: ReportTraceContext;
  }> {
    const defaultRun = resolveDefault(sideKey);
    if (!defaultRun) return { error: `Unknown run '${sideKey}'. Pass run: ${keys}.` };

    if (!caseId) {
      // Default case — the fallback trace identity is already resolved
      // (route.ts resolves the two default reports eagerly), no fetch needed.
      if (!defaultRun.runId && !(defaultRun.agents && defaultRun.agents.length)) {
        return { error: `No runId or window hints for the default case on run ${sideKey} — traces unavailable.` };
      }
      return {
        caseId: defaultCaseId,
        reportId: defaultRun.reportId || defaultCaseId,
        label: defaultRun.label,
        ctx: { runId: defaultRun.runId, agents: defaultRun.agents, startedAt: 0, endedAt: 0 },
      };
    }

    const ref = caseReports.get(caseId);
    const reportId = sideKey === 'A' ? ref?.a : ref?.b;
    if (!reportId) {
      return {
        error: `No report for run ${sideKey} on case '${caseId}' — that side may not have run this case, or the case id is wrong.`,
      };
    }
    const budgetErr = checkCaseFetchBudget(caseId);
    if (budgetErr) return budgetErr;
    const report = await getReport(reportId);
    if (!report) {
      return { error: `Report ${reportId} (case '${caseId}', run ${sideKey}) was not found in storage.` };
    }
    const ctx = resolveReportTraceContext(report);
    if (!ctx.runId && !(ctx.agents && ctx.agents.length)) {
      return { error: `Case '${caseId}', run ${sideKey}: no runId or window hints on that report — traces unavailable for this case.` };
    }
    return { caseId, reportId, label: report.agentName || report.agentKey || sideKey, ctx };
  }

  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: 'query_spans',
      label: 'Query OTel spans for one of the two runs being compared, on ANY case',
      description:
        'Fetch the real OpenTelemetry spans a run emitted for a SPECIFIC test case. Read-only and scoped to ' +
        `the two runs being compared (${keys}). Pass caseId = the exact testCaseId of any row from the results ` +
        'table to inspect that case; omit caseId to use a sensible default case. Each returned span includes ' +
        'spanId, traceId, runId, name, timing, status and gen_ai.* attributes — use the caseId + runId ECHOED ' +
        'BACK in this tool\'s response (not one you guess) to cite a span as ' +
        '[label](span:<caseId>:<runId>:<spanId>). Prefer this over the trajectory text.',
      promptSnippet: 'Query the real OTel spans for run A or B on a specific case',
      promptGuidelines: [
        'Always pass run: "A" or "B" to choose which side to inspect',
        'Pass caseId = the exact testCaseId of any row in the results table to inspect THAT case; you are not limited to one case',
        'Call it for BOTH sides of a case before comparing that case',
        'Pass nameFilter to narrow to spans whose name contains a substring',
        'Cite spans using the caseId + runId this tool echoed back, never a guessed or remembered one',
      ],
      parameters: Type.Object({
        run: Type.String({ description: `Which run to query: ${keys}` }),
        caseId: Type.Optional(
          Type.String({ description: 'The exact testCaseId of the case to inspect (from the results table). Omit for a default case.' })
        ),
        nameFilter: Type.Optional(
          Type.String({ description: 'Only return spans whose name contains this substring' })
        ),
      }),
      async execute(_toolCallId: string, params: { run?: string; caseId?: string; nameFilter?: string }) {
        const budgetErr = checkToolCallBudget();
        if (budgetErr) return textResult(budgetErr);
        const resolved = await resolveSide(String(params.run ?? ''), params.caseId);
        if (resolved.error || !resolved.ctx || !resolved.caseId || !resolved.reportId) {
          return textResult({ error: resolved.error ?? 'Could not resolve this case.' });
        }
        const { caseId, reportId, label, ctx } = resolved;
        try {
          const body: Record<string, unknown> = { size: 500 };
          if (ctx.runId) body.runIds = [ctx.runId];
          if (ctx.sessionId) body.sessionId = ctx.sessionId;
          if (ctx.agents && ctx.agents.length > 0) body.agents = ctx.agents;
          const res = await fetch(`${serverUrl}/api/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return textResult({ run: params.run, caseId, error: `traces query failed: HTTP ${res.status}` });
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
          recordVisited(capture, {
            key: params.run === 'B' ? 'B' : 'A',
            caseId,
            reportId,
            runId: ctx.runId,
            serviceName: ctx.serviceName,
            startedAt: ctx.startedAt,
            endedAt: ctx.endedAt,
          });
          return textResult({
            run: params.run,
            caseId,
            runId: ctx.runId,
            label,
            spanCount: summary.length,
            spans: summary,
            warning: data?.warning,
            citeAs: ctx.runId ? `span:${caseId}:${ctx.runId}:<spanId>` : undefined,
          });
        } catch (err: any) {
          return textResult({ run: params.run, caseId, error: `traces query error: ${err?.message ?? String(err)}` });
        }
      },
    });

    pi.registerTool({
      name: 'query_logs',
      label: 'Query logs for one of the two runs being compared, on ANY case',
      description:
        `Fetch application/OTel logs correlated to a run for a SPECIFIC test case. Read-only, scoped to the ` +
        `two runs (${keys}). Pass caseId like query_spans. Use it to find evidence for/against a root-cause or ` +
        'thoroughness claim.',
      promptSnippet: 'Query the logs for run A or B on a specific case',
      promptGuidelines: [
        'Always pass run: "A" or "B"',
        'Pass caseId = the exact testCaseId of the case to inspect, same as query_spans',
        'Pass a query substring to filter the log lines',
      ],
      parameters: Type.Object({
        run: Type.String({ description: `Which run to query: ${keys}` }),
        caseId: Type.Optional(
          Type.String({ description: 'The exact testCaseId of the case to inspect. Omit for a default case.' })
        ),
        query: Type.Optional(Type.String({ description: 'Optional substring/text filter for log lines' })),
      }),
      async execute(_toolCallId: string, params: { run?: string; caseId?: string; query?: string }) {
        const budgetErr = checkToolCallBudget();
        if (budgetErr) return textResult(budgetErr);
        const resolved = await resolveSide(String(params.run ?? ''), params.caseId);
        if (resolved.error || !resolved.ctx || !resolved.caseId || !resolved.reportId) {
          return textResult({ error: resolved.error ?? 'Could not resolve this case.' });
        }
        const { caseId, reportId, ctx } = resolved;
        if (!ctx.runId) return textResult({ run: params.run, caseId, error: 'No runId for this case — logs unavailable.' });
        try {
          const res = await fetch(`${serverUrl}/api/logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: ctx.runId, query: params.query, size: 200 }),
          });
          if (!res.ok) return textResult({ run: params.run, caseId, error: `logs query failed: HTTP ${res.status}` });
          const data: any = await res.json();
          recordVisited(capture, {
            key: params.run === 'B' ? 'B' : 'A',
            caseId,
            reportId,
            runId: ctx.runId,
            serviceName: ctx.serviceName,
            startedAt: ctx.startedAt,
            endedAt: ctx.endedAt,
          });
          return textResult({ run: params.run, caseId, runId: ctx.runId, ...data });
        } catch (err: any) {
          return textResult({ run: params.run, caseId, error: `logs query error: ${err?.message ?? String(err)}` });
        }
      },
    });

    pi.registerTool({
      name: 'record_deepdive_extras',
      label: 'Record an optional A-vs-B chart and/or follow-up experiment ideas',
      description:
        'Call this AT MOST ONCE, near the end of your investigation, after you have queried both runs. ' +
        'Include `chart` if you found 2-6 real numeric dimensions where A and B genuinely differ (e.g. ' +
        'tool-call count, retries, tokens, error count, duration) — real numbers you actually saw via ' +
        'query_spans/query_logs, never invented; the UI renders it as a small compare-bars chart above your ' +
        "narrative. Include `experiments` if you have 1-4 concrete follow-up test-case ideas suggested by what " +
        'you actually observed (e.g. a failure mode only one agent handled, a tool one agent never ' +
        'tried, an edge case neither run exercised) — each should be something a human could turn directly into ' +
        'a new test case; ground the rationale in what you saw, citing a span with the same ' +
        '[label](span:<caseId>:<runId>:<spanId>) syntax used in your narrative when relevant. Either or both may be ' +
        "omitted entirely if you didn't find anything worth recording for that part — never fabricate one just " +
        'to fill the call.',
      promptSnippet: 'Record an optional A-vs-B chart and/or follow-up experiment ideas',
      promptGuidelines: [
        'Call at most once, near the end of your investigation, after querying both runs',
        'chart: only real numbers you actually observed — never invent one; 2 to 6 series entries',
        'experiments: 1 to 4 ideas that probe a difference, gap or failure you actually found — not generic advice',
        'Omit chart and/or experiments entirely rather than fabricating content to fill them',
      ],
      parameters: Type.Object({
        chart: Type.Optional(
          Type.Object({
            title: Type.String({ description: 'Short chart title, e.g. "Tool usage & retries"' }),
            series: Type.Array(
              Type.Object({
                label: Type.String({ description: 'Short dimension label, e.g. "Tool calls"' }),
                a: Type.Number({ minimum: 0, description: 'Non-negative value for run A' }),
                b: Type.Number({ minimum: 0, description: 'Non-negative value for run B' }),
                unit: Type.Optional(Type.String({ description: 'Unit suffix, e.g. "s", "tokens", "calls"' })),
              }),
              { minItems: 2, maxItems: 6 }
            ),
          })
        ),
        experiments: Type.Optional(
          Type.Array(
            Type.Object({
              title: Type.String({ description: 'Short, actionable idea, e.g. "Force a mid-task tool failure"' }),
              rationale: Type.String({ description: 'Why this is worth trying, grounded in this comparison' }),
            }),
            { minItems: 1, maxItems: 4 }
          )
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { chart?: DeepDiveChartSpec; experiments?: DeepDiveExperimentSuggestion[] }
      ) {
        if (params.chart) capture.chart = { title: params.chart.title, series: params.chart.series };
        if (params.experiments) capture.experiments = params.experiments;
        return textResult({
          recorded: true,
          chart: !!params.chart,
          experimentsCount: params.experiments?.length ?? 0,
        });
      },
    });
  };
}
