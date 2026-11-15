/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * runJudge — the `/api/judge` dispatch as a plain function.
 *
 * Validates the request, resolves the evaluator (system / stored / default),
 * picks the provider from `evaluator.inferenceConfig.provider` →
 * `config.models[modelId].provider` → `'bedrock'`, calls that provider and
 * runs the canonical verdict engine (lib/scoring/applyScoring.ts) on the
 * result. `server/routes/judge.ts` is a thin HTTP wrapper around it; an
 * executor running outside the server (#612) can call it in-process with its
 * own credentials and get the identical response contract.
 *
 * Errors are typed so the wrapper can map them to the same HTTP responses the
 * route always produced:
 *   - `JudgeRequestError`  → 400 / 403 (validation, evaluator lookup, runId binding)
 *   - a judge parse error  → 422 `JUDGE_UNPARSEABLE` (see judgeResponseParser)
 *   - anything else        → 500 with the provider-specific message
 *     (`describeJudgeFailure`)
 */

import { evaluateTrajectory, parseBedrockError, type JudgeResponse } from '@/server/services/bedrockService';
import { evaluateWithOpenAICompatible, parseOpenAICompatibleError } from '@/server/services/judgeService';
import { evaluateWithLiteLLM, parseLiteLLMError } from '@/server/services/litellmJudgeService';
import { evaluateWithClaudeCode, parseClaudeCodeError } from '@/server/services/claudeCodeJudgeService';
import { evaluateWithPi, parsePiError } from '@/server/services/piJudgeService';
import { evaluateWithPiAgenticTrace } from '@/server/services/piAgenticJudgeService';
import { evaluateWithAgenticJudge, parseAgenticJudgeError } from '@/server/services/agenticJudgeService';
import { hasTraceCorrelation } from '@/services/traces/judgeAgentsHints';
import { debug } from '@/lib/debug';
import { getDefaultEvaluator, getSystemEvaluatorById, isSystemEvaluatorId } from '@/server/prompts/evaluatorTemplates';
import { applyScoringToJudgeResponse } from '@/lib/scoring/applyScoring';
import { isDeterministicEvaluator } from '@/lib/evaluators/deterministic';
import type { Evaluator, ModelConfig } from '@/types';
import type { JudgeRequestBody } from '@/lib/judge/transport';
import { generateMockEvaluation } from './mockJudge';

/** The configuration slice the judge needs: the model catalog and the judge block. */
export interface JudgeConfig {
  models: Record<string, ModelConfig>;
  judge?: { endpoint?: string };
}

export interface RunJudgeDeps {
  /** Resolve a STORED evaluator by id (system evaluators never reach this). `null` when unknown. */
  getEvaluator: (evaluatorId: string) => Promise<Evaluator | null>;
  config: JudgeConfig;
}

/** A request the judge refuses: carries the HTTP status + body the route answers with. */
export class JudgeRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'JudgeRequestError';
  }
}

/**
 * True for an AWS SDK v3 service error that means "the request itself is
 * invalid": the modelled `ValidationException`, or any client-fault error
 * the service answered with HTTP 400 or 404 (unknown model id). Throttling
 * (429), model timeouts/errors (408/424), access/credential errors (403) and
 * server faults (5xx) are NOT matched — those may succeed on retry and keep
 * the existing retryable 500 response.
 */
export function isProviderRequestRejection(error: any): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'ValidationException') return true;
  // 400 = malformed/invalid request; 404 = the model id does not exist
  // (ResourceNotFoundException). Neither heals on retry.
  return error.$fault === 'client' && (error.$metadata?.httpStatusCode === 400 || error.$metadata?.httpStatusCode === 404);
}

/** Resolve the provider + model id the request judges with (same precedence as the route always used). */
export function resolveJudgeProvider(config: JudgeConfig, modelId: string | undefined, evaluator?: Evaluator): { provider: string; resolvedModelId: string } {
  let modelConfig = modelId ? config.models[modelId] : undefined;
  if (!modelConfig && modelId) {
    // Try to find by model_id (in case full Bedrock ID was passed)
    modelConfig = Object.values(config.models).find(m => m.model_id === modelId);
  }
  const provider = evaluator?.inferenceConfig?.provider || modelConfig?.provider || 'bedrock';
  // Use the resolved model_id: evaluator override > config > provided
  const resolvedModelId = evaluator?.inferenceConfig?.modelId || modelConfig?.model_id || (modelId as string);
  return { provider, resolvedModelId };
}

/**
 * The single exit point for every provider branch: run the canonical verdict
 * engine (lib/scoring/applyScoring.ts) so the response carries the engine's
 * `passFailStatus`, the LLM's own `llmVerdict`, the normalized weighted
 * `score`, `verdictConflict` and the frozen `scoringSnapshot`. Provider errors
 * never reach here — they propagate to the caller, which records a judge error
 * with NO metrics.
 */
function finalizeJudgeResponse<T extends JudgeResponse>(result: T, evaluator: Evaluator, resolvedModelId: string): T {
  return applyScoringToJudgeResponse(result, evaluator, resolvedModelId);
}

export async function runJudge(body: JudgeRequestBody, deps: RunJudgeDeps): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs, modelId, evaluatorId, runId, agents } = body as JudgeRequestBody & { trajectory: any[] };

  // Validate required fields
  if (!trajectory || !Array.isArray(trajectory) || trajectory.length === 0) {
    throw new JudgeRequestError(400, 'Trajectory is required and must be a non-empty array');
  }
  if (!expectedOutcomes?.length && !expectedTrajectory?.length) {
    throw new JudgeRequestError(400, 'Missing required field: expectedOutcomes or expectedTrajectory');
  }

  // Load evaluator if specified, otherwise use default
  let evaluator: Evaluator;
  if (evaluatorId) {
    debug('JudgeAPI', 'Loading evaluator:', evaluatorId);
    // Check system evaluators first (they aren't stored in the storage backend)
    if (isSystemEvaluatorId(evaluatorId)) {
      const systemEval = getSystemEvaluatorById(evaluatorId);
      if (!systemEval) throw new JudgeRequestError(400, `System evaluator not found: ${evaluatorId}`);
      evaluator = systemEval;
    } else {
      const loadedEvaluator = await deps.getEvaluator(evaluatorId);
      if (!loadedEvaluator) throw new JudgeRequestError(400, `Evaluator not found: ${evaluatorId}`);
      evaluator = loadedEvaluator;
    }
  } else {
    debug('JudgeAPI', 'Using default evaluator (backward compatible)');
    evaluator = getDefaultEvaluator();
  }

  // A `kind: 'deterministic'` evaluator has no system prompt and is scored
  // in code (lib/scoring/deterministicScoring.ts) by the runner / Retry
  // judgement — it must never be sent to an LLM. Pre-fix this fell through
  // to the Bedrock path with `system: [{ text: '' }]` → ValidationException
  // → the client's 10-attempt retry budget per case. 4xx = the client
  // fails fast with this message instead.
  if (isDeterministicEvaluator(evaluator)) {
    throw new JudgeRequestError(
      400,
      `Evaluator "${evaluator.name}" is deterministic: it is scored in code from the stored trajectory, ` +
        'never by an LLM judge. /api/judge only serves LLM evaluators.',
      'DETERMINISTIC_EVALUATOR',
    );
  }

  // Determine provider from evaluator's inferenceConfig or model config
  // Priority: evaluator.inferenceConfig.provider > modelConfig.provider > 'bedrock'
  const { provider, resolvedModelId } = resolveJudgeProvider(deps.config, modelId, evaluator);
  debug('JudgeAPI', 'Using provider:', provider, 'model:', resolvedModelId, 'evaluator:', evaluator.name);

  const request = { trajectory, expectedOutcomes: expectedOutcomes as string[], expectedTrajectory: expectedTrajectory as any[], logs: logs as any[] };

  // Route to appropriate provider
  if (provider === 'demo') {
    // Loud, always-on warning (not behind the debug flag): the mock judge
    // returns a semi-random pass without calling an LLM, so a run can look
    // like "100% pass" while nothing was actually judged. Make that
    // impossible to miss in the server logs.
    console.warn(
      '\u26a0\ufe0f  [agent-health] MOCK JUDGE IN USE: judge model "%s" resolves to the "demo" provider — ' +
      'scores are NOT real (no LLM is called). Pin a real judge model (e.g. --judge-model <bedrock-id> ' +
      'or evaluator.inferenceConfig) to get a real verdict.',
      resolvedModelId
    );
    debug('JudgeAPI', 'Demo provider - returning mock evaluation');
    const mockResult = generateMockEvaluation(trajectory, expectedOutcomes as string[]);
    // Same identity contract as the real providers: the report says what
    // judged it. Here that is honestly "the demo mock", never an LLM id.
    return finalizeJudgeResponse({ ...mockResult, judgeModel: resolvedModelId, judgeProvider: 'demo' }, evaluator, resolvedModelId);
  }

  if (provider === 'claude-code') {
    debug('JudgeAPI', 'Claude Code provider - spawning claude CLI');
    // Pass the resolved evaluator so its `systemPrompt` replaces the
    // hardcoded baseline (and `scoringConfig.metrics` drives dynamic metric
    // extraction). Pre-fix this was the silent-prompt-drop bug.
    const result = await evaluateWithClaudeCode(request, evaluator);
    return finalizeJudgeResponse(result, evaluator, resolvedModelId);
  }

  if (provider === 'pi') {
    debug('JudgeAPI', 'Pi provider - spawning pi CLI');
    // Pass the resolved evaluator so its `systemPrompt` is forwarded to
    // the pi CLI via `--system-prompt` instead of the hardcoded baseline.
    const result = await evaluateWithPi(request, evaluator);
    return finalizeJudgeResponse(result, evaluator, resolvedModelId);
  }

  if (provider === 'agent') {
    // Agent trace judge: an LLM judge with read-only, trace-scoped tools
    // (query_spans/query_logs) so it can verify claims against the run's real
    // OTel spans/logs instead of trusting the trajectory text.
    //
    // `traceToolsAvailable` gates WHICH mode the judge runs in — it no
    // longer gates whether the judge runs at all. Accept EITHER a runId
    // (Strategy B, possibly already the caller's traceId fallback — see
    // resolveJudgeRunId) OR at least one Strategy C/D correlation hint in
    // `agents` (serviceName+window or sessionId, from buildJudgeAgentsHints
    // — #264) to enable the trace tools. Pre-fix (see #461/#462 lineage)
    // this hard-required a correlation hint and 400'd otherwise, even for
    // agents that declare `useTraces: false` and were never going to have
    // one — every case of a non-instrumented agent's 62-case run hard-
    // failed at the judge step with a validation error instead of a
    // verdict. A non-instrumented (or uncorrelated) agent still has a
    // trajectory + final response worth judging — degrade to
    // trajectory-only reasoning (no query_spans/query_logs tool pack)
    // instead of erroring. See piAgenticJudgeService.evaluateWithPiAgenticTrace's
    // `traceToolsAvailable` param and the persisted `judgeMode` field.
    const traceToolsAvailable = hasTraceCorrelation(runId, agents);
    if (!traceToolsAvailable) {
      debug(
        'JudgeAPI',
        'Agent trace judge - no runId/correlation hint available; degrading to ' +
          'trajectory-only judging (query_spans/query_logs tools withheld) instead of failing.'
      );
    }
    // Defense in depth against cross-run/cross-tenant exfiltration: the trace
    // tools will happily read spans/logs for whatever runId they're given, so
    // a direct caller could pass a benign trajectory but a *different* run's
    // runId and leak that run's data through the judge's reasoning text. Bind
    // the runId to the trajectory the request also carries: when the
    // trajectory steps carry runId(s) (the SDK path always derives runId from
    // the judged result, so they match), the requested runId MUST be one of
    // them. When the trajectory carries no runId we cannot corroborate it —
    // this provider then trusts the caller and is single-tenant-only (see
    // AGENTS.md "Trace correlation"; gate it behind auth in shared clusters).
    // Only applies when a runId was actually supplied — a hints-only request
    // (no runId at all) has nothing here to corroborate against, and the
    // hints themselves are server-derived from the report, not caller input.
    if (runId) {
      const trajectoryRunIds = new Set(
        (trajectory as any[])
          .map((s) => s?.runId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      );
      if (trajectoryRunIds.size > 0 && !trajectoryRunIds.has(runId)) {
        throw new JudgeRequestError(
          403,
          'runId does not match the submitted trajectory — the agent (trace) judge ' +
            'may only inspect the run that produced its trajectory',
        );
      }
    }
    debug(
      'JudgeAPI',
      'Agent trace judge - evaluating (runId=' +
        (runId ?? 'none — hints-only') +
        ', hints=' + (Array.isArray(agents) ? agents.length : 0) +
        ', traceToolsAvailable=' + traceToolsAvailable + ')'
    );
    // Pass the resolved evaluator so a saved `systemPrompt` replaces the
    // default base prompt (the trace-tool addendum, or its trajectory-only
    // counterpart, is still appended inside the service). `traceToolsAvailable`
    // decides whether the service wires up query_spans/query_logs at all —
    // see evaluateWithPiAgenticTrace's doc comment.
    const result = await evaluateWithPiAgenticTrace(
      { ...request, runId, modelId: resolvedModelId, agents },
      evaluator,
      traceToolsAvailable
    );
    return finalizeJudgeResponse(result, evaluator, resolvedModelId);
  }

  if (provider === 'agentic') {
    debug('JudgeAPI', 'Agentic judge provider - running agent-based evaluation');
    const judgeConfig = deps.config.judge || {};
    const backend = resolvedModelId === 'agentic-custom' ? 'custom' : 'claude-code';
    // Pass the resolved evaluator so its `systemPrompt` replaces the
    // baseline (the AGENTIC_JUDGE_ADDENDUM stays appended).
    const result = await evaluateWithAgenticJudge(
      { ...request, runId },
      { backend, endpoint: judgeConfig.endpoint },
      evaluator
    );
    return finalizeJudgeResponse(result, evaluator, resolvedModelId);
  }

  if (provider === 'openai-compatible') {
    debug('JudgeAPI', 'OpenAI-compatible provider - calling endpoint');
    const result = await evaluateWithOpenAICompatible(request, resolvedModelId, evaluator);
    return finalizeJudgeResponse(result, evaluator, resolvedModelId);
  }

  if (provider === 'litellm') {
    debug('JudgeAPI', 'LiteLLM provider - calling OpenAI-compatible endpoint');
    const result = await evaluateWithLiteLLM(request, resolvedModelId, evaluator);
    return finalizeJudgeResponse(result, evaluator, resolvedModelId);
  }

  // Default: bedrock
  const result = await evaluateTrajectory(request, resolvedModelId, evaluator);
  return finalizeJudgeResponse(result, evaluator, resolvedModelId);
}

/**
 * Provider-specific, human-readable description of a judge failure (the
 * `error` of the route's 500 body). The provider is re-derived from the
 * request's `modelId` alone — the evaluator may be what failed to load.
 */
export function describeJudgeFailure(error: any, modelId: string | undefined, config: JudgeConfig | undefined): string {
  const provider = config ? resolveJudgeProvider(config, modelId).provider : 'bedrock';
  return provider === 'agentic'
    ? parseAgenticJudgeError(error)
    : provider === 'pi' || provider === 'agent'
      ? parsePiError(error)
      : provider === 'claude-code'
        ? parseClaudeCodeError(error)
        : provider === 'litellm'
          ? parseLiteLLMError(error)
          : provider === 'openai-compatible'
            ? parseOpenAICompatibleError(error)
            : parseBedrockError(error);
}
