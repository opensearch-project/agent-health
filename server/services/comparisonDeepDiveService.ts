/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Deep-Dive (agentic).
 *
 * Generates the top-level "what's actually different" narrative for TWO runs
 * being compared, by running pi's agent loop **in-process** (pi SDK,
 * `createAgentSession`) with read-only trace tools (`query_spans` /
 * `query_logs`) that can inspect EITHER run, on ANY compared case.
 *
 * Unlike the agentic judge (single run, verdict JSON), this agent:
 *   - inspects BOTH runs' real OTel spans/logs, resolved per-case (Strategy D
 *     session.id + Strategy C service.name/window, so closed-source agents
 *     like claude-code are visible even though they don't stamp our own
 *     agent_health.run.id attribute),
 *   - writes a concise markdown deep-dive of the meaningful differences,
 *     INCLUDING any errors/failures observed in either or both runs,
 *   - cites specific spans as `[label](span:<caseId>:<runId>:<spanId>)` links
 *     the UI parses into deep-links into the trace view of the RIGHT case row.
 *
 * COMPARISON-WIDE TRACING (this round): earlier versions scoped the trace
 * tools to exactly ONE pre-resolved "representative" case. Owner feedback:
 * "we don't want the data only limited to a single test... I want the wide
 * one" — the default SYSTEM_PROMPT analyzes the comparison AS A WHOLE (a full
 * A-vs-B results table across every compared case, see `ComparisonRowSummary`
 * / `buildUserPrompt`) AND the trace tools now accept an optional `caseId` so
 * the agent can pull real spans/logs for whichever case(s) it decides matter
 * — not just a single fixed one. Each case's report (and therefore its
 * runId/session.id/service-name window) is resolved LAZILY, one at a time,
 * by `server/routes/comparison.ts` — never prefetched for every row.
 *
 * This is the engine behind `POST /api/comparison/deep-dive`.
 */

import {
  createComparisonTraceExtension,
  type DeepDiveCapture,
  type DeepDiveChartSpec,
  type DeepDiveExperimentSuggestion,
  type CaseReportRef,
  type VisitedCaseRef,
} from './comparisonTraceTools';
import {
  findRequestedModel,
  pickJudgeModel,
  extractFinalAssistantText,
} from './piAgenticJudgeService';
import type { PiSdk } from './piSdkTypes';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';

/** One run participating in the comparison (the DEFAULT/fallback case for that side). */
export interface ComparisonRunInput {
  /** Stable label the model addresses the run by in tool calls: 'A' | 'B'. */
  key: string;
  /** Human-readable agent label, e.g. "aos-oncall (Claude Code)". */
  label: string;
  /** The default case's reportId for this side (for the tools' default-case fallback + visitedCases meta). */
  reportId?: string;
  /** The agent-health run id (Strategy B) for the default case. */
  runId?: string;
  /** Strategy C/D correlation hints (service.name + wall-clock window + session.id) for the default case. */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>;
  /** Pass/fail + score for prompt context (default case only). */
  passFailStatus?: string;
  accuracy?: number;
  /** Top-level tool-call names from the trajectory (seed; details via tools). */
  toolNames?: string[];
  /** Wall-clock agent duration (ms) if known (default case only). */
  durationMs?: number;
  /** The agent's final answer text (seed context, default case only). */
  finalOutput?: string;
}

/**
 * One row of the FULL A-vs-B results table across every compared case.
 * Carries each side's reportId too (this round) so the trace tools can
 * resolve ANY row's real spans/logs on demand, not just one fixed case.
 */
export interface ComparisonRowSummary {
  testCaseId: string;
  testCaseName: string;
  a?: { passFailStatus?: string; score?: number; reportId?: string };
  b?: { passFailStatus?: string; score?: number; reportId?: string };
}

export interface ComparisonDeepDiveResult {
  markdown: string;
  modelId: string;
  durationMs: number;
  /** A-vs-B compare-bars chart, when the agent found numbers worth charting. */
  chart?: DeepDiveChartSpec;
  /** Concrete follow-up experiment ideas grounded in this comparison. */
  experiments?: DeepDiveExperimentSuggestion[];
  /** Every (case, side) the agent actually queried — window-agent hints for span-citation deep links. */
  visitedCases: VisitedCaseRef[];
}

/**
 * Hard ceiling on the agent loop's wall-clock time. Owner bug report: "What's
 * actually different" appeared to never load (waited minutes) on a 62-row
 * comparison with no trace data at all — in that specific repro the agent
 * loop DID complete (~50s), just with zero client-side feedback, but there is
 * no other guard against a genuinely stuck loop (e.g. Bedrock throttling with
 * no bounded retry, a runaway tool-call cycle). Without this, a real hang
 * would keep the HTTP request — and therefore the client's fetch — open
 * forever, since there is no server-side deadline anywhere in this path.
 * Generous enough for a large results table + a couple of trace-tool round
 * trips; bounded so a genuine hang always resolves to a clear, retryable error
 * instead of an indefinite spinner.
 */
export const DEEP_DIVE_DEADLINE_MS = 180_000;

/** Race a promise against a deadline; rejects with `message` if it fires first. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Dynamically load the pi SDK (optionalDependency) with an actionable error. */
async function loadPiSdk(): Promise<PiSdk> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as unknown as PiSdk;
  } catch (err: any) {
    throw new Error(
      'Comparison deep-dive requires the optional dependency "@earendil-works/pi-coding-agent". ' +
        `(${err?.message ?? String(err)})`
    );
  }
}

export const SYSTEM_PROMPT = `You are an expert evaluator comparing how TWO (usually different) AI agents/configurations performed across a comparison of test cases (A vs B) — not just one case. Your job is to explain — concisely and concretely — what is ACTUALLY different between A and B OVERALL, grounded in the full results table you're given AND in real execution traces for whichever specific cases you decide matter.

You are given a RESULTS TABLE listing every compared case with each side's pass/fail and judge score. Treat this table as your map of the comparison. Do NOT force a fixed rubric onto every row and do NOT walk the table top to bottom — SELECTIVELY pick the rows that actually matter: cases where A and B disagree (one passed, one failed), cases with a large score gap, and any systematic pattern (e.g. "B fails every case in category X", "A scores lower whenever Y shows up").

You have read-only tools that return REAL OpenTelemetry data for ANY case in the table — you are NOT limited to a single case:
  - query_spans({ run: "A" | "B", caseId?, nameFilter? }) — real spans (tool calls + arguments, token usage, latency, gen_ai.* attributes) for the given side on the given case. Pass caseId = the exact testCaseId of any row you want to inspect; omit it only to fall back to a generic default case.
  - query_logs({ run: "A" | "B", caseId?, query? }) — that side's correlated logs for the same case.
Each tool response ECHOES BACK the caseId and runId it actually resolved — ALWAYS use those exact echoed values (never a guessed or remembered one) when citing a span. If a side has no report for a case (didn't run it) or the report has no spans (traces unavailable), the tool tells you so plainly — never invent spans or claim to have traced a case you did not actually query.

WORKFLOW:
1. Scan the results table for the interesting rows: disagreements, large score gaps, category/label patterns.
2. For EACH row you plan to build a claim on, call query_spans (and query_logs if useful) for BOTH sides on that row's exact testCaseId to ground the claim in real data. Trace as many or as few cases as you need — a comparison-wide pattern across dozens of cases is worth more than exhaustively tracing one.
3. ERRORS — for every case you actually traced, explicitly hunt for failures on EACH side: spans carrying an error/exception status or error attributes (e.g. otel.status_code=ERROR, status=ERROR, error=true, exception.message / exception.type, an HTTP/result status >= 400, a non-zero exit code), tool calls that failed or were retried repeatedly, timeouts, and error-/warn-level entries from query_logs. For every error you find, note WHICH case, WHICH side, WHAT failed, and HOW that agent handled it — recovered, retried, worked around it, or failed outright. You can only know about errors in cases you actually queried.
4. Before writing your final answer, call \`record_deepdive_extras\` AT MOST ONCE with an optional \`chart\` (2-6 real numeric dimensions where A and B genuinely differ, skip if nothing numeric stood out) and/or an optional \`experiments\` (1-4 concrete follow-up test-case ideas grounded in what you actually found) — omit either or both rather than fabricating content.

OUTPUT — a tight markdown deep-dive of the A-VS-B COMPARISON AS A WHOLE. Structure:
  - A one-line **headline verdict** summarizing the overall pattern across the results table (e.g. "A wins on RCA-tagged cases but B is faster and equally accurate everywhere else"; mention a material error here if one changed a traced case's outcome).
  - 3–6 bullets of the concrete, material differences — SELECTED from the results table (disagreements, score gaps, category patterns), each grounded in real spans/logs from the specific case(s) it's about wherever you traced one. Lead each bullet with the dimension in **bold**.
  - An **Errors** bullet that is ALWAYS present: call out every error/failure found in the case(s) you traced, on side A, side B, or both — name the case, what failed, which side, and how that agent handled it (recovered / retried / ignored / failed) — each backed by a span or log citation. If the case(s) you traced had no errors, state "no errors observed" explicitly; never silently omit this bullet.
  - Be specific with numbers: pass counts / score gaps / how many cases show a pattern from the results table, and tool counts / durations / tokens / error counts from whichever cases' real spans you queried.
  - Judge score wording: whenever you state a judge score, ALWAYS write it unambiguously as "N/100 judge score" (e.g. "a 92/100 judge score") — NEVER a bare "N/N", which misreads as a case count rather than a score in a page that may show hundreds of cases.

SPAN CITATIONS (important): when a claim is backed by a specific span, cite it inline as a markdown link of EXACTLY this form:
    [short human label](span:<caseId>:<runId>:<spanId>)
using the EXACT caseId, runId and spanId echoed back by the query_spans call that found it — never invent or guess any of the three. The UI turns these into clickable links that open the span in the Traces tab of that exact case. Cite 2–8 spans total across however many cases you traced — only where a span genuinely backs the claim. Comparison-wide claims that are backed only by the results table (not a traced span) don't need a citation — support them with the actual numbers instead.

Keep it under ~350 words. No preamble, no "as an AI", no restating the task. Start with the headline.`;

/** Format one results-table row as a compact, single-line A-vs-B summary. */
function formatRowSummaryLine(row: ComparisonRowSummary): string {
  const side = (s?: { passFailStatus?: string; score?: number }): string => {
    if (!s) return 'not run';
    const outcome = s.passFailStatus || 'unknown';
    return typeof s.score === 'number' ? `${outcome} (${Math.round(s.score)}/100)` : outcome;
  };
  return `- [${row.testCaseId}] ${row.testCaseName} — A: ${side(row.a)} · B: ${side(row.b)}`;
}

export function buildUserPrompt(
  runs: ComparisonRunInput[],
  rows?: ComparisonRowSummary[],
  defaultCaseId?: string
): string {
  const lines: string[] = [];

  if (rows && rows.length > 0) {
    lines.push(
      `## Full results table — ${rows.length} compared case${rows.length === 1 ? '' : 's'} (A vs B)`,
      'Every row\'s testCaseId is in [brackets] — pass that exact string as `caseId` to query_spans/query_logs to trace THAT row on either side. You are not limited to the default case below; trace as many rows as your analysis needs.',
      ...rows.map(formatRowSummaryLine),
      ''
    );
  }

  lines.push(
    `Default case (used by query_spans/query_logs only when you omit caseId): ${defaultCaseId ?? '(unknown)'}. Use query_spans / query_logs with an explicit caseId on BOTH "A" and "B" for whichever rows above you decide are worth tracing.`,
    ''
  );
  for (const r of runs) {
    lines.push(`## ${r.key} — ${r.label} (default case)`);
    if (r.runId) lines.push(`- runId: ${r.runId}`);
    // Label the judge score explicitly ("judgeScore: N on a 0-100 scale") rather
    // than a bare number — this is the context the model reads before writing its
    // prose, and a bare "(score 100)" here is exactly what produced ambiguous
    // narrative text like "passed (100/100)" (misread as a case count in a
    // multi-hundred-case comparison). See also the SYSTEM_PROMPT rule below.
    if (r.passFailStatus) lines.push(`- outcome: ${r.passFailStatus}${typeof r.accuracy === 'number' ? ` (judgeScore: ${r.accuracy} on a 0-100 scale)` : ''}`);
    if (typeof r.durationMs === 'number') lines.push(`- agent duration: ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.toolNames && r.toolNames.length) {
      lines.push(`- top-level tool calls (${r.toolNames.length}): ${r.toolNames.slice(0, 40).join(', ')}`);
    }
    if (r.finalOutput) {
      const snip = r.finalOutput.replace(/\s+/g, ' ').slice(0, 700);
      lines.push(`- final answer (excerpt): ${snip}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Run the comparison agent and return its markdown deep-dive.
 * Never throws past model/SDK setup — tool failures degrade to a
 * trajectory-only narrative.
 */
export async function generateComparisonDeepDive(opts: {
  runs: ComparisonRunInput[];
  /** testCaseId of the default/fallback case (same for both sides). */
  defaultCaseId: string;
  /** `testCaseId -> per-side reportId`, for every case in the results table — enables comparison-wide tracing. */
  caseReports: Map<string, CaseReportRef>;
  /** Lazy, memoized report fetch (server/routes/comparison.ts owns storage access). */
  getReport: (reportId: string) => Promise<any | null>;
  modelId?: string;
  /**
   * Owner-editable override for the deep-dive agent's system prompt
   * (browser-cache-only feature: the frontend persists edits in
   * localStorage, never server-side). When omitted, falls back to the
   * built-in {@link SYSTEM_PROMPT}.
   */
  systemPrompt?: string;
  /** Full A-vs-B results table across every compared case (see {@link ComparisonRowSummary}). */
  rows?: ComparisonRowSummary[];
}): Promise<ComparisonDeepDiveResult> {
  const { runs, defaultCaseId, caseReports, getReport } = opts;
  const effectiveSystemPrompt = opts.systemPrompt?.trim() ? opts.systemPrompt : SYSTEM_PROMPT;
  if (runs.length !== 2) {
    throw new Error(`Comparison deep-dive expects exactly 2 runs, got ${runs.length}`);
  }
  const serverUrl =
    process.env.AH_JUDGE_SERVER_URL ||
    `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
  const startTime = Date.now();

  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, getAgentDir } =
    await loadPiSdk();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const available = await modelRegistry.getAvailable();
  const model = findRequestedModel(available, opts.modelId) ?? pickJudgeModel(available);
  if (!model) {
    throw new Error('Comparison deep-dive: no model available (configure a Bedrock/Anthropic model with valid credentials).');
  }
  debug('CompareDeepDive', 'model:', `${model.provider}/${model.id}`, 'runs:', runs.map((r) => r.key).join(','), 'cases:', caseReports.size);

  const capture: DeepDiveCapture = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => effectiveSystemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [createComparisonTraceExtension(runs, defaultCaseId, caseReports, getReport, serverUrl, capture)],
    // Full isolation for a HEADLESS in-process session. Without noExtensions
    // the loader auto-loads the user's global ~/.pi/agent extensions (e.g.
    // midway-status) whose interactive theme/status `tick` timer throws
    // "Theme not initialized" and crashes the SERVER PROCESS. Our inline
    // extensionFactories (query_spans/query_logs) still register regardless.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    // Only the run-scoped trace tools + the structured-output recorder — no filesystem/bash access.
    tools: ['query_spans', 'query_logs', 'record_deepdive_extras'],
    sessionManager: SessionManager.inMemory(),
  });

  await withDeadline(
    session.prompt(buildUserPrompt(runs, opts.rows, defaultCaseId)),
    DEEP_DIVE_DEADLINE_MS,
    `Comparison deep-dive timed out after ${Math.round(DEEP_DIVE_DEADLINE_MS / 1000)}s — the agent loop did not finish in time. Try Regenerate.`
  );
  const markdown = extractFinalAssistantText(session.messages).trim();
  const durationMs = Date.now() - startTime;
  debug(
    'CompareDeepDive',
    'done in',
    durationMs,
    'ms, markdown len',
    markdown.length,
    'rows:',
    opts.rows?.length ?? 0,
    'visitedCases:',
    capture.visitedCases?.length ?? 0,
    'chart:',
    !!capture.chart,
    'experiments:',
    capture.experiments?.length ?? 0
  );

  return {
    markdown,
    modelId: `${model.provider}/${model.id}`,
    durationMs,
    chart: capture.chart,
    experiments: capture.experiments,
    visitedCases: capture.visitedCases ?? [],
  };
}
