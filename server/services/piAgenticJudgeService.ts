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
import { parsePiJudgeJson } from '@/server/services/piJudgeService';
import { createTraceJudgeExtension } from '@/server/services/traceJudgeTools';
import type { PiSdk } from '@/server/services/piSdkTypes';
import { readEnv } from '@/lib/envCompat';
import { debug } from '@/lib/debug';

/** System prompt: tells the judge it has real trace/log tools and to use them. */
const AGENTIC_TRACE_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for observability and Root Cause Analysis (RCA) agents.

You are an AGENTIC judge: in addition to the trajectory shown in the prompt, you have READ-ONLY tools that return the REAL OpenTelemetry spans and logs for the exact run you are judging:
  - query_spans({ nameFilter? }): the run's actual spans (tool calls, token usage, latency, gen_ai.* attributes)
  - query_logs({ query? }): the run's correlated logs (evidence for/against a root cause)

These tools are hard-scoped to this single run; you cannot query other runs. PREFER verifying claims against this real data instead of trusting the trajectory narrative. For example: before accepting "the agent called search_logs", confirm a matching span exists; before accepting a budget claim, check real token usage; before accepting a root-cause claim, look for supporting log evidence.

When you are done investigating, respond with ONLY a JSON object (no prose, optionally fenced in \`\`\`json):
{
  "pass_fail_status": "passed" | "failed",
  "accuracy": <0-100>,
  "reasoning": "<concise explanation grounded in what the tools showed>",
  "metrics": { "faithfulness": <0-100>, "latency_score": <0-100>, "trajectory_alignment_score": <0-100> },
  "improvement_strategies": []
}`;

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

/** Inference-profile prefix appropriate for the current AWS region. */
function regionInferencePrefix(): string {
  const r = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1').toLowerCase();
  if (r.startsWith('eu-')) return 'eu.';
  if (r.startsWith('ap-')) return 'apac.';
  return 'us.';
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
 * Evaluate a trajectory with the agent trace judge (in-process pi SDK).
 *
 * Requires `request.runId` so the trace tools can scope to the run. Without a
 * runId the tools report "no run id" and the judge degrades to a
 * trajectory-only judgement rather than failing.
 */
export async function evaluateWithPiAgenticTrace(request: JudgeRequest): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs, runId } = request;

  debug('AgentJudge', '========== AGENT TRACE JUDGE (in-process) ==========');
  debug('AgentJudge', 'runId:', runId ?? '(none)', 'trajectory steps:', trajectory.length);

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
  // Prefer the exact model the run is configured to judge with; fall back to a
  // recent Claude from the credentialed models.
  const model = findRequestedModel(available, request.modelId) ?? pickJudgeModel(available);
  if (!model) {
    throw new Error(
      'Agent judge: no model available. Configure a default pi model (e.g. a Bedrock or Anthropic model with valid credentials).'
    );
  }
  debug('AgentJudge', 'model:', `${model.provider}/${model.id}`);

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => AGENTIC_TRACE_JUDGE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    extensionFactories: [createTraceJudgeExtension(runId, serverUrl)],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    // Restrict to ONLY the run-scoped trace tools registered by the extension
    // factory. `tools: []` disables all built-in tools (read/bash/grep/...) so
    // the judge cannot read the project's filesystem — it may only inspect this
    // run's spans/logs. This is the core scoping guarantee of the trace judge.
    tools: ['query_spans', 'query_logs'],
    sessionManager: SessionManager.inMemory(),
  });

  await session.prompt(userPrompt);
  const finalText = extractFinalAssistantText(session.messages);
  const duration = Date.now() - startTime;

  const parsed = parsePiJudgeJson(finalText);
  debug('AgentJudge', 'Pass/Fail:', parsed.passFailStatus, 'in', duration, 'ms');
  // Per RFC 004: individual judge verdicts never carry recommendations
  // (those belong to the insights synthesis layer). Forcing an empty array
  // also keeps the persisted matcherResults.improvementStrategies shape stable
  // regardless of what the model emitted.
  return { ...parsed, improvementStrategies: [], duration };
}
