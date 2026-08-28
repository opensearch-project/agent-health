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
import { getBackendUrl } from '@/lib/portConfig';

interface JudgeResult {
  passFailStatus: PassFailStatus;
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies: ImprovementStrategy[];
  judgeDurationMs?: number;
  judgeAttempts?: number;
  /**
   * Set only by the demo/mock judge (`/api/judge` never sets this for a real
   * provider) to flag that the verdict was NOT produced by an LLM. Forwarded
   * as-is so any caller of `callBedrockJudge` can detect a mock verdict
   * without re-parsing `llmJudgeReasoning` prose.
   */
  warning?: string;
  /** Raw text the judge model emitted (forwarded from /api/judge). */
  rawResponse?: string;
  /** Extra JSON keys the model emitted that weren't typed wire fields. */
  extraFields?: Record<string, unknown>;
  /** System/user prompts the judge actually saw (when AH_JUDGE_DEBUG=1). */
  judgeDebug?: {
    provider?: string;
    modelId?: string;
    evaluatorId?: string;
    systemPrompt?: string;
    userPrompt?: string;
    toolCalls?: Array<{ tool: string; command: string }>;
    evidenceDir?: string;
  };
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

export interface JudgeEvidenceContext {
  prompt?: string;
  agentKey?: string;
  timings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  workspaceDir?: string;
}

/**
 * Real Bedrock Judge implementation via backend proxy with exponential backoff retry
 * Calls the backend API which handles AWS Bedrock communication
 * The backend routes to the appropriate provider (demo/bedrock/ollama) based on modelId
 * @param trajectory - The agent's execution trajectory
 * @param expected - Expected outcomes or trajectory
 * @param logs - Optional OpenSearch logs
 * @param onProgress - Optional progress callback
 * @param modelId - Model ID for judge evaluation (determines provider routing)
 * @param evaluatorId - Optional saved evaluator id (resolves the system prompt server-side)
 * @param runId - Agent run id. Forwarded so the `agent` (trace) judge provider's
 *   read-only `query_spans` / `query_logs` tools can scope to this single run.
 *   Without it the route 400s with `runId is required for the agent (trace)
 *   judge provider`. For other providers it's ignored. Pre-fix the runner
 *   never forwarded this even when known on the report, so picking the
 *   `agent-trace-judge` model from the UI Judge Model dropdown always
 *   failed at the route layer.
 * @param agents - Optional Strategy C correlation hints (service.name +
 *   time-window) for the agent (trace) judge. The trace tool unions
 *   Strategy B (`runIds`) with these so spans the agent emits under its
 *   own correlation (claude-code's session id, etc.) are findable. See #264.
 */
export async function callBedrockJudge(
  trajectory: TrajectoryStep[],
  expected: ExpectedBehavior,
  logs?: OpenSearchLog[],
  onProgress?: (chunk: string) => void,
  modelId?: string,
  evaluatorId?: string,
  runId?: string,
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>,
  evidenceContext?: JudgeEvidenceContext
): Promise<JudgeResult> {
  const maxRetries = 10;
  const baseDelay = 1000; // 1 second
  const judgeApiUrl = ENV_CONFIG.judgeApiUrl || `${getBackendUrl()}/api/judge`;

  console.log('[BedrockJudge] Sending request to backend proxy...');
  console.log('[BedrockJudge] Trajectory steps:', trajectory.length);
  console.log('[BedrockJudge] Expected outcomes:', expected.expectedOutcomes?.length || 0);
  console.log('[BedrockJudge] Expected trajectory steps:', expected.expectedTrajectory?.length || 0);
  console.log('[BedrockJudge] Logs provided:', logs?.length || 0);
  console.log('[BedrockJudge] Model:', modelId || '(using default)');

  const judgeStartTime = Date.now();

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
          ...(evaluatorId ? { evaluatorId } : {}),
          // Forward runId so /api/judge can route to the `agent` (trace)
          // provider — its tools require this to scope. Other providers
          // ignore it.
          ...(runId ? { runId } : {}),
          // Forward Strategy C correlation hints (#264) so the agent (trace)
          // judge tool can find spans the agent emits under its OWN
          // correlation (claude-code's session id, etc.), not just spans
          // that share agent-health's runId via gen_ai.request.id.
          ...(agents && agents.length > 0 ? { agents } : {}),
          // Complete runner metadata for the immutable evidence bundle. The
          // trajectory above is already the original, untruncated array.
          ...(evidenceContext ? { evidenceContext } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = errorData.error || `API request failed with status ${response.status}`;
        // 4xx client errors are validation failures — retrying won't help
        if (response.status >= 400 && response.status < 500) {
          throw Object.assign(new Error(`Bedrock Judge validation error (not retryable): ${errorMessage}`), { nonRetryable: true });
        }
        throw new Error(errorMessage);
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
        judgeDurationMs: Date.now() - judgeStartTime,
        judgeAttempts: attempt,
        // Forward the mock-judge warning (absent for every real provider).
        warning: result.warning,
        // Forward debug breadcrumbs from the route so the runner can persist
        // them on the run document. These are absent in older /api/judge
        // responses (back-compat) and in production unless AH_JUDGE_DEBUG=1.
        rawResponse: result.rawResponse,
        extraFields: result.extraFields,
        judgeDebug: result.judgeDebug,
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

      // Fail fast on non-retryable errors (4xx validation failures)
      if ((error as any)?.nonRetryable) {
        throw error;
      }

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
