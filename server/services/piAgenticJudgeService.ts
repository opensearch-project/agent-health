/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Trace Judge (RFC 004 §4.4, #244).
 *
 * An LLM judge that verifies its claims against the run's REAL OTel spans/logs
 * — not just the trajectory text — by running pi's agent loop **in-process**
 * (via the pi SDK, `createAgentSession`) with a restricted, read-only,
 * run-scoped trace-tool pack (`query_spans` / `query_logs`).
 *
 * In-process (SDK) rather than spawning the pi CLI: no subprocess, no NDJSON
 * stdout parsing, no extension file, no env-var scoping, no PATH/bin lookup.
 * The tools capture `runId` via closure so the judging model cannot pivot to
 * other runs. pi ships as the optionalDependency `@earendil-works/pi-coding-agent`.
 */

import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from '@/server/services/bedrockService';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { createTraceJudgeExtension } from '@/server/services/traceJudgeTools';
import type { PiSdk } from '@/server/services/piSdkTypes';
import { Evaluator } from '@/types';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';
import { regionInferencePrefix } from '@/lib/bedrockCompat';

/**
 * Default base prompt used when no saved evaluator's `systemPrompt` is provided.
 * The trace-tool addendum is appended to whatever base is in effect (default
 * or saved evaluator) so the agentic-judge contract — the existence and use
 * of `query_spans` / `query_logs` — is preserved regardless of how the user
 * customizes the judge prompt.
 */
const DEFAULT_AGENT_TRACE_JUDGE_BASE_PROMPT = `You are an expert evaluator for observability and Root Cause Analysis (RCA) agents.

When you are done investigating, respond with ONLY a JSON object (no prose, optionally fenced in \`\`\`json):
{
  "pass_fail_status": "passed" | "failed",
  "accuracy": <0-100>,
  "reasoning": "<concise explanation grounded in what the tools showed>",
  "metrics": { "faithfulness": <0-100>, "latency_score": <0-100>, "trajectory_alignment_score": <0-100> },
  "improvement_strategies": []
}`;

/**
 * Trace-tool addendum that's ALWAYS appended to whatever base system prompt
 * is in effect (default or user-saved evaluator). Without this paragraph the
 * judge has no way to know `query_spans` / `query_logs` exist or what they
 * return — the trace-judging contract collapses into trajectory-only
 * judgement. Documenting the tools is structurally separate from "how to
 * judge an RCA agent", which is what the saved evaluator's prompt covers.
 */
const AGENT_TRACE_TOOL_ADDENDUM = `

---

## Available trace-query tools (READ-ONLY, scoped to the run being judged)

In addition to the trajectory shown in the prompt you have these tools that return the REAL OpenTelemetry spans and logs for the run you are judging:
  - query_spans({ nameFilter? }): the run's actual spans (tool calls, token usage, latency, gen_ai.* attributes)
  - query_logs({ query? }): the run's correlated logs (evidence for/against a root cause)

These tools are hard-scoped to this single run — you cannot query other runs. PREFER verifying claims against this real data over trusting the trajectory narrative. Confirm a span exists before crediting a tool call, check real token usage before crediting a budget claim, and look for log evidence before crediting a root-cause claim.`;

/**
 * Addendum appended instead of {@link AGENT_TRACE_TOOL_ADDENDUM} when the
 * request carries no trace correlation (no `runId`, no `agents` hint — see
 * `hasTraceCorrelation`). This is the normal, expected case for an agent
 * declared `useTraces: false` (not OTel-instrumented) — there is nothing to
 * correlate, not a bug. The judge must know it has NO trace tools this run
 * so it grounds its verdict in the trajectory/response actually shown in
 * the prompt instead of hallucinating span/log checks it never performed
 * (or silently trying to call query_spans/query_logs, which don't exist in
 * this mode).
 */
const NO_TRACE_TOOLS_ADDENDUM = `

---

## No trace-query tools available for this run

This run's agent is not instrumented with OpenTelemetry (or agent-health could not correlate this run to any trace/session), so \`query_spans\` and \`query_logs\` are NOT available to you for this evaluation.

Judge STRICTLY from the trajectory and the agent's final response shown in the prompt above. Do NOT claim to have checked spans, logs, token usage, or latency data — you were not given any. Do NOT reference \`query_spans\`/\`query_logs\` or "the real OTel data" in your reasoning; ground every claim only in what the trajectory/response actually shows.`;

/**
 * Dynamically load the pi SDK (optionalDependency). Throws a clear, actionable
 * error when it isn't installed rather than a raw module-not-found.
 *
 * The specifier is held in a variable (not a string literal) so tsc does NOT
 * statically resolve `@earendil-works/pi-coding-agent` at compile time — the
 * package is optional and may be absent (CI / platforms where its native
 * install scripts fail), and a literal `import()` would make the build require
 * it. The runtime result is cast to the local {@link PiSdk} surface.
 */
async function loadPiSdk(): Promise<PiSdk> {
  const PI_SDK_MODULE = '@earendil-works/pi-coding-agent';
  try {
    return (await import(PI_SDK_MODULE)) as unknown as PiSdk;
  } catch (err: any) {
    throw new Error(
      'Agent judge requires the optional dependency "@earendil-works/pi-coding-agent". ' +
        'Reinstall agent-health without --no-optional, or run `npm i @earendil-works/pi-coding-agent`. ' +
        `(${err?.message ?? String(err)})`
    );
  }
}

/** Strip the Bedrock inference-profile region prefix (us./eu./global./au.). */
function bedrockBaseId(id: string): string {
  return id.replace(/^(us|eu|global|au)\./, '');
}

/**
 * Compose the final system prompt the trace judge will see.
 *
 * Two-layer composition:
 *   1. Base prompt: the saved evaluator's `systemPrompt` (when non-empty),
 *      else the default. This is the surface the user iterates on.
 *   2. {@link AGENT_TRACE_TOOL_ADDENDUM} is ALWAYS appended on top so the
 *      tool-use contract (`query_spans` / `query_logs`) survives any
 *      customization of the base prompt. A regression test pins this
 *      invariant — see piAgenticJudgeService.test.
 *
 * Exported for unit testing; production callers go through
 * {@link evaluateWithPiAgenticTrace}.
 */
export function buildAgentTraceJudgeSystemPrompt(
  evaluator?: { systemPrompt?: string },
  traceToolsAvailable: boolean = true
): string {
  const baseSystemPrompt =
    evaluator?.systemPrompt && evaluator.systemPrompt.trim().length > 0
      ? evaluator.systemPrompt
      : DEFAULT_AGENT_TRACE_JUDGE_BASE_PROMPT;
  return baseSystemPrompt + (traceToolsAvailable ? AGENT_TRACE_TOOL_ADDENDUM : NO_TRACE_TOOLS_ADDENDUM);
}

/**
 * Find the registry model matching the run's configured judge model id.
 *
 * Claude 4.x on Bedrock can only be invoked via an inference profile (a model
 * id prefixed with the region, e.g. `us.`/`global.`), NOT the bare id — the
 * bare id fails with "on-demand throughput isn't supported". So among models
 * sharing the requested base id we prefer, in order: the region-appropriate
 * profile, a `global.` profile, any prefixed profile, then the bare id.
 */
export function findRequestedModel<T extends { provider: string; id: string }>(
  models: T[],
  requestedId?: string
): T | undefined {
  if (!requestedId) return undefined;
  const want = bedrockBaseId(requestedId);
  const candidates = models.filter((m) => bedrockBaseId(m.id) === want);
  if (!candidates.length) return undefined;
  const rp = regionInferencePrefix();
  return (
    candidates.find((m) => m.id.startsWith(rp)) ??
    candidates.find((m) => m.id.startsWith('global.')) ??
    candidates.find((m) => bedrockBaseId(m.id) !== m.id) ?? // any inference-profile variant
    candidates[0]
  );
}

/** Pick a judge model from the available (credentialed) models, preferring a recent Claude. */
export function pickJudgeModel<T extends { provider: string; id: string }>(models: T[]): T | undefined {
  if (!models.length) return undefined;
  const score = (m: T) => {
    const id = m.id.toLowerCase();
    let s = 0;
    if (id.includes('sonnet')) s += 100;
    else if (id.includes('opus')) s += 90;
    else if (id.includes('claude')) s += 50;
    // Prefer an inference-profile (region-prefixed) Claude 4.x; the 4.x bare
    // ids fail on-demand on Bedrock, and the older 3.x models are penalized.
    if (id.includes('-4-5') || id.includes('-4-6')) s += 20;
    else if (id.includes('-4-') || id.includes('sonnet-4') || id.includes('opus-4')) s += 15;
    if (id.includes('claude-3') || id.includes('-3-5') || id.includes('-3-7')) s -= 40;
    // Prefer region/global inference profiles over bare ids (bare 4.x can't run on-demand).
    if (id.startsWith(regionInferencePrefix()) || id.startsWith('global.')) s += 8;
    else if (/^(eu|au|apac)\./.test(id)) s -= 8; // wrong-region profile
    return s;
  };
  return [...models].sort((a, b) => score(b) - score(a))[0];
}

/** Extract the final assistant text (the verdict JSON) from pi session messages. */
export function extractFinalAssistantText(messages: any[]): string {
  let last = '';
  for (const m of messages ?? []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
    if (text.trim()) last = text;
  }
  return last;
}

/**
 * Env var that PINS the agent (trace) judge's underlying LLM (mirrors the
 * deep-dive's `AH_DEEP_DIVE_MODEL_ID`). Matched by base id, so
 * `anthropic.claude-sonnet-4-5` satisfies any `us.`/`global.` profile of it.
 * Unset (the default) keeps today's auto-pick — the pick ORDER is deliberately
 * unchanged so existing runs stay comparable; this only makes the choice
 * explicit and deterministic for operators who want it.
 */
export const AGENT_JUDGE_MODEL_ENV = 'AH_AGENT_JUDGE_MODEL_ID';

/** Judge-kind ids that name a provider, not a model — never a valid pin target. */
const PROVIDER_PSEUDO_MODEL_IDS = new Set(['agent-trace-judge', 'pi-judge', 'agentic-claude-code', 'agentic-custom', 'claude-code-judge']);

/** How the agent judge's underlying model was chosen — surfaced by GET /api/judge/models. */
export type AgentJudgeModelSource = 'evaluator-pin' | 'env-pin' | 'request' | 'auto';

export interface ResolvedAgentJudgeModel<T> {
  model: T;
  /** Which rule selected it (for the UI hint and the debug log). */
  source: AgentJudgeModelSource;
}

/**
 * Resolve the UNDERLYING LLM the agent (trace) judge runs on. Precedence:
 *   1. `evaluator.inferenceConfig.agentJudgeModelId` (saved-evaluator pin)
 *   2. `AH_AGENT_JUDGE_MODEL_ID` env (server-wide pin)
 *   3. the request's `modelId` when it is a REAL model id (a caller that
 *      routed to this provider via evaluator.inferenceConfig.provider while
 *      passing a concrete Bedrock id) — pre-existing behaviour, kept
 *   4. {@link pickJudgeModel} auto-pick over the credentialed registry
 *
 * Pseudo-model ids such as `agent-trace-judge` name the PROVIDER and are
 * skipped at every level (they never match a registry model anyway).
 *
 * Exported so `GET /api/judge/models` can report exactly what a run without
 * a pin would be judged by, and for unit tests.
 */
export function resolveAgentJudgeModel<T extends { provider: string; id: string }>(
  available: T[],
  opts: { requestedModelId?: string; evaluatorPin?: string; env?: NodeJS.ProcessEnv } = {}
): ResolvedAgentJudgeModel<T> | undefined {
  const env = opts.env ?? process.env;
  const tryPin = (id: string | undefined, source: AgentJudgeModelSource): ResolvedAgentJudgeModel<T> | undefined => {
    const trimmed = id?.trim();
    if (!trimmed || PROVIDER_PSEUDO_MODEL_IDS.has(trimmed)) return undefined;
    const model = findRequestedModel(available, trimmed);
    return model ? { model, source } : undefined;
  };
  const pinned =
    tryPin(opts.evaluatorPin, 'evaluator-pin') ??
    tryPin(env[AGENT_JUDGE_MODEL_ENV], 'env-pin') ??
    tryPin(opts.requestedModelId, 'request');
  if (pinned) return pinned;
  const auto = pickJudgeModel(available);
  return auto ? { model: auto, source: 'auto' } : undefined;
}

/**
 * What the agent (trace) judge would run on RIGHT NOW for a run with no
 * pin — read live from the credentialed pi registry. Used by
 * `GET /api/judge/models` to label the "Agent Trace Judge" dropdown entry.
 * Never throws: returns `{ error }` when the SDK is missing or no model is
 * credentialed.
 */
export async function describeDefaultAgentJudgeModel(): Promise<
  | { id: string; name?: string; source: AgentJudgeModelSource }
  | { error: string }
> {
  try {
    const { AuthStorage, ModelRegistry } = await loadPiSdk();
    const registry = ModelRegistry.create(AuthStorage.create());
    const available = (await registry.getAvailable()) as Array<{ provider: string; id: string; name?: string }>;
    const pick = resolveAgentJudgeModel(available);
    if (!pick) return { error: 'no credentialed model in the pi registry' };
    return { id: qualifiedModelId(pick.model), name: pick.model.name, source: pick.source };
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

/** Provider-qualified id (`amazon-bedrock/us.anthropic.claude-sonnet-4-5…`) — the persisted `judgeModel` shape for pi-registry models. */
export function qualifiedModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * The model id the pi SDK session REPORTED using (from the assistant
 * messages' `model` / `responseModel` fields), or undefined when the
 * transcript carries none. Preferred over the requested model when present
 * because it is what actually answered.
 */
export function extractResponseModel(messages: any[]): { provider?: string; model: string } | undefined {
  let last: { provider?: string; model: string } | undefined;
  for (const m of messages ?? []) {
    if (m?.role !== 'assistant') continue;
    const model = typeof m.responseModel === 'string' && m.responseModel.trim()
      ? m.responseModel
      : typeof m.model === 'string' && m.model.trim() ? m.model : undefined;
    if (model) last = { provider: typeof m.provider === 'string' ? m.provider : undefined, model };
  }
  return last;
}

/**
 * Evaluate a trajectory with the agent trace judge (in-process pi SDK).
 *
 * Two modes, selected by `traceToolsAvailable` (the caller —
 * server/routes/judge.ts — computes this via `hasTraceCorrelation(runId,
 * agents)` and passes the result in):
 *   - `true` (trace-tools mode): `request.runId` or a `request.agents`
 *     correlation hint (serviceName+window / sessionId) is present. The
 *     judge gets the real `query_spans`/`query_logs` tools scoped to this
 *     run and is instructed to verify claims against them.
 *   - `false` (trajectory-only mode): no correlation hint exists — the
 *     normal case for an agent declared `useTraces: false` (not
 *     OTel-instrumented), or one whose spans just can't be correlated. The
 *     judge gets NO trace tools at all and is told so explicitly (see
 *     {@link NO_TRACE_TOOLS_ADDENDUM}) so it grounds its verdict in the
 *     trajectory/response instead of hallucinating span checks. This
 *     NEVER throws for lack of correlation — pre-fix (#461/#462 lineage)
 *     the route hard-400'd here instead, which is what turned an entire
 *     62-case run against a non-instrumented REST agent into 62 judge
 *     failures with `passFailStatus: null` instead of 62 real verdicts.
 *
 * The resolved mode is persisted on the response as `judgeMode` (see
 * {@link JudgeResponse.judgeMode}) so reports/comparisons can show whether a
 * verdict had real trace evidence behind it.
 *
 * @param request - The judge request. `runId`/`agents` are used only to
 *   decide tool scoping when `traceToolsAvailable` is true.
 * @param evaluator - Optional saved evaluator. When provided, its `systemPrompt`
 *   replaces the default base prompt; the trace-tool (or trajectory-only)
 *   addendum is ALWAYS appended on top so the judge's understanding of its
 *   own tool access is never silently dropped by a custom prompt.
 *   `scoringConfig.metrics` drives dynamic metric extraction in the parsed
 *   response.
 * @param traceToolsAvailable - Whether to wire up `query_spans`/`query_logs`
 *   for this evaluation. Defaults to `true` for callers that don't pass it
 *   (back-compat with any caller written before this param existed) — the
 *   route always passes an explicit value.
 */
export async function evaluateWithPiAgenticTrace(
  request: JudgeRequest,
  evaluator?: Evaluator,
  traceToolsAvailable: boolean = true
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs, runId, agents } = request;

  debug('AgentJudge', '========== AGENT TRACE JUDGE (in-process) ==========');
  debug('AgentJudge', 'runId:', runId ?? '(none)', 'trajectory steps:', trajectory.length, 'traceToolsAvailable:', traceToolsAvailable);
  debug('AgentJudge', 'Evaluator:', evaluator ? `${evaluator.name} (${evaluator.id})` : '(none, using default prompt)');

  const userPrompt = buildEvaluationPrompt(trajectory, expectedOutcomes, expectedTrajectory, logs);
  const serverUrl =
    process.env.AH_JUDGE_SERVER_URL ||
    `http://localhost:${readEnv('AH_PORT', 'AGENT_HEALTH_PORT') || '4001'}`;
  const startTime = Date.now();

  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, getAgentDir } =
    await loadPiSdk();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const available = await modelRegistry.getAvailable();
  // Resolve the underlying LLM: saved-evaluator pin > AH_AGENT_JUDGE_MODEL_ID
  // env pin > the run's configured judge model when it's a real model id >
  // auto-pick a recent Claude from the credentialed registry. The auto-pick
  // ORDER is unchanged from before pins existed (comparability); pins only
  // make the choice explicit.
  const resolved = resolveAgentJudgeModel(available, {
    requestedModelId: request.modelId,
    evaluatorPin: evaluator?.inferenceConfig?.agentJudgeModelId,
  });
  if (!resolved) {
    throw new Error(
      'Agent judge: no model available. Configure a default pi model (e.g. a Bedrock or Anthropic model with valid credentials).'
    );
  }
  const { model } = resolved;
  debug('AgentJudge', 'model:', qualifiedModelId(model), `(${resolved.source})`);

  // Compose the system prompt: saved evaluator's prompt (if any) replaces
  // the default base, then the trace-tool (or trajectory-only) addendum is
  // unconditionally appended. Editing the saved prompt cannot accidentally
  // break either contract — a regression test in piAgenticJudgeService.test
  // pins this invariant.
  const systemPrompt = buildAgentTraceJudgeSystemPrompt(evaluator, traceToolsAvailable);

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    // Only register the trace-query tool extension when there's something to
    // scope it to. Without this guard, a trajectory-only evaluation would
    // still expose query_spans/query_logs — tools the system prompt just told
    // the model it doesn't have — confusing the model and reintroducing the
    // "no run id or trace correlation hints" failure mode inside the tool
    // call instead of at the route.
    extensionFactories: traceToolsAvailable ? [createTraceJudgeExtension(runId, serverUrl, agents)] : [],
    // Full isolation for this HEADLESS in-process session. Without
    // noExtensions the loader auto-loads the user's global ~/.pi/agent
    // extensions (e.g. an interactive status-bar extension) whose render
    // `tick` touches the TUI theme and throws "Theme not initialized",
    // crashing the server process. Inline extensionFactories
    // (query_spans/query_logs) still register regardless of this flag.
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
    // Restrict to ONLY the run-scoped trace tools registered by the extension
    // factory (when available — `tools: []` in trajectory-only mode disables
    // ALL tools, including the trace ones, matching `extensionFactories` above).
    // `tools: []` disables all built-in tools (read/bash/grep/...) either way so
    // the judge cannot read the project's filesystem — it may only inspect this
    // run's spans/logs when they're available. This is the core scoping
    // guarantee of the trace judge.
    tools: traceToolsAvailable ? ['query_spans', 'query_logs'] : [],
    sessionManager: SessionManager.inMemory(),
  });

  await session.prompt(userPrompt);
  const finalText = extractFinalAssistantText(session.messages);
  const duration = Date.now() - startTime;

  // What ACTUALLY answered: prefer the model the transcript reports (pi
  // stamps `model`/`responseModel` on every assistant message), fall back
  // to the model we asked for. Same provider-qualified shape either way.
  const answered = extractResponseModel(session.messages);
  const judgeModel = answered
    ? `${answered.provider ?? model.provider}/${answered.model}`
    : qualifiedModelId(model);

  const parsed = parseJudgeResponse(finalText, {
    evaluator,
    duration,
    source: 'AgentJudge',
  });
  // The underlying LLM — ALWAYS recorded (judgeDebug below is env-gated,
  // which is why no persisted agent-trace-judge report said which model
  // judged it). Persisted onto TestCaseRun.judgeModel + LLMJudgeResponse.modelId
  // via the `...parsed` spread in the return below.
  parsed.judgeModel = judgeModel;
  parsed.judgeProvider = 'agent';
  debug('AgentJudge', 'Pass/Fail:', parsed.passFailStatus, 'in', duration, 'ms', 'judged by', judgeModel);
  const judgeDebug = buildJudgeDebug({
    provider: 'agent',
    modelId: judgeModel,
    evaluatorId: evaluator?.id,
    systemPrompt,
    userPrompt,
  });
  if (judgeDebug) parsed.judgeDebug = judgeDebug;
  // Per RFC 004: individual judge verdicts never carry recommendations
  // (those belong to the insights synthesis layer). Forcing an empty array
  // also keeps the persisted matcherResults.improvementStrategies shape stable
  // regardless of what the model emitted.
  return {
    ...parsed,
    improvementStrategies: [],
    // Persisted downstream (services/evaluation/*, evaluationRunner.ts,
    // benchmarkRunner.ts) onto TestCaseRun.judgeMode so reports/comparisons
    // can show which cases had real trace evidence vs. trajectory-only
    // reasoning.
    judgeMode: traceToolsAvailable ? 'trace-tools' : 'trajectory-only',
  };
}
