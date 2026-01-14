/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bedrock LLM Judge Client
 * Calls backend proxy for AWS Bedrock evaluations
 */

import { TrajectoryStep, EvaluationMetrics, ImprovementStrategy, OpenSearchLog, PassFailStatus } from '@/types';
import { ENV_CONFIG } from '@/lib/config';

interface JudgeResult {
  passFailStatus: PassFailStatus;
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies: ImprovementStrategy[];
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ExpectedBehavior {
  expectedOutcomes?: string[];  // NEW: Simple text descriptions
  expectedTrajectory?: any[];   // Legacy: step-by-step trajectory
}

/**
 * Real Bedrock Judge implementation via backend proxy with exponential backoff retry
 * Calls the backend API which handles AWS Bedrock communication
 * @param trajectory - The agent's execution trajectory
 * @param expected - Expected outcomes or trajectory
 * @param logs - Optional OpenSearch logs
 * @param onProgress - Optional progress callback
 * @param modelId - Optional model ID for judge evaluation (falls back to BEDROCK_MODEL_ID env var)
 * @param judgeKey - Optional judge key to select between Demo Judge and Bedrock Judge
 */
export async function callBedrockJudge(
  trajectory: TrajectoryStep[],
  expected: ExpectedBehavior,
  logs?: OpenSearchLog[],
  onProgress?: (chunk: string) => void,
  modelId?: string,
  judgeKey?: string
): Promise<JudgeResult> {
  const maxRetries = 10;
  const baseDelay = 1000; // 1 second
  const judgeApiUrl = ENV_CONFIG.judgeApiUrl || 'http://localhost:4001/api/judge';

  console.log('[BedrockJudge] Sending request to backend proxy...');
  console.log('[BedrockJudge] Trajectory steps:', trajectory.length);
  console.log('[BedrockJudge] Expected outcomes:', expected.expectedOutcomes?.length || 0);
  console.log('[BedrockJudge] Expected trajectory steps:', expected.expectedTrajectory?.length || 0);
  console.log('[BedrockJudge] Logs provided:', logs?.length || 0);
  console.log('[BedrockJudge] Model:', modelId || '(using default)');
  console.log('[BedrockJudge] Judge:', judgeKey || '(using default)');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[BedrockJudge] Attempt ${attempt}/${maxRetries}`);

      // Call backend proxy
      const startTime = Date.now();
      const response = await fetch(judgeApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          trajectory,
          expectedOutcomes: expected.expectedOutcomes,
          expectedTrajectory: expected.expectedTrajectory,
          logs,
          modelId,
          judgeKey,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `API request failed with status ${response.status}`);
      }

      const result = await response.json();
      const duration = Date.now() - startTime;

      console.log('[BedrockJudge] ✓ Evaluation completed in', duration, 'ms');
      console.log('[BedrockJudge] Pass/Fail Status:', result.passFailStatus?.toUpperCase());
      console.log('[BedrockJudge] Metrics:', result.metrics);
      console.log('[BedrockJudge] Improvement strategies:', result.improvementStrategies?.length || 0);

      // Call onProgress with the full reasoning if provided
      if (onProgress && result.llmJudgeReasoning) {
        onProgress(result.llmJudgeReasoning);
      }

      return {
        passFailStatus: result.passFailStatus || 'failed', // Default to failed if missing
        metrics: result.metrics,
        llmJudgeReasoning: result.llmJudgeReasoning,
        improvementStrategies: result.improvementStrategies || [],
      };
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      let errorMessage = 'Unknown error occurred';

      if (error instanceof Error) {
        errorMessage = error.message;

        // Check for network errors
        if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
          errorMessage = `Cannot connect to Bedrock Judge backend at ${judgeApiUrl}. Please ensure the backend proxy server is running.`;
        }
      }

      console.error(`[BedrockJudge] Attempt ${attempt} failed:`, errorMessage);

      // If this is the last attempt, throw the error
      if (isLastAttempt) {
        throw new Error(`Bedrock Judge evaluation failed after ${maxRetries} attempts: ${errorMessage}`);
      }

      // Calculate exponential backoff delay: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`[BedrockJudge] Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  // This should never be reached due to throw in last attempt, but TypeScript needs it
  throw new Error('Bedrock Judge evaluation failed: Maximum retries exceeded');
}

/**
 * Simulate Bedrock Judge evaluation (fallback for testing)
 * @deprecated Use callBedrockJudge for real evaluations
 */
export function simulateBedrockJudge(
  trajectory: TrajectoryStep[],
  expectedTrajectory: any[]
): JudgeResult {
  console.warn('[BedrockJudge] Using simulated judge - this is for testing only');

  const hasRequiredTools = expectedTrajectory.every(exp =>
    trajectory.some(t => t.toolName && exp.requiredTools.includes(t.toolName))
  );

  const accuracy = hasRequiredTools ? 92 : 65;
  const faithfulness = 95;
  const latency_score = 88;

  return {
    passFailStatus: hasRequiredTools ? 'passed' : 'failed',
    metrics: {
      accuracy,
      faithfulness,
      latency_score,
      trajectory_alignment_score: hasRequiredTools ? 85 : 40
    },
    llmJudgeReasoning: hasRequiredTools
      ? "The agent successfully followed the standard RCA procedure. It correctly identified the problematic node using `opensearch_nodes_stats` after checking health."
      : "The agent deviated from the expected path. It jumped to conclusions without verifying individual node statistics first, missing the specific CPU spike confirmation.",
    improvementStrategies: [
      {
        category: 'tool_usage',
        issue: 'Missing comprehensive health check',
        recommendation: 'Always start with cluster health check before diving into specific nodes',
        priority: 'high'
      }
    ]
  };
}
