/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bedrock Service - LLM Judge evaluation using AWS Bedrock
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import config from '../config';
import { TrajectoryStep, ImprovementStrategy, Evaluator, EvaluationMetrics } from '@/types';
import { debug } from '@/lib/debug';
import { getDefaultEvaluator } from '@/server/prompts/evaluatorTemplates';

// ============================================================================
// Types
// ============================================================================

export interface JudgeRequest {
  trajectory: TrajectoryStep[];
  expectedOutcomes?: string[];
  expectedTrajectory?: any[];
  logs?: any[];
}

export interface JudgeResponse {
  passFailStatus: 'passed' | 'failed';
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies: ImprovementStrategy[];
  duration: number;
}

interface BedrockJudgeResult {
  pass_fail_status: string;
  accuracy?: number;
  metrics?: {
    accuracy?: number;
    faithfulness?: number;
    latency_score?: number;
    trajectory_alignment_score?: number;
  };
  reasoning: string;
  improvement_strategies?: ImprovementStrategy[];
}

// ============================================================================
// Bedrock Client Initialization
// ============================================================================

const bedrockClient = new BedrockRuntimeClient({
  region: config.AWS_REGION,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncate large strings to reduce token count
 */
export function truncateString(str: string | undefined | null, maxLength: number = 1000): string {
  if (!str || str.length <= maxLength) return str || '';
  return str.substring(0, maxLength) + `... [truncated ${str.length - maxLength} chars]`;
}

/**
 * Reduce trajectory size by truncating large tool outputs
 */
export function compactTrajectory(trajectory: TrajectoryStep[]): TrajectoryStep[] {
  return trajectory.map(step => {
    const compacted = { ...step };

    // Truncate large content fields
    if (compacted.content && typeof compacted.content === 'string') {
      compacted.content = truncateString(compacted.content, 500);
    }

    // Truncate large tool outputs
    if (compacted.toolOutput) {
      if (typeof compacted.toolOutput === 'string') {
        compacted.toolOutput = truncateString(compacted.toolOutput, 1000);
      } else if (typeof compacted.toolOutput === 'object') {
        compacted.toolOutput = truncateString(JSON.stringify(compacted.toolOutput), 1000);
      }
    }

    return compacted;
  });
}

/**
 * Build the evaluation prompt for the LLM judge
 */
export function buildEvaluationPrompt(
  trajectory: TrajectoryStep[],
  expectedOutcomes?: string[],
  expectedTrajectory?: any[],
  logs?: any[]
): string {
  // Compact trajectory to reduce size
  const compactedTrajectory = compactTrajectory(trajectory);
  const trajectoryJson = JSON.stringify(compactedTrajectory, null, 2);

  // Limit logs to 20 most recent
  const logsJson = logs && logs.length > 0
    ? JSON.stringify(logs.slice(0, 20), null, 2)
    : 'No logs available';

  // Build expected section based on what's provided
  let expectedSection = '';
  if (expectedOutcomes && expectedOutcomes.length > 0) {
    // Use expectedOutcomes (new format)
    expectedSection = `## Expected Outcomes
The agent should achieve the following outcomes:
${expectedOutcomes.map((outcome, i) => `${i + 1}. ${outcome}`).join('\n')}`;
  } else if (expectedTrajectory && expectedTrajectory.length > 0) {
    // Fall back to expectedTrajectory (legacy format)
    const expectedJson = JSON.stringify(expectedTrajectory, null, 2);
    expectedSection = `## Expected Trajectory (Legacy)
\`\`\`json
${expectedJson}
\`\`\``;
  } else {
    expectedSection = '## Expected Outcomes\nNo expected outcomes defined.';
  }

  return `# Evaluation Task

## Actual Agent Trajectory
\`\`\`json
${trajectoryJson}
\`\`\`

${expectedSection}

## OpenSearch Logs (Recent 20)
\`\`\`json
${logsJson}
\`\`\`

Please evaluate the agent's performance and provide your assessment in the JSON format specified.`;
}

// ============================================================================
// Main Evaluation Function
// ============================================================================

/**
 * Evaluate agent trajectory using AWS Bedrock LLM Judge
 * @param request - The judge request containing trajectory and expected outcomes
 * @param modelId - Optional model ID to use for evaluation (falls back to config.BEDROCK_MODEL_ID)
 * @param evaluator - Optional evaluator to use (falls back to default RCA evaluator)
 */
export async function evaluateTrajectory(
  request: JudgeRequest,
  modelId?: string,
  evaluator?: Evaluator
): Promise<JudgeResponse> {
  const { trajectory, expectedOutcomes, expectedTrajectory, logs } = request;

  // Use default evaluator if none provided (backward compatibility)
  const effectiveEvaluator = evaluator || getDefaultEvaluator();

  // Use provided modelId or fall back to configured default
  const effectiveModelId = modelId || config.BEDROCK_MODEL_ID;

  debug('JudgeAPI', '========== BEDROCK JUDGE REQUEST ==========');
  debug('JudgeAPI', 'Received evaluation request');
  debug('JudgeAPI', 'Evaluator:', effectiveEvaluator.name, `(${effectiveEvaluator.id})`);
  debug('JudgeAPI', 'Trajectory steps:', trajectory.length);
  debug('JudgeAPI', 'Expected outcomes:', expectedOutcomes?.length || 0);
  debug('JudgeAPI', 'Expected trajectory steps:', expectedTrajectory?.length || 0);
  debug('JudgeAPI', 'Logs provided:', logs?.length || 0);
  debug('JudgeAPI', 'Model:', effectiveModelId, modelId ? '(from request)' : '(default)');

  // Log trajectory summary for debugging
  debug('JudgeAPI', '--- Trajectory Summary ---');
  trajectory.forEach((step, idx) => {
    debug('JudgeAPI', `Step ${idx + 1}: ${step.type} ${step.toolName ? `(${step.toolName})` : ''}`);
  });

  // Log expected outcomes or trajectory
  if (expectedOutcomes?.length) {
    debug('JudgeAPI', '--- Expected Outcomes ---');
    expectedOutcomes.forEach((outcome, idx) => {
      debug('JudgeAPI', `${idx + 1}. ${outcome}`);
    });
  } else if (expectedTrajectory?.length) {
    debug('JudgeAPI', '--- Expected Trajectory (Legacy) ---');
    expectedTrajectory.forEach((step: any, idx) => {
      debug('JudgeAPI', `Step ${idx + 1}: ${step.description} (Tools: ${step.requiredTools?.join(', ') || 'none'})`);
    });
  }

  // Build evaluation prompt
  const userPrompt = buildEvaluationPrompt(trajectory, expectedOutcomes, expectedTrajectory, logs);

  debug('JudgeAPI', 'Prompt built, length:', userPrompt.length, 'characters');

  // Get inference config from evaluator with fallback defaults
  const temperature = effectiveEvaluator.inferenceConfig?.temperature ?? 0.1;
  const maxTokens = effectiveEvaluator.inferenceConfig?.maxTokens ?? 4096;

  debug('JudgeAPI', 'Inference config - temperature:', temperature, 'maxTokens:', maxTokens);

  // Create Bedrock command using evaluator's system prompt
  const command = new ConverseCommand({
    modelId: effectiveModelId,
    messages: [
      {
        role: 'user',
        content: [{ text: userPrompt }],
      },
    ],
    system: [{ text: effectiveEvaluator.systemPrompt }],
    inferenceConfig: {
      maxTokens,
      temperature,
    },
  });

  // Call Bedrock
  debug('JudgeAPI', 'Calling Bedrock API...');
  const startTime = Date.now();
  const response = await bedrockClient.send(command);
  const duration = Date.now() - startTime;

  debug('JudgeAPI', 'Response received in', duration, 'ms');

  // Extract response text
  let responseText = '';
  if (response.output?.message?.content) {
    for (const content of response.output.message.content) {
      if ('text' in content && content.text) {
        responseText += content.text;
      }
    }
  }

  debug('JudgeAPI', '--- Raw Bedrock Response ---');
  debug('JudgeAPI', responseText.substring(0, 500) + (responseText.length > 500 ? '...' : ''));

  // Parse JSON response
  let jsonText = responseText.trim();
  const jsonMatch = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonText = jsonMatch[1];
    debug('JudgeAPI', 'Extracted JSON from markdown code block');
  } else {
    const startIdx = jsonText.indexOf('{');
    const endIdx = jsonText.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      jsonText = jsonText.slice(startIdx, endIdx + 1);
      debug('JudgeAPI', 'Extracted JSON from text');
    }
  }

  const result: BedrockJudgeResult = JSON.parse(jsonText);

  debug('JudgeAPI', '========== BEDROCK JUDGE RESPONSE ==========');
  debug('JudgeAPI', 'Pass/Fail Status:', result.pass_fail_status?.toUpperCase() || 'MISSING');

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
        debug('JudgeAPI', `Metric '${metricName}':`, parsed);
      } else {
        debug('JudgeAPI', `Warning: Metric '${metricName}' has invalid value:`, value);
      }
    } else {
      debug('JudgeAPI', `Warning: Metric '${metricName}' not found in judge response`);
    }
  }

  debug('JudgeAPI', 'Improvement Strategies:', result.improvement_strategies?.length ?? 0, 'items');
  if (result.improvement_strategies?.length) {
    result.improvement_strategies.forEach((s, i) => {
      debug('JudgeAPI', `  ${i + 1}. [${s.priority}] ${s.category}: ${s.issue}`);
    });
  }
  debug('JudgeAPI', 'Evaluation completed successfully');

  // Return structured response with dynamic metrics
  return {
    passFailStatus: (result.pass_fail_status || 'failed') as 'passed' | 'failed',
    metrics,
    llmJudgeReasoning: result.reasoning,
    improvementStrategies: result.improvement_strategies || [],
    duration,
  };
}

/**
 * Parse error messages from Bedrock API failures
 */
export function parseBedrockError(error: Error): string {
  const errorMessage = error.message;

  if (errorMessage.includes('ExpiredToken') || errorMessage.includes('CredentialsProviderError')) {
    return 'AWS credentials expired or invalid. Please refresh your AWS credentials.';
  } else if (errorMessage.includes('ThrottlingException')) {
    return 'Bedrock API rate limit exceeded. Please try again in a moment.';
  } else if (errorMessage.includes('ValidationException')) {
    return 'Invalid request to Bedrock. Please check your configuration.';
  } else if (errorMessage.includes('JSON')) {
    return 'Failed to parse LLM judge response. The model may have returned invalid JSON.';
  }

  return errorMessage || 'Unknown error occurred';
}
