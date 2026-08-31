/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Comparison Deep-Dive (agentic).
 *
 * Generates the top-level "what's actually different" narrative for TWO runs
 * being compared, by running pi's agent loop **in-process** (pi SDK,
 * `createAgentSession`) with read-only, run-scoped trace tools
 * (`query_spans` / `query_logs`) that can inspect EITHER run.
 *
 * Unlike the agentic judge (single run, verdict JSON), this agent:
 *   - inspects BOTH runs' real OTel spans/logs (Strategy B runId + Strategy C
 *     service.name + time-window, so closed-source agents like claude-code are
 *     visible even though they don't stamp gen_ai.request.id with our runId),
 *   - writes a concise markdown deep-dive of the meaningful differences,
 *     INCLUDING any errors/failures observed in either or both runs,
 *   - cites specific spans as `[label](span:<runId>:<spanId>)` links the UI
 *     parses into deep-links into the trace view (same page).
 *
 * As of this round, the default SYSTEM_PROMPT analyzes the comparison AS A
 * WHOLE (a full A-vs-B results table across every compared case), rather
 * than only the one representative case the trace tools happen to be scoped
 * to — see `ComparisonRowSummary` / `buildUserPrompt` below.
 *
 * This is the engine behind `POST /api/comparison/deep-dive`.
 */

import {
  createComparisonTraceExtension,
  type DeepDiveCapture,
  type DeepDiveChartSpec,
  type DeepDiveExperimentSuggestion,
} from './comparisonTraceTools';
import {
  findRequestedModel,
  pickJudgeModel,
  extractFinalAssistantText,
} from './piAgenticJudgeService';
import type { PiSdk } from './piSdkTypes';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';

/** One run participating in the comparison. */
export interface ComparisonRunInput {
  /** Stable label the model addresses the run by in tool calls: 'A' | 'B'. */
  key: string;
  /** Human-readable agent label, e.g. "aos-oncall (Claude Code)". */
  label: string;
  /** The agent-health run id (Strategy B). */
  runId?: string;
  /** Strategy C correlation hints (service.name + wall-clock window). */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number }>;
  /** Pass/fail + score for prompt context. */
  passFailStatus?: string;
  accuracy?: number;
  /** Top-level tool-call names from the trajectory (seed; details via tools). */
  toolNames?: string[];
  /** Wall-clock agent duration (ms) if known. */
  durationMs?: number;
  /** The agent's final answer text (seed context). */
  finalOutput?: string;
}

/**
 * One row of the FULL A-vs-B results table across every compared case (not
 * just the one representative case the trace tools are scoped to). Lets the
 * default SYSTEM_PROMPT analyze the comparison as a whole — selectively
 * surfacing disagreements, score gaps, and category patterns — instead of
 * only ever discussing the single traced case.
 */
export interface ComparisonRowSummary {
  testCaseId: string;
  testCaseName: string;
  a?: { passFailStatus?: string; score?: number };
  b?: { passFailStatus?: string; score?: number };
}

export interface ComparisonDeepDiveResult {
  markdown: string;
  modelId: string;
  durationMs: number;
  /** A-vs-B compare-bars chart, when the agent found numbers worth charting. */
  chart?: DeepDiveChartSpec;
  /** Concrete follow-up experiment ideas grounded in this comparison. */
  experiments?: DeepDiveExperimentSuggestion[];
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

export const SYSTEM_PROMPT = `You are an expert evaluator comparing how TWO (usually different) AI agents/configurations performed across a comparison of test cases (A vs B) — not just one case. Your job is to explain — concisely and concretely — what is ACTUALLY different between A and B OVERALL, grounded in the full results table you're given and, for one representative case, in real execution traces.

You are given a RESULTS TABLE listing every compared case with each side's pass/fail and judge score. Treat this table as your primary evidence for comparison-wide claims. Do NOT force a fixed rubric onto every row and do NOT walk the table top to bottom — SELECTIVELY pick the rows that actually matter: cases where A and B disagree (one passed, one failed), cases with a large score gap, and any systematic pattern (e.g. "B fails every case in category X", "A scores lower whenever Y shows up"). It is fine to discuss run-level / comparison-wide patterns (e.g. "B passes more cases overall, but loses badly on category X") — this is expected, not a violation of scope.

You ALSO have read-only tools scoped to exactly ONE representative case (the one named "Case: <name>" in the panel above this text) — use these for concrete, trace-grounded detail on THAT case only:
  - query_spans({ run: "A" | "B", nameFilter? }) — that side's actual spans on the traced case: tool calls + arguments, token usage, latency, gen_ai.* attributes. Each span has a spanId and runId.
  - query_logs({ run: "A" | "B", query? }) — that side's correlated logs on the traced case.
These tools CANNOT inspect any case in the table other than the traced one — never claim to have traced a case you did not query.

WORKFLOW:
1. Scan the results table for the interesting rows: disagreements, large score gaps, category/label patterns. These are your candidate comparison-wide claims.
2. Call query_spans for BOTH sides on the traced case (start with no nameFilter to see the shape, then narrow) to ground at least one claim in a real span citation.
3. ERRORS on the traced case — explicitly hunt for failures on EACH side of that ONE case: spans carrying an error/exception status or error attributes (e.g. otel.status_code=ERROR, status=ERROR, error=true, exception.message / exception.type, an HTTP/result status >= 400, a non-zero exit code), tool calls that failed or were retried repeatedly, timeouts, and error-/warn-level entries from query_logs. For every error you find, note WHICH side, WHAT failed, and HOW that agent handled it — recovered, retried, worked around it, or failed outright. This hunt only covers the traced case; you cannot know about errors in cases you didn't query.
4. If the traced case has NO spans (traces unavailable), say so plainly and fall back to that row's results-table entry instead — never invent spans.
5. Before writing your final answer, call \`record_deepdive_extras\` AT MOST ONCE with an optional \`chart\` (2-6 real numeric dimensions where A and B genuinely differ, skip if nothing numeric stood out) and/or an optional \`experiments\` (1-4 concrete follow-up test-case ideas grounded in what you actually found) — omit either or both rather than fabricating content.

OUTPUT — a tight markdown deep-dive of the A-VS-B COMPARISON AS A WHOLE (not a walkthrough of every row, and not limited to the one traced case). Structure:
  - A one-line **headline verdict** summarizing the overall pattern across the results table (e.g. "A wins on RCA-tagged cases but B is faster and equally accurate everywhere else"; mention an error here if it materially changed the traced case's outcome).
  - 3–6 bullets of the concrete, material differences — SELECTED from the results table (disagreements, score gaps, category patterns) plus at least one bullet grounded in the traced case's real spans/logs. Lead each bullet with the dimension in **bold**.
  - An **Errors** bullet for the TRACED CASE that is ALWAYS present: call out every error/failure found there on side A, side B, or both — what it was, which side it hit, and how that agent handled it (recovered / retried / ignored / failed) — each backed by a span or log citation. If the traced case had no errors, state "no errors observed" for that side explicitly; never silently omit it. (This bullet is about the traced case only — you have no trace data for the rest of the table.)
  - Be specific with numbers: pass counts / score gaps / how many cases show a pattern from the results table, and tool counts / durations / tokens / error counts from the traced case's spans when available.
  - Judge score wording: whenever you state a judge score, ALWAYS write it unambiguously as "N/100 judge score" (e.g. "a 92/100 judge score") — NEVER a bare "N/N", which misreads as a case count rather than a score in a page that may show hundreds of cases.

SPAN CITATIONS (important): when a claim about the TRACED case is backed by a specific span, cite it inline as a markdown link of EXACTLY this form:
    [short human label](span:<runId>:<spanId>)
using the exact runId and spanId from the query_spans output for that side. The UI turns these into clickable links that open the span in the trace view on the same page. Cite 2–6 spans total — only where a span genuinely backs the claim. Do not fabricate spanIds; only cite spans you saw in tool output. Comparison-wide claims are grounded in the results table, not a span citation — support them with the actual numbers instead.

Keep it under ~350 words. No preamble, no "as an AI", no restating the task. Start with the headline.`;

/** Format one results-table row as a compact, single-line A-vs-B summary. */
function formatRowSummaryLine(row: ComparisonRowSummary): string {
  const side = (s?: { passFailStatus?: string; score?: number }): string => {
    if (!s) return 'not run';
    const outcome = s.passFailStatus || 'unknown';
    return typeof s.score === 'number' ? `${outcome} (${Math.round(s.score)}/100)` : outcome;
  };
  return `- ${row.testCaseName} — A: ${side(row.a)} · B: ${side(row.b)}`;
}

export function buildUserPrompt(runs: ComparisonRunInput[], rows?: ComparisonRowSummary[]): string {
  const lines: string[] = [];

  if (rows && rows.length > 0) {
    lines.push(
      `## Full results table — ${rows.length} compared case${rows.length === 1 ? '' : 's'} (A vs B)`,
      'This is your primary evidence for comparison-wide claims (disagreements, score gaps, category patterns). Only the ONE case in the "Traced case" section below has span/log tools available — do not claim trace-level detail for any other row here.',
      ...rows.map(formatRowSummaryLine),
      ''
    );
  }

  lines.push(
    'Traced case (the one case with span/log tools). Use query_spans / query_logs on BOTH (run "A" and run "B") before writing — ground your Errors bullet and at least one other claim in real spans, and use the results table above for the comparison-wide narrative.',
    ''
  );
  for (const r of runs) {
    lines.push(`## ${r.key} — ${r.label}`);
    if (r.runId) lines.push(`- runId (use this in span: citations): ${r.runId}`);
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
  const { runs } = opts;
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
  debug('CompareDeepDive', 'model:', `${model.provider}/${model.id}`, 'runs:', runs.map((r) => r.key).join(','));

  const capture: DeepDiveCapture = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => effectiveSystemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [createComparisonTraceExtension(runs, serverUrl, capture)],
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

  await session.prompt(buildUserPrompt(runs, opts.rows));
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
  };
}
