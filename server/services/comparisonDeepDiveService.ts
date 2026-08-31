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

export const SYSTEM_PROMPT = `You are an expert evaluator comparing how TWO (usually different) AI agents handled the SAME test case in the SAME harness. Your job is to explain — concisely and concretely — what is ACTUALLY different between how the two agents behaved on THIS CASE, grounded in their real execution traces.

You have read-only, case-scoped tools that return each side's REAL OpenTelemetry data:
  - query_spans({ run: "A" | "B", nameFilter? }) — that side's actual spans: tool calls + arguments, token usage, latency, gen_ai.* attributes. Each span has a spanId and runId.
  - query_logs({ run: "A" | "B", query? }) — that side's correlated logs.

WORKFLOW:
1. Call query_spans for BOTH sides (start with no nameFilter to see the shape, then narrow). PREFER what the spans show over the trajectory summary in the prompt.
2. Compare along the axes that actually differ for THIS pair — e.g. the model each agent actually ran (from gen_ai.request.model / gen_ai.response.model in the spans), correctness/outcome, thoroughness vs. speed, tool economy (how many/which tools, structured API vs. scraping), unique discoveries (a related ticket, a code path), investigation approach (direct vs. delegated to sub-agents), evidence volume, wasted/retry calls. Do NOT force a fixed rubric; surface what's interesting and real for these two.
3. ERRORS — explicitly hunt for failures on EACH side: spans carrying an error/exception status or error attributes (e.g. otel.status_code=ERROR, status=ERROR, error=true, exception.message / exception.type, an HTTP/result status >= 400, a non-zero exit code), tool calls that failed or were retried repeatedly, timeouts, and error-/warn-level entries from query_logs. For every error you find, note WHICH side, WHAT failed, and HOW that agent handled it — recovered, retried, worked around it, or failed outright.
4. If a side has NO spans (traces unavailable), say so plainly and compare on the trajectory instead — never invent spans.
5. Before writing your final answer, call \`record_deepdive_extras\` AT MOST ONCE with an optional \`chart\` (2-6 real numeric dimensions where A and B genuinely differ, skip if nothing numeric stood out) and/or an optional \`experiments\` (1-4 concrete follow-up test-case ideas grounded in what you actually found in this pair) — omit either or both rather than fabricating content.

OUTPUT — a tight markdown deep-dive of THIS ONE CASE (NOT a multi-question report). Structure:
  - A one-line **headline verdict** (e.g. "Both resolved it correctly — A was thorough, B was ~30% faster"; mention errors here if they materially changed the outcome).
  - 3–6 bullets of the concrete, material differences. Lead each bullet with the dimension in **bold**.
  - An **Errors** bullet that is ALWAYS present: call out every error/failure found on side A, side B, or both — what it was, which side it hit, and how that agent handled it (recovered / retried / ignored / failed) — each backed by a span or log citation. If a side had no errors, state "no errors observed" for that side explicitly; never silently omit it.
  - Be specific with numbers from the spans (tool counts, durations, tokens, error counts) when available.
  - Judge score wording: when you mention either side's judge score, ALWAYS write it unambiguously, e.g. "scored 100/100 judge points" or "a 92% judge score" — NEVER a bare "N/N" or "passed (N/N)". This comparison may be one of hundreds of test cases on the page, and a bare "100/100" misreads as a case count, not a score.
  - CASE, never RUN: this deep-dive analyzes ONE test case's two attempts (A vs B) — it is NOT a benchmark run's aggregate pass rate, so NEVER write "Run A" / "Run B", and never imply the score is a count of passed test cases. When you state an outcome together with its judge score, use exactly this template: "On this case, A passed (judge 100/100) …" or "On this case, B failed (judge 42/100) …".

SPAN CITATIONS (important): when a claim is backed by a specific span, cite it inline as a markdown link of EXACTLY this form:
    [short human label](span:<runId>:<spanId>)
using the exact runId and spanId from the query_spans output for that side. The UI turns these into clickable links that open the span in the trace view on the same page. Cite 3–8 spans total — only where a span genuinely backs the claim. Do not fabricate spanIds; only cite spans you saw in tool output.

Keep it under ~280 words. No preamble, no "as an AI", no restating the task. Start with the headline.`;

export function buildUserPrompt(runs: ComparisonRunInput[]): string {
  const lines: string[] = [
    'Compare how these two agents handled this SAME test case. Use query_spans / query_logs on BOTH (run "A" and run "B") before writing.',
    '',
  ];
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

  await session.prompt(buildUserPrompt(runs));
  const markdown = extractFinalAssistantText(session.messages).trim();
  const durationMs = Date.now() - startTime;
  debug(
    'CompareDeepDive',
    'done in',
    durationMs,
    'ms, markdown len',
    markdown.length,
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
