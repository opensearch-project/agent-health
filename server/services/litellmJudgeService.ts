/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiteLLM Judge Service - LLM evaluation using any OpenAI-compatible endpoint
 *
 * Supports OpenAI, Ollama, Azure OpenAI, Anthropic, and any other provider
 * accessible through a LiteLLM proxy or directly via the OpenAI Chat Completions format.
 */

import config from '../config';
import { buildEvaluationPrompt, JudgeRequest, JudgeResponse } from './bedrockService';
import { JUDGE_SYSTEM_PROMPT } from '../prompts/judgePrompt';
import { debug } from '@/lib/debug';

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using any OpenAI-compatible LLM endpoint
 * @param request - The judge request containing trajectory and expected outcomes
 * @param modelId - Model name forwarded to the LiteLLM endpoint (e.g. "gpt-4o", "ollama/llama3")
 */
export async function evaluateWithLiteLLM(
  request: JudgeRequest,
  modelId: string
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  debug('LiteLLMJudge', '========== LITELLM JUDGE REQUEST ==========');
  debug('LiteLLMJudge', 'Trajectory steps:', trajectory.length);
  debug('LiteLLMJudge', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('LiteLLMJudge', 'Model:', modelId);
  debug('LiteLLMJudge', 'Endpoint:', config.LITELLM_ENDPOINT);

  const userPrompt = buildEvaluationPrompt(trajectory, expectedOutcomes, expectedTrajectory, logs);
  debug('LiteLLMJudge', 'Prompt built, length:', userPrompt.length, 'characters');

  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.LITELLM_API_KEY) {
    headers['Authorization'] = `Bearer ${config.LITELLM_API_KEY}`;
  }

  debug('LiteLLMJudge', 'Calling LiteLLM endpoint...');
  const startTime = Date.now();

  const res = await fetch(config.LITELLM_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LiteLLM responded ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const duration = Date.now() - startTime;
  debug('LiteLLMJudge', 'Response received in', duration, 'ms');

  const responseText: string = data.choices?.[0]?.message?.content ?? '';

  debug('LiteLLMJudge', '--- Raw LiteLLM Response ---');
  debug('LiteLLMJudge', responseText.substring(0, 500) + (responseText.length > 500 ? '...' : ''));

  // Extract JSON — handles markdown code blocks and bare JSON
  let jsonText = responseText.trim();
  const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
    debug('LiteLLMJudge', 'Extracted JSON from markdown code block');
  } else {
    const startIdx = jsonText.indexOf('{');
    const endIdx = jsonText.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonText = jsonText.slice(startIdx, endIdx + 1);
      debug('LiteLLMJudge', 'Extracted JSON from text');
    }
  }

  const result = JSON.parse(jsonText);

  debug('LiteLLMJudge', '========== LITELLM JUDGE RESPONSE ==========');
  debug('LiteLLMJudge', 'Pass/Fail Status:', result.pass_fail_status?.toUpperCase() || 'MISSING');

  // Handle both simplified format (accuracy at top level) and legacy format (accuracy in metrics)
  const accuracy = result.accuracy ?? result.metrics?.accuracy ?? 0;
  debug('LiteLLMJudge', 'Accuracy:', accuracy);
  debug('LiteLLMJudge', 'Improvement Strategies:', result.improvement_strategies?.length ?? 0, 'items');

  return {
    passFailStatus: (result.pass_fail_status || 'failed') as 'passed' | 'failed',
    metrics: {
      accuracy,
      faithfulness: result.metrics?.faithfulness,
      latency_score: result.metrics?.latency_score,
      trajectory_alignment_score: result.metrics?.trajectory_alignment_score,
    },
    llmJudgeReasoning: result.reasoning,
    improvementStrategies: result.improvement_strategies || [],
    duration,
  };
}

// ============================================================================
// Error Parser
// ============================================================================

/**
 * Parse error messages from LiteLLM / OpenAI-compatible API failures
 */
export function parseLiteLLMError(error: Error): string {
  const msg = error.message;

  if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('authentication')) {
    return 'LiteLLM authentication failed. Check your LITELLM_API_KEY.';
  } else if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests')) {
    return 'LiteLLM rate limit exceeded. Please try again in a moment.';
  } else if (msg.includes('JSON') || msg.toLowerCase().includes('parse')) {
    return 'Failed to parse LLM judge response. The model may have returned invalid JSON.';
  } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return `Cannot connect to LiteLLM endpoint (${config.LITELLM_ENDPOINT}). Ensure the server is running and LITELLM_ENDPOINT is correct.`;
  }

  return msg || 'Unknown error occurred';
}
