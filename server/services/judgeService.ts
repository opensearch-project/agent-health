/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI-compatible Judge Service - LLM evaluation using any OpenAI-compatible endpoint
 *
 * Supports OpenAI, Ollama, Azure OpenAI, Anthropic, and any other provider
 * accessible via the OpenAI Chat Completions format.
 */

import config from '../config';
import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from './bedrockService';
import { debug } from '@/lib/debug';
import type { Evaluator } from '@/types';
import { getDefaultEvaluator } from '@/server/prompts/evaluatorTemplates';
import { AGENT_PATH_SYSTEM_ADDENDUM } from '@/server/prompts/judgePrompt';
import { parseJudgeResponse } from '@/server/services/judgeResponseParser';
import { buildJudgeDebug } from '@/server/services/judgeDebug';
import { getAgentSourceForPrompt, isAgentPathConfigured } from '@/server/services/agentPath';

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using any OpenAI-compatible LLM endpoint
 * @param request - The judge request containing trajectory and expected outcomes
 * @param modelId - Model name forwarded to the endpoint (e.g. "gpt-4o", "ollama/llama3")
 * @param evaluator - Optional evaluator to use (falls back to default RCA evaluator)
 */
export async function evaluateWithOpenAICompatible(
  request: JudgeRequest,
  modelId: string,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  // Use default evaluator if none provided (backward compatibility)
  const effectiveEvaluator = evaluator || getDefaultEvaluator();

  debug('JudgeService', '========== OPENAI-COMPATIBLE JUDGE REQUEST ==========');
  debug('JudgeService', 'Evaluator:', effectiveEvaluator.name, `(${effectiveEvaluator.id})`);
  debug('JudgeService', 'Trajectory steps:', trajectory.length);
  debug('JudgeService', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('JudgeService', 'Model:', modelId);
  debug('JudgeService', 'Endpoint:', config.OPENAI_COMPATIBLE_ENDPOINT);

  const agentSource = isAgentPathConfigured()
    ? await getAgentSourceForPrompt({ trajectory, expectedOutcomes, modelId })
    : null;
  const userPrompt = buildEvaluationPrompt(
    trajectory,
    expectedOutcomes,
    expectedTrajectory,
    logs,
    agentSource,
  );
  debug('JudgeService', 'Prompt built, length:', userPrompt.length, 'characters');

  // Get inference config from evaluator with fallback defaults
  const temperature = effectiveEvaluator.inferenceConfig?.temperature ?? 0.1;
  const maxTokens = effectiveEvaluator.inferenceConfig?.maxTokens ?? 4096;

  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: effectiveEvaluator.systemPrompt + (agentSource ? AGENT_PATH_SYSTEM_ADDENDUM : '') },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.OPENAI_COMPATIBLE_API_KEY) {
    headers['Authorization'] = `Bearer ${config.OPENAI_COMPATIBLE_API_KEY}`;
  }

  debug('JudgeService', 'Calling OpenAI-compatible endpoint...');
  const startTime = Date.now();

  const res = await fetch(config.OPENAI_COMPATIBLE_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenAI-compatible endpoint responded ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const duration = Date.now() - startTime;
  debug('JudgeService', 'Response received in', duration, 'ms');

  const responseText: string = data.choices?.[0]?.message?.content ?? '';

  debug('JudgeService', '--- Raw Response ---');
  debug('JudgeService', responseText.substring(0, 500) + (responseText.length > 500 ? '...' : ''));

  debug('JudgeService', '========== OPENAI-COMPATIBLE JUDGE RESPONSE ==========');

  // Delegate JSON parse + metric extraction + extra-field capture to the
  // shared parser — single implementation across all providers.
  const parsed = parseJudgeResponse(responseText, {
    evaluator: effectiveEvaluator,
    duration,
    source: 'JudgeService',
  });
  const judgeDebug = buildJudgeDebug({
    provider: 'openai-compatible',
    modelId,
    evaluatorId: effectiveEvaluator.id,
    systemPrompt: effectiveEvaluator.systemPrompt,
    userPrompt,
  });
  if (judgeDebug) parsed.judgeDebug = judgeDebug;
  // Always record which LLM judged (the response's `model` echoes what the
  // gateway actually served; fall back to what we asked for).
  parsed.judgeModel = typeof data.model === 'string' && data.model ? data.model : modelId;
  parsed.judgeProvider = 'openai-compatible';
  return parsed;
}

// ============================================================================
// Error Parser
// ============================================================================

/**
 * Parse error messages from OpenAI-compatible API failures
 */
export function parseOpenAICompatibleError(error: Error): string {
  const msg = error.message;

  if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('authentication')) {
    return 'OpenAI-compatible endpoint authentication failed. Check your OPENAI_COMPATIBLE_API_KEY.';
  } else if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests')) {
    return 'OpenAI-compatible endpoint rate limit exceeded. Please try again in a moment.';
  } else if (msg.includes('JSON') || msg.toLowerCase().includes('parse')) {
    return 'Failed to parse LLM judge response. The model may have returned invalid JSON.';
  } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return `Cannot connect to OpenAI-compatible endpoint (${config.OPENAI_COMPATIBLE_ENDPOINT}). Ensure the server is running and OPENAI_COMPATIBLE_ENDPOINT is correct.`;
  }

  return msg || 'Unknown error occurred';
}
