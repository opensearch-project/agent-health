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

  const userPrompt = buildEvaluationPrompt(trajectory, expectedOutcomes, expectedTrajectory, logs);
  debug('JudgeService', 'Prompt built, length:', userPrompt.length, 'characters');

  // Get inference config from evaluator with fallback defaults
  const temperature = effectiveEvaluator.inferenceConfig?.temperature ?? 0.1;
  const maxTokens = effectiveEvaluator.inferenceConfig?.maxTokens ?? 4096;

  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: effectiveEvaluator.systemPrompt },
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

  // Extract JSON — handles markdown code blocks and bare JSON
  let jsonText = responseText.trim();
  const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
    debug('JudgeService', 'Extracted JSON from markdown code block');
  } else {
    const startIdx = jsonText.indexOf('{');
    const endIdx = jsonText.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonText = jsonText.slice(startIdx, endIdx + 1);
      debug('JudgeService', 'Extracted JSON from text');
    }
  }

  const result = JSON.parse(jsonText);

  debug('JudgeService', '========== OPENAI-COMPATIBLE JUDGE RESPONSE ==========');
  debug('JudgeService', 'Pass/Fail Status:', result.pass_fail_status?.toUpperCase() || 'MISSING');

  // Extract metrics dynamically based on evaluator's scoring config
  const metrics: Record<string, number> = {};

  for (const metricDef of effectiveEvaluator.scoringConfig.metrics) {
    const metricName = metricDef.name;
    // Check top-level first (new format), then nested metrics object (legacy)
    const value = (result as any)[metricName] ?? result.metrics?.[metricName];
    if (value !== undefined && value !== null) {
      const parsed = typeof value === 'number' ? value : parseFloat(value);
      if (Number.isFinite(parsed)) {
        metrics[metricName] = parsed;
        debug('JudgeService', `Metric '${metricName}':`, parsed);
      } else {
        debug('JudgeService', `Warning: Metric '${metricName}' has invalid value:`, value);
      }
    } else {
      debug('JudgeService', `Warning: Metric '${metricName}' not found in judge response`);
    }
  }

  debug('JudgeService', 'Improvement Strategies:', result.improvement_strategies?.length ?? 0, 'items');

  return {
    passFailStatus: (result.pass_fail_status || 'failed') as 'passed' | 'failed',
    metrics,
    llmJudgeReasoning: result.reasoning,
    improvementStrategies: result.improvement_strategies || [],
    duration,
  };
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
